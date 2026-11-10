-- Marketplace follow-up: deauthorization, idempotent payment failures,
-- destination-charge transfer ids, and forced RLS on private market tables.
-- Apply once after supabase/chess_market_stripe.sql.
-- Do not edit or reapply chess_market.sql or chess_market_stripe.sql.

begin;

alter table chess_private.market_orders
  add column stripe_charge_id text;

alter table chess_private.market_sellers enable row level security;
alter table chess_private.market_photos enable row level security;
alter table chess_private.market_orders enable row level security;
alter table chess_private.market_trades enable row level security;
alter table chess_private.market_reports enable row level security;
alter table chess_private.market_stripe_events enable row level security;
alter table chess_private.market_sellers force row level security;
alter table chess_private.market_photos force row level security;
alter table chess_private.market_orders force row level security;
alter table chess_private.market_trades force row level security;
alter table chess_private.market_reports force row level security;
alter table chess_private.market_stripe_events force row level security;

create or replace function chess_private.market_order_move(order_uuid uuid, next_status text, next_tracking text, payment_intent text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current chess_private.market_orders%rowtype;
begin
  select * into current from chess_private.market_orders orders where orders.id = order_uuid for update;
  if not found then
    if next_status = 'canceled' then
      return;
    end if;
    raise exception 'That order was not found.';
  end if;
  if current.status = next_status then
    return;
  end if;
  if next_status = 'canceled' and current.status <> 'pending' then
    return;
  end if;
  if next_status = 'paid' and current.status = 'pending' then
    if current.trade_id is null and current.quantity_adjusted is not true then
      update public.chess_market_listings listings
        set quantity = listings.quantity - current.quantity, updated_at = clock_timestamp()
        where listings.id = current.listing_id and listings.quantity >= current.quantity;
      if not found then
        raise exception 'That listing does not have enough left.';
      end if;
      update chess_private.market_orders orders set quantity_adjusted = true where orders.id = current.id;
    end if;
    update chess_private.market_orders orders
      set status = 'paid',
          stripe_payment_intent = coalesce(payment_intent, orders.stripe_payment_intent)
      where orders.id = current.id;
  elsif next_status = 'shipped' and current.status in ('paid', 'partially_refunded') then
    update chess_private.market_orders orders
      set status = 'shipped', tracking = nullif(left(coalesce(next_tracking, ''), 80), ''), shipped_at = clock_timestamp()
      where orders.id = current.id;
  elsif next_status = 'refunded' and current.status in ('paid', 'shipped', 'partially_refunded', 'disputed') then
    if current.quantity_adjusted then
      update public.chess_market_listings listings
        set quantity = least(999, listings.quantity + current.quantity), updated_at = clock_timestamp()
        where listings.id = current.listing_id;
    end if;
    update chess_private.market_orders orders
      set status = 'refunded', quantity_adjusted = false
      where orders.id = current.id;
  elsif next_status = 'canceled' and current.status = 'pending' then
    if current.quantity_adjusted and current.trade_id is null then
      update public.chess_market_listings listings
        set quantity = least(999, listings.quantity + current.quantity), updated_at = clock_timestamp()
        where listings.id = current.listing_id;
    end if;
    update chess_private.market_orders orders
      set status = 'canceled', quantity_adjusted = false
      where orders.id = current.id;
  else
    raise exception 'That order cannot change.';
  end if;
end;
$$;

create or replace function chess_service.market_stripe_apply(event_id text, event_type text, payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_uuid uuid;
  current chess_private.market_orders%rowtype;
  account_id text;
  buyer uuid;
  seller uuid;
  refunded_amount integer;
  charge_amount integer;
  outcome text;
  admin_profile uuid;
  group_intent text;
  result jsonb := '{}'::jsonb;
begin
  if event_id is null or char_length(event_id) < 3 or char_length(event_id) > 80 then
    return result;
  end if;
  insert into chess_private.market_stripe_events (event_id) values (event_id) on conflict do nothing;
  if not found then
    return result;
  end if;
  if coalesce(payload->>'orderId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    order_uuid := (payload->>'orderId')::uuid;
  end if;
  if order_uuid is null and coalesce(payload->>'paymentIntent', '') <> '' then
    select orders.id into order_uuid from chess_private.market_orders orders where orders.stripe_payment_intent = payload->>'paymentIntent';
  end if;
  if order_uuid is null and coalesce(payload->>'sessionId', '') <> '' then
    select orders.id into order_uuid from chess_private.market_orders orders where orders.stripe_session_id = payload->>'sessionId';
  end if;
  if order_uuid is null and coalesce(payload->>'chargeId', '') <> '' then
    select orders.id into order_uuid from chess_private.market_orders orders where orders.stripe_charge_id = payload->>'chargeId';
  end if;
  if order_uuid is null and coalesce(payload->>'transferGroup', '') <> '' then
    group_intent := payload->>'transferGroup';
    if group_intent like 'group_%' then
      group_intent := substring(group_intent from 7);
    end if;
    select orders.id into order_uuid from chess_private.market_orders orders where orders.stripe_payment_intent = group_intent;
  end if;
  if order_uuid is not null then
    update chess_private.market_orders orders
      set transfer_id = coalesce(nullif(payload->>'transferId', ''), orders.transfer_id),
          stripe_charge_id = coalesce(nullif(payload->>'chargeId', ''), orders.stripe_charge_id),
          stripe_payment_intent = coalesce(nullif(payload->>'paymentIntent', ''), orders.stripe_payment_intent),
          ship_name = coalesce(nullif(payload->>'shipName', ''), orders.ship_name),
          ship_line1 = coalesce(nullif(payload->>'shipLine1', ''), orders.ship_line1),
          ship_line2 = coalesce(nullif(payload->>'shipLine2', ''), orders.ship_line2),
          ship_city = coalesce(nullif(payload->>'shipCity', ''), orders.ship_city),
          ship_state = coalesce(nullif(payload->>'shipState', ''), orders.ship_state),
          ship_postal = coalesce(nullif(payload->>'shipPostal', ''), orders.ship_postal),
          ship_country = coalesce(nullif(payload->>'shipCountry', ''), orders.ship_country)
      where orders.id = order_uuid;
    select * into current from chess_private.market_orders orders where orders.id = order_uuid;
  end if;
  if event_type in ('checkout.session.completed', 'checkout.session.async_payment_succeeded') and payload->>'paymentStatus' = 'paid' and order_uuid is not null then
    select orders.buyer_id, orders.seller_id into buyer, seller from chess_private.market_orders orders where orders.id = order_uuid;
    perform chess_private.market_order_move(order_uuid, 'paid', null, payload->>'paymentIntent');
    update chess_private.market_trades trades set status = 'paid'
      where trades.id = (select orders.trade_id from chess_private.market_orders orders where orders.id = order_uuid)
        and trades.status = 'awaiting_payment';
    perform chess_private.notification_put(buyer, seller, 'market_order', 'order:' || order_uuid::text, '/marketplace/?sales=1', 'Listing order', 'A Chess listing order was paid.');
  elsif event_type in ('checkout.session.async_payment_failed', 'checkout.session.expired', 'payment_intent.payment_failed') then
    if current.id is not null and current.status = 'pending' then
      begin
        perform chess_private.market_order_move(order_uuid, 'canceled', null, nullif(payload->>'paymentIntent', ''));
      exception when others then
        null;
      end;
    end if;
  elsif event_type = 'charge.refunded' and order_uuid is not null then
    refunded_amount := coalesce(nullif(payload->>'amountRefunded', '')::integer, 0);
    charge_amount := coalesce(nullif(payload->>'amount', '')::integer, current.total_cents);
    if refunded_amount > 0 and charge_amount > 0 and refunded_amount < charge_amount then
      update chess_private.market_orders orders
        set status = case when orders.status = 'disputed' then orders.status else 'partially_refunded' end,
            amount_refunded = refunded_amount
        where orders.id = order_uuid and orders.status in ('paid', 'shipped', 'partially_refunded', 'disputed');
    elsif refunded_amount >= charge_amount and charge_amount > 0 then
      perform chess_private.market_order_move(order_uuid, 'refunded', null, payload->>'paymentIntent');
      update chess_private.market_orders orders set amount_refunded = refunded_amount where orders.id = order_uuid;
    end if;
  elsif event_type = 'charge.dispute.created' and order_uuid is not null then
    update chess_private.market_orders orders
      set dispute_id = coalesce(nullif(payload->>'disputeId', ''), orders.dispute_id),
          dispute_status = coalesce(nullif(payload->>'disputeStatus', ''), 'open'),
          held_status = case when orders.status in ('paid', 'shipped', 'partially_refunded') then orders.status else orders.held_status end,
          status = case when orders.status in ('paid', 'shipped', 'partially_refunded') then 'disputed' else orders.status end
      where orders.id = order_uuid
      returning orders.seller_id into seller;
    perform chess_private.notification_put(null, seller, 'market_dispute', 'dispute:' || order_uuid::text, '/marketplace/?sales=1', 'Listing dispute', 'A Chess listing payment is disputed. Shipping is paused.');
    for admin_profile in
      select owners.profile_id from chess_private.admins admins
      join chess_private.profile_owners owners on owners.owner_id = admins.owner_id
    loop
      perform chess_private.notification_put(seller, admin_profile, 'market_dispute', 'dispute-admin:' || order_uuid::text, '/marketplace/?disputes=1', 'Listing dispute', 'A Chess listing payment is disputed.');
    end loop;
  elsif event_type = 'charge.dispute.updated' and order_uuid is not null then
    update chess_private.market_orders orders
      set dispute_status = coalesce(nullif(payload->>'disputeStatus', ''), orders.dispute_status)
      where orders.id = order_uuid;
  elsif event_type = 'charge.dispute.closed' and order_uuid is not null then
    outcome := coalesce(payload->>'disputeStatus', '');
    if outcome in ('won', 'warning_closed') then
      update chess_private.market_orders orders
        set status = coalesce(orders.held_status, 'paid'), dispute_status = outcome
        where orders.id = order_uuid and orders.status = 'disputed';
    elsif outcome = 'lost' then
      update chess_private.market_orders orders
        set dispute_status = 'lost', reversal_needed = true
        where orders.id = order_uuid
        returning orders.transfer_id into account_id;
      result := jsonb_build_object('orderId', order_uuid, 'reversalNeeded', true, 'reverseTransfer', nullif(account_id, ''));
    else
      update chess_private.market_orders orders set dispute_status = outcome where orders.id = order_uuid;
    end if;
  elsif event_type = 'account.updated' then
    account_id := payload->>'accountId';
    update chess_private.market_sellers sellers
      set transfers_active = coalesce((payload->>'transfersActive')::boolean, false),
          charges_enabled = coalesce((payload->>'chargesEnabled')::boolean, sellers.charges_enabled),
          payouts_enabled = coalesce((payload->>'payoutsEnabled')::boolean, false),
          details_submitted = coalesce((payload->>'detailsSubmitted')::boolean, false)
      where sellers.stripe_account_id = account_id;
  elsif event_type = 'account.application.deauthorized' then
    account_id := payload->>'accountId';
    update chess_private.market_sellers sellers
      set stripe_account_id = null, transfers_active = false, charges_enabled = false, payouts_enabled = false, details_submitted = false
      where sellers.stripe_account_id = account_id;
  end if;
  return result;
end;
$$;

commit;

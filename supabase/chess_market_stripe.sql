-- Harden marketplace payments: disputes, delayed payments, reservations, and shipping.
-- Apply once after supabase/chess_market.sql. Do not edit or reapply that file.

begin;

alter table chess_private.market_sellers
  add column transfers_active boolean not null default false;

alter table chess_private.market_orders
  add column held_status text,
  add column checkout_url text,
  add column transfer_id text,
  add column dispute_id text,
  add column dispute_status text,
  add column reversal_needed boolean not null default false,
  add column amount_refunded integer not null default 0,
  add column ship_name text,
  add column ship_line1 text,
  add column ship_line2 text,
  add column ship_city text,
  add column ship_state text,
  add column ship_postal text,
  add column ship_country text;

alter table chess_private.market_orders drop constraint chess_market_order_status;
alter table chess_private.market_orders add constraint chess_market_order_status
  check (status in ('pending', 'paid', 'shipped', 'refunded', 'partially_refunded', 'canceled', 'disputed'));

create unique index chess_market_open_checkout
  on chess_private.market_orders (buyer_id, listing_id)
  where status = 'pending' and trade_id is null;

create or replace function chess_private.notification_put(
  actor uuid,
  recipient uuid,
  event_kind text,
  event_key text,
  target_url text,
  event_title text,
  event_body text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if recipient is null or (actor is not null and actor = recipient) then
    return;
  end if;
  if event_kind not in (
    'direct_message', 'mention', 'your_turn', 'challenged',
    'game_result', 'challenge_accepted', 'challenge_declined', 'test',
    'market_offer', 'market_accepted', 'market_declined', 'market_order', 'market_shipped',
    'market_dispute'
  ) then
    return;
  end if;
  if target_url is null or left(target_url, 1) <> '/' or left(target_url, 2) = '//' then
    return;
  end if;
  insert into chess_private.notification_events (recipient_id, actor_id, kind, dedupe_key, url, title, body)
  values (recipient, actor, event_kind, event_key, target_url, left(coalesce(event_title, 'Chess'), 120), left(coalesce(event_body, ''), 180))
  on conflict (recipient_id, dedupe_key) do nothing;
end;
$$;

revoke all on function chess_private.notification_put(uuid, uuid, text, text, text, text, text) from public, anon, authenticated, chess_api, chess_server;

create or replace function chess_service.push_preference(raw_token text, expected uuid, event_kind text, enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
begin
  actor := chess_private.as_profile(raw_token);
  if expected is distinct from actor then
    raise exception 'You can play only as your own Chess profile.';
  end if;
  if event_kind not in (
    'direct_message', 'mention', 'your_turn', 'challenged',
    'game_result', 'challenge_accepted', 'challenge_declined',
    'market_offer', 'market_accepted', 'market_declined', 'market_order', 'market_shipped',
    'market_dispute'
  ) then
    raise exception 'That notification setting is not available.';
  end if;
  insert into chess_private.push_preferences (profile_id, kind, enabled)
  values (actor, event_kind, coalesce(enabled, true))
  on conflict (profile_id, kind) do update set enabled = excluded.enabled;
  return chess_service.push_settings(raw_token);
end;
$$;

create or replace function chess_service.push_settings(raw_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  result jsonb;
begin
  actor := chess_private.as_profile(raw_token);
  select coalesce(jsonb_object_agg(kinds.kind, coalesce(prefs.enabled, true)), '{}'::jsonb)
  into result
  from (
    values
      ('direct_message'), ('mention'), ('your_turn'), ('challenged'),
      ('game_result'), ('challenge_accepted'), ('challenge_declined'),
      ('market_offer'), ('market_accepted'), ('market_declined'), ('market_order'), ('market_shipped'),
      ('market_dispute')
  ) as kinds(kind)
  left join chess_private.push_preferences prefs
    on prefs.profile_id = actor and prefs.kind = kinds.kind;
  return result;
end;
$$;

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
    raise exception 'That order was not found.';
  end if;
  if current.status = next_status then
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

create or replace function chess_service.market_seller(raw_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  seller chess_private.market_sellers%rowtype;
begin
  actor := chess_private.as_profile(raw_token);
  select * into seller from chess_private.market_sellers sellers where sellers.profile_id = actor;
  return jsonb_build_object(
    'accountId', seller.stripe_account_id,
    'chargesEnabled', coalesce(seller.charges_enabled, false),
    'transfersActive', coalesce(seller.transfers_active, false),
    'detailsSubmitted', coalesce(seller.details_submitted, false),
    'ready', coalesce(seller.transfers_active, false)
  );
end;
$$;

create or replace function chess_service.market_order_open(raw_token text, listing_id uuid, next_quantity integer, fee_bps integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  listing public.chess_market_listings%rowtype;
  seller chess_private.market_sellers%rowtype;
  existing chess_private.market_orders%rowtype;
  saved uuid;
  fee integer;
  applied integer;
begin
  actor := chess_private.as_profile(raw_token);
  select * into listing from public.chess_market_listings listings where listings.id = listing_id and listings.status = 'active' for update;
  if not found then
    raise exception 'That listing was not found.';
  end if;
  if listing.seller_id = actor then
    raise exception 'You cannot buy your own listing.';
  end if;
  if listing.price_cents < 50 then
    raise exception 'Checkout not yet enabled';
  end if;
  select * into seller from chess_private.market_sellers sellers where sellers.profile_id = listing.seller_id;
  if seller.stripe_account_id is null or seller.transfers_active is not true then
    raise exception 'Checkout not yet enabled';
  end if;
  select * into existing
    from chess_private.market_orders orders
    where orders.buyer_id = actor and orders.listing_id = listing.id and orders.status = 'pending' and orders.trade_id is null
    for update;
  if found then
    return jsonb_build_object(
      'orderId', existing.id,
      'title', listing.title,
      'quantity', existing.quantity,
      'unitCents', existing.unit_cents,
      'feeCents', existing.fee_cents,
      'destination', seller.stripe_account_id,
      'fulfillment', existing.fulfillment,
      'sessionId', existing.stripe_session_id,
      'checkoutUrl', existing.checkout_url,
      'reused', true
    );
  end if;
  if next_quantity is null or next_quantity < 1 or next_quantity > listing.quantity or next_quantity > 99 then
    raise exception 'That listing does not have enough left.';
  end if;
  applied := least(10000, greatest(coalesce(fee_bps, 500), 0));
  fee := (listing.price_cents * next_quantity * applied) / 10000;
  update public.chess_market_listings listings
    set quantity = listings.quantity - next_quantity, updated_at = clock_timestamp()
    where listings.id = listing.id and listings.quantity >= next_quantity;
  if not found then
    raise exception 'That listing does not have enough left.';
  end if;
  insert into chess_private.market_orders (
    listing_id, buyer_id, seller_id, quantity, unit_cents, fee_cents, total_cents, status, fulfillment, quantity_adjusted
  ) values (
    listing.id, actor, listing.seller_id, next_quantity, listing.price_cents, fee, listing.price_cents * next_quantity, 'pending', listing.fulfillment, true
  ) returning id into saved;
  return jsonb_build_object(
    'orderId', saved,
    'title', listing.title,
    'quantity', next_quantity,
    'unitCents', listing.price_cents,
    'feeCents', fee,
    'destination', seller.stripe_account_id,
    'fulfillment', listing.fulfillment,
    'reused', false
  );
end;
$$;

create function chess_service.market_checkout_bind(order_id uuid, session_id text, checkout_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if session_id is null or left(session_id, 3) <> 'cs_' or char_length(session_id) > 80 then
    raise exception 'Checkout could not start.';
  end if;
  update chess_private.market_orders orders
    set stripe_session_id = session_id,
        checkout_url = coalesce(nullif(checkout_url, ''), orders.checkout_url)
    where orders.id = order_id and orders.status = 'pending' and (orders.stripe_session_id is null or orders.stripe_session_id = session_id);
end;
$$;

create or replace function chess_service.market_ship(raw_token text, order_id uuid, tracking text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  current chess_private.market_orders%rowtype;
begin
  actor := chess_private.as_profile(raw_token);
  select * into current from chess_private.market_orders orders where orders.id = order_id and orders.seller_id = actor;
  if not found then
    raise exception 'That order was not found.';
  end if;
  if current.status = 'disputed' then
    raise exception 'That order is not ready to ship.';
  end if;
  if current.status not in ('paid', 'partially_refunded') then
    raise exception 'That order is not ready to ship.';
  end if;
  perform chess_private.market_order_move(current.id, 'shipped', tracking, null);
  perform chess_private.notification_put(actor, current.buyer_id, 'market_shipped', 'shipped:' || current.id::text, '/marketplace/?orders=1', 'Order shipped', 'A seller marked your Chess marketplace order shipped.');
  return jsonb_build_object('id', current.id, 'status', 'shipped');
end;
$$;

create or replace function chess_service.market_orders(raw_token text, side text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  result jsonb;
begin
  actor := chess_private.as_profile(raw_token);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', orders.id,
    'listingId', orders.listing_id,
    'title', listings.title,
    'quantity', orders.quantity,
    'totalCents', orders.total_cents,
    'status', orders.status,
    'tracking', orders.tracking,
    'fulfillment', orders.fulfillment,
    'shipName', orders.ship_name,
    'shipLine1', orders.ship_line1,
    'shipCity', orders.ship_city,
    'shipState', orders.ship_state,
    'shipPostal', orders.ship_postal,
    'shipCountry', orders.ship_country,
    'disputeStatus', orders.dispute_status
  ) order by orders.created_at desc), '[]'::jsonb)
  into result
  from chess_private.market_orders orders
  join public.chess_market_listings listings on listings.id = orders.listing_id
  where (side = 'sales' and orders.seller_id = actor) or (side is distinct from 'sales' and orders.buyer_id = actor);
  return result;
end;
$$;

create or replace function chess_service.market_trade_answer(raw_token text, trade_id uuid, accept boolean, fee_bps integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  trade chess_private.market_trades%rowtype;
  requested public.chess_market_listings%rowtype;
  order_id uuid;
  payer uuid;
  payee uuid;
  seller chess_private.market_sellers%rowtype;
begin
  actor := chess_private.as_profile(raw_token);
  select * into trade from chess_private.market_trades trades where trades.id = trade_id for update;
  if not found or trade.status <> 'offered' then
    raise exception 'That trade is no longer open.';
  end if;
  select * into requested from public.chess_market_listings listings where listings.id = trade.requested_listing_id;
  if requested.seller_id is distinct from actor then
    raise exception 'That trade is no longer open.';
  end if;
  if accept is not true then
    update chess_private.market_trades trades set status = 'declined' where trades.id = trade.id;
    perform chess_private.notification_put(actor, trade.offerer_id, 'market_declined', 'trade-no:' || trade.id::text, '/marketplace/?listing=' || trade.offered_listing_id::text, 'Trade declined', 'Your Chess marketplace trade was declined.');
    return jsonb_build_object('id', trade.id, 'status', 'declined');
  end if;
  if trade.cash_cents = 0 or trade.cash_payer = 'none' then
    update chess_private.market_trades trades set status = 'accepted' where trades.id = trade.id;
    perform chess_private.notification_put(actor, trade.offerer_id, 'market_accepted', 'trade-yes:' || trade.id::text, '/marketplace/?listing=' || trade.requested_listing_id::text, 'Trade accepted', 'Your Chess marketplace trade was accepted.');
    return jsonb_build_object('id', trade.id, 'status', 'accepted');
  end if;
  payer := case when trade.cash_payer = 'offerer' then trade.offerer_id else actor end;
  payee := case when trade.cash_payer = 'offerer' then actor else trade.offerer_id end;
  select * into seller from chess_private.market_sellers sellers where sellers.profile_id = payee;
  if seller.transfers_active is not true then
    raise exception 'Checkout not yet enabled';
  end if;
  insert into chess_private.market_orders (listing_id, buyer_id, seller_id, quantity, unit_cents, fee_cents, total_cents, status, fulfillment, trade_id, quantity_adjusted)
  values (
    trade.requested_listing_id, payer, payee, 1, trade.cash_cents,
    (trade.cash_cents * least(10000, greatest(coalesce(fee_bps, 500), 0))) / 10000,
    trade.cash_cents, 'pending', 'shipping', trade.id, false
  )
  returning id into order_id;
  update chess_private.market_trades trades set status = 'awaiting_payment' where trades.id = trade.id;
  perform chess_private.notification_put(actor, trade.offerer_id, 'market_accepted', 'trade-yes:' || trade.id::text, '/marketplace/?trades=1', 'Trade accepted', 'Your Chess marketplace trade was accepted. Cash still needs checkout.');
  return jsonb_build_object('id', trade.id, 'status', 'awaiting_payment', 'orderId', order_id, 'payerId', payer);
end;
$$;

create function chess_service.market_trade_checkout(raw_token text, trade_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  trade chess_private.market_trades%rowtype;
  current chess_private.market_orders%rowtype;
  seller chess_private.market_sellers%rowtype;
begin
  actor := chess_private.as_profile(raw_token);
  select * into trade from chess_private.market_trades trades where trades.id = trade_id;
  if not found or trade.status <> 'awaiting_payment' then
    raise exception 'That trade is no longer open.';
  end if;
  select * into current from chess_private.market_orders orders
    where orders.trade_id = trade.id and orders.status = 'pending' and orders.buyer_id = actor;
  if not found then
    raise exception 'That order was not found.';
  end if;
  select * into seller from chess_private.market_sellers sellers where sellers.profile_id = current.seller_id;
  if seller.transfers_active is not true then
    raise exception 'Checkout not yet enabled';
  end if;
  return jsonb_build_object(
    'orderId', current.id,
    'title', 'Trade cash',
    'quantity', 1,
    'unitCents', current.unit_cents,
    'feeCents', current.fee_cents,
    'destination', seller.stripe_account_id,
    'fulfillment', 'shipping',
    'sessionId', current.stripe_session_id,
    'checkoutUrl', current.checkout_url,
    'reused', current.stripe_session_id is not null
  );
end;
$$;

create function chess_service.market_trades(raw_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  result jsonb;
begin
  actor := chess_private.as_profile(raw_token);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', trades.id,
    'status', trades.status,
    'cashCents', trades.cash_cents,
    'cashPayer', trades.cash_payer,
    'offeredId', trades.offered_listing_id,
    'requestedId', trades.requested_listing_id,
    'mine', trades.offerer_id = actor,
    'orderId', orders.id,
    'canPay', orders.buyer_id = actor and orders.status = 'pending'
  ) order by trades.created_at desc), '[]'::jsonb)
  into result
  from chess_private.market_trades trades
  left join chess_private.market_orders orders on orders.trade_id = trades.id and orders.status = 'pending'
  left join public.chess_market_listings requested on requested.id = trades.requested_listing_id
  where trades.offerer_id = actor or requested.seller_id = actor;
  return result;
end;
$$;

create function chess_service.market_disputes(raw_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  result jsonb;
begin
  actor := chess_private.as_profile(raw_token);
  if not chess_private.profile_is_admin(actor) then
    raise exception 'Only an admin can hide this.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', orders.id,
    'title', listings.title,
    'status', orders.status,
    'disputeId', orders.dispute_id,
    'disputeStatus', orders.dispute_status,
    'reversalNeeded', orders.reversal_needed,
    'totalCents', orders.total_cents,
    'sellerId', orders.seller_id
  ) order by orders.created_at desc), '[]'::jsonb)
  into result
  from chess_private.market_orders orders
  join public.chess_market_listings listings on listings.id = orders.listing_id
  where orders.dispute_id is not null or orders.status = 'disputed' or orders.reversal_needed;
  return result;
end;
$$;

create function chess_service.market_reversal_note(order_id uuid, done boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update chess_private.market_orders orders
    set reversal_needed = done is not true
    where orders.id = order_id;
end;
$$;

drop function chess_service.market_stripe_apply(text, text, jsonb);

create function chess_service.market_stripe_apply(event_id text, event_type text, payload jsonb)
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
  if order_uuid is not null then
    update chess_private.market_orders orders
      set transfer_id = coalesce(nullif(payload->>'transferId', ''), orders.transfer_id),
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
  elsif event_type in ('checkout.session.async_payment_failed', 'checkout.session.expired', 'payment_intent.payment_failed') and order_uuid is not null then
    perform chess_private.market_order_move(order_uuid, 'canceled', null, payload->>'paymentIntent');
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

revoke all on function chess_service.market_checkout_bind(uuid, text, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_trade_checkout(text, uuid) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_trades(text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_disputes(text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_reversal_note(uuid, boolean) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_stripe_apply(text, text, jsonb) from public, anon, authenticated, chess_api;

grant execute on function chess_service.market_checkout_bind(uuid, text, text) to chess_server;
grant execute on function chess_service.market_trade_checkout(text, uuid) to chess_server;
grant execute on function chess_service.market_trades(text) to chess_server;
grant execute on function chess_service.market_disputes(text) to chess_server;
grant execute on function chess_service.market_reversal_note(uuid, boolean) to chess_server;
grant execute on function chess_service.market_stripe_apply(text, text, jsonb) to chess_server;

commit;

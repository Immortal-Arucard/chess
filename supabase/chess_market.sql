-- Chess marketplace: listings, photos, orders, trades, and reports.
-- Apply once after supabase/chess_push.sql and supabase/chess_private_execute.sql.
-- Do not edit or reapply those files.

begin;

create table public.chess_market_listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.chess_profiles (id) on delete cascade,
  title text not null,
  description text not null,
  category text not null,
  condition text not null,
  price_cents integer not null,
  quantity integer not null,
  fulfillment text not null,
  location text not null default '',
  open_to_trades boolean not null default false,
  status text not null default 'active',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint chess_market_category check (category in ('boards', 'sets', 'clocks', 'books', 'art', 'apparel', 'lessons', 'digital')),
  constraint chess_market_condition check (condition in ('new', 'like_new', 'good', 'fair', 'digital')),
  constraint chess_market_fulfillment check (fulfillment in ('shipping', 'pickup', 'digital')),
  constraint chess_market_status check (status in ('active', 'hidden', 'removed')),
  constraint chess_market_price check (price_cents >= 0 and price_cents <= 100000000),
  constraint chess_market_quantity check (quantity >= 0 and quantity <= 999),
  constraint chess_market_title check (char_length(title) between 1 and 80),
  constraint chess_market_description check (char_length(description) between 1 and 4000),
  constraint chess_market_location check (char_length(location) <= 80)
);

revoke all on table public.chess_market_listings from public, anon, authenticated, chess_api, chess_server;
grant select on table public.chess_market_listings to anon, authenticated;
alter table public.chess_market_listings enable row level security;
alter table public.chess_market_listings force row level security;

create policy chess_market_listings_active on public.chess_market_listings
  for select to anon, authenticated
  using (status = 'active');

create table chess_private.market_sellers (
  profile_id uuid primary key references public.chess_profiles (id) on delete cascade,
  stripe_account_id text unique,
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false
);

create table chess_private.market_photos (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.chess_market_listings (id) on delete cascade,
  mime text not null,
  bytes bytea not null,
  sort_order integer not null default 0
);

create table chess_private.market_orders (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.chess_market_listings (id),
  buyer_id uuid not null references public.chess_profiles (id),
  seller_id uuid not null references public.chess_profiles (id),
  quantity integer not null,
  unit_cents integer not null,
  fee_cents integer not null,
  total_cents integer not null,
  status text not null,
  stripe_session_id text unique,
  stripe_payment_intent text,
  fulfillment text not null,
  tracking text,
  shipped_at timestamptz,
  trade_id uuid,
  quantity_adjusted boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  constraint chess_market_order_status check (status in ('pending', 'paid', 'shipped', 'refunded', 'canceled')),
  constraint chess_market_order_quantity check (quantity between 1 and 99)
);

create table chess_private.market_trades (
  id uuid primary key default gen_random_uuid(),
  offerer_id uuid not null references public.chess_profiles (id),
  offered_listing_id uuid not null references public.chess_market_listings (id),
  requested_listing_id uuid not null references public.chess_market_listings (id),
  cash_cents integer not null default 0,
  cash_payer text not null default 'none',
  status text not null default 'offered',
  created_at timestamptz not null default clock_timestamp(),
  constraint chess_market_trade_status check (status in ('offered', 'declined', 'accepted', 'awaiting_payment', 'paid', 'canceled')),
  constraint chess_market_trade_payer check (cash_payer in ('none', 'offerer', 'owner')),
  constraint chess_market_trade_cash check (cash_cents >= 0 and cash_cents <= 100000000)
);

create table chess_private.market_reports (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.chess_market_listings (id) on delete cascade,
  reporter_id uuid not null references public.chess_profiles (id),
  reason text not null,
  note text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  unique (listing_id, reporter_id),
  constraint chess_market_report_reason check (reason in ('not_chess', 'scam', 'other'))
);

create table chess_private.market_stripe_events (
  event_id text primary key,
  applied_at timestamptz not null default clock_timestamp()
);

revoke all on table chess_private.market_sellers from public, anon, authenticated, chess_api, chess_server;
revoke all on table chess_private.market_photos from public, anon, authenticated, chess_api, chess_server;
revoke all on table chess_private.market_orders from public, anon, authenticated, chess_api, chess_server;
revoke all on table chess_private.market_trades from public, anon, authenticated, chess_api, chess_server;
revoke all on table chess_private.market_reports from public, anon, authenticated, chess_api, chess_server;
revoke all on table chess_private.market_stripe_events from public, anon, authenticated, chess_api, chess_server;

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
    'market_offer', 'market_accepted', 'market_declined', 'market_order', 'market_shipped'
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
    'market_offer', 'market_accepted', 'market_declined', 'market_order', 'market_shipped'
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
      ('market_offer'), ('market_accepted'), ('market_declined'), ('market_order'), ('market_shipped')
  ) as kinds(kind)
  left join chess_private.push_preferences prefs
    on prefs.profile_id = actor and prefs.kind = kinds.kind;
  return result;
end;
$$;

create function chess_private.market_order_move(order_uuid uuid, next_status text, next_tracking text, payment_intent text)
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
    if current.trade_id is null then
      update public.chess_market_listings listings
        set quantity = listings.quantity - current.quantity, updated_at = clock_timestamp()
        where listings.id = current.listing_id and listings.quantity >= current.quantity;
      if not found then
        raise exception 'That listing does not have enough left.';
      end if;
    end if;
    update chess_private.market_orders orders
      set status = 'paid',
          quantity_adjusted = current.trade_id is null,
          stripe_payment_intent = coalesce(payment_intent, orders.stripe_payment_intent)
      where orders.id = current.id;
  elsif next_status = 'shipped' and current.status = 'paid' then
    update chess_private.market_orders orders
      set status = 'shipped', tracking = nullif(left(coalesce(next_tracking, ''), 80), ''), shipped_at = clock_timestamp()
      where orders.id = current.id;
  elsif next_status = 'refunded' and current.status in ('paid', 'shipped') then
    if current.quantity_adjusted then
      update public.chess_market_listings listings
        set quantity = least(999, listings.quantity + current.quantity), updated_at = clock_timestamp()
        where listings.id = current.listing_id;
    end if;
    update chess_private.market_orders orders
      set status = 'refunded', quantity_adjusted = false
      where orders.id = current.id;
  elsif next_status = 'canceled' and current.status = 'pending' then
    update chess_private.market_orders orders set status = 'canceled' where orders.id = current.id;
  else
    raise exception 'That order cannot change.';
  end if;
end;
$$;

revoke all on function chess_private.market_order_move(uuid, text, text, text) from public, anon, authenticated, chess_api, chess_server;

create function chess_service.market_save(
  raw_token text,
  listing_id uuid,
  next_title text,
  next_description text,
  next_category text,
  next_condition text,
  next_price integer,
  next_quantity integer,
  next_fulfillment text,
  next_location text,
  next_trades boolean
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  saved uuid;
begin
  actor := chess_private.as_profile(raw_token);
  if next_category not in ('boards', 'sets', 'clocks', 'books', 'art', 'apparel', 'lessons', 'digital') then
    raise exception 'Choose a chess category.';
  end if;
  if next_condition not in ('new', 'like_new', 'good', 'fair', 'digital') then
    raise exception 'Choose a condition.';
  end if;
  if next_fulfillment not in ('shipping', 'pickup', 'digital') then
    raise exception 'Choose shipping, pickup, or digital.';
  end if;
  if next_title is null or char_length(btrim(next_title)) < 1 or char_length(next_title) > 80 then
    raise exception 'Enter a title of 1 to 80 characters.';
  end if;
  if next_description is null or char_length(btrim(next_description)) < 1 or char_length(next_description) > 4000 then
    raise exception 'Enter a description of 1 to 4000 characters.';
  end if;
  if next_price is null or next_price < 0 or next_price > 100000000 or next_quantity is null or next_quantity < 1 or next_quantity > 999 then
    raise exception 'Enter a price and a quantity.';
  end if;
  if next_fulfillment in ('shipping', 'pickup') and char_length(btrim(coalesce(next_location, ''))) < 2 then
    raise exception 'Enter a city or region.';
  end if;
  if char_length(coalesce(next_location, '')) > 80 then
    raise exception 'Enter a city or region.';
  end if;
  if listing_id is null then
    insert into public.chess_market_listings (seller_id, title, description, category, condition, price_cents, quantity, fulfillment, location, open_to_trades)
    values (actor, btrim(next_title), btrim(next_description), next_category, next_condition, next_price, next_quantity, next_fulfillment, btrim(coalesce(next_location, '')), coalesce(next_trades, false))
    returning id into saved;
  else
    update public.chess_market_listings listings
      set title = btrim(next_title), description = btrim(next_description), category = next_category,
          condition = next_condition, price_cents = next_price, quantity = next_quantity,
          fulfillment = next_fulfillment, location = btrim(coalesce(next_location, '')),
          open_to_trades = coalesce(next_trades, false), updated_at = clock_timestamp()
      where listings.id = listing_id and listings.seller_id = actor and listings.status <> 'removed'
      returning listings.id into saved;
    if saved is null then
      raise exception 'That listing was not found.';
    end if;
  end if;
  return chess_service.market_listing(raw_token, saved);
end;
$$;

create function chess_service.market_listing(raw_token text, listing_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  row public.chess_market_listings%rowtype;
  seller_name text;
  photos jsonb;
begin
  begin
    actor := chess_private.as_profile(raw_token);
  exception when others then
    actor := null;
  end;
  select * into row from public.chess_market_listings listings where listings.id = listing_id;
  if not found then
    return null;
  end if;
  if row.status <> 'active' and actor is distinct from row.seller_id and not chess_private.profile_is_admin(actor) then
    return null;
  end if;
  select profiles.display_name into seller_name from public.chess_profiles profiles where profiles.id = row.seller_id;
  select coalesce(jsonb_agg(jsonb_build_object('id', photos.id, 'mime', photos.mime) order by photos.sort_order, photos.id), '[]'::jsonb)
    into photos
    from chess_private.market_photos photos
    where photos.listing_id = row.id;
  return jsonb_build_object(
    'id', row.id,
    'sellerId', row.seller_id,
    'sellerName', coalesce(seller_name, 'Chess member'),
    'title', row.title,
    'description', row.description,
    'category', row.category,
    'condition', row.condition,
    'priceCents', row.price_cents,
    'quantity', row.quantity,
    'fulfillment', row.fulfillment,
    'location', row.location,
    'openToTrades', row.open_to_trades,
    'status', row.status,
    'photos', photos,
    'mine', actor is not distinct from row.seller_id
  );
end;
$$;

create function chess_service.market_search(raw_query text, raw_category text, raw_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
  capped integer := least(greatest(coalesce(raw_limit, 20), 1), 30);
begin
  if raw_category is not null and raw_category <> '' and raw_category not in ('boards', 'sets', 'clocks', 'books', 'art', 'apparel', 'lessons', 'digital') then
    raise exception 'Choose a chess category.';
  end if;
  select coalesce(jsonb_agg(item), '[]'::jsonb) into result from (
    select jsonb_build_object(
      'id', listings.id,
      'title', listings.title,
      'category', listings.category,
      'priceCents', listings.price_cents,
      'quantity', listings.quantity,
      'fulfillment', listings.fulfillment,
      'location', listings.location,
      'openToTrades', listings.open_to_trades,
      'sellerName', profiles.display_name
    ) as item
    from public.chess_market_listings listings
    join public.chess_profiles profiles on profiles.id = listings.seller_id
    where listings.status = 'active'
      and (raw_category is null or raw_category = '' or listings.category = raw_category)
      and (
        raw_query is null or btrim(raw_query) = ''
        or listings.title ilike '%' || replace(replace(btrim(raw_query), '%', ''), '_', '') || '%'
        or listings.description ilike '%' || replace(replace(btrim(raw_query), '%', ''), '_', '') || '%'
      )
    order by listings.created_at desc
    limit capped
  ) found;
  return result;
end;
$$;

create function chess_service.market_photo_add(raw_token text, listing_id uuid, mime text, bytes bytea)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  saved uuid;
  next_sort integer;
begin
  actor := chess_private.as_profile(raw_token);
  if mime not in ('image/jpeg', 'image/png', 'image/webp') or bytes is null or octet_length(bytes) < 16 or octet_length(bytes) > 524288 then
    raise exception 'Use a JPEG, PNG, or WebP image up to 512 KB.';
  end if;
  if not exists (select 1 from public.chess_market_listings listings where listings.id = listing_id and listings.seller_id = actor and listings.status <> 'removed') then
    raise exception 'That listing was not found.';
  end if;
  if (select count(*) from chess_private.market_photos photos where photos.listing_id = market_photo_add.listing_id) >= 4 then
    raise exception 'A listing can have at most 4 photos.';
  end if;
  select coalesce(max(photos.sort_order), 0) + 1 into next_sort from chess_private.market_photos photos where photos.listing_id = market_photo_add.listing_id;
  insert into chess_private.market_photos (listing_id, mime, bytes, sort_order)
  values (listing_id, mime, bytes, next_sort)
  returning id into saved;
  return saved;
end;
$$;

create function chess_service.market_photo(photo_id uuid)
returns table (mime text, bytes bytea)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select photos.mime, photos.bytes
  from chess_private.market_photos photos
  join public.chess_market_listings listings on listings.id = photos.listing_id
  where photos.id = photo_id and listings.status = 'active';
end;
$$;

create function chess_service.market_report(raw_token text, listing_id uuid, reason text, note text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  saved uuid;
begin
  actor := chess_private.as_profile(raw_token);
  if reason not in ('not_chess', 'scam', 'other') then
    raise exception 'Choose a report reason.';
  end if;
  if not exists (select 1 from public.chess_market_listings listings where listings.id = listing_id and listings.status = 'active') then
    raise exception 'That listing was not found.';
  end if;
  insert into chess_private.market_reports (listing_id, reporter_id, reason, note)
  values (listing_id, actor, reason, left(coalesce(note, ''), 500))
  on conflict (listing_id, reporter_id) do update set reason = excluded.reason, note = excluded.note
  returning id into saved;
  return saved;
end;
$$;

create function chess_service.market_moderate(raw_token text, listing_id uuid, action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
begin
  actor := chess_private.as_profile(raw_token);
  if not chess_private.profile_is_admin(actor) then
    raise exception 'Only an admin can hide this.';
  end if;
  if action = 'hide' then
    update public.chess_market_listings listings set status = 'hidden', updated_at = clock_timestamp() where listings.id = listing_id and listings.status = 'active';
  elsif action = 'remove' then
    update public.chess_market_listings listings set status = 'removed', updated_at = clock_timestamp() where listings.id = listing_id and listings.status <> 'removed';
  elsif action = 'restore' then
    update public.chess_market_listings listings set status = 'active', updated_at = clock_timestamp() where listings.id = listing_id and listings.status = 'hidden';
  else
    raise exception 'Choose hide, remove, or restore.';
  end if;
  if not found then
    raise exception 'That listing was not found.';
  end if;
  return chess_service.market_listing(raw_token, listing_id);
end;
$$;

create function chess_service.market_queue(raw_token text)
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
    'id', listings.id,
    'title', listings.title,
    'status', listings.status,
    'category', listings.category,
    'reports', (select count(*) from chess_private.market_reports reports where reports.listing_id = listings.id)
  ) order by listings.updated_at desc), '[]'::jsonb)
  into result
  from public.chess_market_listings listings
  where listings.status <> 'removed'
    and exists (select 1 from chess_private.market_reports reports where reports.listing_id = listings.id);
  return result;
end;
$$;

create function chess_service.market_config(raw_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
begin
  begin
    actor := chess_private.as_profile(raw_token);
  exception when others then
    actor := null;
  end;
  return jsonb_build_object('admin', actor is not null and chess_private.profile_is_admin(actor), 'profileId', actor);
end;
$$;

create function chess_service.market_seller_set(raw_token text, account_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
begin
  actor := chess_private.as_profile(raw_token);
  if account_id is null or left(account_id, 5) <> 'acct_' or char_length(account_id) > 64 then
    raise exception 'Checkout could not start.';
  end if;
  insert into chess_private.market_sellers (profile_id, stripe_account_id)
  values (actor, account_id)
  on conflict (profile_id) do update set stripe_account_id = excluded.stripe_account_id
  where chess_private.market_sellers.stripe_account_id is null;
end;
$$;

create function chess_service.market_seller(raw_token text)
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
    'detailsSubmitted', coalesce(seller.details_submitted, false)
  );
end;
$$;

create function chess_service.market_order_open(raw_token text, listing_id uuid, next_quantity integer, fee_bps integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  listing public.chess_market_listings%rowtype;
  seller chess_private.market_sellers%rowtype;
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
  if next_quantity is null or next_quantity < 1 or next_quantity > listing.quantity or next_quantity > 99 then
    raise exception 'That listing does not have enough left.';
  end if;
  select * into seller from chess_private.market_sellers sellers where sellers.profile_id = listing.seller_id;
  if seller.stripe_account_id is null or seller.charges_enabled is not true then
    raise exception 'Checkout not yet enabled';
  end if;
  applied := least(10000, greatest(coalesce(fee_bps, 0), 0));
  fee := (listing.price_cents * next_quantity * applied) / 10000;
  insert into chess_private.market_orders (listing_id, buyer_id, seller_id, quantity, unit_cents, fee_cents, total_cents, status, fulfillment)
  values (listing.id, actor, listing.seller_id, next_quantity, listing.price_cents, fee, listing.price_cents * next_quantity, 'pending', listing.fulfillment)
  returning id into saved;
  return jsonb_build_object(
    'orderId', saved,
    'title', listing.title,
    'quantity', next_quantity,
    'unitCents', listing.price_cents,
    'feeCents', fee,
    'destination', seller.stripe_account_id
  );
end;
$$;

create function chess_service.market_order_session(order_id uuid, session_id text)
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
    set stripe_session_id = session_id
    where orders.id = order_id and orders.status = 'pending' and orders.stripe_session_id is null;
end;
$$;

create function chess_service.market_ship(raw_token text, order_id uuid, tracking text)
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
  if current.status <> 'paid' then
    raise exception 'That order is not ready to ship.';
  end if;
  perform chess_private.market_order_move(current.id, 'shipped', tracking, null);
  perform chess_private.notification_put(actor, current.buyer_id, 'market_shipped', 'shipped:' || current.id::text, '/marketplace/?orders=1', 'Order shipped', 'A seller marked your Chess marketplace order shipped.');
  return jsonb_build_object('id', current.id, 'status', 'shipped');
end;
$$;

create function chess_service.market_orders(raw_token text, side text)
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
    'fulfillment', orders.fulfillment
  ) order by orders.created_at desc), '[]'::jsonb)
  into result
  from chess_private.market_orders orders
  join public.chess_market_listings listings on listings.id = orders.listing_id
  where (side = 'sales' and orders.seller_id = actor) or (side is distinct from 'sales' and orders.buyer_id = actor);
  return result;
end;
$$;

create function chess_service.market_trade_offer(raw_token text, offered_id uuid, requested_id uuid, cash_cents integer, cash_payer text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  offered public.chess_market_listings%rowtype;
  requested public.chess_market_listings%rowtype;
  saved uuid;
  payer text := coalesce(cash_payer, 'none');
begin
  actor := chess_private.as_profile(raw_token);
  select * into offered from public.chess_market_listings listings where listings.id = offered_id and listings.status = 'active';
  select * into requested from public.chess_market_listings listings where listings.id = requested_id and listings.status = 'active';
  if offered.id is null or requested.id is null then
    raise exception 'That listing was not found.';
  end if;
  if offered.seller_id is distinct from actor then
    raise exception 'Offer a listing of your own.';
  end if;
  if requested.seller_id = actor or requested.open_to_trades is not true then
    raise exception 'That listing is not open to trades.';
  end if;
  if payer not in ('none', 'offerer', 'owner') or coalesce(cash_cents, 0) < 0 or coalesce(cash_cents, 0) > 100000000 then
    raise exception 'Enter the cash for this trade.';
  end if;
  if payer = 'none' and coalesce(cash_cents, 0) <> 0 then
    raise exception 'Enter the cash for this trade.';
  end if;
  if payer <> 'none' and coalesce(cash_cents, 0) < 50 then
    raise exception 'Enter the cash for this trade.';
  end if;
  insert into chess_private.market_trades (offerer_id, offered_listing_id, requested_listing_id, cash_cents, cash_payer)
  values (actor, offered.id, requested.id, coalesce(cash_cents, 0), payer)
  returning id into saved;
  perform chess_private.notification_put(actor, requested.seller_id, 'market_offer', 'trade:' || saved::text, '/marketplace/?listing=' || requested.id::text, 'Trade offer', 'Someone offered a trade on your Chess listing.');
  return jsonb_build_object('id', saved, 'status', 'offered');
end;
$$;

create function chess_service.market_trade_answer(raw_token text, trade_id uuid, accept boolean, fee_bps integer)
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
  if seller.charges_enabled is not true then
    raise exception 'Checkout not yet enabled';
  end if;
  insert into chess_private.market_orders (listing_id, buyer_id, seller_id, quantity, unit_cents, fee_cents, total_cents, status, fulfillment, trade_id)
  values (
    trade.requested_listing_id, payer, payee, 1, trade.cash_cents,
    (trade.cash_cents * least(10000, greatest(coalesce(fee_bps, 0), 0))) / 10000,
    trade.cash_cents, 'pending', 'shipping', trade.id
  )
  returning id into order_id;
  update chess_private.market_trades trades set status = 'awaiting_payment' where trades.id = trade.id;
  perform chess_private.notification_put(actor, trade.offerer_id, 'market_accepted', 'trade-yes:' || trade.id::text, '/marketplace/?listing=' || trade.requested_listing_id::text, 'Trade accepted', 'Your Chess marketplace trade was accepted. Cash still needs checkout.');
  return jsonb_build_object('id', trade.id, 'status', 'awaiting_payment', 'orderId', order_id, 'payerId', payer);
end;
$$;

create function chess_service.market_stripe_apply(event_id text, event_type text, payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_uuid uuid;
  account_id text;
  buyer uuid;
  seller uuid;
begin
  if event_id is null or char_length(event_id) < 3 or char_length(event_id) > 80 then
    return;
  end if;
  insert into chess_private.market_stripe_events (event_id) values (event_id) on conflict do nothing;
  if not found then
    return;
  end if;
  if event_type = 'checkout.session.completed' and payload->>'paymentStatus' = 'paid' then
    order_uuid := nullif(payload->>'orderId', '')::uuid;
    select orders.buyer_id, orders.seller_id into buyer, seller from chess_private.market_orders orders where orders.id = order_uuid;
    perform chess_private.market_order_move(order_uuid, 'paid', null, payload->>'paymentIntent');
    update chess_private.market_trades trades set status = 'paid'
      where trades.id = (select orders.trade_id from chess_private.market_orders orders where orders.id = order_uuid)
        and trades.status = 'awaiting_payment';
    perform chess_private.notification_put(buyer, seller, 'market_order', 'order:' || order_uuid::text, '/marketplace/?sales=1', 'Marketplace order', 'A Chess marketplace order was paid.');
  elsif event_type = 'charge.refunded' then
    order_uuid := nullif(payload->>'orderId', '')::uuid;
    if order_uuid is null and payload->>'paymentIntent' is not null then
      select orders.id into order_uuid from chess_private.market_orders orders where orders.stripe_payment_intent = payload->>'paymentIntent';
    end if;
    perform chess_private.market_order_move(order_uuid, 'refunded', null, payload->>'paymentIntent');
  elsif event_type = 'account.updated' then
    account_id := payload->>'accountId';
    update chess_private.market_sellers sellers
      set charges_enabled = coalesce((payload->>'chargesEnabled')::boolean, false),
          payouts_enabled = coalesce((payload->>'payoutsEnabled')::boolean, false),
          details_submitted = coalesce((payload->>'detailsSubmitted')::boolean, false)
      where sellers.stripe_account_id = account_id;
  end if;
end;
$$;

revoke all on function chess_service.market_save(text, uuid, text, text, text, text, integer, integer, text, text, boolean) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_listing(text, uuid) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_search(text, text, integer) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_photo_add(text, uuid, text, bytea) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_photo(uuid) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_report(text, uuid, text, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_moderate(text, uuid, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_queue(text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_config(text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_seller_set(text, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_seller(text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_order_open(text, uuid, integer, integer) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_order_session(uuid, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_ship(text, uuid, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_orders(text, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_trade_offer(text, uuid, uuid, integer, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_trade_answer(text, uuid, boolean, integer) from public, anon, authenticated, chess_api;
revoke all on function chess_service.market_stripe_apply(text, text, jsonb) from public, anon, authenticated, chess_api;

grant execute on function chess_service.market_save(text, uuid, text, text, text, text, integer, integer, text, text, boolean) to chess_server;
grant execute on function chess_service.market_listing(text, uuid) to chess_server;
grant execute on function chess_service.market_search(text, text, integer) to chess_server;
grant execute on function chess_service.market_photo_add(text, uuid, text, bytea) to chess_server;
grant execute on function chess_service.market_photo(uuid) to chess_server;
grant execute on function chess_service.market_report(text, uuid, text, text) to chess_server;
grant execute on function chess_service.market_moderate(text, uuid, text) to chess_server;
grant execute on function chess_service.market_queue(text) to chess_server;
grant execute on function chess_service.market_config(text) to chess_server;
grant execute on function chess_service.market_seller_set(text, text) to chess_server;
grant execute on function chess_service.market_seller(text) to chess_server;
grant execute on function chess_service.market_order_open(text, uuid, integer, integer) to chess_server;
grant execute on function chess_service.market_order_session(uuid, text) to chess_server;
grant execute on function chess_service.market_ship(text, uuid, text) to chess_server;
grant execute on function chess_service.market_orders(text, text) to chess_server;
grant execute on function chess_service.market_trade_offer(text, uuid, uuid, integer, text) to chess_server;
grant execute on function chess_service.market_trade_answer(text, uuid, boolean, integer) to chess_server;
grant execute on function chess_service.market_stripe_apply(text, text, jsonb) to chess_server;

commit;

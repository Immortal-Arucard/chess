-- Simulated ratings exchange. Apply once after supabase/chess_private_execute.sql.
-- Do not edit earlier SQL files. Do not apply this file twice.
-- AMU is simulated. The only user issuance is one grant of 1000000000000 AMU
-- per Chess profile, stored in exchange_grants. Trades move that cash; they do
-- not create it. The simulated market maker is seeded here and is not a user.
-- Reference ratings and simulated prices are different columns.
-- A Worker deploy is required after this file is applied. This file does not deploy it.

begin;

create table chess_private.exchange_markets (
  id text primary key,
  source text not null,
  category text not null,
  title text not null,
  rating_label text not null,
  reference_kind text not null,
  reference_source text not null,
  as_of timestamptz,
  live boolean not null default false,
  constraint exchange_markets_id check (id ~ '^[a-z]+:[a-z0-9]+$'),
  constraint exchange_markets_source check (source in ('fide', 'chesscom', 'lichess', 'site')),
  constraint exchange_markets_kind check (reference_kind in ('snapshot', 'cached_public_api', 'site_rating')),
  constraint exchange_markets_not_live check (live = false)
);

create table chess_private.exchange_instruments (
  id uuid primary key default gen_random_uuid(),
  market_id text not null references chess_private.exchange_markets (id),
  symbol text not null,
  player_name text not null,
  external_ref text not null,
  reference_rating integer,
  reference_as_of timestamptz,
  reference_source text not null,
  reference_kind text not null,
  seed_price bigint not null,
  last_price bigint not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (market_id, symbol),
  unique (market_id, external_ref),
  constraint exchange_instruments_symbol check (symbol ~ '^[A-Z0-9]{2,12}$'),
  constraint exchange_instruments_name check (char_length(player_name) between 1 and 80),
  constraint exchange_instruments_ref check (char_length(external_ref) between 1 and 80),
  constraint exchange_instruments_kind check (reference_kind in ('snapshot', 'cached_public_api', 'site_rating')),
  constraint exchange_instruments_rating check (reference_rating is null or reference_rating between 1 and 4000),
  constraint exchange_instruments_prices check (seed_price > 0 and last_price > 0)
);

create table chess_private.exchange_grants (
  profile_id uuid primary key references public.chess_profiles (id) on delete cascade,
  amount bigint not null,
  granted_at timestamptz not null default clock_timestamp(),
  constraint exchange_grants_once check (amount = 1000000000000)
);

create table chess_private.exchange_accounts (
  profile_id uuid primary key references public.chess_profiles (id) on delete cascade,
  balance bigint not null,
  realized_pnl bigint not null default 0,
  constraint exchange_accounts_balance check (balance >= 0)
);

create table chess_private.exchange_holdings (
  profile_id uuid not null references public.chess_profiles (id) on delete cascade,
  instrument_id uuid not null references chess_private.exchange_instruments (id),
  quantity integer not null,
  avg_cost bigint not null,
  primary key (profile_id, instrument_id),
  constraint exchange_holdings_qty check (quantity >= 0),
  constraint exchange_holdings_cost check (avg_cost >= 0)
);

create table chess_private.exchange_orders (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references chess_private.exchange_instruments (id),
  profile_id uuid references public.chess_profiles (id),
  liquidity text not null,
  side text not null,
  order_type text not null,
  price bigint,
  quantity integer not null,
  filled integer not null default 0,
  reserved_amu bigint not null default 0,
  reserved_qty integer not null default 0,
  cost_avg bigint,
  status text not null default 'open',
  created_at timestamptz not null default clock_timestamp(),
  constraint exchange_orders_liquidity check (liquidity in ('user', 'amm')),
  constraint exchange_orders_side check (side in ('buy', 'sell')),
  constraint exchange_orders_type check (order_type in ('limit', 'market')),
  constraint exchange_orders_status check (status in ('open', 'filled', 'canceled')),
  constraint exchange_orders_qty check (quantity between 1 and 100000 and filled between 0 and quantity),
  constraint exchange_orders_reserved check (reserved_amu >= 0 and reserved_qty >= 0 and reserved_qty <= quantity),
  constraint exchange_orders_owner check (
    (liquidity = 'user' and profile_id is not null)
    or (liquidity = 'amm' and profile_id is null)
  ),
  constraint exchange_orders_price check (
    (order_type = 'market' and price is null)
    or (order_type = 'limit' and price between 1 and 1000000000000)
  ),
  constraint exchange_orders_cost check (
    (side = 'buy' and cost_avg is null)
    or (side = 'sell' and cost_avg is not null and cost_avg >= 0)
  )
);

create table chess_private.exchange_trades (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references chess_private.exchange_instruments (id),
  price bigint not null,
  quantity integer not null,
  buyer_id uuid,
  seller_id uuid,
  resting_liquidity text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint exchange_trades_price check (price > 0 and quantity between 1 and 100000),
  constraint exchange_trades_resting check (resting_liquidity in ('user', 'amm')),
  constraint exchange_trades_not_self check (buyer_id is distinct from seller_id)
);

create table chess_private.exchange_amm (
  instrument_id uuid primary key references chess_private.exchange_instruments (id),
  cash bigint not null,
  shares integer not null,
  cash_endowment bigint not null,
  share_endowment integer not null,
  constraint exchange_amm_nonnegative check (cash >= 0 and shares >= 0 and cash_endowment >= 0 and share_endowment >= 0)
);

create index exchange_orders_book on chess_private.exchange_orders (instrument_id, side, status, price, created_at);
create index exchange_trades_instrument on chess_private.exchange_trades (instrument_id, created_at desc);
create index exchange_orders_profile on chess_private.exchange_orders (profile_id, created_at desc);

revoke all on chess_private.exchange_markets from public, anon, authenticated, chess_api, chess_server;
revoke all on chess_private.exchange_instruments from public, anon, authenticated, chess_api, chess_server;
revoke all on chess_private.exchange_grants from public, anon, authenticated, chess_api, chess_server;
revoke all on chess_private.exchange_accounts from public, anon, authenticated, chess_api, chess_server;
revoke all on chess_private.exchange_holdings from public, anon, authenticated, chess_api, chess_server;
revoke all on chess_private.exchange_orders from public, anon, authenticated, chess_api, chess_server;
revoke all on chess_private.exchange_trades from public, anon, authenticated, chess_api, chess_server;
revoke all on chess_private.exchange_amm from public, anon, authenticated, chess_api, chess_server;

alter table chess_private.exchange_markets enable row level security;
alter table chess_private.exchange_instruments enable row level security;
alter table chess_private.exchange_grants enable row level security;
alter table chess_private.exchange_accounts enable row level security;
alter table chess_private.exchange_holdings enable row level security;
alter table chess_private.exchange_orders enable row level security;
alter table chess_private.exchange_trades enable row level security;
alter table chess_private.exchange_amm enable row level security;
alter table chess_private.exchange_markets force row level security;
alter table chess_private.exchange_instruments force row level security;
alter table chess_private.exchange_grants force row level security;
alter table chess_private.exchange_accounts force row level security;
alter table chess_private.exchange_holdings force row level security;
alter table chess_private.exchange_orders force row level security;
alter table chess_private.exchange_trades force row level security;
alter table chess_private.exchange_amm force row level security;

create function chess_private.exchange_lock()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(87221027);
end;
$$;

create function chess_private.exchange_ensure_grant(actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform chess_private.exchange_lock();
  with issued as (
    insert into chess_private.exchange_grants (profile_id, amount)
    values (actor, 1000000000000)
    on conflict (profile_id) do nothing
    returning profile_id, amount
  )
  insert into chess_private.exchange_accounts (profile_id, balance, realized_pnl)
  select issued.profile_id, issued.amount, 0
  from issued
  on conflict (profile_id) do nothing;
end;
$$;

create function chess_private.exchange_quote(inst chess_private.exchange_instruments)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  bid bigint;
  ask bigint;
  bid_maker boolean;
  ask_maker boolean;
begin
  select max(orders.price) into bid
  from chess_private.exchange_orders orders
  where orders.instrument_id = inst.id and orders.status = 'open' and orders.side = 'buy' and orders.order_type = 'limit';
  select min(orders.price) into ask
  from chess_private.exchange_orders orders
  where orders.instrument_id = inst.id and orders.status = 'open' and orders.side = 'sell' and orders.order_type = 'limit';
  select coalesce(bool_and(orders.liquidity = 'amm'), false) into bid_maker
  from chess_private.exchange_orders orders
  where orders.instrument_id = inst.id and orders.status = 'open' and orders.side = 'buy'
    and orders.order_type = 'limit' and orders.price = bid;
  select coalesce(bool_and(orders.liquidity = 'amm'), false) into ask_maker
  from chess_private.exchange_orders orders
  where orders.instrument_id = inst.id and orders.status = 'open' and orders.side = 'sell'
    and orders.order_type = 'limit' and orders.price = ask;
  return jsonb_build_object(
    'id', inst.id,
    'marketId', inst.market_id,
    'symbol', inst.symbol,
    'name', inst.player_name,
    'referenceRating', inst.reference_rating,
    'referenceAsOf', inst.reference_as_of,
    'referenceSource', inst.reference_source,
    'referenceKind', inst.reference_kind,
    'live', false,
    'lastPrice', inst.last_price::text,
    'seedPrice', inst.seed_price::text,
    'bid', bid::text,
    'ask', ask::text,
    'bidIsMarketMaker', coalesce(bid_maker, false),
    'askIsMarketMaker', coalesce(ask_maker, false),
    'marketMakerLabel', 'Simulated market maker'
  );
end;
$$;

create function chess_private.exchange_book(inst uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'bids', coalesce((
      select jsonb_agg(jsonb_build_object(
        'price', level.price::text,
        'quantity', level.quantity,
        'makerQuantity', level.maker_quantity
      ) order by level.price desc)
      from (
        select orders.price,
          sum(orders.quantity - orders.filled)::integer as quantity,
          sum(orders.quantity - orders.filled) filter (where orders.liquidity = 'amm')::integer as maker_quantity
        from chess_private.exchange_orders orders
        where orders.instrument_id = inst and orders.status = 'open' and orders.side = 'buy' and orders.order_type = 'limit'
        group by orders.price
        order by orders.price desc
        limit 8
      ) level
    ), '[]'::jsonb),
    'asks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'price', level.price::text,
        'quantity', level.quantity,
        'makerQuantity', level.maker_quantity
      ) order by level.price asc)
      from (
        select orders.price,
          sum(orders.quantity - orders.filled)::integer as quantity,
          sum(orders.quantity - orders.filled) filter (where orders.liquidity = 'amm')::integer as maker_quantity
        from chess_private.exchange_orders orders
        where orders.instrument_id = inst and orders.status = 'open' and orders.side = 'sell' and orders.order_type = 'limit'
        group by orders.price
        order by orders.price asc
        limit 8
      ) level
    ), '[]'::jsonb)
  );
$$;

create function chess_private.exchange_apply_fill(buy_id uuid, sell_id uuid, trade_price bigint, qty integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  buy chess_private.exchange_orders;
  sell chess_private.exchange_orders;
  resting text;
begin
  if qty < 1 or trade_price < 1 then
    raise exception 'The request could not be completed.';
  end if;
  select * into buy from chess_private.exchange_orders where id = buy_id for update;
  select * into sell from chess_private.exchange_orders where id = sell_id for update;
  if buy.id is null or sell.id is null or buy.side <> 'buy' or sell.side <> 'sell' then
    raise exception 'The request could not be completed.';
  end if;
  if buy.profile_id is not distinct from sell.profile_id then
    raise exception 'That order would trade against your own resting order.';
  end if;
  if buy.filled + qty > buy.quantity or sell.filled + qty > sell.quantity then
    raise exception 'The request could not be completed.';
  end if;
  if buy.order_type = 'limit' then
    update chess_private.exchange_orders
      set reserved_amu = reserved_amu - price * qty
      where id = buy.id and reserved_amu >= price * qty;
    if not found then
      raise exception 'You do not have enough AMU for that order.';
    end if;
    if buy.liquidity = 'user' then
      update chess_private.exchange_accounts
        set balance = balance + (buy.price - trade_price) * qty
        where profile_id = buy.profile_id;
    else
      update chess_private.exchange_amm
        set cash = cash + (buy.price - trade_price) * qty
        where instrument_id = buy.instrument_id;
    end if;
  elsif buy.liquidity = 'user' then
    update chess_private.exchange_accounts
      set balance = balance - trade_price * qty
      where profile_id = buy.profile_id and balance >= trade_price * qty;
    if not found then
      raise exception 'You do not have enough AMU for that order.';
    end if;
  else
    update chess_private.exchange_amm
      set cash = cash - trade_price * qty
      where instrument_id = buy.instrument_id and cash >= trade_price * qty;
    if not found then
      raise exception 'You do not have enough AMU for that order.';
    end if;
  end if;
  if buy.liquidity = 'user' then
    insert into chess_private.exchange_holdings (profile_id, instrument_id, quantity, avg_cost)
    values (buy.profile_id, buy.instrument_id, qty, trade_price)
    on conflict (profile_id, instrument_id) do update
      set avg_cost = ((chess_private.exchange_holdings.quantity * chess_private.exchange_holdings.avg_cost) + (qty * trade_price))
        / (chess_private.exchange_holdings.quantity + qty),
          quantity = chess_private.exchange_holdings.quantity + qty;
  else
    update chess_private.exchange_amm
      set shares = shares + qty
      where instrument_id = buy.instrument_id;
  end if;
  update chess_private.exchange_orders
    set reserved_qty = reserved_qty - qty
    where id = sell.id and reserved_qty >= qty;
  if not found then
    raise exception 'You do not have enough shares for that order.';
  end if;
  if sell.liquidity = 'user' then
    update chess_private.exchange_accounts
      set balance = balance + trade_price * qty,
          realized_pnl = realized_pnl + (trade_price - sell.cost_avg) * qty
      where profile_id = sell.profile_id;
  else
    update chess_private.exchange_amm
      set cash = cash + trade_price * qty
      where instrument_id = sell.instrument_id;
  end if;
  update chess_private.exchange_orders
    set filled = filled + qty,
        status = case when filled + qty >= quantity then 'filled' else status end
    where id in (buy.id, sell.id);
  update chess_private.exchange_instruments
    set last_price = trade_price
    where id = buy.instrument_id;
  if buy.created_at < sell.created_at then resting := buy.liquidity; else resting := sell.liquidity; end if;
  insert into chess_private.exchange_trades (instrument_id, price, quantity, buyer_id, seller_id, resting_liquidity)
  values (buy.instrument_id, trade_price, qty, buy.profile_id, sell.profile_id, resting);
end;
$$;

create function chess_private.exchange_match(order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  incoming chess_private.exchange_orders;
  resting chess_private.exchange_orders;
  buyer_id uuid;
  seller_id uuid;
  trade_price bigint;
  room integer;
  affordable bigint;
  guard integer := 0;
begin
  loop
    guard := guard + 1;
    if guard > 100 then
      exit;
    end if;
    select * into incoming from chess_private.exchange_orders where id = order_id;
    exit when incoming.id is null or incoming.status <> 'open' or incoming.filled >= incoming.quantity;
    if incoming.side = 'buy' then
      select * into resting
      from chess_private.exchange_orders orders
      where orders.instrument_id = incoming.instrument_id
        and orders.status = 'open'
        and orders.side = 'sell'
        and orders.order_type = 'limit'
        and orders.id <> incoming.id
        and (incoming.order_type = 'market' or orders.price <= incoming.price)
        and orders.profile_id is distinct from incoming.profile_id
        and not (orders.liquidity = 'amm' and incoming.liquidity = 'amm')
      order by orders.price asc, orders.created_at asc, orders.id asc
      limit 1
      for update;
    else
      select * into resting
      from chess_private.exchange_orders orders
      where orders.instrument_id = incoming.instrument_id
        and orders.status = 'open'
        and orders.side = 'buy'
        and orders.order_type = 'limit'
        and orders.id <> incoming.id
        and (incoming.order_type = 'market' or orders.price >= incoming.price)
        and orders.profile_id is distinct from incoming.profile_id
        and not (orders.liquidity = 'amm' and incoming.liquidity = 'amm')
      order by orders.price desc, orders.created_at asc, orders.id asc
      limit 1
      for update;
    end if;
    exit when not found;
    trade_price := resting.price;
    if incoming.side = 'buy' then
      buyer_id := incoming.id;
      seller_id := resting.id;
      room := least(incoming.quantity - incoming.filled, resting.quantity - resting.filled);
      if incoming.order_type = 'market' then
        if incoming.liquidity = 'user' then
          select accounts.balance into affordable from chess_private.exchange_accounts accounts where accounts.profile_id = incoming.profile_id;
        else
          select pool.cash into affordable from chess_private.exchange_amm pool where pool.instrument_id = incoming.instrument_id;
        end if;
        room := least(room, least(coalesce(affordable, 0) / trade_price, 100000)::integer);
      end if;
    else
      buyer_id := resting.id;
      seller_id := incoming.id;
      room := least(resting.quantity - resting.filled, incoming.quantity - incoming.filled);
      if resting.order_type = 'market' then
        room := 0;
      end if;
    end if;
    exit when room < 1;
    perform chess_private.exchange_apply_fill(buyer_id, seller_id, trade_price, room);
  end loop;
end;
$$;

create function chess_private.exchange_replenish_one(inst uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  px bigint;
  bid bigint;
  ask bigint;
  pool chess_private.exchange_amm;
  sell_id uuid;
  buy_id uuid;
begin
  perform chess_private.exchange_lock();
  select * into pool from chess_private.exchange_amm where instrument_id = inst for update;
  if pool.instrument_id is null then
    return;
  end if;
  update chess_private.exchange_amm
    set cash = cash + coalesce((
          select sum(orders.reserved_amu)
          from chess_private.exchange_orders orders
          where orders.instrument_id = inst and orders.liquidity = 'amm' and orders.status = 'open'
        ), 0),
        shares = shares + coalesce((
          select sum(orders.reserved_qty)
          from chess_private.exchange_orders orders
          where orders.instrument_id = inst and orders.liquidity = 'amm' and orders.status = 'open'
        ), 0)::integer
    where instrument_id = inst;
  update chess_private.exchange_orders
    set status = 'canceled', reserved_amu = 0, reserved_qty = 0
    where instrument_id = inst and liquidity = 'amm' and status = 'open';
  select last_price into px from chess_private.exchange_instruments where id = inst;
  bid := greatest(1, px * 995 / 1000);
  ask := greatest(bid + 1, (px * 1005 + 999) / 1000);
  select * into pool from chess_private.exchange_amm where instrument_id = inst for update;
  if pool.shares >= 100 then
    update chess_private.exchange_amm set shares = shares - 100 where instrument_id = inst;
    insert into chess_private.exchange_orders (
      instrument_id, profile_id, liquidity, side, order_type, price, quantity, reserved_qty, cost_avg
    ) values (
      inst, null, 'amm', 'sell', 'limit', ask, 100, 100, 0
    ) returning id into sell_id;
  end if;
  if pool.cash >= bid * 100 then
    update chess_private.exchange_amm set cash = cash - bid * 100 where instrument_id = inst;
    insert into chess_private.exchange_orders (
      instrument_id, profile_id, liquidity, side, order_type, price, quantity, reserved_amu
    ) values (
      inst, null, 'amm', 'buy', 'limit', bid, 100, bid * 100
    ) returning id into buy_id;
  end if;
  if sell_id is not null then
    perform chess_private.exchange_match(sell_id);
  end if;
  if buy_id is not null then
    perform chess_private.exchange_match(buy_id);
  end if;
end;
$$;

create function chess_private.exchange_sync_site()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  cat text;
  row record;
  base text;
  candidate text;
  suffix integer;
  inst uuid;
  seed bigint;
begin
  perform chess_private.exchange_lock();
  foreach cat in array array['bullet', 'blitz', 'rapid', 'daily', 'untimed', 'puzzles']
  loop
    for row in
      select profiles.id as profile_id, profiles.display_name, ratings.rating, ratings.updated_at
      from chess_private.profile_ratings ratings
      join public.chess_profiles profiles on profiles.id = ratings.profile_id
      where ratings.category = cat and ratings.rating > 0
      order by ratings.rating desc, profiles.display_name asc, profiles.id asc
      limit 20
    loop
      update chess_private.exchange_instruments
        set player_name = row.display_name,
            reference_rating = row.rating,
            reference_as_of = row.updated_at,
            reference_source = 'Chess profile ratings on this site',
            reference_kind = 'site_rating'
        where market_id = 'site:' || cat and external_ref = row.profile_id::text;
      if found then
        continue;
      end if;
      base := upper(regexp_replace(row.display_name, '[^A-Za-z0-9]', '', 'g'));
      if char_length(base) < 2 then
        base := 'P' || upper(substr(replace(row.profile_id::text, '-', ''), 1, 8));
      end if;
      base := substr(base, 1, 12);
      candidate := base;
      suffix := 2;
      while exists (
        select 1 from chess_private.exchange_instruments existing
        where existing.market_id = 'site:' || cat and existing.symbol = candidate
      ) loop
        candidate := substr(base, 1, 12 - char_length(suffix::text)) || suffix::text;
        suffix := suffix + 1;
        exit when suffix > 99;
      end loop;
      seed := row.rating::bigint * 1000;
      insert into chess_private.exchange_instruments (
        market_id, symbol, player_name, external_ref, reference_rating, reference_as_of,
        reference_source, reference_kind, seed_price, last_price
      ) values (
        'site:' || cat, candidate, row.display_name, row.profile_id::text, row.rating, row.updated_at,
        'Chess profile ratings on this site', 'site_rating', seed, seed
      ) returning id into inst;
      insert into chess_private.exchange_amm (instrument_id, cash, shares, cash_endowment, share_endowment)
      values (inst, seed * 200, 200, seed * 200, 200);
      perform chess_private.exchange_replenish_one(inst);
    end loop;
  end loop;
end;
$$;

create function chess_private.exchange_place(
  raw_token text,
  inst uuid,
  side text,
  order_type text,
  limit_price bigint,
  qty integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  actor uuid;
  existing chess_private.exchange_instruments;
  order_id uuid;
  cost_snapshot bigint;
  stored chess_private.exchange_orders;
begin
  perform chess_private.exchange_lock();
  actor := chess_private.as_profile(raw_token);
  perform chess_private.bump_rate(actor, 'exchange orders', 60);
  perform chess_private.exchange_ensure_grant(actor);
  if side not in ('buy', 'sell') then
    raise exception 'Choose buy or sell.';
  end if;
  if order_type not in ('limit', 'market') then
    raise exception 'Choose a limit or market order.';
  end if;
  if qty is null or qty < 1 or qty > 100000 then
    raise exception 'Enter a whole number of shares from 1 to 100000.';
  end if;
  if order_type = 'limit' and (limit_price is null or limit_price < 1 or limit_price > 1000000000000) then
    raise exception 'Enter a limit price in whole AMU.';
  end if;
  if order_type = 'market' then
    limit_price := null;
  end if;
  select * into existing from chess_private.exchange_instruments where id = inst for update;
  if existing.id is null then
    raise exception 'That instrument was not found.';
  end if;
  perform 1 from chess_private.exchange_amm where instrument_id = inst for update;
  perform 1 from chess_private.exchange_accounts where profile_id = actor for update;
  if side = 'buy' and exists (
    select 1 from chess_private.exchange_orders orders
    where orders.instrument_id = inst and orders.profile_id = actor and orders.status = 'open' and orders.side = 'sell'
      and (order_type = 'market' or orders.price <= limit_price)
  ) then
    raise exception 'That order would trade against your own resting order.';
  end if;
  if side = 'sell' and exists (
    select 1 from chess_private.exchange_orders orders
    where orders.instrument_id = inst and orders.profile_id = actor and orders.status = 'open' and orders.side = 'buy'
      and (order_type = 'market' or orders.price >= limit_price)
  ) then
    raise exception 'That order would trade against your own resting order.';
  end if;
  if side = 'buy' and order_type = 'limit' then
    update chess_private.exchange_accounts
      set balance = balance - limit_price * qty
      where profile_id = actor and balance >= limit_price * qty;
    if not found then
      raise exception 'You do not have enough AMU for that order.';
    end if;
    insert into chess_private.exchange_orders (
      instrument_id, profile_id, liquidity, side, order_type, price, quantity, reserved_amu
    ) values (
      inst, actor, 'user', 'buy', 'limit', limit_price, qty, limit_price * qty
    ) returning id into order_id;
  elsif side = 'sell' then
    update chess_private.exchange_holdings
      set quantity = quantity - qty
      where profile_id = actor and instrument_id = inst and quantity >= qty
      returning avg_cost into cost_snapshot;
    if not found then
      raise exception 'You do not have enough shares for that order.';
    end if;
    insert into chess_private.exchange_orders (
      instrument_id, profile_id, liquidity, side, order_type, price, quantity, reserved_qty, cost_avg
    ) values (
      inst, actor, 'user', 'sell', order_type, limit_price, qty, qty, cost_snapshot
    ) returning id into order_id;
  else
    insert into chess_private.exchange_orders (
      instrument_id, profile_id, liquidity, side, order_type, price, quantity
    ) values (
      inst, actor, 'user', 'buy', 'market', null, qty
    ) returning id into order_id;
  end if;
  perform chess_private.exchange_match(order_id);
  select * into stored from chess_private.exchange_orders where id = order_id;
  if stored.order_type = 'market' and stored.filled = 0 then
    if stored.side = 'buy' then
      raise exception 'The book had no shares you could buy.';
    end if;
    raise exception 'The book had no bid for that sale.';
  end if;
  if stored.order_type = 'market' and stored.filled < stored.quantity then
    if stored.side = 'sell' and stored.reserved_qty > 0 then
      update chess_private.exchange_holdings
        set quantity = quantity + stored.reserved_qty
        where profile_id = actor and instrument_id = inst;
    end if;
    update chess_private.exchange_orders
      set status = 'canceled', reserved_amu = 0, reserved_qty = 0
      where id = order_id;
  end if;
  perform chess_private.exchange_replenish_one(inst);
  select * into stored from chess_private.exchange_orders where id = order_id;
  select * into existing from chess_private.exchange_instruments where id = inst;
  return jsonb_build_object(
    'simulated', true,
    'currency', 'AMU',
    'order', jsonb_build_object(
      'id', stored.id,
      'status', stored.status,
      'side', stored.side,
      'orderType', stored.order_type,
      'price', stored.price::text,
      'quantity', stored.quantity,
      'filled', stored.filled
    ),
    'instrument', chess_private.exchange_quote(existing)
  );
end;
$$;

create function chess_private.exchange_cancel(raw_token text, order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  stored chess_private.exchange_orders;
begin
  perform chess_private.exchange_lock();
  actor := chess_private.as_profile(raw_token);
  perform chess_private.bump_rate(actor, 'exchange orders', 60);
  select * into stored
  from chess_private.exchange_orders
  where id = order_id and profile_id = actor and status = 'open'
  for update;
  if stored.id is null then
    raise exception 'That order was not found.';
  end if;
  if stored.side = 'buy' and stored.reserved_amu > 0 then
    update chess_private.exchange_accounts
      set balance = balance + stored.reserved_amu
      where profile_id = actor;
  end if;
  if stored.side = 'sell' and stored.reserved_qty > 0 then
    update chess_private.exchange_holdings
      set quantity = quantity + stored.reserved_qty
      where profile_id = actor and instrument_id = stored.instrument_id;
  end if;
  update chess_private.exchange_orders
    set status = 'canceled', reserved_amu = 0, reserved_qty = 0
    where id = stored.id;
  perform chess_private.exchange_replenish_one(stored.instrument_id);
  return jsonb_build_object('canceled', stored.id, 'simulated', true, 'currency', 'AMU');
end;
$$;

create function chess_private.exchange_markets_json()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'simulated', true,
    'currency', 'AMU',
    'live', false,
    'disclaimer', 'Simulated, not real money.',
    'startingBalance', '1000000000000',
    'markets', coalesce(jsonb_agg(jsonb_build_object(
      'id', markets.id,
      'title', markets.title,
      'source', markets.source,
      'category', markets.category,
      'ratingLabel', markets.rating_label,
      'referenceKind', markets.reference_kind,
      'referenceSource', markets.reference_source,
      'asOf', markets.as_of,
      'live', false,
      'listed', (
        select count(*) from chess_private.exchange_instruments instruments
        where instruments.market_id = markets.id
      )
    ) order by markets.source, markets.category), '[]'::jsonb)
  )
  from chess_private.exchange_markets markets;
$$;

create function chess_private.exchange_market_json(market text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  found_market chess_private.exchange_markets;
  quotes jsonb;
begin
  select * into found_market from chess_private.exchange_markets where id = market;
  if found_market.id is null then
    raise exception 'That market was not found.';
  end if;
  select coalesce(jsonb_agg(chess_private.exchange_quote(instruments) order by instruments.reference_rating desc nulls last, instruments.symbol), '[]'::jsonb)
    into quotes
  from chess_private.exchange_instruments instruments
  where instruments.market_id = market;
  return jsonb_build_object(
    'simulated', true,
    'currency', 'AMU',
    'live', false,
    'disclaimer', 'Simulated, not real money. The reference rating is not the market price.',
    'market', jsonb_build_object(
      'id', found_market.id,
      'title', found_market.title,
      'source', found_market.source,
      'category', found_market.category,
      'ratingLabel', found_market.rating_label,
      'referenceKind', found_market.reference_kind,
      'referenceSource', found_market.reference_source,
      'asOf', found_market.as_of,
      'live', false
    ),
    'instruments', quotes
  );
end;
$$;

create function chess_private.exchange_instrument_json(inst uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  found_row chess_private.exchange_instruments;
  found_market chess_private.exchange_markets;
  prints jsonb;
  chart jsonb;
begin
  select * into found_row from chess_private.exchange_instruments where id = inst;
  if found_row.id is null then
    raise exception 'That instrument was not found.';
  end if;
  select * into found_market from chess_private.exchange_markets where id = found_row.market_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'price', recent.price::text,
    'quantity', recent.quantity,
    'at', recent.created_at,
    'maker', case when recent.resting_liquidity = 'amm' then 'simulated_market_maker' else 'member' end
  ) order by recent.created_at desc), '[]'::jsonb)
  into prints
  from (
    select trades.price, trades.quantity, trades.created_at, trades.resting_liquidity
    from chess_private.exchange_trades trades
    where trades.instrument_id = inst
    order by trades.created_at desc
    limit 40
  ) recent;
  select coalesce(jsonb_agg(jsonb_build_object(
    'price', older.price::text,
    'at', older.created_at
  ) order by older.created_at asc), '[]'::jsonb)
  into chart
  from (
    select trades.price, trades.created_at
    from chess_private.exchange_trades trades
    where trades.instrument_id = inst
    order by trades.created_at desc
    limit 60
  ) older;
  if chart = '[]'::jsonb then
    chart := jsonb_build_array(jsonb_build_object(
      'price', found_row.seed_price::text,
      'at', found_row.created_at,
      'opening', true
    ));
  end if;
  return jsonb_build_object(
    'simulated', true,
    'currency', 'AMU',
    'live', false,
    'disclaimer', 'Simulated, not real money. The reference rating is not the market price.',
    'market', jsonb_build_object(
      'id', found_market.id,
      'title', found_market.title,
      'ratingLabel', found_market.rating_label,
      'referenceKind', found_market.reference_kind,
      'referenceSource', found_market.reference_source,
      'asOf', found_market.as_of,
      'live', false
    ),
    'instrument', chess_private.exchange_quote(found_row),
    'book', chess_private.exchange_book(inst),
    'trades', prints,
    'chart', chart
  );
end;
$$;

create function chess_private.exchange_portfolio_json(actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  account chess_private.exchange_accounts;
  reserved bigint;
  marked bigint;
  unrealized bigint;
  equity bigint;
begin
  select * into account from chess_private.exchange_accounts where profile_id = actor;
  select coalesce(sum(orders.reserved_amu), 0) into reserved
  from chess_private.exchange_orders orders
  where orders.profile_id = actor and orders.status = 'open' and orders.side = 'buy';
  select coalesce(sum(held.quantity * instruments.last_price), 0)
    + coalesce((
      select sum(orders.reserved_qty * instruments.last_price)
      from chess_private.exchange_orders orders
      join chess_private.exchange_instruments instruments on instruments.id = orders.instrument_id
      where orders.profile_id = actor and orders.status = 'open' and orders.side = 'sell'
    ), 0)
  into marked
  from chess_private.exchange_holdings held
  join chess_private.exchange_instruments instruments on instruments.id = held.instrument_id
  where held.profile_id = actor;
  select coalesce(sum((instruments.last_price - held.avg_cost) * held.quantity), 0)
    + coalesce((
      select sum((instruments.last_price - orders.cost_avg) * orders.reserved_qty)
      from chess_private.exchange_orders orders
      join chess_private.exchange_instruments instruments on instruments.id = orders.instrument_id
      where orders.profile_id = actor and orders.status = 'open' and orders.side = 'sell'
    ), 0)
  into unrealized
  from chess_private.exchange_holdings held
  join chess_private.exchange_instruments instruments on instruments.id = held.instrument_id
  where held.profile_id = actor;
  equity := account.balance + reserved + marked;
  return jsonb_build_object(
    'simulated', true,
    'currency', 'AMU',
    'live', false,
    'disclaimer', 'Simulated, not real money.',
    'balance', account.balance::text,
    'reserved', reserved::text,
    'equity', equity::text,
    'realizedPnl', account.realized_pnl::text,
    'unrealizedPnl', unrealized::text,
    'holdings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'instrumentId', held.instrument_id,
        'symbol', instruments.symbol,
        'name', instruments.player_name,
        'marketId', instruments.market_id,
        'quantity', held.quantity,
        'avgCost', held.avg_cost::text,
        'lastPrice', instruments.last_price::text,
        'referenceRating', instruments.reference_rating,
        'marketValue', (held.quantity::bigint * instruments.last_price)::text
      ) order by instruments.market_id, instruments.symbol)
      from chess_private.exchange_holdings held
      join chess_private.exchange_instruments instruments on instruments.id = held.instrument_id
      where held.profile_id = actor and held.quantity > 0
    ), '[]'::jsonb),
    'openOrders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', orders.id,
        'instrumentId', orders.instrument_id,
        'symbol', instruments.symbol,
        'marketId', instruments.market_id,
        'side', orders.side,
        'orderType', orders.order_type,
        'price', orders.price::text,
        'quantity', orders.quantity,
        'filled', orders.filled,
        'createdAt', orders.created_at
      ) order by orders.created_at desc)
      from chess_private.exchange_orders orders
      join chess_private.exchange_instruments instruments on instruments.id = orders.instrument_id
      where orders.profile_id = actor and orders.status = 'open'
    ), '[]'::jsonb),
    'trades', coalesce((
      select jsonb_agg(jsonb_build_object(
        'price', recent.price::text,
        'quantity', recent.quantity,
        'side', recent.side,
        'symbol', recent.symbol,
        'marketId', recent.market_id,
        'at', recent.created_at,
        'maker', recent.maker
      ) order by recent.created_at desc)
      from (
        select trades.price, trades.quantity, trades.created_at, instruments.symbol, instruments.market_id,
          case when trades.buyer_id = actor then 'buy' else 'sell' end as side,
          case when trades.resting_liquidity = 'amm' then 'simulated_market_maker' else 'member' end as maker
        from chess_private.exchange_trades trades
        join chess_private.exchange_instruments instruments on instruments.id = trades.instrument_id
        where trades.buyer_id = actor or trades.seller_id = actor
        order by trades.created_at desc
        limit 40
      ) recent
    ), '[]'::jsonb)
  );
end;
$$;

create function chess_private.exchange_leaderboard_json(page_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with lim as (
    select least(greatest(coalesce(page_limit, 20), 1), 50) as n
  ), valued as (
    select profiles.id, profiles.display_name,
      (
        accounts.balance
        + coalesce((
          select sum(orders.reserved_amu)
          from chess_private.exchange_orders orders
          where orders.profile_id = accounts.profile_id and orders.status = 'open' and orders.side = 'buy'
        ), 0)
        + coalesce((
          select sum(held.quantity::bigint * instruments.last_price)
          from chess_private.exchange_holdings held
          join chess_private.exchange_instruments instruments on instruments.id = held.instrument_id
          where held.profile_id = accounts.profile_id
        ), 0)
        + coalesce((
          select sum(orders.reserved_qty::bigint * instruments.last_price)
          from chess_private.exchange_orders orders
          join chess_private.exchange_instruments instruments on instruments.id = orders.instrument_id
          where orders.profile_id = accounts.profile_id and orders.status = 'open' and orders.side = 'sell'
        ), 0)
      ) as equity
    from chess_private.exchange_accounts accounts
    join public.chess_profiles profiles on profiles.id = accounts.profile_id
  )
  select jsonb_build_object(
    'simulated', true,
    'currency', 'AMU',
    'live', false,
    'disclaimer', 'Simulated, not real money. Ranked by simulated portfolio value.',
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'rank', ranked.rank,
        'profileId', ranked.id,
        'displayName', ranked.display_name,
        'equity', ranked.equity::text
      ) order by ranked.rank)
      from (
        select valued.id, valued.display_name, valued.equity,
          row_number() over (order by valued.equity desc, valued.display_name asc, valued.id asc) as rank
        from valued
        order by valued.equity desc, valued.display_name asc, valued.id asc
        limit (select n from lim)
      ) ranked
    ), '[]'::jsonb)
  );
$$;

create function chess_private.exchange_cache_references(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated integer;
begin
  perform chess_private.exchange_lock();
  update chess_private.exchange_instruments instruments
    set reference_rating = quote.rating,
        reference_as_of = quote."asOf",
        reference_source = quote.source,
        reference_kind = quote.kind
    from jsonb_to_recordset(coalesce(payload -> 'quotes', '[]'::jsonb))
      as quote("marketId" text, "externalRef" text, rating integer, "asOf" timestamptz, source text, kind text)
    where instruments.market_id = quote."marketId"
      and instruments.external_ref = quote."externalRef"
      and instruments.reference_kind <> 'site_rating'
      and quote.kind in ('cached_public_api', 'snapshot')
      and quote.rating between 1 and 4000
      and quote."asOf" is not null
      and char_length(coalesce(quote.source, '')) between 1 and 160;
  get diagnostics updated = row_count;
  return jsonb_build_object('updated', updated, 'live', false);
end;
$$;

create function chess_service.exchange_markets(raw_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
begin
  if raw_token is not null and btrim(raw_token) <> '' then
    select sessions.profile_id into actor from chess_private.load_session(raw_token) sessions;
    if actor is not null then
      perform set_config('chess.profile_id', actor::text, true);
      perform chess_private.exchange_ensure_grant(actor);
    end if;
  end if;
  perform chess_private.exchange_sync_site();
  return chess_private.exchange_markets_json();
end;
$$;

create function chess_service.exchange_market(raw_token text, market_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
begin
  if raw_token is not null and btrim(raw_token) <> '' then
    select sessions.profile_id into actor from chess_private.load_session(raw_token) sessions;
    if actor is not null then
      perform set_config('chess.profile_id', actor::text, true);
      perform chess_private.exchange_ensure_grant(actor);
    end if;
  end if;
  perform chess_private.exchange_sync_site();
  return chess_private.exchange_market_json(market_id);
end;
$$;

create function chess_service.exchange_instrument(inst uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select chess_private.exchange_instrument_json(inst);
$$;

create function chess_service.exchange_leaderboard(page_limit integer)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select chess_private.exchange_leaderboard_json(page_limit);
$$;

create function chess_service.exchange_portfolio(raw_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
begin
  actor := chess_private.as_profile(raw_token);
  perform chess_private.exchange_ensure_grant(actor);
  return chess_private.exchange_portfolio_json(actor);
end;
$$;

create function chess_service.exchange_place(
  raw_token text,
  inst uuid,
  side text,
  order_type text,
  limit_price bigint,
  qty integer
) returns jsonb
language sql
security definer
set search_path = ''
as $$
  select chess_private.exchange_place(raw_token, inst, side, order_type, limit_price, qty);
$$;

create function chess_service.exchange_cancel(raw_token text, order_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select chess_private.exchange_cancel(raw_token, order_id);
$$;

create function chess_service.exchange_cache_references(payload jsonb)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select chess_private.exchange_cache_references(payload);
$$;

revoke all on function chess_private.exchange_lock() from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.exchange_ensure_grant(uuid) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.exchange_quote(chess_private.exchange_instruments) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.exchange_book(uuid) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.exchange_apply_fill(uuid, uuid, bigint, integer) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.exchange_match(uuid) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.exchange_replenish_one(uuid) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.exchange_sync_site() from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.exchange_place(text, uuid, text, text, bigint, integer) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.exchange_cancel(text, uuid) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.exchange_markets_json() from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.exchange_market_json(text) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.exchange_instrument_json(uuid) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.exchange_portfolio_json(uuid) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.exchange_leaderboard_json(integer) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.exchange_cache_references(jsonb) from public, anon, authenticated, chess_api, chess_server;

revoke all on function chess_service.exchange_markets(text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.exchange_market(text, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.exchange_instrument(uuid) from public, anon, authenticated, chess_api;
revoke all on function chess_service.exchange_leaderboard(integer) from public, anon, authenticated, chess_api;
revoke all on function chess_service.exchange_portfolio(text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.exchange_place(text, uuid, text, text, bigint, integer) from public, anon, authenticated, chess_api;
revoke all on function chess_service.exchange_cancel(text, uuid) from public, anon, authenticated, chess_api;
revoke all on function chess_service.exchange_cache_references(jsonb) from public, anon, authenticated, chess_api;

grant execute on function chess_service.exchange_markets(text) to chess_server;
grant execute on function chess_service.exchange_market(text, text) to chess_server;
grant execute on function chess_service.exchange_instrument(uuid) to chess_server;
grant execute on function chess_service.exchange_leaderboard(integer) to chess_server;
grant execute on function chess_service.exchange_portfolio(text) to chess_server;
grant execute on function chess_service.exchange_place(text, uuid, text, text, bigint, integer) to chess_server;
grant execute on function chess_service.exchange_cancel(text, uuid) to chess_server;
grant execute on function chess_service.exchange_cache_references(jsonb) to chess_server;

insert into chess_private.exchange_markets (id, source, category, title, rating_label, reference_kind, reference_source, as_of, live) values
  ('fide:standard', 'fide', 'standard', 'FIDE Standard', 'FIDE Standard rating', 'snapshot', 'ChessBase publication of the FIDE standard list, 2 November 2026', '2026-11-01T00:00:00Z', false),
  ('fide:rapid', 'fide', 'rapid', 'FIDE Rapid', 'FIDE Rapid rating', 'snapshot', 'EloTracker compilation of the November 2026 FIDE rapid list', '2026-11-01T00:00:00Z', false),
  ('fide:blitz', 'fide', 'blitz', 'FIDE Blitz', 'FIDE Blitz rating', 'snapshot', 'EloTracker compilation of the November 2026 FIDE blitz list', '2026-11-01T00:00:00Z', false),
  ('chesscom:bullet', 'chesscom', 'bullet', 'Chess.com Bullet', 'Chess.com bullet rating', 'cached_public_api', 'Chess.com public API /pub/leaderboards (live_bullet)', '2026-11-10T05:04:00Z', false),
  ('chesscom:blitz', 'chesscom', 'blitz', 'Chess.com Blitz', 'Chess.com blitz rating', 'cached_public_api', 'Chess.com public API /pub/leaderboards (live_blitz)', '2026-11-10T05:04:00Z', false),
  ('chesscom:rapid', 'chesscom', 'rapid', 'Chess.com Rapid', 'Chess.com rapid rating', 'cached_public_api', 'Chess.com public API /pub/leaderboards (live_rapid)', '2026-11-10T05:04:00Z', false),
  ('lichess:bullet', 'lichess', 'bullet', 'Lichess Bullet', 'Lichess bullet rating', 'cached_public_api', 'Lichess public API /api/player/top/20/bullet', '2026-11-10T05:04:00Z', false),
  ('lichess:blitz', 'lichess', 'blitz', 'Lichess Blitz', 'Lichess blitz rating', 'cached_public_api', 'Lichess public API /api/player/top/20/blitz', '2026-11-10T05:04:00Z', false),
  ('lichess:rapid', 'lichess', 'rapid', 'Lichess Rapid', 'Lichess rapid rating', 'cached_public_api', 'Lichess public API /api/player/top/20/rapid', '2026-11-10T05:04:00Z', false),
  ('lichess:classical', 'lichess', 'classical', 'Lichess Classical', 'Lichess classical rating', 'cached_public_api', 'Lichess public API /api/player/top/20/classical', '2026-11-10T05:04:00Z', false),
  ('site:bullet', 'site', 'bullet', 'Chess Bullet', 'On-site bullet rating', 'site_rating', 'Chess profile ratings on this site', null, false),
  ('site:blitz', 'site', 'blitz', 'Chess Blitz', 'On-site blitz rating', 'site_rating', 'Chess profile ratings on this site', null, false),
  ('site:rapid', 'site', 'rapid', 'Chess Rapid', 'On-site rapid rating', 'site_rating', 'Chess profile ratings on this site', null, false),
  ('site:daily', 'site', 'daily', 'Chess Daily', 'On-site daily rating', 'site_rating', 'Chess profile ratings on this site', null, false),
  ('site:untimed', 'site', 'untimed', 'Chess Untimed', 'On-site untimed rating', 'site_rating', 'Chess profile ratings on this site', null, false),
  ('site:puzzles', 'site', 'puzzles', 'Chess Puzzles', 'On-site puzzles rating', 'site_rating', 'Chess profile ratings on this site', null, false);

-- Instrument rows are appended by the seed block below, still inside this transaction.

insert into chess_private.exchange_instruments (
  market_id, symbol, player_name, external_ref, reference_rating, reference_as_of,
  reference_source, reference_kind, seed_price, last_price
) values
('fide:standard', 'CARLSEN', 'Magnus Carlsen', 'fide:magnus-carlsen', 2823, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2823000, 2823000),
('fide:standard', 'NAKAMURA', 'Hikaru Nakamura', 'fide:hikaru-nakamura', 2792, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2792000, 2792000),
('fide:standard', 'CARUANA', 'Fabiano Caruana', 'fide:fabiano-caruana', 2783, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2783000, 2783000),
('fide:standard', 'SINDAROV', 'Javokhir Sindarov', 'fide:javokhir-sindarov', 2782, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2782000, 2782000),
('fide:standard', 'ABDUSATTOROV', 'Nodirbek Abdusattorov', 'fide:nodirbek-abdusattorov', 2772, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2772000, 2772000),
('fide:standard', 'SO', 'Wesley So', 'fide:wesley-so', 2771, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2771000, 2771000),
('fide:standard', 'PRAGG', 'Praggnanandhaa R', 'fide:praggnanandhaa-r', 2763, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2763000, 2763000),
('fide:standard', 'WEI', 'Yi Wei', 'fide:yi-wei', 2761, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2761000, 2761000),
('fide:standard', 'KEYMER', 'Vincent Keymer', 'fide:vincent-keymer', 2761, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2761000, 2761000),
('fide:standard', 'FIROUZJA', 'Alireza Firouzja', 'fide:alireza-firouzja', 2757, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2757000, 2757000),
('fide:standard', 'GIRI', 'Anish Giri', 'fide:anish-giri', 2747, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2747000, 2747000),
('fide:standard', 'ERIGAISI', 'Arjun Erigaisi', 'fide:arjun-erigaisi', 2746, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2746000, 2746000),
('fide:standard', 'DUDA', 'Jan-Krzysztof Duda', 'fide:jan-krzysztof-duda', 2741, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2741000, 2741000),
('fide:standard', 'ANAND', 'Viswanathan Anand', 'fide:viswanathan-anand', 2739, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2739000, 2739000),
('fide:standard', 'DOMINGUEZ', 'Leinier Dominguez Perez', 'fide:leinier-dominguez-perez', 2732, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2732000, 2732000),
('fide:standard', 'QUANGLIEM', 'Le Quang Liem', 'fide:le-quang-liem', 2732, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2732000, 2732000),
('fide:standard', 'DING', 'Liren Ding', 'fide:liren-ding', 2723, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2723000, 2723000),
('fide:standard', 'TABATABAEI', 'M. Amin Tabatabaei', 'fide:m-amin-tabatabaei', 2720, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2720000, 2720000),
('fide:standard', 'NIHAL', 'Nihal Sarin', 'fide:nihal-sarin', 2720, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2720000, 2720000),
('fide:standard', 'ARONIAN', 'Levon Aronian', 'fide:levon-aronian', 2719, '2026-11-01T00:00:00Z', 'ChessBase publication of the FIDE standard list, 2 November 2026', 'snapshot', 2719000, 2719000),
('fide:rapid', 'CARLSEN', 'Magnus Carlsen', 'fide:magnus-carlsen', 2801, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2801000, 2801000),
('fide:rapid', 'SINDAROV', 'Javokhir Sindarov', 'fide:javokhir-sindarov', 2755, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2755000, 2755000),
('fide:rapid', 'NEPO', 'Ian Nepomniachtchi', 'fide:ian-nepomniachtchi', 2748, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2748000, 2748000),
('fide:rapid', 'ERIGAISI', 'Arjun Erigaisi', 'fide:arjun-erigaisi', 2740, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2740000, 2740000),
('fide:rapid', 'ARONIAN', 'Levon Aronian', 'fide:levon-aronian', 2738, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2738000, 2738000),
('fide:rapid', 'FIROUZJA', 'Alireza Firouzja', 'fide:alireza-firouzja', 2737, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2737000, 2737000),
('fide:rapid', 'PRAGG', 'Praggnanandhaa R', 'fide:praggnanandhaa-r', 2733, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2733000, 2733000),
('fide:rapid', 'NAKAMURA', 'Hikaru Nakamura', 'fide:hikaru-nakamura', 2718, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2718000, 2718000),
('fide:rapid', 'NIHAL', 'Nihal Sarin', 'fide:nihal-sarin', 2712, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2712000, 2712000),
('fide:rapid', 'MVL', 'Maxime Vachier-Lagrave', 'fide:maxime-vachier-lagrave', 2712, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2712000, 2712000),
('fide:rapid', 'ARTEMIEV', 'Vladislav Artemiev', 'fide:vladislav-artemiev', 2707, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2707000, 2707000),
('fide:rapid', 'SO', 'Wesley So', 'fide:wesley-so', 2704, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2704000, 2704000),
('fide:rapid', 'ABDUSATTOROV', 'Nodirbek Abdusattorov', 'fide:nodirbek-abdusattorov', 2704, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2704000, 2704000),
('fide:rapid', 'WEI', 'Yi Wei', 'fide:yi-wei', 2704, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2704000, 2704000),
('fide:rapid', 'FEDOSEEV', 'Vladimir Fedoseev', 'fide:vladimir-fedoseev', 2701, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2701000, 2701000),
('fide:rapid', 'LEKO', 'Peter Leko', 'fide:peter-leko', 2700, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2700000, 2700000),
('fide:rapid', 'ANAND', 'Viswanathan Anand', 'fide:viswanathan-anand', 2694, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2694000, 2694000),
('fide:rapid', 'DING', 'Liren Ding', 'fide:liren-ding', 2689, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2689000, 2689000),
('fide:rapid', 'MAGHSOODLOO', 'Parham Maghsoodloo', 'fide:parham-maghsoodloo', 2689, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2689000, 2689000),
('fide:rapid', 'CARUANA', 'Fabiano Caruana', 'fide:fabiano-caruana', 2687, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE rapid list', 'snapshot', 2687000, 2687000),
('fide:blitz', 'CARLSEN', 'Magnus Carlsen', 'fide:magnus-carlsen', 2860, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2860000, 2860000),
('fide:blitz', 'ABDUSATTOROV', 'Nodirbek Abdusattorov', 'fide:nodirbek-abdusattorov', 2819, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2819000, 2819000),
('fide:blitz', 'NAKAMURA', 'Hikaru Nakamura', 'fide:hikaru-nakamura', 2800, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2800000, 2800000),
('fide:blitz', 'FIROUZJA', 'Alireza Firouzja', 'fide:alireza-firouzja', 2797, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2797000, 2797000),
('fide:blitz', 'DUBOV', 'Daniil Dubov', 'fide:daniil-dubov', 2779, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2779000, 2779000),
('fide:blitz', 'ERIGAISI', 'Arjun Erigaisi', 'fide:arjun-erigaisi', 2766, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2766000, 2766000),
('fide:blitz', 'NEPO', 'Ian Nepomniachtchi', 'fide:ian-nepomniachtchi', 2765, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2765000, 2765000),
('fide:blitz', 'SO', 'Wesley So', 'fide:wesley-so', 2745, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2745000, 2745000),
('fide:blitz', 'CARUANA', 'Fabiano Caruana', 'fide:fabiano-caruana', 2738, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2738000, 2738000),
('fide:blitz', 'DING', 'Liren Ding', 'fide:liren-ding', 2736, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2736000, 2736000),
('fide:blitz', 'MVL', 'Maxime Vachier-Lagrave', 'fide:maxime-vachier-lagrave', 2734, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2734000, 2734000),
('fide:blitz', 'FEDOSEEV', 'Vladimir Fedoseev', 'fide:vladimir-fedoseev', 2726, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2726000, 2726000),
('fide:blitz', 'SINDAROV', 'Javokhir Sindarov', 'fide:javokhir-sindarov', 2725, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2725000, 2725000),
('fide:blitz', 'YU', 'Yangyi Yu', 'fide:yangyi-yu', 2722, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2722000, 2722000),
('fide:blitz', 'NIHAL', 'Nihal Sarin', 'fide:nihal-sarin', 2721, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2721000, 2721000),
('fide:blitz', 'BU', 'Xiangzhi Bu', 'fide:xiangzhi-bu', 2717, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2717000, 2717000),
('fide:blitz', 'ARONIAN', 'Levon Aronian', 'fide:levon-aronian', 2714, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2714000, 2714000),
('fide:blitz', 'ARTEMIEV', 'Vladislav Artemiev', 'fide:vladislav-artemiev', 2712, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2712000, 2712000),
('fide:blitz', 'PRAGG', 'Praggnanandhaa R', 'fide:praggnanandhaa-r', 2712, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2712000, 2712000),
('fide:blitz', 'NIEMANN', 'Hans Moke Niemann', 'fide:hans-moke-niemann', 2711, '2026-11-01T00:00:00Z', 'EloTracker compilation of the November 2026 FIDE blitz list', 'snapshot', 2711000, 2711000),
('chesscom:bullet', 'ARKADIIKHROM', 'ArkadiiKhromaev', 'arkadiikhromaev', 3602, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3602000, 3602000),
('chesscom:bullet', 'GMBREWCHESS', 'GMBrewChess', 'gmbrewchess', 3500, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3500000, 3500000),
('chesscom:bullet', 'PHILIPPIANS4', 'Philippians46', 'philippians46', 3454, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3454000, 3454000),
('chesscom:bullet', 'HIKARU', 'Hikaru', 'hikaru', 3424, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3424000, 3424000),
('chesscom:bullet', 'ZOLTANBOLT04', 'zoltanbolt_04', 'zoltanbolt_04', 3405, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3405000, 3405000),
('chesscom:bullet', 'FIROUZJA2003', 'Firouzja2003', 'firouzja2003', 3386, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3386000, 3386000),
('chesscom:bullet', 'GURELEDIZ', 'gurelediz', 'gurelediz', 3378, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3378000, 3378000),
('chesscom:bullet', 'PARHAMOV', 'Parhamov', 'parhamov', 3352, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3352000, 3352000),
('chesscom:bullet', 'ORANGEGHOST', 'Orange_Ghost', 'orange_ghost', 3333, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3333000, 3333000),
('chesscom:bullet', 'MAGNUSCARLSE', 'MagnusCarlsen', 'magnuscarlsen', 3331, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3331000, 3331000),
('chesscom:bullet', 'FAUSTINOORO', 'FaustinoOro', 'faustinooro', 3329, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3329000, 3329000),
('chesscom:bullet', 'DOLPHIN2010', 'Dolphin_2010', 'dolphin_2010', 3325, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3325000, 3325000),
('chesscom:bullet', 'ELFANGM2', 'Elfangm2', 'elfangm2', 3303, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3303000, 3303000),
('chesscom:bullet', 'JINGTIANWU', 'JingtianWu', 'jingtianwu', 3295, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3295000, 3295000),
('chesscom:bullet', 'WONDERFULTIM', 'wonderfultime', 'wonderfultime', 3287, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3287000, 3287000),
('chesscom:bullet', 'NIHALSARIN', 'nihalsarin', 'nihalsarin', 3282, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3282000, 3282000),
('chesscom:bullet', 'SPICYCATERPI', 'spicycaterpillar', 'spicycaterpillar', 3269, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3269000, 3269000),
('chesscom:bullet', 'ARYSYA', 'Arysya', 'arysya', 3267, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3267000, 3267000),
('chesscom:bullet', 'SINAMOVAHED', 'Sina-Movahed', 'sina-movahed', 3267, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3267000, 3267000),
('chesscom:bullet', '0GZPANDA', '0gZPanda', '0gzpanda', 3264, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_bullet)', 'cached_public_api', 3264000, 3264000),
('chesscom:blitz', 'HIKARU', 'Hikaru', 'hikaru', 3455, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3455000, 3455000),
('chesscom:blitz', 'FIROUZJA2003', 'Firouzja2003', 'firouzja2003', 3391, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3391000, 3391000),
('chesscom:blitz', 'MAGNUSCARLSE', 'MagnusCarlsen', 'magnuscarlsen', 3375, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3375000, 3375000),
('chesscom:blitz', 'NIHALSARIN', 'nihalsarin', 'nihalsarin', 3331, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3331000, 3331000),
('chesscom:blitz', 'DENLAZ', 'DenLaz', 'denlaz', 3319, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3319000, 3319000),
('chesscom:blitz', 'FAIRCHESSONY', 'FairChess_on_YouTube', 'fairchess_on_youtube', 3307, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3307000, 3307000),
('chesscom:blitz', 'SINAMOVAHED', 'Sina-Movahed', 'sina-movahed', 3305, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3305000, 3305000),
('chesscom:blitz', 'HANSONTWITCH', 'HansOnTwitch', 'hansontwitch', 3293, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3293000, 3293000),
('chesscom:blitz', 'MICHAELROIZ', 'MichaelRoiz', 'michaelroiz', 3288, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3288000, 3288000),
('chesscom:blitz', 'MICKITARYAN', 'Micki-taryan', 'micki-taryan', 3286, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3286000, 3286000),
('chesscom:blitz', 'CHESSWARRIOR', 'ChessWarrior7197', 'chesswarrior7197', 3285, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3285000, 3285000),
('chesscom:blitz', 'GURELEDIZ', 'gurelediz', 'gurelediz', 3281, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3281000, 3281000),
('chesscom:blitz', 'GHANDEEVAM20', 'GHANDEEVAM2003', 'ghandeevam2003', 3279, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3279000, 3279000),
('chesscom:blitz', 'POLISHFIGHTE', 'Polish_fighter3000', 'polish_fighter3000', 3277, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3277000, 3277000),
('chesscom:blitz', 'RPRAGCHESS', 'rpragchess', 'rpragchess', 3275, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3275000, 3275000),
('chesscom:blitz', 'FABIANOCARUA', 'FabianoCaruana', 'fabianocaruana', 3269, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3269000, 3269000),
('chesscom:blitz', 'PARHAMOV', 'Parhamov', 'parhamov', 3267, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3267000, 3267000),
('chesscom:blitz', 'GMWSO', 'GMWSO', 'gmwso', 3267, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3267000, 3267000),
('chesscom:blitz', 'SIBELEPHANT', 'Sibelephant', 'sibelephant', 3264, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3264000, 3264000),
('chesscom:blitz', 'LEGENDISBACK', 'legendisback1', 'legendisback1', 3256, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_blitz)', 'cached_public_api', 3256000, 3256000),
('chesscom:rapid', 'MAGNUSCARLSE', 'MagnusCarlsen', 'magnuscarlsen', 2941, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2941000, 2941000),
('chesscom:rapid', 'GUTOVANDREY', 'GutovAndrey', 'gutovandrey', 2938, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2938000, 2938000),
('chesscom:rapid', 'SEANWINSHAND', 'SeanWinshand', 'seanwinshand', 2876, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2876000, 2876000),
('chesscom:rapid', 'HIKARU', 'Hikaru', 'hikaru', 2838, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2838000, 2838000),
('chesscom:rapid', 'LPSUPI', 'LPSupi', 'lpsupi', 2838, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2838000, 2838000),
('chesscom:rapid', 'POLISHFIGHTE', 'Polish_fighter3000', 'polish_fighter3000', 2835, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2835000, 2835000),
('chesscom:rapid', 'GIORGISIBASH', 'Giorgi-Sibashvili', 'giorgi-sibashvili', 2821, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2821000, 2821000),
('chesscom:rapid', 'ILQAR74', 'ilqar_74', 'ilqar_74', 2815, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2815000, 2815000),
('chesscom:rapid', 'CHESSWARRIOR', 'ChessWarrior7197', 'chesswarrior7197', 2807, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2807000, 2807000),
('chesscom:rapid', 'FIROUZJA2003', 'Firouzja2003', 'firouzja2003', 2802, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2802000, 2802000),
('chesscom:rapid', 'DENLAZ', 'DenLaz', 'denlaz', 2799, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2799000, 2799000),
('chesscom:rapid', 'EVANDROBARBO', 'Evandro_Barbosa', 'evandro_barbosa', 2797, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2797000, 2797000),
('chesscom:rapid', 'LACHESISQ', 'lachesisQ', 'lachesisq', 2793, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2793000, 2793000),
('chesscom:rapid', 'KACPAROV', 'Kacparov', 'kacparov', 2793, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2793000, 2793000),
('chesscom:rapid', 'GHANDEEVAM20', 'GHANDEEVAM2003', 'ghandeevam2003', 2791, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2791000, 2791000),
('chesscom:rapid', 'GMKRIKOR', 'GMKrikor', 'gmkrikor', 2782, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2782000, 2782000),
('chesscom:rapid', 'LOVEVAE', 'LOVEVAE', 'lovevae', 2778, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2778000, 2778000),
('chesscom:rapid', 'CHRISTOPHERY', 'ChristopherYoo', 'christopheryoo', 2770, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2770000, 2770000),
('chesscom:rapid', 'NIHALSARIN', 'nihalsarin', 'nihalsarin', 2767, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2767000, 2767000),
('chesscom:rapid', 'GIGAQUPARADZ', 'GigaQuparadze', 'gigaquparadze', 2766, '2026-11-10T05:04:00Z', 'Chess.com public API /pub/leaderboards (live_rapid)', 'cached_public_api', 2766000, 2766000),
('lichess:bullet', 'ARKADIYKHROM', 'Arkadiy_Khromaev', 'arkadiy_khromaev', 3406, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3406000, 3406000),
('lichess:bullet', 'HACKERETTAN', 'Hackerettan', 'hackerettan', 3359, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3359000, 3359000),
('lichess:bullet', 'EDIZGUREL', 'Ediz_Gurel', 'ediz_gurel', 3339, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3339000, 3339000),
('lichess:bullet', 'DRTIGER', 'Dr_Tiger', 'dr_tiger', 3333, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3333000, 3333000),
('lichess:bullet', 'NIGHTKING96', 'Night-King96', 'night-king96', 3317, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3317000, 3317000),
('lichess:bullet', 'CHESSARTUS', 'chess-art-us', 'chess-art-us', 3279, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3279000, 3279000),
('lichess:bullet', 'IAMSTRAW', 'iamstraw', 'iamstraw', 3271, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3271000, 3271000),
('lichess:bullet', 'ANDRES4891', 'Andres4891', 'andres4891', 3264, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3264000, 3264000),
('lichess:bullet', 'TROJANHORSE2', 'Trojanhorse2500', 'trojanhorse2500', 3260, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3260000, 3260000),
('lichess:bullet', 'SERGIOOLIVA6', 'SergioOliva64', 'sergiooliva64', 3248, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3248000, 3248000),
('lichess:bullet', 'JOSHUAKIMMIC', 'JoshuaKimmich22', 'joshuakimmich22', 3245, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3245000, 3245000),
('lichess:bullet', 'FEEGLOOD', 'FeegLood', 'feeglood', 3244, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3244000, 3244000),
('lichess:bullet', 'BLAZINQ', 'Blazinq', 'blazinq', 3232, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3232000, 3232000),
('lichess:bullet', 'ROB188', 'rob188', 'rob188', 3225, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3225000, 3225000),
('lichess:bullet', 'MAHAMMADMURA', 'MahammadMuradli2003', 'mahammadmuradli2003', 3202, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3202000, 3202000),
('lichess:bullet', 'GLASNOSTPERE', 'GlasnostPerestroika', 'glasnostperestroika', 3201, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3201000, 3201000),
('lichess:bullet', 'WOSHIGESHAGU', 'woshigeshagua', 'woshigeshagua', 3200, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3200000, 3200000),
('lichess:bullet', 'VM', 'V_M', 'v_m', 3200, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3200000, 3200000),
('lichess:bullet', 'HEISENBERG01', 'Heisenberg01', 'heisenberg01', 3200, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3200000, 3200000),
('lichess:bullet', 'EXPERTISE64', 'expertise64', 'expertise64', 3200, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/bullet', 'cached_public_api', 3200000, 3200000),
('lichess:blitz', 'TARZANSMURF', 'tarzansmurf', 'tarzansmurf', 2981, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2981000, 2981000),
('lichess:blitz', 'ASDERT9', 'asdert9', 'asdert9', 2953, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2953000, 2953000),
('lichess:blitz', 'CUTEMOUSE83', 'cutemouse83', 'cutemouse83', 2937, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2937000, 2937000),
('lichess:blitz', 'KNIGHTCHECKS', 'KnightCheckShadow', 'knightcheckshadow', 2937, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2937000, 2937000),
('lichess:blitz', 'DRTIGER', 'Dr_Tiger', 'dr_tiger', 2934, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2934000, 2934000),
('lichess:blitz', 'AWORLDIDONTK', 'AWorldIDontKnow', 'aworldidontknow', 2929, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2929000, 2929000),
('lichess:blitz', 'REALDAVIDNAV', 'RealDavidNavara', 'realdavidnavara', 2926, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2926000, 2926000),
('lichess:blitz', 'VLADIMIROVIC', 'Vladimirovich9000', 'vladimirovich9000', 2917, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2917000, 2917000),
('lichess:blitz', 'HOWELLHUB', 'HowellHub', 'howellhub', 2914, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2914000, 2914000),
('lichess:blitz', 'ATHENAPALLAD', 'athena-pallada', 'athena-pallada', 2912, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2912000, 2912000),
('lichess:blitz', 'MLCHAEL', 'Mlchael', 'mlchael', 2910, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2910000, 2910000),
('lichess:blitz', 'ONEPOUNDROOK', 'onepoundrook', 'onepoundrook', 2910, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2910000, 2910000),
('lichess:blitz', 'DAFREX', 'dafrex', 'dafrex', 2906, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2906000, 2906000),
('lichess:blitz', 'SERGOY45', 'Sergoy45', 'sergoy45', 2903, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2903000, 2903000),
('lichess:blitz', 'HIGURUMAJ', 'higuruma_j', 'higuruma_j', 2900, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2900000, 2900000),
('lichess:blitz', 'FABSID', 'Fabsid', 'fabsid', 2900, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2900000, 2900000),
('lichess:blitz', 'ELCONCETO', 'elconceto', 'elconceto', 2897, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2897000, 2897000),
('lichess:blitz', 'TSOIDIMA', 'Tsoi_Dima', 'tsoi_dima', 2886, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2886000, 2886000),
('lichess:blitz', 'ABIK02', 'Abik02', 'abik02', 2882, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2882000, 2882000),
('lichess:blitz', 'JAKEBR8', 'Jakebr8', 'jakebr8', 2878, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/blitz', 'cached_public_api', 2878000, 2878000),
('lichess:rapid', 'KURALDGALAIN', 'Kurald_Galain', 'kurald_galain', 2799, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2799000, 2799000),
('lichess:rapid', 'CRAZYFASTGAM', 'CRaZyFAstGamiNg1221', 'crazyfastgaming1221', 2735, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2735000, 2735000),
('lichess:rapid', 'BAKINGINTHEO', 'bakingintheoven', 'bakingintheoven', 2724, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2724000, 2724000),
('lichess:rapid', 'SHADOWNINJA7', 'ShadowNinja7i', 'shadowninja7i', 2721, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2721000, 2721000),
('lichess:rapid', 'HAUNTINGGAME', 'Haunting_Games', 'haunting_games', 2718, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2718000, 2718000),
('lichess:rapid', 'VVERTI', 'vverti', 'vverti', 2703, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2703000, 2703000),
('lichess:rapid', 'ALEXSOELDEN', 'Alex_Soelden', 'alex_soelden', 2699, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2699000, 2699000),
('lichess:rapid', 'T34USSR', 'T34USSR', 't34ussr', 2695, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2695000, 2695000),
('lichess:rapid', 'FASTBOOSTER', 'FastBooster', 'fastbooster', 2669, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2669000, 2669000),
('lichess:rapid', 'NEWCOMER68', 'Newcomer68', 'newcomer68', 2669, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2669000, 2669000),
('lichess:rapid', 'CHESSMEM', 'chessmem', 'chessmem', 2660, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2660000, 2660000),
('lichess:rapid', 'MARTINOEDENN', 'Martino_Edenn', 'martino_edenn', 2648, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2648000, 2648000),
('lichess:rapid', 'LARRYTHECABL', 'Larrythecabledude', 'larrythecabledude', 2646, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2646000, 2646000),
('lichess:rapid', 'CHESSMOUNT', 'chessmount', 'chessmount', 2646, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2646000, 2646000),
('lichess:rapid', 'KUTAHYAPORSE', 'Kutahyaporselen', 'kutahyaporselen', 2645, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2645000, 2645000),
('lichess:rapid', 'EVGENYSHARAP', 'evgenysharapov', 'evgenysharapov', 2641, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2641000, 2641000),
('lichess:rapid', 'METAN0IA', 'metan0ia', 'metan0ia', 2639, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2639000, 2639000),
('lichess:rapid', 'LIKEWATER', 'likewater', 'likewater', 2638, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2638000, 2638000),
('lichess:rapid', 'SPARSELY23', 'sparsely23', 'sparsely23', 2637, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2637000, 2637000),
('lichess:rapid', 'JURGENZWIEG1', 'JurgenZwieg1900', 'jurgenzwieg1900', 2636, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/rapid', 'cached_public_api', 2636000, 2636000),
('lichess:classical', 'GEK76', 'gek76', 'gek76', 2522, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2522000, 2522000),
('lichess:classical', 'JOHNKRAMER19', 'John_Kramer1953', 'john_kramer1953', 2496, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2496000, 2496000),
('lichess:classical', 'GGPLAYER', 'GGplayer', 'ggplayer', 2483, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2483000, 2483000),
('lichess:classical', 'STERNSINGER1', 'Sternsinger1', 'sternsinger1', 2466, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2466000, 2466000),
('lichess:classical', 'LANCE5500', 'Lance5500', 'lance5500', 2462, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2462000, 2462000),
('lichess:classical', 'OJAIJOAO', 'OjaiJoao', 'ojaijoao', 2455, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2455000, 2455000),
('lichess:classical', 'DRMULEKEVINF', 'DrMuleKevinFan', 'drmulekevinfan', 2437, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2437000, 2437000),
('lichess:classical', 'KC6', 'kc6', 'kc6', 2430, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2430000, 2430000),
('lichess:classical', 'KIRAOVO', 'KiraOvO', 'kiraovo', 2429, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2429000, 2429000),
('lichess:classical', 'SYLVLONDON', 'sylvlondon', 'sylvlondon', 2426, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2426000, 2426000),
('lichess:classical', 'EAGLEAN', 'eaglean', 'eaglean', 2425, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2425000, 2425000),
('lichess:classical', 'SPEEDYSORCER', 'SpeedySorcerer', 'speedysorcerer', 2424, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2424000, 2424000),
('lichess:classical', 'LUCASCROTTI', 'lucascrotti', 'lucascrotti', 2424, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2424000, 2424000),
('lichess:classical', 'KCIOWA', 'KCIOWA', 'kciowa', 2423, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2423000, 2423000),
('lichess:classical', 'GOALDENGOOKI', 'Goalden_Gookie10', 'goalden_gookie10', 2422, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2422000, 2422000),
('lichess:classical', 'RTCM2200', 'RTCM-2200', 'rtcm-2200', 2422, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2422000, 2422000),
('lichess:classical', 'ARTVEGA', 'Art-Vega', 'art-vega', 2421, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2421000, 2421000),
('lichess:classical', 'KONNOVOLEG', 'Konnov_Oleg', 'konnov_oleg', 2411, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2411000, 2411000),
('lichess:classical', 'TOMRATD', 'TOMRATD', 'tomratd', 2405, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2405000, 2405000),
('lichess:classical', 'SCHACHSTRATE', 'Schachstratege', 'schachstratege', 2404, '2026-11-10T05:04:00Z', 'Lichess public API /api/player/top/20/classical', 'cached_public_api', 2404000, 2404000);

insert into chess_private.exchange_amm (instrument_id, cash, shares, cash_endowment, share_endowment)
select id, seed_price * 200, 200, seed_price * 200, 200
from chess_private.exchange_instruments;

do $$
declare
  inst uuid;
begin
  for inst in select id from chess_private.exchange_instruments loop
    perform chess_private.exchange_replenish_one(inst);
  end loop;
end
$$;

commit;

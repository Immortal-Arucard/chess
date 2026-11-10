import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createServer } from 'node:http';
import { createChessApp } from './chess-api.mjs';

const db = 'chess_ex_' + randomBytes(3).toString('hex');
const password = randomBytes(12).toString('hex');
const ada = { master: '11111111-1111-4111-8111-111111111111', profile: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', name: 'Mina Chen', token: 'ada-exchange-token', csrf: 'ada-exchange-csrf' };
const bob = { master: '22222222-2222-4222-8222-222222222222', profile: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', name: 'Julian Park', token: 'bob-exchange-token', csrf: 'bob-exchange-csrf' };
const files = [
  'supabase/chess_release.sql',
  'supabase/chess_discussion.sql',
  'supabase/chess_profile_card.sql',
  'supabase/chess_human.sql',
  'supabase/chess_roster.sql',
  'supabase/chess_ratings.sql',
  'supabase/chess_puzzles.sql',
  'supabase/chess_puzzle_serial.sql',
  'supabase/chess_master_header.sql',
  'supabase/chess_messages.sql',
  'supabase/chess_push.sql',
  'supabase/chess_private_execute.sql',
  'supabase/chess_exchange.sql'
];

function psql(database, sql) {
  const command = process.env.PGHOST
    ? ['psql', ['-d', database, '-v', 'ON_ERROR_STOP=1', '-t', '-A'], process.env]
    : ['sudo', ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-t', '-A'], process.env];
  const result = spawnSync(command[0], command[1], { input: sql, encoding: 'utf8', env: command[2] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return (result.stdout || '').split('\n').map((line) => line.trim()).filter((line) => line && !/^(INSERT|UPDATE|DELETE) \d/.test(line)).join('\n');
}
function psqlFile(database, file) {
  const command = process.env.PGHOST
    ? ['psql', ['-d', database, '-v', 'ON_ERROR_STOP=1', '-f', file], process.env]
    : ['sudo', ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', file], process.env];
  const result = spawnSync(command[0], command[1], { encoding: 'utf8', env: command[2] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
function seed(person) {
  return `
    insert into auth.users (id) values ('${person.master}');
    insert into public.chess_profiles (id, display_name) values ('${person.profile}', '${person.name}');
    insert into chess_private.profile_owners (profile_id, owner_id) values ('${person.profile}', '${person.master}');
    insert into chess_private.browser_sessions (token_hash, csrf_hash, master_id, profile_id, expires_at, idle_expires_at)
    values (chess_private.token_hash('${person.token}'), chess_private.token_hash('${person.csrf}'), '${person.master}', '${person.profile}', clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day');
  `;
}
function fail(sql) {
  try {
    psql(db, sql);
  } catch (err) {
    return String(err.message);
  }
  return '';
}
function invariants() {
  const row = psql(db, `
    select
      ((select coalesce(sum(balance), 0) from chess_private.exchange_accounts)
        + (select coalesce(sum(reserved_amu), 0) from chess_private.exchange_orders where status = 'open')
        + (select coalesce(sum(cash), 0) from chess_private.exchange_amm))::text
      || ',' ||
      ((select coalesce(sum(amount), 0) from chess_private.exchange_grants)
        + (select coalesce(sum(cash_endowment), 0) from chess_private.exchange_amm))::text
      || ',' ||
      ((select coalesce(sum(quantity), 0) from chess_private.exchange_holdings)
        + (select coalesce(sum(reserved_qty), 0) from chess_private.exchange_orders where status = 'open')
        + (select coalesce(sum(shares), 0) from chess_private.exchange_amm))::text
      || ',' ||
      (select coalesce(sum(share_endowment), 0)::text from chess_private.exchange_amm);
  `);
  const [cash, cashBasis, shares, shareBasis] = row.split(',');
  assert.equal(cash, cashBasis, 'cash invariant');
  assert.equal(shares, shareBasis, 'share invariant');
}

psql('postgres', `drop database if exists ${db}; create database ${db};`);
try {
  psql(db, `
    create schema if not exists auth;
    create table auth.users (id uuid primary key);
    do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
    create schema if not exists extensions;
    create extension if not exists pgcrypto schema extensions;
  `);
  for (const file of files) psqlFile(db, file);
  psql(db, `
    alter role chess_server login password '${password}';
    grant connect on database ${db} to chess_server;
    ${seed(ada)}
    ${seed(bob)}
  `);
  assert.equal(psql(db, "select count(*)::text from chess_private.exchange_instruments where market_id = 'fide:standard';"), '20');
  assert.equal(psql(db, "select count(*)::text from chess_private.exchange_orders where liquidity = 'amm' and status = 'open';") !== '0', true);
  invariants();

  const first = JSON.parse(psql(db, `select chess_service.exchange_portfolio('${ada.token}');`));
  assert.equal(first.balance, '1000000000000');
  assert.equal(first.currency, 'AMU');
  assert.equal(first.simulated, true);
  const second = JSON.parse(psql(db, `select chess_service.exchange_portfolio('${ada.token}');`));
  assert.equal(second.balance, '1000000000000');
  assert.equal(psql(db, `select count(*)::text from chess_private.exchange_grants where profile_id = '${ada.profile}';`), '1');

  const carlsen = psql(db, "select id::text from chess_private.exchange_instruments where market_id = 'fide:standard' and symbol = 'CARLSEN';");
  const before = psql(db, `select reference_rating::text || ',' || last_price::text from chess_private.exchange_instruments where id = '${carlsen}';`);
  assert.equal(before, '2823,2823000');
  const bought = JSON.parse(psql(db, `select chess_service.exchange_place('${ada.token}', '${carlsen}', 'buy', 'market', null, 1);`));
  assert.equal(bought.order.filled, 1);
  assert.equal(bought.order.status, 'filled');
  const after = psql(db, `select reference_rating::text || ',' || last_price::text from chess_private.exchange_instruments where id = '${carlsen}';`);
  assert.equal(after.split(',')[0], '2823');
  assert.notEqual(after.split(',')[1], '2823');
  assert.equal(Number(after.split(',')[1]) > 2823000, true);
  const book = JSON.parse(psql(db, `select chess_service.exchange_instrument('${carlsen}');`));
  assert.equal(book.live, false);
  assert.equal(book.instrument.referenceRating, 2823);
  assert.equal(book.book.asks.some((level) => level.makerQuantity > 0), true);
  invariants();

  const balance = psql(db, `select balance::text from chess_private.exchange_accounts where profile_id = '${ada.profile}';`);
  const overspend = fail(`select chess_service.exchange_place('${ada.token}', '${carlsen}', 'buy', 'limit', 1000000000000, 100000);`);
  assert.match(overspend, /enough AMU/);
  assert.equal(psql(db, `select balance::text from chess_private.exchange_accounts where profile_id = '${ada.profile}';`), balance);
  const oversell = fail(`select chess_service.exchange_place('${ada.token}', '${carlsen}', 'sell', 'limit', 9000000, 5);`);
  assert.match(oversell, /enough shares/);
  invariants();

  const quiet = psql(db, `
    insert into chess_private.exchange_instruments (
      market_id, symbol, player_name, external_ref, reference_rating, reference_as_of,
      reference_source, reference_kind, seed_price, last_price
    ) values (
      'fide:standard', 'TESTPAIR', 'Test Pair', 'fide:test-pair', 1500, '2026-11-01T00:00:00Z',
      'test snapshot', 'snapshot', 10000, 10000
    ) returning id::text;
  `);
  psql(db, `
    insert into chess_private.exchange_amm (instrument_id, cash, shares, cash_endowment, share_endowment)
    values ('${quiet}', 0, 0, 0, 0);
    update chess_private.exchange_amm set shares = 10, share_endowment = 10 where instrument_id = '${quiet}';
    update chess_private.exchange_amm set shares = 0 where instrument_id = '${quiet}';
    insert into chess_private.exchange_holdings (profile_id, instrument_id, quantity, avg_cost)
    values ('${ada.profile}', '${quiet}', 10, 10000);
  `);
  JSON.parse(psql(db, `select chess_service.exchange_portfolio('${bob.token}');`));
  const rested = JSON.parse(psql(db, `select chess_service.exchange_place('${ada.token}', '${quiet}', 'sell', 'limit', 10000, 4);`));
  assert.equal(rested.order.status, 'open');
  assert.equal(rested.order.filled, 0);
  const crossed = fail(`select chess_service.exchange_place('${ada.token}', '${quiet}', 'buy', 'limit', 10000, 1);`);
  assert.match(crossed, /your own resting order/);
  const matched = JSON.parse(psql(db, `select chess_service.exchange_place('${bob.token}', '${quiet}', 'buy', 'limit', 10000, 4);`));
  assert.equal(matched.order.filled, 4);
  assert.equal(matched.order.status, 'filled');
  const trade = psql(db, `
    select buyer_id::text || ',' || seller_id::text || ',' || price::text
    from chess_private.exchange_trades
    where instrument_id = '${quiet}';
  `);
  assert.equal(trade, bob.profile + ',' + ada.profile + ',10000');
  assert.equal(psql(db, `select quantity::text from chess_private.exchange_holdings where profile_id = '${bob.profile}' and instrument_id = '${quiet}';`), '4');
  assert.equal(psql(db, `select quantity::text from chess_private.exchange_holdings where profile_id = '${ada.profile}' and instrument_id = '${quiet}';`), '6');
  const self = JSON.parse(psql(db, `select chess_service.exchange_place('${bob.token}', '${quiet}', 'sell', 'limit', 50000, 4);`));
  const blocked = fail(`select chess_service.exchange_place('${bob.token}', '${quiet}', 'buy', 'limit', 50000, 1);`);
  assert.match(blocked, /your own resting order/);
  const canceled = JSON.parse(psql(db, `select chess_service.exchange_cancel('${bob.token}', '${self.order.id}');`));
  assert.equal(canceled.canceled, self.order.id);
  assert.equal(psql(db, `select quantity::text from chess_private.exchange_holdings where profile_id = '${bob.profile}' and instrument_id = '${quiet}';`), '4');
  invariants();

  const negative = fail(`update chess_private.exchange_accounts set balance = -1 where profile_id = '${ada.profile}';`);
  assert.match(negative, /exchange_accounts_balance|check constraint/);

  const cached = JSON.parse(psql(db, `select chess_service.exchange_cache_references('{"quotes":[
    {"marketId":"fide:standard","externalRef":"fide:magnus-carlsen","rating":2800,"asOf":"2026-11-10T00:00:00Z","source":"test cache","kind":"snapshot","lastPrice":"1"},
    {"marketId":"fide:standard","externalRef":"fide:nobody","rating":2000,"asOf":"2026-11-10T00:00:00Z","source":"test cache","kind":"snapshot"}
  ]}'::jsonb);`));
  assert.equal(cached.updated, 1);
  assert.equal(cached.live, false);
  assert.equal(psql(db, `select reference_rating::text || ',' || last_price::text from chess_private.exchange_instruments where id = '${carlsen}';`).split(',')[0], '2800');
  assert.equal(psql(db, `select count(*)::text from chess_private.exchange_instruments where external_ref = 'fide:nobody';`), '0');

  psql(db, `insert into chess_private.profile_ratings (profile_id, category, rating) values ('${ada.profile}', 'blitz', 1600);`);
  const markets = JSON.parse(psql(db, `select chess_service.exchange_markets(null);`));
  assert.equal(markets.live, false);
  assert.equal(markets.markets.every((market) => market.live === false), true);
  const site = psql(db, `
    select reference_rating::text || ',' || last_price::text || ',' || reference_kind
    from chess_private.exchange_instruments
    where market_id = 'site:blitz' and external_ref = '${ada.profile}';
  `);
  assert.equal(site, '1600,1600000,site_rating');
  const leaders = JSON.parse(psql(db, `select chess_service.exchange_leaderboard(10);`));
  assert.equal(leaders.entries.length, 2);
  assert.equal(leaders.entries.some((entry) => entry.displayName === 'Mina Chen'), true);

  const privileges = psql(db, `
    select has_function_privilege('anon', 'chess_service.exchange_place(text,uuid,text,text,bigint,integer)', 'execute')::text
      || ',' || has_function_privilege('chess_server', 'chess_private.exchange_place(text,uuid,text,text,bigint,integer)', 'execute')::text
      || ',' || has_function_privilege('chess_server', 'chess_service.exchange_markets(text)', 'execute')::text
      || ',' || has_function_privilege('public', 'chess_private.exchange_ensure_grant(uuid)', 'execute')::text;
  `);
  assert.equal(privileges, 'false,false,true,false');
  const denied = fail(`
    set role chess_server;
    select * from chess_private.exchange_accounts;
  `);
  assert.match(denied, /permission denied/);
  const anonDenied = fail(`
    set role anon;
    select * from chess_private.exchange_orders;
  `);
  assert.match(anonDenied, /permission denied/);
  invariants();

  const host = process.env.PGHOST || '127.0.0.1';
  const port = Number(process.env.PGPORT || 5432);
  const pool = new pg.Pool({ host, port, user: 'chess_server', password, database: db, max: 4 });
  const origin = 'https://chess.example';
  const app = createChessApp({ pool, origin, supabaseUrl: 'https://example.supabase.co', supabaseKey: 'publishable-test-key' });
  const server = createServer((req, res) => { app.handle(req, res).catch(() => res.end()); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const open = await fetch(base + '/api/exchange/markets');
  const body = await open.json();
  assert.equal(open.status, 200);
  assert.equal(body.simulated, true);
  assert.equal(body.live, false);
  const unsigned = await fetch(base + '/api/exchange/orders', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(unsigned.status, 401);
  const noCsrf = await fetch(base + '/api/exchange/orders', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', cookie: '__Host-chess_session=' + ada.token },
    body: JSON.stringify({ instrumentId: carlsen, side: 'buy', orderType: 'market', quantity: 1 })
  });
  assert.equal(noCsrf.status, 403);
  const placed = await fetch(base + '/api/exchange/orders', {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      cookie: '__Host-chess_session=' + ada.token + '; chess_csrf=' + ada.csrf,
      'x-csrf-token': ada.csrf
    },
    body: JSON.stringify({ instrumentId: carlsen, side: 'buy', orderType: 'market', quantity: 1 })
  });
  const placedBody = await placed.json();
  assert.equal(placed.status, 200, JSON.stringify(placedBody));
  assert.equal(placedBody.order.filled, 1);
  assert.equal(placedBody.instrument.referenceRating, 2800);
  invariants();
  server.close();
  await pool.end();
  console.log('exchange matching tests passed');
} finally {
  psql('postgres', `drop database if exists ${db};`);
}

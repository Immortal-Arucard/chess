import { createHmac, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { checkoutBody, feeCents, nextOrderStatus, stripeSignatureValid } from './market-stripe.mjs';

const db = 'chess_mkt_' + randomBytes(3).toString('hex');
const mina = { master: '11111111-1111-4111-8111-111111111111', profile: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', token: 'mina-market-token' };
const julian = { master: '22222222-2222-4222-8222-222222222222', profile: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', token: 'julian-market-token' };

function psql(database, sql) {
  const command = process.env.PGHOST ? ['psql', ['-d', database, '-v', 'ON_ERROR_STOP=1', '-t', '-A'], process.env] : ['sudo', ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-t', '-A'], process.env];
  const result = spawnSync(command[0], command[1], { input: sql, encoding: 'utf8', env: command[2] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'psql failed');
  return (result.stdout || '').trim();
}
function psqlFile(database, file) {
  const command = process.env.PGHOST ? ['psql', ['-d', database, '-v', 'ON_ERROR_STOP=1', '-f', file], process.env] : ['sudo', ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', file], process.env];
  const result = spawnSync(command[0], command[1], { encoding: 'utf8', env: command[2] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'psql file failed');
}
function quiet(sql) {
  return psql(db, sql).split('\n').filter((line) => line && !['SET', 'RESET', 'BEGIN', 'ROLLBACK'].includes(line)).join('\n');
}
function fails(sql) {
  const command = process.env.PGHOST ? ['psql', ['-d', db, '-v', 'ON_ERROR_STOP=1', '-t', '-A'], process.env] : ['sudo', ['-u', 'postgres', 'psql', '-d', db, '-v', 'ON_ERROR_STOP=1', '-t', '-A'], process.env];
  const result = spawnSync(command[0], command[1], { input: sql, encoding: 'utf8', env: command[2] });
  assert.notEqual(result.status, 0);
  return (result.stderr || result.stdout || '').trim();
}

assert.equal(feeCents(2500, 0), 0);
assert.equal(feeCents(2500, 200), 50);
assert.equal(nextOrderStatus('pending', 'paid'), 'paid');
assert.equal(nextOrderStatus('pending', 'shipped'), null);
assert.equal(nextOrderStatus('paid', 'shipped'), 'shipped');
assert.equal(nextOrderStatus('shipped', 'refunded'), 'refunded');
assert.equal(nextOrderStatus('refunded', 'paid'), null);
const body = checkoutBody({
  orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  title: 'Rosewood board',
  quantity: 1,
  unitCents: 4000,
  feeBps: 250,
  destination: 'acct_test_destination',
  successUrl: 'https://chess.example/marketplace/?orders=1',
  cancelUrl: 'https://chess.example/marketplace/'
});
assert.equal(body.get('payment_intent_data[transfer_data][destination]'), 'acct_test_destination');
assert.equal(body.get('payment_intent_data[application_fee_amount]'), '100');
assert.equal(body.get('metadata[order_id]'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
const secret = 'whsec_' + randomBytes(16).toString('hex');
const payload = JSON.stringify({ id: 'evt_test', type: 'checkout.session.completed' });
const stamp = 1_700_000_000;
const good = createHmac('sha256', secret).update(stamp + '.' + payload).digest('hex');
assert.equal(stripeSignatureValid(payload, 't=' + stamp + ',v1=' + good, secret, stamp), true);
assert.equal(stripeSignatureValid(payload, 't=' + stamp + ',v1=' + (good.slice(0, -1) + (good.endsWith('0') ? '1' : '0')), secret, stamp), false);
assert.equal(stripeSignatureValid(payload, 't=' + (stamp - 1000) + ',v1=' + good, secret, stamp), false);

psql('postgres', `drop database if exists ${db}; create database ${db};`);
try {
  psql(db, `
    create schema if not exists auth;
    create table auth.users (id uuid primary key);
    insert into auth.users (id) values ('${mina.master}'), ('${julian.master}');
    do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
    create schema if not exists extensions;
    create extension if not exists pgcrypto schema extensions;
  `);
  ['supabase/chess_release.sql', 'supabase/chess_discussion.sql', 'supabase/chess_human.sql', 'supabase/chess_messages.sql', 'supabase/chess_push.sql', 'supabase/chess_private_execute.sql', 'supabase/chess_market.sql'].forEach((file) => psqlFile(db, file));
  psql(db, `
    insert into public.chess_profiles (id, display_name) values ('${mina.profile}', 'Mina'), ('${julian.profile}', 'Julian');
    insert into chess_private.profile_owners (profile_id, owner_id) values ('${mina.profile}', '${mina.master}'), ('${julian.profile}', '${julian.master}');
    insert into chess_private.browser_sessions (token_hash, csrf_hash, master_id, profile_id, expires_at, idle_expires_at) values
      (chess_private.token_hash('${mina.token}'), chess_private.token_hash('csrf'), '${mina.master}', '${mina.profile}', clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day'),
      (chess_private.token_hash('${julian.token}'), chess_private.token_hash('csrf'), '${julian.master}', '${julian.profile}', clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day');
    insert into chess_private.admins (owner_id) values ('${mina.master}');
  `);
  assert.match(fails(`select chess_service.market_save('${julian.token}', null, 'Bike', 'A road bike', 'bicycles', 'new', 1000, 1, 'shipping', 'Austin', false);`), /Choose a chess category/);
  const listed = JSON.parse(psql(db, `select chess_service.market_save('${julian.token}', null, 'Rosewood board', 'A chess board', 'boards', 'good', 4000, 2, 'shipping', 'Austin', true);`));
  assert.equal(listed.category, 'boards');
  assert.equal(listed.openToTrades, true);
  const hidden = JSON.parse(psql(db, `select chess_service.market_moderate('${mina.token}', '${listed.id}', 'hide');`));
  assert.equal(hidden.status, 'hidden');
  assert.equal(quiet(`set role anon; select count(*)::text from public.chess_market_listings where id = '${listed.id}'; reset role;`), '0');
  psql(db, `select chess_service.market_moderate('${mina.token}', '${listed.id}', 'restore');`);
  assert.equal(quiet(`set role anon; select count(*)::text from public.chess_market_listings where status = 'active'; reset role;`), '1');
  assert.match(fails(`set role authenticated; insert into public.chess_market_listings (seller_id, title, description, category, condition, price_cents, quantity, fulfillment) values ('${julian.profile}', 'Nope', 'Nope', 'books', 'new', 100, 1, 'digital');`), /permission denied|row-level security|policy/);
  assert.match(fails(`set role authenticated; select count(*) from chess_private.market_orders;`), /permission denied/);
  const mine = JSON.parse(psql(db, `select chess_service.market_save('${mina.token}', null, 'Clock', 'A digital chess clock', 'clocks', 'new', 2500, 1, 'pickup', 'Boston', true);`));
  const offered = JSON.parse(psql(db, `select chess_service.market_trade_offer('${mina.token}', '${mine.id}', '${listed.id}', 0, 'none');`));
  assert.equal(offered.status, 'offered');
  const declined = JSON.parse(psql(db, `select chess_service.market_trade_answer('${julian.token}', '${offered.id}', false, 0);`));
  assert.equal(declined.status, 'declined');
  assert.equal(psql(db, `select kind from chess_private.notification_events where recipient_id = '${mina.profile}' and kind = 'market_declined';`), 'market_declined');
  const again = JSON.parse(psql(db, `select chess_service.market_trade_offer('${mina.token}', '${mine.id}', '${listed.id}', 500, 'offerer');`));
  psql(db, `insert into chess_private.market_sellers (profile_id, stripe_account_id, charges_enabled) values ('${julian.profile}', 'acct_julian_test', true);`);
  const accepted = JSON.parse(psql(db, `select chess_service.market_trade_answer('${julian.token}', '${again.id}', true, 0);`));
  assert.equal(accepted.status, 'awaiting_payment');
  assert.equal(psql(db, `select status from chess_private.market_orders where id = '${accepted.orderId}';`), 'pending');
  assert.match(fails(`select chess_service.market_ship('${julian.token}', '${accepted.orderId}', '1Z');`), /not ready to ship/);
  psql(db, `select chess_service.market_stripe_apply('evt_paid', 'checkout.session.completed', '{"orderId":"${accepted.orderId}","paymentStatus":"paid","paymentIntent":"pi_trade"}'::jsonb);`);
  assert.equal(psql(db, `select status from chess_private.market_orders where id = '${accepted.orderId}';`), 'paid');
  assert.equal(psql(db, `select quantity::text from public.chess_market_listings where id = '${listed.id}';`), '2');
  const settings = JSON.parse(psql(db, `select chess_service.push_preference('${julian.token}', '${julian.profile}', 'market_offer', false);`));
  assert.equal(settings.market_offer, false);
  assert.equal(settings.your_turn, true);
  assert.match(fails(`select chess_service.push_preference('${julian.token}', '${julian.profile}', 'spam', true);`), /not available/);
  const direct = JSON.parse(psql(db, `select chess_service.market_order_open('${mina.token}', '${listed.id}', 1, 0);`));
  assert.equal(direct.destination, 'acct_julian_test');
  assert.equal(psql(db, `select status from chess_private.market_orders where id = '${direct.orderId}';`), 'pending');
  psql(db, `select chess_service.market_stripe_apply('evt_buy', 'checkout.session.completed', '{"orderId":"${direct.orderId}","paymentStatus":"paid","paymentIntent":"pi_buy"}'::jsonb);`);
  assert.equal(psql(db, `select quantity::text from public.chess_market_listings where id = '${listed.id}';`), '1');
  psql(db, `select chess_service.market_stripe_apply('evt_buy', 'checkout.session.completed', '{"orderId":"${direct.orderId}","paymentStatus":"paid"}'::jsonb);`);
  assert.equal(psql(db, `select quantity::text from public.chess_market_listings where id = '${listed.id}';`), '1');
  const shipped = JSON.parse(psql(db, `select chess_service.market_ship('${julian.token}', '${direct.orderId}', '1Z999');`));
  assert.equal(shipped.status, 'shipped');
  psql(db, `select chess_service.market_stripe_apply('evt_refund', 'charge.refunded', '{"paymentIntent":"pi_buy"}'::jsonb);`);
  assert.equal(psql(db, `select status from chess_private.market_orders where id = '${direct.orderId}';`), 'refunded');
  assert.equal(psql(db, `select quantity::text from public.chess_market_listings where id = '${listed.id}';`), '2');
  console.log('marketplace tests passed');
} finally {
  psql('postgres', `drop database if exists ${db};`);
}

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  DEFAULT_FEE_BPS,
  STRIPE_VERSION,
  checkoutBody,
  checkoutEnabled,
  createRecipientAccount,
  feeCents,
  platformFeeBps,
  stripeEventPayload
} from './market-stripe.mjs';

assert.equal(DEFAULT_FEE_BPS, 500);
assert.equal(platformFeeBps(undefined), 500);
assert.equal(platformFeeBps(''), 500);
assert.equal(platformFeeBps('0'), 0);
assert.equal(platformFeeBps('500'), 500);
assert.equal(feeCents(4000, undefined), 200);
assert.equal(feeCents(4000, 0), 0);
assert.equal(checkoutEnabled({ secretKey: 'rk_test_fixture' }), true);
assert.equal(checkoutEnabled({ secretKey: 'sk_test_fixture' }), true);
assert.equal(checkoutEnabled({ secretKey: '' }), false);
const priced = checkoutBody({
  orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  title: 'Board',
  quantity: 1,
  unitCents: 4000,
  destination: 'acct_seller',
  fulfillment: 'shipping',
  successUrl: 'https://chess.example/ok',
  cancelUrl: 'https://chess.example/cancel'
});
assert.equal(priced.get('payment_intent_data[application_fee_amount]'), '200');
assert.equal(priced.get('integration_identifier'), 'chess.marketplace');
assert.equal(priced.get('shipping_address_collection[allowed_countries][]'), 'US');
assert.equal(priced.has('automatic_tax[enabled]'), false);
const free = checkoutBody({
  orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  title: 'Board',
  quantity: 1,
  unitCents: 4000,
  feeBps: 0,
  destination: 'acct_seller',
  successUrl: 'https://chess.example/ok',
  cancelUrl: 'https://chess.example/cancel'
});
assert.equal(free.has('payment_intent_data[application_fee_amount]'), false);
const calls = [];
await createRecipientAccount(async (url, options) => {
  calls.push({ url, key: options.headers['Idempotency-Key'], version: options.headers['Stripe-Version'] });
  if (url.includes('/v2/')) return { ok: false, text: async () => '' };
  return { ok: true, json: async () => ({ id: 'acct_created' }) };
}, 'rk_test_fixture', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
assert.equal(calls[0].url.endsWith('/v2/core/accounts'), true);
assert.equal(calls[1].key, 'chess-account-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
assert.equal(calls[1].version, STRIPE_VERSION);
assert.equal(calls[1].url.endsWith('/v1/accounts'), true);
const normalized = stripeEventPayload({
  data: { object: { object: 'checkout.session', id: 'cs_test', payment_status: 'paid', metadata: { order_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' }, shipping_details: { name: 'Ada', address: { line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } } } }
});
assert.equal(normalized.paymentStatus, 'paid');
assert.equal(normalized.shipCity, 'Austin');

const db = 'chess_fee_' + randomBytes(3).toString('hex');
const mina = { master: '11111111-1111-4111-8111-111111111111', profile: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', token: 'mina-fee-token' };
const julian = { master: '22222222-2222-4222-8222-222222222222', profile: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', token: 'julian-fee-token' };

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
function fails(sql) {
  const command = process.env.PGHOST ? ['psql', ['-d', db, '-v', 'ON_ERROR_STOP=1', '-t', '-A'], process.env] : ['sudo', ['-u', 'postgres', 'psql', '-d', db, '-v', 'ON_ERROR_STOP=1', '-t', '-A'], process.env];
  const result = spawnSync(command[0], command[1], { input: sql, encoding: 'utf8', env: command[2] });
  assert.notEqual(result.status, 0);
  return (result.stderr || result.stdout || '').trim();
}

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
  ['supabase/chess_release.sql', 'supabase/chess_discussion.sql', 'supabase/chess_human.sql', 'supabase/chess_messages.sql', 'supabase/chess_push.sql', 'supabase/chess_private_execute.sql', 'supabase/chess_market.sql', 'supabase/chess_market_stripe.sql'].forEach((file) => psqlFile(db, file));
  psql(db, `
    insert into public.chess_profiles (id, display_name) values ('${mina.profile}', 'Mina'), ('${julian.profile}', 'Julian');
    insert into chess_private.profile_owners (profile_id, owner_id) values ('${mina.profile}', '${mina.master}'), ('${julian.profile}', '${julian.master}');
    insert into chess_private.browser_sessions (token_hash, csrf_hash, master_id, profile_id, expires_at, idle_expires_at) values
      (chess_private.token_hash('${mina.token}'), chess_private.token_hash('csrf'), '${mina.master}', '${mina.profile}', clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day'),
      (chess_private.token_hash('${julian.token}'), chess_private.token_hash('csrf'), '${julian.master}', '${julian.profile}', clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day');
    insert into chess_private.admins (owner_id) values ('${mina.master}');
  `);
  const board = JSON.parse(psql(db, `select chess_service.market_save('${julian.token}', null, 'Board', 'A chess board', 'boards', 'good', 4000, 1, 'shipping', 'Austin', true);`));
  psql(db, `insert into chess_private.market_sellers (profile_id, stripe_account_id, transfers_active) values ('${julian.profile}', 'acct_julian_test', true);`);
  const first = JSON.parse(psql(db, `select chess_service.market_order_open('${mina.token}', '${board.id}', 1, null);`));
  assert.equal(first.feeCents, 200);
  assert.equal(first.reused, false);
  assert.equal(psql(db, `select quantity::text from public.chess_market_listings where id = '${board.id}';`), '0');
  const again = JSON.parse(psql(db, `select chess_service.market_order_open('${mina.token}', '${board.id}', 1, null);`));
  assert.equal(again.orderId, first.orderId);
  assert.equal(again.reused, true);
  assert.equal(psql(db, `select quantity::text from public.chess_market_listings where id = '${board.id}';`), '0');
  psql(db, `select chess_service.market_stripe_apply('evt_unpaid', 'checkout.session.completed', '{"orderId":"${first.orderId}","paymentStatus":"unpaid"}'::jsonb);`);
  assert.equal(psql(db, `select status from chess_private.market_orders where id = '${first.orderId}';`), 'pending');
  psql(db, `select chess_service.market_stripe_apply('evt_fail', 'checkout.session.async_payment_failed', '{"orderId":"${first.orderId}"}'::jsonb);`);
  assert.equal(psql(db, `select status from chess_private.market_orders where id = '${first.orderId}';`), 'canceled');
  assert.equal(psql(db, `select quantity::text from public.chess_market_listings where id = '${board.id}';`), '1');
  const paidOrder = JSON.parse(psql(db, `select chess_service.market_order_open('${mina.token}', '${board.id}', 1, 500);`));
  psql(db, `select chess_service.market_stripe_apply('evt_paid', 'checkout.session.async_payment_succeeded', '{"orderId":"${paidOrder.orderId}","paymentStatus":"paid","paymentIntent":"pi_paid","transferId":"tr_paid","shipName":"Mina","shipLine1":"1 Main","shipCity":"Austin","shipState":"TX","shipPostal":"78701","shipCountry":"US"}'::jsonb);`);
  assert.equal(psql(db, `select status || ' ' || ship_city from chess_private.market_orders where id = '${paidOrder.orderId}';`), 'paid Austin');
  assert.equal(psql(db, `select quantity::text from public.chess_market_listings where id = '${board.id}';`), '0');
  psql(db, `select chess_service.market_stripe_apply('evt_part', 'charge.refunded', '{"orderId":"${paidOrder.orderId}","amount":4000,"amountRefunded":100}'::jsonb);`);
  assert.equal(psql(db, `select status from chess_private.market_orders where id = '${paidOrder.orderId}';`), 'partially_refunded');
  assert.equal(psql(db, `select quantity::text from public.chess_market_listings where id = '${board.id}';`), '0');
  const clock = JSON.parse(psql(db, `select chess_service.market_save('${julian.token}', null, 'Clock', 'A chess clock', 'clocks', 'new', 2000, 1, 'pickup', 'Boston', false);`));
  const disputed = JSON.parse(psql(db, `select chess_service.market_order_open('${mina.token}', '${clock.id}', 1, 0);`));
  assert.equal(disputed.feeCents, 0);
  psql(db, `select chess_service.market_stripe_apply('evt_clock', 'checkout.session.completed', '{"orderId":"${disputed.orderId}","paymentStatus":"paid","paymentIntent":"pi_clock","transferId":"tr_clock"}'::jsonb);`);
  psql(db, `select chess_service.market_stripe_apply('evt_dispute', 'charge.dispute.created', '{"orderId":"${disputed.orderId}","disputeId":"dp_clock","disputeStatus":"needs_response"}'::jsonb);`);
  assert.equal(psql(db, `select status from chess_private.market_orders where id = '${disputed.orderId}';`), 'disputed');
  assert.match(fails(`select chess_service.market_ship('${julian.token}', '${disputed.orderId}', '1Z');`), /not ready to ship/);
  const lost = JSON.parse(psql(db, `select chess_service.market_stripe_apply('evt_lost', 'charge.dispute.closed', '{"orderId":"${disputed.orderId}","disputeStatus":"lost"}'::jsonb);`));
  assert.equal(lost.reverseTransfer, 'tr_clock');
  assert.equal(lost.reversalNeeded, true);
  const queue = JSON.parse(psql(db, `select chess_service.market_disputes('${mina.token}');`));
  assert.equal(queue.some((item) => item.id === disputed.orderId), true);
  psql(db, `select chess_service.market_stripe_apply('evt_off', 'account.application.deauthorized', '{"accountId":"acct_julian_test"}'::jsonb);`);
  assert.equal(psql(db, `select transfers_active::text || coalesce(stripe_account_id, '') from chess_private.market_sellers where profile_id = '${julian.profile}';`), 'false');
  const mine = JSON.parse(psql(db, `select chess_service.market_save('${mina.token}', null, 'Set', 'A chess set', 'sets', 'new', 1500, 1, 'pickup', 'Austin', true);`));
  psql(db, `insert into chess_private.market_sellers (profile_id, stripe_account_id, transfers_active) values ('${mina.profile}', 'acct_mina_test', true) on conflict (profile_id) do update set stripe_account_id = 'acct_mina_test', transfers_active = true;`);
  psql(db, `update chess_private.market_sellers set stripe_account_id = 'acct_julian_ready', transfers_active = true where profile_id = '${julian.profile}';`);
  const offer = JSON.parse(psql(db, `select chess_service.market_trade_offer('${mina.token}', '${mine.id}', '${board.id}', 800, 'offerer');`));
  const accepted = JSON.parse(psql(db, `select chess_service.market_trade_answer('${julian.token}', '${offer.id}', true, null);`));
  assert.equal(accepted.status, 'awaiting_payment');
  const tradePay = JSON.parse(psql(db, `select chess_service.market_trade_checkout('${mina.token}', '${offer.id}');`));
  assert.equal(tradePay.orderId, accepted.orderId);
  assert.equal(psql(db, `select count(*)::text from chess_private.market_orders where trade_id = '${offer.id}';`), '1');
  console.log('marketplace stripe tests passed');
} finally {
  psql('postgres', `drop database if exists ${db};`);
}

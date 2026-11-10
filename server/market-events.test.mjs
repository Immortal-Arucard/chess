import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { stripeEventPayload } from './market-stripe.mjs';

const deauthorized = stripeEventPayload({
  type: 'account.application.deauthorized',
  account: 'acct_connected',
  data: { object: { id: 'ca_application', object: 'application' } }
});
assert.equal(deauthorized.accountId, 'acct_connected');
const fallback = stripeEventPayload({
  type: 'account.application.deauthorized',
  data: { object: { id: 'acct_from_object', object: 'application' } }
});
assert.equal(fallback.accountId, 'acct_from_object');
const charge = stripeEventPayload({
  type: 'charge.succeeded',
  data: { object: { id: 'ch_1', object: 'charge', transfer: 'tr_1', payment_intent: 'pi_1', metadata: { order_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' } } }
});
assert.equal(charge.transferId, 'tr_1');
assert.equal(charge.chargeId, 'ch_1');
assert.equal(charge.orderId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
const transfer = stripeEventPayload({
  type: 'transfer.created',
  data: { object: { id: 'tr_2', object: 'transfer', source_transaction: 'ch_1', transfer_group: 'group_pi_1' } }
});
assert.equal(transfer.transferId, 'tr_2');
assert.equal(transfer.chargeId, 'ch_1');
assert.equal(transfer.transferGroup, 'group_pi_1');

const db = 'chess_evt_' + randomBytes(3).toString('hex');
const mina = { master: '11111111-1111-4111-8111-111111111111', profile: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', token: 'mina-event-token' };
const julian = { master: '22222222-2222-4222-8222-222222222222', profile: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', token: 'julian-event-token' };

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
  return psql(db, sql).split('\n').filter((line) => line && !['SET', 'RESET', 'BEGIN', 'ROLLBACK', 'GRANT'].includes(line)).join('\n');
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
  ['supabase/chess_release.sql', 'supabase/chess_discussion.sql', 'supabase/chess_human.sql', 'supabase/chess_messages.sql', 'supabase/chess_push.sql', 'supabase/chess_private_execute.sql', 'supabase/chess_market.sql', 'supabase/chess_market_stripe.sql', 'supabase/chess_market_events.sql'].forEach((file) => psqlFile(db, file));
  const forced = psql(db, `select string_agg(c.relname || ':' || c.relrowsecurity::text || ',' || c.relforcerowsecurity::text, ' ' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'chess_private' and c.relname like 'market_%' and c.relkind = 'r';`);
  for (const name of ['market_orders', 'market_photos', 'market_reports', 'market_sellers', 'market_stripe_events', 'market_trades']) {
    assert.equal(forced.includes(name + ':true,true'), true, forced);
  }
  psql(db, `
    insert into public.chess_profiles (id, display_name) values ('${mina.profile}', 'Mina'), ('${julian.profile}', 'Julian');
    insert into chess_private.profile_owners (profile_id, owner_id) values ('${mina.profile}', '${mina.master}'), ('${julian.profile}', '${julian.master}');
    insert into chess_private.browser_sessions (token_hash, csrf_hash, master_id, profile_id, expires_at, idle_expires_at) values
      (chess_private.token_hash('${mina.token}'), chess_private.token_hash('csrf'), '${mina.master}', '${mina.profile}', clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day'),
      (chess_private.token_hash('${julian.token}'), chess_private.token_hash('csrf'), '${julian.master}', '${julian.profile}', clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day');
    insert into chess_private.admins (owner_id) values ('${mina.master}');
    insert into chess_private.market_sellers (profile_id, stripe_account_id, transfers_active) values ('${julian.profile}', 'acct_connected', true);
  `);
  const board = JSON.parse(psql(db, `select chess_service.market_save('${julian.token}', null, 'Board', 'A chess board', 'boards', 'good', 4000, 1, 'shipping', 'Austin', false);`));
  const order = JSON.parse(psql(db, `select chess_service.market_order_open('${mina.token}', '${board.id}', 1, 500);`));
  psql(db, `select chess_service.market_stripe_apply('evt_paid', 'checkout.session.completed', '{"orderId":"${order.orderId}","paymentStatus":"paid","paymentIntent":"pi_1"}'::jsonb);`);
  const stored = JSON.parse(psql(db, `select chess_service.market_stripe_apply('evt_charge', 'charge.succeeded', '{"orderId":"${order.orderId}","paymentIntent":"pi_1","chargeId":"ch_1","transferId":"tr_1"}'::jsonb);`));
  assert.deepEqual(stored, {});
  assert.equal(psql(db, `select transfer_id || ' ' || stripe_charge_id from chess_private.market_orders where id = '${order.orderId}';`), 'tr_1 ch_1');
  psql(db, `select chess_service.market_stripe_apply('evt_expired', 'checkout.session.expired', '{"orderId":"${order.orderId}"}'::jsonb);`);
  psql(db, `select chess_service.market_stripe_apply('evt_fail', 'checkout.session.async_payment_failed', '{"orderId":"${order.orderId}"}'::jsonb);`);
  psql(db, `select chess_service.market_stripe_apply('evt_pi', 'payment_intent.payment_failed', '{"paymentIntent":"pi_1"}'::jsonb);`);
  assert.equal(psql(db, `select status from chess_private.market_orders where id = '${order.orderId}';`), 'paid');
  psql(db, `select chess_service.market_stripe_apply('evt_dispute', 'charge.dispute.created', '{"orderId":"${order.orderId}","disputeId":"dp_1","disputeStatus":"needs_response"}'::jsonb);`);
  const lost = JSON.parse(psql(db, `select chess_service.market_stripe_apply('evt_lost', 'charge.dispute.closed', '{"orderId":"${order.orderId}","disputeStatus":"lost"}'::jsonb);`));
  assert.equal(lost.reverseTransfer, 'tr_1');
  const viaTransfer = JSON.parse(psql(db, `select chess_service.market_save('${julian.token}', null, 'Clock', 'A chess clock', 'clocks', 'new', 2000, 1, 'pickup', 'Boston', false);`));
  const second = JSON.parse(psql(db, `select chess_service.market_order_open('${mina.token}', '${viaTransfer.id}', 1, 500);`));
  psql(db, `select chess_service.market_stripe_apply('evt_paid2', 'checkout.session.completed', '{"orderId":"${second.orderId}","paymentStatus":"paid","paymentIntent":"pi_2"}'::jsonb);`);
  psql(db, `select chess_service.market_stripe_apply('evt_transfer', 'transfer.created', '{"chargeId":"ch_missing","transferId":"tr_2","transferGroup":"group_pi_2"}'::jsonb);`);
  assert.equal(psql(db, `select transfer_id from chess_private.market_orders where id = '${second.orderId}';`), 'tr_2');
  psql(db, `select chess_service.market_stripe_apply('evt_off', 'account.application.deauthorized', '{"accountId":"acct_connected"}'::jsonb);`);
  assert.equal(psql(db, `select transfers_active::text || coalesce(stripe_account_id, '') from chess_private.market_sellers where profile_id = '${julian.profile}';`), 'false');
  assert.equal(quiet(`
    begin;
    grant usage on schema chess_private to authenticated;
    grant select on chess_private.market_orders to authenticated;
    set local role authenticated;
    select count(*)::text from chess_private.market_orders;
    rollback;
  `), '0');
  const visible = JSON.parse(psql(db, `select chess_service.market_orders('${mina.token}', 'orders');`));
  assert.equal(visible.length, 2);
  console.log('marketplace event tests passed');
} finally {
  psql('postgres', `drop database if exists ${db};`);
}

import { createServer } from 'node:https';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from 'node:https';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { deliverDue, sendPushNotification } from './push-send.mjs';

const db = 'chess_push_' + randomBytes(3).toString('hex');
const mina = { master: '11111111-1111-4111-8111-111111111111', profile: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', token: 'mina-push-token' };
const julian = { master: '22222222-2222-4222-8222-222222222222', profile: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', token: 'julian-push-token' };

function psql(database, sql) {
  const command = process.env.PGHOST ? ['psql', ['-d', database, '-v', 'ON_ERROR_STOP=1', '-t', '-A'], process.env] : ['sudo', ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-t', '-A'], process.env];
  const result = spawnSync(command[0], command[1], { input: sql, encoding: 'utf8', env: command[2] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return (result.stdout || '').trim();
}
function psqlFile(database, file) {
  const command = process.env.PGHOST ? ['psql', ['-d', database, '-v', 'ON_ERROR_STOP=1', '-f', file], process.env] : ['sudo', ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', file], process.env];
  const result = spawnSync(command[0], command[1], { encoding: 'utf8', env: command[2] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
function kinds(profile) {
  const text = psql(db, `select kind from chess_private.notification_events where recipient_id = '${profile}' and actor_id is distinct from recipient_id order by kind;`);
  return text ? text.split('\n') : [];
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
  for (const file of [
    'supabase/chess_release.sql',
    'supabase/chess_discussion.sql',
    'supabase/chess_profile_card.sql',
    'supabase/chess_human.sql',
    'supabase/chess_roster.sql',
    'supabase/chess_ratings.sql',
    'supabase/chess_puzzles.sql',
    'supabase/chess_puzzle_serial.sql',
    'supabase/chess_messages.sql',
    'supabase/chess_push.sql'
  ]) psqlFile(db, file);
  psql(db, `
    insert into auth.users (id) values ('${mina.master}'), ('${julian.master}');
    insert into public.chess_profiles (id, display_name) values ('${mina.profile}', 'Mina'), ('${julian.profile}', 'Julian');
    insert into chess_private.profile_owners (profile_id, owner_id) values ('${mina.profile}', '${mina.master}'), ('${julian.profile}', '${julian.master}');
    insert into chess_private.browser_sessions (token_hash, csrf_hash, master_id, profile_id, expires_at, idle_expires_at) values
      (chess_private.token_hash('${mina.token}'), chess_private.token_hash('csrf'), '${mina.master}', '${mina.profile}', clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day'),
      (chess_private.token_hash('${julian.token}'), chess_private.token_hash('csrf'), '${julian.master}', '${julian.profile}', clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day');
  `);
  const challenge = JSON.parse(psql(db, `select chess_service.human_create('${mina.token}', '${mina.profile}', 'named', 'white', 'blitz', '3+2', 180000, 2000, null, '${julian.profile}', false);`));
  psql(db, `select chess_service.notification_from_game('${mina.token}', '${challenge.id}');`);
  assert.deepEqual(kinds(julian.profile), ['challenged']);
  assert.deepEqual(kinds(mina.profile), []);
  psql(db, `select chess_service.human_decline('${julian.token}', '${julian.profile}', '${challenge.id}');`);
  psql(db, `select chess_service.notification_from_game('${julian.token}', '${challenge.id}');`);
  assert.ok(kinds(mina.profile).includes('challenge_declined'));
  assert.equal(kinds(julian.profile).includes('challenge_declined'), false);

  const again = JSON.parse(psql(db, `select chess_service.human_create('${mina.token}', '${mina.profile}', 'named', 'white', 'blitz', '3+2', 180000, 2000, null, '${julian.profile}', false);`));
  const accepted = JSON.parse(psql(db, `select chess_service.human_accept('${julian.token}', '${julian.profile}', '${again.id}', null);`));
  psql(db, `select chess_service.notification_from_game('${julian.token}', '${again.id}');`);
  assert.ok(kinds(mina.profile).includes('challenge_accepted'));
  assert.ok(kinds(mina.profile).includes('your_turn'));
  assert.equal(kinds(julian.profile).includes('your_turn'), false);
  psql(db, `select chess_service.human_resign('${mina.token}', '${mina.profile}', '${again.id}', ${accepted.version});`);
  psql(db, `select chess_service.notification_from_game('${mina.token}', '${again.id}');`);
  assert.ok(kinds(julian.profile).includes('game_result'));
  assert.equal(kinds(mina.profile).includes('game_result'), false);
  const self = psql(db, `select count(*)::text from chess_private.notification_events where recipient_id = actor_id;`);
  assert.equal(self, '0');

  const endpoint = 'http://127.0.0.1:9/gone';
  psql(db, `select chess_service.push_save('${julian.token}', '${julian.profile}', '${endpoint}', 'key', 'auth');`);
  psql(db, `select chess_service.push_preference('${julian.token}', '${julian.profile}', 'your_turn', false);`);
  const settings = JSON.parse(psql(db, `select chess_service.push_settings('${julian.token}');`));
  assert.equal(settings.your_turn, false);
  assert.equal(settings.mention, true);
  const before = psql(db, `select count(*)::text from chess_private.notification_events where recipient_id = '${julian.profile}' and kind = 'your_turn' and delivered_at is null;`);
  assert.equal(before, '0');
  psql(db, `select chess_service.push_due();`);
  const skipped = psql(db, `select count(*)::text from chess_private.notification_events where recipient_id = '${mina.profile}' and kind = 'your_turn' and delivered_at is null;`);
  assert.equal(skipped, '1');
  psql(db, `select chess_service.push_forget('${endpoint}');`);
  assert.equal(psql(db, `select count(*)::text from chess_private.push_subscriptions;`), '0');
  console.log('push event tests passed');
} finally {
  psql('postgres', `drop database if exists ${db};`);
}

const keys = webpush.generateVAPIDKeys();
const certDir = mkdtempSync(join(tmpdir(), 'chess-push-'));
const keyPath = join(certDir, 'key.pem');
const certPath = join(certDir, 'cert.pem');
const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1']);
if (made.status !== 0) throw new Error(made.stderr && made.stderr.toString());
const server = createServer({
  key: readFileSync(keyPath),
  cert: readFileSync(certPath)
}, (req, res) => {
  res.writeHead(410);
  res.end('gone');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = 'https://127.0.0.1:' + server.address().port + '/push';
const agent = new Agent({ rejectUnauthorized: false });
try {
  const gone = await sendPushNotification({
    subscription: {
      endpoint,
      p256dh: 'BL7ELU24fJTAlH5Kyl8N6BDCac8u8li_U5PIwG963MOvdYs9s7LSzj8x_7v7RFdLZ9Eap50PiiyF5K0TDAis7t0',
      auth: 'juarI8x__VnHvsOgfeAPHg'
    },
    payload: { title: 'Chess', body: 'gone', url: '/human/' },
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subject: 'mailto:cubzub@gmail.com',
    agent
  });
  assert.equal(gone.gone, true);
  assert.equal(gone.status, 410);
  const calls = [];
  const query = async (sql, params) => {
    calls.push(sql + ' ' + JSON.stringify(params || []));
    if (sql.includes('push_due')) {
      return { rows: [{ due: [{ id: '11111111-1111-4111-8111-111111111111', kind: 'mention', title: 'Mina', body: 'tagged', url: '/community/discussion/', subscriptions: [{ endpoint, p256dh: 'BL7ELU24fJTAlH5Kyl8N6BDCac8u8li_U5PIwG963MOvdYs9s7LSzj8x_7v7RFdLZ9Eap50PiiyF5K0TDAis7t0', auth: 'juarI8x__VnHvsOgfeAPHg' }] }] }] };
    }
    return { rows: [{}] };
  };
  assert.equal(await deliverDue(query, { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:cubzub@gmail.com', agent }), 1);
  assert.equal(calls.some((line) => line.includes('push_forget') && line.includes(endpoint)), true);
  assert.equal(calls.some((line) => line.includes('push_mark')), true);
  console.log('push send tests passed');
} finally {
  server.close();
}

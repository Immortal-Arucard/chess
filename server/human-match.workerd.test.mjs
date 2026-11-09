import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import assert from 'node:assert/strict';
import { unstable_dev } from './node_modules/wrangler/wrangler-dist/cli.js';

const db = 'chess_human_' + randomBytes(3).toString('hex');
const password = randomBytes(12).toString('hex');
const configPath = '/tmp/chess-human-wrangler.jsonc';
const mina = { master: '11111111-1111-4111-8111-111111111111', profile: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', name: 'Mina Chen', token: 'mina-human-session-token', csrf: 'mina-human-csrf-token' };
const julian = { master: '22222222-2222-4222-8222-222222222222', profile: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', name: 'Julian Park', token: 'julian-human-session-token', csrf: 'julian-human-csrf-token' };
const nora = { master: '33333333-3333-4333-8333-333333333333', profile: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3', name: 'Nora Ellison', token: 'nora-human-session-token', csrf: 'nora-human-csrf-token' };

function psql(database, sql) {
  const command = process.env.PGHOST ? ['psql', ['-d', database, '-v', 'ON_ERROR_STOP=1'], process.env] : ['sudo', ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1'], process.env];
  const result = spawnSync(command[0], command[1], { input: sql, encoding: 'utf8', env: command[2] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
function psqlFile(database, file) {
  const command = process.env.PGHOST ? ['psql', ['-d', database, '-v', 'ON_ERROR_STOP=1', '-f', file], process.env] : ['sudo', ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', file], process.env];
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

psql('postgres', `drop database if exists ${db}; create database ${db};`);
psql(db, `
  create schema if not exists auth;
  create table auth.users (id uuid primary key);
  do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
  create schema if not exists extensions;
  create extension if not exists pgcrypto schema extensions;
`);
psqlFile(db, 'supabase/chess_release.sql');
psqlFile(db, 'supabase/chess_discussion.sql');
psqlFile(db, 'supabase/chess_profile_card.sql');
psqlFile(db, 'supabase/chess_human.sql');
psql(db, `alter role chess_server login password '${password}'; grant connect on database ${db} to chess_server; ${seed(mina)} ${seed(julian)} ${seed(nora)}`);
const host = process.env.PGHOST || '127.0.0.1';
const port = process.env.PGPORT || '5432';
writeFileSync(configPath, JSON.stringify({
  name: 'chess-api-human',
  main: 'server/worker.mjs',
  compatibility_date: '2026-11-08',
  compatibility_flags: ['nodejs_compat'],
  vars: { CHESS_ORIGIN: 'http://chess.example', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'publishable-test-key' },
  hyperdrive: [{ binding: 'HYPERDRIVE', id: '0123456789abcdef0123456789abcdef', localConnectionString: `postgres://chess_server:${encodeURIComponent(password)}@${host}:${port}/${db}` }]
}, null, 2));

function headers(person, json) {
  return {
    origin: 'http://chess.example',
    cookie: `__Host-chess_session=${person.token}; chess_csrf=${person.csrf}`,
    ...(json ? { 'content-type': 'application/json', 'x-csrf-token': person.csrf } : {})
  };
}
async function call(worker, person, method, path, body) {
  const response = await worker.fetch('https://chess.example' + path, {
    method,
    headers: headers(person, method !== 'GET'),
    body: body ? JSON.stringify(Object.assign({ authorId: person.profile }, body)) : undefined
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { json = null; }
  return { status: response.status, json, text };
}

const worker = await unstable_dev('server/worker.mjs', {
  config: configPath,
  local: true,
  ip: '127.0.0.1',
  experimental: { disableExperimentalWarning: true }
});
try {
  const search = await call(worker, mina, 'GET', '/api/human/search?q=Julian');
  assert.equal(search.status, 200, search.text);
  assert.equal(search.json.profiles[0].id, julian.profile);
  assert.equal(JSON.stringify(search.json).includes(julian.master), false);
  const named = await call(worker, mina, 'POST', '/api/human/challenges', { kind: 'named', opponentId: julian.profile, color: 'white', category: 'blitz', preset: '3+2', rated: false });
  assert.equal(named.status, 200, named.text);
  assert.equal(named.json.category, 'blitz');
  assert.equal(named.json.timeLabel, '3+2');
  assert.equal(named.json.creatorColor, 'white');
  assert.ok(named.json.invite);
  const incoming = await call(worker, julian, 'GET', '/api/human/incoming');
  assert.equal(incoming.json.games[0].timeLabel, '3+2');
  assert.equal(incoming.json.games[0].creatorColor, 'white');
  const accepted = await call(worker, julian, 'POST', '/api/human/accept', { id: named.json.id });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.json.status, 'active');
  assert.equal(accepted.json.myColor, 'black');
  const e4 = await call(worker, mina, 'POST', '/api/human/move', { id: named.json.id, version: accepted.json.version, san: 'e4' });
  assert.equal(e4.status, 200, e4.text);
  assert.deepEqual(e4.json.sans, ['e4']);
  const stolen = await call(worker, mina, 'POST', '/api/human/move', { id: named.json.id, version: e4.json.version, san: 'd4' });
  assert.equal(stolen.status, 400);
  assert.equal(stolen.json.error, 'It is not your turn.');
  const illegal = await call(worker, julian, 'POST', '/api/human/move', { id: named.json.id, version: e4.json.version, san: 'Nf3' });
  assert.equal(illegal.status, 400);
  assert.equal(illegal.json.error, 'That move is not legal.');
  const e5 = await call(worker, julian, 'POST', '/api/human/move', { id: named.json.id, version: e4.json.version, san: 'e5' });
  assert.equal(e5.status, 200, e5.text);
  const chat = await call(worker, mina, 'POST', '/api/human/chat', { id: named.json.id, body: 'Good game so far.' });
  assert.equal(chat.status, 200, chat.text);
  assert.equal(chat.json.messages[0].body, 'Good game so far.');
  assert.equal(chat.json.messages[0].authorName, 'Mina Chen');
  const outsider = await call(worker, nora, 'POST', '/api/human/chat', { id: named.json.id, body: 'I should not be here.' });
  assert.equal(outsider.status, 400);
  const recorded = await call(worker, mina, 'POST', '/api/human/record', { id: named.json.id });
  assert.equal(recorded.json.iAmRecording, true);
  const resigned = await call(worker, mina, 'POST', '/api/human/resign', { id: named.json.id, version: e5.json.version });
  assert.equal(resigned.status, 200, resigned.text);
  assert.equal(resigned.json.result, '0-1');
  assert.equal(resigned.json.termination, 'resign');
  const minaHistory = await call(worker, mina, 'GET', '/api/human/results');
  const julianHistory = await call(worker, julian, 'GET', '/api/human/results');
  assert.equal(minaHistory.json.games[0].category, 'blitz');
  assert.equal(minaHistory.json.games[0].timeLabel, '3+2');
  assert.equal(minaHistory.json.games[0].dialogueRecorded, true);
  assert.equal(minaHistory.json.games[0].dialogue[0].body, 'Good game so far.');
  assert.equal(julianHistory.json.games[0].dialogueRecorded, false);
  assert.equal(julianHistory.json.games[0].dialogue, null);
  const again = await call(worker, mina, 'POST', '/api/human/record', { id: named.json.id });
  assert.equal(again.status, 400);
  assert.equal(again.json.error, 'This dialogue is already saved with your game.');

  const pub = await call(worker, mina, 'POST', '/api/human/challenges', { kind: 'public', color: 'random', category: 'rapid', preset: '10+0' });
  assert.equal(pub.json.kind, 'public');
  const own = await call(worker, mina, 'POST', '/api/human/accept', { id: pub.json.id });
  assert.equal(own.json.error, 'You cannot claim your own challenge.');
  const claim = await call(worker, julian, 'POST', '/api/human/accept', { id: pub.json.id });
  assert.equal(claim.status, 200, claim.text);
  assert.equal(claim.json.status, 'active');
  const late = await call(worker, nora, 'POST', '/api/human/accept', { id: pub.json.id });
  assert.equal(late.json.error, 'That challenge is no longer open.');
  const lobby = await call(worker, nora, 'GET', '/api/human/lobby');
  assert.equal(lobby.json.games.find((game) => game.id === pub.json.id), undefined);

  const daily = await call(worker, mina, 'POST', '/api/human/challenges', { kind: 'public', color: 'white', category: 'daily', preset: '1d' });
  const started = await call(worker, julian, 'POST', '/api/human/accept', { id: daily.json.id });
  assert.equal(started.json.category, 'daily');
  assert.equal(started.json.timeLabel, '1 day');
  psql(db, `update chess_private.human_matches set deadline_at = clock_timestamp() - interval '1 minute' where id = '${daily.json.id}';`);
  const expired = await call(worker, mina, 'GET', '/api/human/games/' + daily.json.id);
  assert.equal(expired.json.status, 'finished', expired.text);
  assert.equal(expired.json.termination, 'timeout');
  assert.equal(expired.json.result, '0-1');
  const flagged = await call(worker, mina, 'POST', '/api/human/challenges', { kind: 'named', opponentId: julian.profile, color: 'white', category: 'bullet', preset: '1+0' });
  const live = await call(worker, julian, 'POST', '/api/human/accept', { id: flagged.json.id });
  psql(db, `update chess_private.human_matches set clock_at = clock_timestamp() - interval '2 minutes' where id = '${flagged.json.id}';`);
  const tooLate = await call(worker, mina, 'POST', '/api/human/move', { id: flagged.json.id, version: live.json.version, san: 'e4' });
  assert.equal(tooLate.json.termination, 'timeout', tooLate.text);
  assert.deepEqual(tooLate.json.sans, []);
  console.log('human match workerd tests passed');
} finally {
  await worker.stop();
  unlinkSync(configPath);
  psql('postgres', `drop database if exists ${db};`);
}

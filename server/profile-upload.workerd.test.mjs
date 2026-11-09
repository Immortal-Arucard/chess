import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import assert from 'node:assert/strict';
import { unstable_dev } from './node_modules/wrangler/wrangler-dist/cli.js';
import { sanitizeProfileImage } from './profile-image.mjs';

const db = 'chess_pic_' + randomBytes(3).toString('hex');
const password = randomBytes(12).toString('hex');
const configPath = '/tmp/chess-picture-wrangler.jsonc';
const master = '11111111-1111-4111-8111-111111111111';
const profile = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const token = 'session-token-profile-picture-save';
const csrf = 'csrf-token-profile-picture-save';
const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda00080001000100003f00fbffd9', 'hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const webp = Buffer.from('524946463800000057454250565038202c0000009001009d012a0200020002003425a00274ba00039800fef9936fff901fff901fff901fff203fe2177b203000', 'hex');

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

psql('postgres', `drop database if exists ${db}; create database ${db};`);
psql(db, `
  create schema if not exists auth;
  create table auth.users (id uuid primary key);
  insert into auth.users (id) values ('${master}');
  do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
  create schema if not exists extensions;
  create extension if not exists pgcrypto schema extensions;
`);
psqlFile(db, 'supabase/chess_release.sql');
psqlFile(db, 'supabase/chess_discussion.sql');
psqlFile(db, 'supabase/chess_profile_card.sql');
psql(db, `
  alter role chess_server login password '${password}';
  grant connect on database ${db} to chess_server;
  insert into public.chess_profiles (id, display_name) values ('${profile}', 'Ada');
  insert into chess_private.profile_owners (profile_id, owner_id) values ('${profile}', '${master}');
  insert into chess_private.browser_sessions (token_hash, csrf_hash, master_id, profile_id, expires_at, idle_expires_at)
  values (
    chess_private.token_hash('${token}'),
    chess_private.token_hash('${csrf}'),
    '${master}',
    '${profile}',
    clock_timestamp() + interval '1 day',
    clock_timestamp() + interval '1 day'
  );
`);
const host = process.env.PGHOST || '127.0.0.1';
const port = process.env.PGPORT || '5432';
writeFileSync(configPath, JSON.stringify({
  name: 'chess-api-picture',
  main: 'server/worker.mjs',
  compatibility_date: '2026-11-08',
  compatibility_flags: ['nodejs_compat'],
  vars: {
    CHESS_ORIGIN: 'http://chess.example',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'publishable-test-key'
  },
  hyperdrive: [{
    binding: 'HYPERDRIVE',
    id: '0123456789abcdef0123456789abcdef',
    localConnectionString: `postgres://chess_server:${encodeURIComponent(password)}@${host}:${port}/${db}`
  }]
}, null, 2));

function headers(type) {
  return {
    origin: 'http://chess.example',
    cookie: `__Host-chess_session=${token}; chess_csrf=${csrf}`,
    'content-type': type,
    'x-csrf-token': csrf,
    'x-chess-profile': profile
  };
}

async function upload(worker, kind, bytes, type) {
  const response = await worker.fetch('https://chess.example/api/profile/' + kind, {
    method: 'POST',
    headers: headers(type),
    body: bytes
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const fetched = await worker.fetch('https://chess.example/api/profiles/' + profile + '/' + kind);
  const body = Buffer.from(await fetched.arrayBuffer());
  assert.equal(fetched.status, 200, body.slice(0, 80).toString('utf8'));
  assert.equal(fetched.headers.get('content-type'), type);
  assert.equal(fetched.headers.get('x-content-type-options'), 'nosniff');
  const expected = sanitizeProfileImage(bytes, type).bytes;
  assert.equal(Buffer.compare(body, expected), 0);
  assert.equal(body[0], expected[0]);
}

let worker;
try {
  worker = await unstable_dev('server/worker.mjs', {
    config: configPath,
    local: true,
    ip: '127.0.0.1',
    experimental: { disableExperimentalWarning: true }
  });
  await upload(worker, 'portrait', jpeg, 'image/jpeg');
  await upload(worker, 'background', png, 'image/png');
  await upload(worker, 'portrait', webp, 'image/webp');
  const card = await worker.fetch('https://chess.example/api/profiles/' + profile);
  const cardJson = await card.json();
  assert.equal(cardJson.hasPortrait, true);
  assert.equal(cardJson.hasBackground, true);
  assert.equal(JSON.stringify(cardJson).includes(master), false);
  const tooBig = await worker.fetch('https://chess.example/api/profile/background', {
    method: 'POST',
    headers: headers('image/jpeg'),
    body: Buffer.alloc(600 * 1024, 0xff)
  });
  const tooBigJson = await tooBig.json();
  assert.equal(tooBig.status, 400);
  assert.equal(tooBigJson.error, 'Use a JPEG, PNG, or WebP image up to 512 KB.');
  const other = await worker.fetch('https://chess.example/api/profile/portrait', {
    method: 'POST',
    headers: Object.assign(headers('image/jpeg'), { 'x-chess-profile': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    body: jpeg
  });
  assert.equal(other.status, 400);
  assert.equal((await other.json()).error, 'You can edit only your own Chess profile.');
  console.log('workerd profile picture round trip passed');
} finally {
  if (worker) await worker.stop();
  unlinkSync(configPath);
  psql('postgres', `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${db}' and pid <> pg_backend_pid()`);
  psql('postgres', `drop database if exists ${db}`);
}

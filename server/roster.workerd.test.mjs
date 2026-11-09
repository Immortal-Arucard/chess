import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import assert from 'node:assert/strict';
import { unstable_dev } from './node_modules/wrangler/wrangler-dist/cli.js';

const db = 'chess_roster_' + randomBytes(3).toString('hex');
const password = randomBytes(12).toString('hex');
const configPath = '/tmp/chess-roster-wrangler.jsonc';
const masters = {
  julian: '11111111-1111-4111-8111-111111111111',
  mina: '22222222-2222-4222-8222-222222222222',
  nora: '33333333-3333-4333-8333-333333333333'
};
const profiles = {
  julian: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  mina: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  nora: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
};

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
  do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
  create schema if not exists extensions;
  create extension if not exists pgcrypto schema extensions;
`);
['supabase/chess_release.sql', 'supabase/chess_discussion.sql', 'supabase/chess_profile_card.sql', 'supabase/chess_human.sql', 'supabase/chess_roster.sql', 'supabase/chess_ratings.sql'].forEach((file) => psqlFile(db, file));
psql(db, `
  alter role chess_server login password '${password}';
  grant connect on database ${db} to chess_server;
  insert into auth.users (id) values ('${masters.julian}'), ('${masters.mina}'), ('${masters.nora}');
  insert into public.chess_profiles (id, display_name, created_at) values
    ('${profiles.julian}', 'Julian Park', '2026-01-01T00:00:00Z'),
    ('${profiles.mina}', 'Mina Chen', '2026-02-01T00:00:00Z'),
    ('${profiles.nora}', 'Nora <b>Ellison</b>', '2026-03-01T00:00:00Z');
  insert into chess_private.profile_owners (profile_id, owner_id) values
    ('${profiles.julian}', '${masters.julian}'),
    ('${profiles.mina}', '${masters.mina}'),
    ('${profiles.nora}', '${masters.nora}');
`);
const host = process.env.PGHOST || '127.0.0.1';
const port = process.env.PGPORT || '5432';
writeFileSync(configPath, JSON.stringify({
  name: 'chess-api-roster',
  main: 'server/worker.mjs',
  compatibility_date: '2026-11-08',
  compatibility_flags: ['nodejs_compat'],
  vars: { CHESS_ORIGIN: 'http://chess.example', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'publishable-test-key' },
  hyperdrive: [{ binding: 'HYPERDRIVE', id: '0123456789abcdef0123456789abcdef', localConnectionString: `postgres://chess_server:${encodeURIComponent(password)}@${host}:${port}/${db}` }]
}, null, 2));

async function call(worker, path) {
  const response = await worker.fetch('https://chess.example' + path, { method: 'GET', headers: { origin: 'http://chess.example' } });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { json = null; }
  return { status: response.status, json, text };
}

const worker = await unstable_dev('server/worker.mjs', { config: configPath, local: true, ip: '127.0.0.1', experimental: { disableExperimentalWarning: true } });
try {
  const all = await call(worker, '/api/community/roster');
  assert.equal(all.status, 200, all.text);
  assert.equal(all.json.total, 3);
  assert.equal(all.json.sort, 'name');
  assert.equal(all.json.ratingSort, false);
  assert.deepEqual(all.json.members.map((member) => member.displayName), ['Julian Park', 'Mina Chen', 'Nora <b>Ellison</b>']);
  all.json.members.forEach((member) => {
    assert.deepEqual(member.ratings, { bullet: 0, blitz: 0, rapid: 0, daily: 0, untimed: 0, puzzles: null });
    assert.equal(typeof member.hasPortrait, 'boolean');
    assert.equal(member.email, undefined);
    assert.equal(member.ownerId, undefined);
  });
  assert.equal(all.text.includes(masters.julian), false);
  assert.equal(all.text.includes(masters.mina), false);
  assert.equal(all.text.includes(masters.nora), false);
  assert.equal(all.text.includes('owner_id'), false);
  const found = await call(worker, '/api/community/roster?q=' + encodeURIComponent('park'));
  assert.equal(found.json.total, 1);
  assert.equal(found.json.members[0].id, profiles.julian);
  const newest = await call(worker, '/api/community/roster?sort=newest');
  assert.deepEqual(newest.json.members.map((member) => member.id), [profiles.nora, profiles.mina, profiles.julian]);
  const ratedOrder = await call(worker, '/api/community/roster?sort=rating');
  assert.equal(ratedOrder.json.sort, 'name');
  assert.equal(ratedOrder.json.ratingSort, false);
  assert.equal(ratedOrder.json.ratingRequested, true);
  assert.deepEqual(ratedOrder.json.members.map((member) => member.displayName), ['Julian Park', 'Mina Chen', 'Nora <b>Ellison</b>']);
  const first = await call(worker, '/api/community/roster?limit=1');
  assert.equal(first.json.members.length, 1);
  assert.equal(first.json.members[0].id, profiles.julian);
  assert.equal(first.json.next.id, profiles.julian);
  const second = await call(worker, '/api/community/roster?limit=1&beforeId=' + first.json.next.id + '&beforeName=' + encodeURIComponent(first.json.next.name));
  assert.equal(second.json.members[0].id, profiles.mina);
  const third = await call(worker, '/api/community/roster?limit=1&beforeId=' + second.json.next.id + '&beforeName=' + encodeURIComponent(second.json.next.name));
  assert.equal(third.json.members[0].id, profiles.nora);
  assert.equal(third.json.next, null);
  psql(db, `insert into chess_private.profile_ratings (profile_id, category, rating) values ('${profiles.mina}', 'blitz', 1510);`);
  const withRating = await call(worker, '/api/community/roster?q=' + encodeURIComponent('Mina'));
  assert.equal(withRating.json.members[0].ratings.blitz, 1510);
  assert.equal(withRating.json.members[0].ratings.bullet, 0);
  assert.equal(withRating.json.members[0].ratings.rapid, 0);
  assert.equal(withRating.json.members[0].ratings.daily, 0);
  assert.equal(withRating.json.members[0].ratings.untimed, 0);
  assert.equal(withRating.json.members[0].ratings.puzzles, null);
  const byBlitz = await call(worker, '/api/community/roster?sort=blitz');
  assert.equal(byBlitz.json.ratingSort, true);
  assert.equal(byBlitz.json.sort, 'blitz');
  assert.equal(byBlitz.json.members[0].id, profiles.mina);
  const tooLong = await call(worker, '/api/community/roster?q=' + encodeURIComponent('x'.repeat(41)));
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.json.error, 'A name search can be at most 40 characters.');
  console.log('community roster workerd tests passed');
} finally {
  await worker.stop();
  unlinkSync(configPath);
  psql('postgres', `drop database if exists ${db};`);
}

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import assert from 'node:assert/strict';
import { unstable_dev } from './node_modules/wrangler/wrangler-dist/cli.js';
import { drawShares, ratingResult, winGain } from '../assets/chess/rating.js';

const db = 'chess_rate_' + randomBytes(3).toString('hex');
const password = randomBytes(12).toString('hex');
const configPath = '/tmp/chess-rating-wrangler.jsonc';
const mina = { master: '11111111-1111-4111-8111-111111111111', profile: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', name: 'Mina Chen', token: 'mina-rate-token', csrf: 'mina-rate-csrf' };
const julian = { master: '22222222-2222-4222-8222-222222222222', profile: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', name: 'Julian Park', token: 'julian-rate-token', csrf: 'julian-rate-csrf' };

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
function seed(person) {
  return `
    insert into auth.users (id) values ('${person.master}');
    insert into public.chess_profiles (id, display_name) values ('${person.profile}', '${person.name}');
    insert into chess_private.profile_owners (profile_id, owner_id) values ('${person.profile}', '${person.master}');
    insert into chess_private.browser_sessions (token_hash, csrf_hash, master_id, profile_id, expires_at, idle_expires_at)
    values (chess_private.token_hash('${person.token}'), chess_private.token_hash('${person.csrf}'), '${person.master}', '${person.profile}', clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day');
  `;
}
function setRating(profile, category, rating) {
  psql(db, `
    insert into chess_private.profile_ratings (profile_id, category, rating)
    values ('${profile}', '${category}', ${rating})
    on conflict (profile_id, category) do update set rating = ${rating};
  `);
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
['supabase/chess_release.sql', 'supabase/chess_discussion.sql', 'supabase/chess_profile_card.sql', 'supabase/chess_human.sql', 'supabase/chess_roster.sql', 'supabase/chess_ratings.sql', 'supabase/chess_puzzles.sql'].forEach((file) => psqlFile(db, file));
psql(db, `alter role chess_server login password '${password}'; grant connect on database ${db} to chess_server; ${seed(mina)} ${seed(julian)}`);
assert.equal(psql(db, "select chess_private.win_gain(151);"), String(winGain(151)));
assert.equal(psql(db, "select chess_private.win_gain(-151);"), String(winGain(-151)));
assert.equal(psql(db, "select chess_private.percent_ceil(21, 20);"), '5');

const host = process.env.PGHOST || '127.0.0.1';
const port = process.env.PGPORT || '5432';
writeFileSync(configPath, JSON.stringify({
  name: 'chess-api-ratings',
  main: 'server/worker.mjs',
  compatibility_date: '2026-11-08',
  compatibility_flags: ['nodejs_compat'],
  vars: { CHESS_ORIGIN: 'http://chess.example', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'publishable-test-key' },
  hyperdrive: [{ binding: 'HYPERDRIVE', id: '0123456789abcdef0123456789abcdef', localConnectionString: `postgres://chess_server:${encodeURIComponent(password)}@${host}:${port}/${db}` }]
}, null, 2));

function headers(person, json) {
  return {
    origin: 'http://chess.example',
    ...(person ? { cookie: `__Host-chess_session=${person.token}; chess_csrf=${person.csrf}` } : {}),
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
function changes(matchId) {
  return psql(db, `select count(*) from chess_private.rating_changes where match_id = '${matchId}';`);
}

const worker = await unstable_dev('server/worker.mjs', { config: configPath, local: true, ip: '127.0.0.1', experimental: { disableExperimentalWarning: true } });
try {
  setRating(mina.profile, 'blitz', 1000);
  setRating(julian.profile, 'blitz', 1101);
  const created = await call(worker, mina, 'POST', '/api/human/challenges', { kind: 'named', opponentId: julian.profile, color: 'white', category: 'blitz', preset: '3+2', rated: true });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.json.rated, true);
  assert.equal(created.json.creatorRating, 1000);
  assert.equal(created.json.opponentRating, 1101);
  const accepted = await call(worker, julian, 'POST', '/api/human/accept', { id: created.json.id });
  assert.equal(accepted.json.whiteRatingBefore, 1000);
  assert.equal(accepted.json.blackRatingBefore, 1101);
  setRating(mina.profile, 'blitz', 1500);
  const resigned = await call(worker, mina, 'POST', '/api/human/resign', { id: created.json.id, version: accepted.json.version });
  assert.equal(resigned.json.result, '0-1');
  const expected = ratingResult('0-1', 1000, 1101);
  assert.equal(resigned.json.whiteDelta, expected.white.delta);
  assert.equal(resigned.json.blackDelta, expected.black.delta);
  assert.equal(psql(db, `select rating from chess_private.profile_ratings where profile_id = '${mina.profile}' and category = 'blitz';`), '1491');
  assert.equal(changes(created.json.id), '2');
  await call(worker, julian, 'POST', '/api/human/resign', { id: created.json.id, version: resigned.json.version });
  psql(db, 'select chess_service.human_expire();');
  assert.equal(changes(created.json.id), '2');
  assert.equal(psql(db, `select rating from chess_private.profile_ratings where profile_id = '${mina.profile}' and category = 'blitz';`), '1491');

  const casual = await call(worker, mina, 'POST', '/api/human/challenges', { kind: 'named', opponentId: julian.profile, color: 'white', category: 'blitz', preset: '3+2', rated: false });
  const casualLive = await call(worker, julian, 'POST', '/api/human/accept', { id: casual.json.id });
  assert.equal(casualLive.json.rated, false);
  assert.equal(casualLive.json.whiteRatingBefore, null);
  const before = psql(db, `select rating from chess_private.profile_ratings where profile_id = '${julian.profile}' and category = 'blitz';`);
  await call(worker, mina, 'POST', '/api/human/resign', { id: casual.json.id, version: casualLive.json.version });
  assert.equal(changes(casual.json.id), '0');
  assert.equal(psql(db, `select rating from chess_private.profile_ratings where profile_id = '${julian.profile}' and category = 'blitz';`), before);

  setRating(mina.profile, 'rapid', 500);
  setRating(julian.profile, 'rapid', 500);
  const drawn = await call(worker, mina, 'POST', '/api/human/challenges', { kind: 'named', opponentId: julian.profile, color: 'white', category: 'rapid', preset: '10+0', rated: true });
  const drawnLive = await call(worker, julian, 'POST', '/api/human/accept', { id: drawn.json.id });
  const offer = await call(worker, mina, 'POST', '/api/human/draw', { id: drawn.json.id, version: drawnLive.json.version, action: 'offer' });
  const agreed = await call(worker, julian, 'POST', '/api/human/draw', { id: drawn.json.id, version: offer.json.version, action: 'accept' });
  const shares = drawShares(500, 500);
  assert.equal(agreed.json.result, '1/2-1/2');
  assert.equal(agreed.json.whiteDelta, shares.white);
  assert.equal(agreed.json.blackDelta, shares.black);
  assert.equal(psql(db, `select rating from chess_private.profile_ratings where profile_id = '${mina.profile}' and category = 'rapid';`), String(500 + shares.white));

  setRating(mina.profile, 'untimed', 40);
  setRating(julian.profile, 'untimed', 10);
  const slow = await call(worker, mina, 'POST', '/api/human/challenges', { kind: 'named', opponentId: julian.profile, color: 'black', category: 'untimed', preset: 'untimed', rated: true });
  assert.equal(slow.json.rated, true);
  assert.equal(slow.json.category, 'untimed');
  const slowLive = await call(worker, julian, 'POST', '/api/human/accept', { id: slow.json.id });
  assert.equal(slowLive.json.blackRatingBefore, 40);
  assert.equal(slowLive.json.whiteRatingBefore, 10);
  const slowEnd = await call(worker, julian, 'POST', '/api/human/resign', { id: slow.json.id, version: slowLive.json.version });
  const untimed = ratingResult(slowEnd.json.result, 10, 40);
  assert.equal(slowEnd.json.whiteDelta, untimed.white.delta);
  assert.equal(slowEnd.json.blackDelta, untimed.black.delta);
  assert.equal(psql(db, `select rating from chess_private.profile_ratings where profile_id = '${mina.profile}' and category = 'blitz';`), '1491');

  const aborted = await call(worker, mina, 'POST', '/api/human/challenges', { kind: 'public', color: 'white', category: 'bullet', preset: '1+0', rated: true });
  const abortedLive = await call(worker, julian, 'POST', '/api/human/accept', { id: aborted.json.id });
  await call(worker, mina, 'POST', '/api/human/abort', { id: aborted.json.id });
  assert.equal(changes(aborted.json.id), '0');
  assert.equal(abortedLive.json.rated, true);

  setRating(mina.profile, 'bullet', 80);
  setRating(julian.profile, 'bullet', 80);
  const flagged = await call(worker, mina, 'POST', '/api/human/challenges', { kind: 'named', opponentId: julian.profile, color: 'white', category: 'bullet', preset: '1+0', rated: true });
  const flaggedLive = await call(worker, julian, 'POST', '/api/human/accept', { id: flagged.json.id });
  psql(db, `update chess_private.human_matches set clock_at = clock_timestamp() - interval '2 minutes' where id = '${flagged.json.id}';`);
  const timed = await call(worker, mina, 'GET', '/api/human/games/' + flagged.json.id);
  assert.equal(timed.json.termination, 'timeout');
  assert.equal(timed.json.whiteDelta, ratingResult('0-1', 80, 80).white.delta);
  const again = await call(worker, mina, 'GET', '/api/human/games/' + flagged.json.id);
  assert.equal(again.json.whiteDelta, timed.json.whiteDelta);
  assert.equal(changes(flagged.json.id), '2');
  psql(db, 'select chess_service.human_expire();');
  assert.equal(changes(flagged.json.id), '2');

  async function playOut(id, version, sans, white, black) {
    let current = version;
    let last = null;
    for (let index = 0; index < sans.length; index += 1) {
      const player = index % 2 === 0 ? white : black;
      last = await call(worker, player, 'POST', '/api/human/move', { id, version: current, san: sans[index] });
      assert.equal(last.status, 200, last.text);
      current = last.json.version;
    }
    return last;
  }

  setRating(mina.profile, 'daily', 1000);
  setRating(julian.profile, 'daily', 1000);
  const mate = await call(worker, mina, 'POST', '/api/human/challenges', { kind: 'named', opponentId: julian.profile, color: 'white', category: 'daily', preset: '1d', rated: true });
  const mateLive = await call(worker, julian, 'POST', '/api/human/accept', { id: mate.json.id });
  const mated = await playOut(mate.json.id, mateLive.json.version, ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7'], mina, julian);
  const mateScore = ratingResult('1-0', 1000, 1000);
  assert.equal(mated.json.result, '1-0');
  assert.equal(mated.json.termination, 'checkmate');
  assert.equal(mated.json.whiteDelta, mateScore.white.delta);
  assert.equal(mated.json.blackDelta, mateScore.black.delta);
  assert.equal(changes(mate.json.id), '2');
  assert.equal(psql(db, `select rating from chess_private.profile_ratings where profile_id = '${mina.profile}' and category = 'daily';`), String(mateScore.white.after));
  assert.equal(psql(db, `select rating from chess_private.profile_ratings where profile_id = '${julian.profile}' and category = 'daily';`), String(mateScore.black.after));

  setRating(mina.profile, 'rapid', 400);
  setRating(julian.profile, 'rapid', 400);
  const stale = await call(worker, mina, 'POST', '/api/human/challenges', { kind: 'named', opponentId: julian.profile, color: 'white', category: 'rapid', preset: '10+0', rated: true });
  const staleLive = await call(worker, julian, 'POST', '/api/human/accept', { id: stale.json.id });
  psql(db, `update chess_private.human_matches set start_fen = 'k7/2Q5/2K5/8/8/8/8/8 w - - 0 1' where id = '${stale.json.id}';`);
  const drawnByMove = await call(worker, mina, 'POST', '/api/human/move', { id: stale.json.id, version: staleLive.json.version, san: 'Qb6' });
  const moveDraw = drawShares(400, 400);
  assert.equal(drawnByMove.status, 200, drawnByMove.text);
  assert.equal(drawnByMove.json.result, '1/2-1/2');
  assert.equal(drawnByMove.json.termination, 'stalemate');
  assert.equal(drawnByMove.json.whiteDelta, moveDraw.white);
  assert.equal(drawnByMove.json.blackDelta, moveDraw.black);
  assert.equal(changes(stale.json.id), '2');
  assert.equal(psql(db, `select rating from chess_private.profile_ratings where profile_id = '${mina.profile}' and category = 'rapid';`), String(400 + moveDraw.white));
  assert.equal(psql(db, `select rating from chess_private.profile_ratings where profile_id = '${julian.profile}' and category = 'rapid';`), String(400 + moveDraw.black));

  const roster = await call(worker, null, 'GET', '/api/community/roster?sort=blitz');
  assert.equal(roster.json.ratingSort, true);
  assert.equal(roster.json.members.find((member) => member.id === mina.profile).ratings.blitz, 1491);
  assert.equal(roster.json.members.find((member) => member.id === mina.profile).ratings.puzzles, 0);
  assert.equal(roster.text.includes(mina.master), false);
  const profile = await call(worker, null, 'GET', '/api/profiles/' + mina.profile);
  assert.equal(profile.json.ratings.blitz, 1491);
  assert.equal(profile.json.ratings.untimed > 0, true);
  assert.equal(profile.json.ratings.puzzles, 0);
  assert.equal(profile.text.includes(mina.master), false);
  console.log('rating workerd tests passed');
} finally {
  await worker.stop();
  unlinkSync(configPath);
  psql('postgres', `drop database if exists ${db};`);
}

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Chess } from '../assets/vendor/chess.js/chess.js';
import { unstable_dev } from './node_modules/wrangler/wrangler-dist/cli.js';
import { puzzleScore } from '../assets/chess/rating.js';

const db = 'chess_puz_' + randomBytes(3).toString('hex');
const password = randomBytes(12).toString('hex');
const configPath = '/tmp/chess-puzzle-wrangler.jsonc';
const mina = { master: '11111111-1111-4111-8111-111111111111', profile: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', name: 'Mina Chen', token: 'mina-puz-token', csrf: 'mina-puz-csrf' };
const julian = { master: '22222222-2222-4222-8222-222222222222', profile: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', name: 'Julian Park', token: 'julian-puz-token', csrf: 'julian-puz-csrf' };
const catalog = JSON.parse(readFileSync(new URL('../puzzles/lichess-open-subset.json', import.meta.url), 'utf8'));

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
function take(band, count) {
  return catalog.filter((row) => Math.floor(row.rating / 100) * 100 === band && row.moves.length >= 4).slice(0, count);
}
const pack = [...take(400, 3), ...take(1500, 3), ...take(2000, 2)];
const byId = Object.fromEntries(pack.map((row) => [row.id, row]));

function insertPack() {
  const values = pack.map((row) => {
    const moves = row.moves.map((move) => "'" + move + "'").join(',');
    const themes = (row.themes || []).filter((theme) => /^[A-Za-z0-9]+$/.test(theme)).map((theme) => "'" + theme + "'").join(',');
    return `('${row.id}','${row.fen}',array[${moves}]::text[],array[${themes}]::text[],${row.rating},false)`;
  });
  psql(db, `insert into chess_private.puzzles (id, fen, moves, themes, rating, practice) values ${values.join(',')};`);
}
function wrongUci(row) {
  const game = new Chess(row.fen);
  const setup = game.move({ from: row.moves[0].slice(0, 2), to: row.moves[0].slice(2, 4), promotion: row.moves[0][4] || undefined });
  if (!setup) throw new Error('setup');
  const expected = row.moves[1];
  const other = game.moves({ verbose: true }).find((move) => move.from + move.to + (move.promotion || '') !== expected);
  if (!other) throw new Error('no alternative on ' + row.id);
  return other.from + other.to + (other.promotion || '');
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
['supabase/chess_release.sql', 'supabase/chess_discussion.sql', 'supabase/chess_profile_card.sql', 'supabase/chess_human.sql', 'supabase/chess_roster.sql', 'supabase/chess_ratings.sql', 'supabase/chess_puzzles.sql', 'supabase/chess_puzzle_serial.sql'].forEach((file) => psqlFile(db, file));
psql(db, `alter role chess_server login password '${password}'; grant connect on database ${db} to chess_server; ${seed(mina)} ${seed(julian)}`);
insertPack();
let denied = false;
try { psql(db, 'set role chess_server; select count(*) from chess_private.puzzle_attempts;'); }
catch (err) { denied = /permission denied/i.test(String(err.message || err)); }
assert.equal(denied, true);

const host = process.env.PGHOST || '127.0.0.1';
const port = process.env.PGPORT || '5432';
writeFileSync(configPath, JSON.stringify({
  name: 'chess-api-puzzles',
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
    body: method === 'GET' ? undefined : JSON.stringify(body || {})
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json, text: JSON.stringify(json) };
}
async function solve(worker, person, attempt) {
  const line = byId[attempt.puzzleId].moves;
  let cursor = 1;
  let body = null;
  while (cursor < line.length) {
    body = await call(worker, person, 'POST', '/api/puzzles/move', { attemptId: attempt.attemptId, uci: line[cursor] });
    assert.equal(body.status, 200, body.text);
    if (body.json.status !== 'active') break;
    cursor += 2;
  }
  return body;
}

const worker = await unstable_dev('server/worker.mjs', { config: configPath, local: true, ip: '127.0.0.1' });
try {
  const saved = await call(worker, mina, 'POST', '/api/settings', { puzzleOrder: 'weakest', puzzleMin: null, puzzleMax: null, puzzleTier: null });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.puzzleOrder, 'weakest');
  assert.equal(saved.json.puzzleRating, 0);
  const badRange = await call(worker, mina, 'POST', '/api/settings', { puzzleOrder: 'weakest', puzzleMin: 20, puzzleMax: 10, puzzleTier: null });
  assert.equal(badRange.status, 400);
  assert.equal(badRange.json.error, 'That puzzle range is not available.');

  let rating = 0;
  let streak = 0;
  const seen = [];
  for (let index = 0; index < 3; index += 1) {
    const next = await call(worker, mina, 'POST', '/api/puzzles/next', {});
    assert.equal(next.json.exhausted, false);
    const attempt = next.json.attempt;
    assert.equal(attempt.status, 'active');
    assert.equal(attempt.solution, null);
    assert.ok(!next.text.includes(mina.master));
    seen.push(attempt.puzzleRating);
    if (index === 1) {
      psql(db, `insert into chess_private.profile_ratings (profile_id, category, rating) values ('${mina.profile}', 'puzzles', ${rating + 50}) on conflict (profile_id, category) do update set rating = ${rating + 50};`);
      rating += 50;
    }
    const score = puzzleScore('solved', attempt.userRating, attempt.puzzleRating, streak);
    const done = await solve(worker, mina, attempt);
    assert.equal(done.json.status, 'solved', done.text);
    assert.equal(done.json.gain, score.gain);
    assert.equal(done.json.bonus, score.bonus);
    assert.equal(done.json.delta, score.delta);
    assert.equal(done.json.streakAfter, score.streakAfter);
    assert.deepEqual(done.json.solution, byId[attempt.puzzleId].moves);
    assert.ok(done.json.played.every((move) => move.correct && move.millis >= 0));
    rating += score.delta;
    streak = score.streakAfter;
    assert.equal(done.json.userRating, rating);
    const again = await call(worker, mina, 'POST', '/api/puzzles/move', { attemptId: attempt.attemptId, uci: byId[attempt.puzzleId].moves[1] });
    assert.equal(again.json.status, 'solved');
    assert.equal(again.json.userRating, rating);
  }
  assert.ok(seen.every((rating, index) => index === 0 || rating >= seen[index - 1]));
  assert.equal(streak, 3);

  const failing = await call(worker, mina, 'POST', '/api/puzzles/next', {});
  const failAttempt = failing.json.attempt;
  const illegal = await call(worker, mina, 'POST', '/api/puzzles/move', { attemptId: failAttempt.attemptId, uci: 'a1a1' });
  assert.equal(illegal.status, 400);
  assert.equal(illegal.json.error, 'That move is not legal.');
  const still = await call(worker, mina, 'GET', '/api/puzzles/current');
  assert.equal(still.json.attempt.status, 'active');
  assert.equal(still.json.attempt.puzzleId, failAttempt.puzzleId);
  const missed = puzzleScore('failed', failAttempt.userRating, failAttempt.puzzleRating, streak);
  const wrong = await call(worker, mina, 'POST', '/api/puzzles/move', { attemptId: failAttempt.attemptId, uci: wrongUci(byId[failAttempt.puzzleId]) });
  assert.equal(wrong.json.status, 'failed');
  assert.equal(wrong.json.delta, missed.delta);
  assert.equal(wrong.json.bonus, 0);
  assert.equal(wrong.json.streakAfter, 0);
  assert.equal(wrong.json.played.at(-1).correct, false);
  rating += missed.delta;
  streak = 0;
  assert.equal(wrong.json.userRating, rating);
  const dup = await call(worker, mina, 'POST', '/api/puzzles/move', { attemptId: failAttempt.attemptId, uci: wrong.json.played.at(-1).uci });
  assert.equal(dup.json.userRating, rating);
  assert.equal(dup.json.status, 'failed');

  const left = await call(worker, mina, 'POST', '/api/puzzles/next', {});
  const leftAttempt = left.json.attempt;
  const step = await call(worker, mina, 'POST', '/api/puzzles/move', { attemptId: leftAttempt.attemptId, uci: byId[leftAttempt.puzzleId].moves[1] });
  assert.equal(step.json.status, 'active');
  const abandoned = await call(worker, mina, 'POST', '/api/puzzles/abandon', { attemptId: leftAttempt.attemptId });
  assert.equal(abandoned.json.status, 'abandoned');
  assert.equal(abandoned.json.delta, 0);
  assert.equal(abandoned.json.streakAfter, streak);
  assert.equal(abandoned.json.userRating, rating);
  const quiet = await call(worker, mina, 'POST', '/api/puzzles/next', {});
  const quietLeft = await call(worker, mina, 'POST', '/api/puzzles/abandon', { attemptId: quiet.json.attempt.attemptId });
  assert.equal(quietLeft.json.status, 'abandoned');
  assert.equal(quietLeft.json.userRating, rating);
  assert.equal(quietLeft.json.streakAfter, 0);

  await call(worker, mina, 'POST', '/api/puzzles/reset', {});
  const narrow = await call(worker, mina, 'POST', '/api/settings', { puzzleOrder: 'random', puzzleMin: 1500, puzzleMax: 1599, puzzleTier: null });
  assert.equal(narrow.status, 200);
  const ranged = [];
  for (let index = 0; index < 3; index += 1) {
    const next = await call(worker, mina, 'POST', '/api/puzzles/next', {});
    assert.equal(next.json.exhausted, false, next.text);
    assert.ok(next.json.attempt.puzzleRating >= 1500 && next.json.attempt.puzzleRating <= 1599);
    ranged.push(next.json.attempt.puzzleId);
    await call(worker, mina, 'POST', '/api/puzzles/abandon', { attemptId: next.json.attempt.attemptId });
  }
  assert.equal(new Set(ranged).size, 3);
  const empty = await call(worker, mina, 'POST', '/api/puzzles/next', {});
  assert.equal(empty.json.exhausted, true);
  await call(worker, mina, 'POST', '/api/puzzles/reset', {});
  const afterReset = await call(worker, mina, 'POST', '/api/puzzles/next', {});
  assert.equal(afterReset.json.exhausted, false);
  await call(worker, mina, 'POST', '/api/puzzles/abandon', { attemptId: afterReset.json.attempt.attemptId });

  await call(worker, mina, 'POST', '/api/settings', { puzzleOrder: 'tier', puzzleMin: null, puzzleMax: null, puzzleTier: 2000 });
  const tiered = await call(worker, mina, 'POST', '/api/puzzles/next', {});
  assert.ok(tiered.json.attempt.puzzleRating >= 2000 && tiered.json.attempt.puzzleRating < 2100);
  await call(worker, mina, 'POST', '/api/puzzles/abandon', { attemptId: tiered.json.attempt.attemptId });

  const history = await call(worker, mina, 'GET', '/api/puzzles/attempts?limit=10');
  assert.equal(history.status, 200);
  assert.ok(history.json.attempts.length >= 2);
  const stamps = history.json.attempts.map((item) => Date.parse(item.finishedAt));
  assert.ok(stamps.every((stamp, index) => index === 0 || stamps[index - 1] >= stamp));
  assert.ok(history.json.attempts.some((item) => item.status === 'solved'));
  assert.ok(history.json.attempts.some((item) => item.status === 'failed'));
  assert.ok(history.json.attempts.some((item) => item.status === 'abandoned'));
  const detail = await call(worker, mina, 'GET', '/api/puzzles/attempts/' + history.json.attempts[0].id);
  assert.equal(detail.status, 200);
  assert.ok(Array.isArray(detail.json.solution));
  assert.ok(Array.isArray(detail.json.played));
  assert.ok(!detail.text.includes(mina.master));
  const hidden = await call(worker, julian, 'GET', '/api/puzzles/attempts/' + history.json.attempts[0].id);
  assert.equal(hidden.status, 400);
  assert.equal(hidden.json.error, 'That puzzle attempt was not found.');
  const julianList = await call(worker, julian, 'GET', '/api/puzzles/attempts');
  assert.deepEqual(julianList.json.attempts, []);

  const roster = await call(worker, null, 'GET', '/api/community/roster?sort=puzzles');
  assert.equal(roster.json.ratingSort, true);
  assert.equal(roster.json.sort, 'puzzles');
  assert.equal(roster.json.members[0].id, mina.profile);
  assert.equal(roster.json.members[0].ratings.puzzles, rating);
  assert.ok(!roster.text.includes(mina.master));
  const profile = await call(worker, null, 'GET', '/api/profiles/' + mina.profile);
  assert.equal(profile.json.ratings.puzzles, rating);

  const summonedRow = catalog.find((row) => row.moves.length >= 4 && !byId[row.id]);
  byId[summonedRow.id] = summonedRow;
  psql(db, `insert into chess_private.puzzles (id, fen, moves, themes, rating, practice, serial) values ('${summonedRow.id}', '${summonedRow.fen}', array[${summonedRow.moves.map((move) => "'" + move + "'").join(',')}]::text[], '{}', ${summonedRow.rating}, false, 1042);`);
  const ratingBefore = psql(db, `select rating from chess_private.profile_ratings where profile_id = '${mina.profile}' and category = 'puzzles';`);
  const streakBefore = psql(db, `select puzzle_streak from chess_private.account_settings where profile_id = '${mina.profile}';`);
  const summoned = await call(worker, mina, 'POST', '/api/puzzles/summon', { serial: 1042 });
  assert.equal(summoned.status, 200, summoned.text);
  assert.equal(summoned.json.attempt.summoned, true);
  assert.equal(summoned.json.attempt.serial, 1042);
  assert.equal(summoned.json.attempt.lichessId, summonedRow.id);
  const summonedDone = await solve(worker, mina, summoned.json.attempt);
  assert.equal(summonedDone.json.status, 'solved');
  assert.equal(summonedDone.json.summoned, true);
  assert.equal(summonedDone.json.delta, 0);
  assert.equal(summonedDone.json.bonus, 0);
  assert.equal(String(summonedDone.json.streakAfter), streakBefore);
  assert.equal(psql(db, `select rating from chess_private.profile_ratings where profile_id = '${mina.profile}' and category = 'puzzles';`), ratingBefore);
  assert.equal(psql(db, `select puzzle_streak from chess_private.account_settings where profile_id = '${mina.profile}';`), streakBefore);
  const summonedHistory = await call(worker, mina, 'GET', '/api/puzzles/attempts?limit=5');
  const summonedItem = summonedHistory.json.attempts.find((item) => item.serial === 1042);
  assert.equal(summonedItem.summoned, true);
  assert.equal(summonedItem.delta, 0);
  const missing = await call(worker, mina, 'POST', '/api/puzzles/summon', { serial: 999999 });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, 'That puzzle was not found.');

  const forced = await call(worker, mina, 'POST', '/api/puzzles/next', {});
  assert.equal(forced.json.exhausted, false, forced.text);
  psql(db, `update chess_private.puzzle_attempts set summoned = true where id = '${forced.json.attempt.attemptId}';`);
  const forcedDone = await solve(worker, mina, forced.json.attempt);
  assert.equal(forcedDone.json.summoned, true);
  assert.equal(forcedDone.json.delta, 0);
  assert.equal(psql(db, `select rating from chess_private.profile_ratings where profile_id = '${mina.profile}' and category = 'puzzles';`), ratingBefore);
  assert.equal(psql(db, `select puzzle_streak from chess_private.account_settings where profile_id = '${mina.profile}';`), streakBefore);
  console.log('puzzle workerd tests passed');
} finally {
  await worker.stop();
  unlinkSync(configPath);
  psql('postgres', `drop database if exists ${db};`);
}

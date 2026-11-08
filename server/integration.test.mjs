import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Chess } from '../assets/vendor/chess.js/chess.js';
import { createServer } from 'node:http';
import { codeChallenge, createChessApp, randomToken } from './chess-api.mjs';

const { Pool } = pg;
const db = 'chess_api_' + randomBytes(4).toString('hex');
const password = randomBytes(18).toString('hex');
const origin = 'https://chess.theworldgovernmentincorporated.com';
const adaMaster = '11111111-1111-4111-8111-111111111111';
const bobMaster = '22222222-2222-4222-8222-222222222222';
const masterSecret = 'master-access-token-should-never-leak';

function psqlFile(database, file) {
  const command = process.env.PGHOST ? ['psql', ['-d', database, '-v', 'ON_ERROR_STOP=1', '-f', file], process.env] : ['sudo', ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', file], process.env];
  const result = spawnSync(command[0], command[1], { encoding: 'utf8', env: command[2] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function psql(database, sql) {
  const command = process.env.PGHOST ? ['psql', ['-d', database, '-v', 'ON_ERROR_STOP=1'], process.env] : ['sudo', ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1'], process.env];
  const result = spawnSync(command[0], command[1], { input: sql, encoding: 'utf8', env: command[2] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function setup() {
  psql('postgres', `drop database if exists ${db}; create database ${db};`);
  psql(db, `
    create schema if not exists auth;
    create table auth.users (id uuid primary key);
    insert into auth.users (id) values ('${adaMaster}'), ('${bobMaster}');
    do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    create schema if not exists extensions;
    create extension if not exists pgcrypto schema extensions;
  `);
  psqlFile(db, 'supabase/chess_release.sql');
  psql(db, `
    alter role chess_server login password '${password}';
    grant connect on database ${db} to chess_server;
    insert into chess_private.admins (owner_id) values ('${adaMaster}');
  `);
}

function cookieJar() {
  const jar = new Map();
  return {
    store(setCookie) {
      const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
      for (const line of list) {
        const part = String(line).split(';')[0];
        const index = part.indexOf('=');
        const name = part.slice(0, index);
        const value = decodeURIComponent(part.slice(index + 1));
        if (String(line).includes('Max-Age=0') || value === '') jar.delete(name);
        else jar.set(name, value);
      }
    },
    header() {
      return [...jar.entries()].map(([name, value]) => name + '=' + encodeURIComponent(value)).join('; ');
    },
    get(name) { return jar.get(name) || ''; }
  };
}

async function request(port, jar, method, path, body, extra) {
  const headers = Object.assign({ origin, cookie: jar.header() }, extra || {});
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch('http://127.0.0.1:' + port + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  });
  jar.store(response.headers.getSetCookie ? response.headers.getSetCookie() : []);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (err) { json = { raw: text }; }
  return { status: response.status, json, text, location: response.headers.get('location'), cookies: response.headers.getSetCookie ? response.headers.getSetCookie() : [] };
}

function jwt(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return 'eyJhbGciOiJub25lIn0.' + body + '.sig';
}

function startMaster() {
  const challenges = new Map();
  const tokens = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://master.local');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (req.method === 'POST' && url.pathname === '/auth/v1/otp') {
      if (req.headers.authorization) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"bearer"}');
        return;
      }
      challenges.set(body.code_challenge, { email: body.email, redirect: url.searchParams.get('redirect_to'), used: false });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/auth/v1/token') {
      if (req.headers.authorization) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"bearer"}');
        return;
      }
      const challenge = codeChallenge(body.code_verifier || '');
      const row = challenges.get(challenge);
      if (!row || row.used || body.auth_code !== row.code) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"invalid"}');
        return;
      }
      row.used = true;
      const access = jwt({ aud: 'authenticated', sub: row.masterId, iss: 'http://127.0.0.1:' + masterPort + '/auth/v1' });
      tokens.set(access, row.masterId);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: access, user: { id: row.masterId } }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/auth/v1/user') {
      const access = String(req.headers.authorization || '').replace('Bearer ', '');
      const masterId = tokens.get(access);
      if (!masterId) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: masterId }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { server, challenges };
}

const master = startMaster();
await new Promise((resolve) => master.server.listen(0, '127.0.0.1', resolve));
const masterPort = master.server.address().port;
setup();
const digest = spawnSync(process.env.PGHOST ? 'psql' : 'sudo', process.env.PGHOST ? ['-d', db, '-tA', '-c', "select n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='digest' order by 1"] : ['-u', 'postgres', 'psql', '-d', db, '-tA', '-c', "select n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='digest' order by 1"], { encoding: 'utf8', env: process.env });
const digestSchemas = digest.stdout.trim().split('\n').filter(Boolean);
assert.equal(digestSchemas.every((schema) => schema === 'extensions'), true, digest.stdout);
assert.equal(digestSchemas.includes('public'), false);

const pool = new Pool({ host: '127.0.0.1', port: 5432, user: 'chess_server', password, database: db, max: 8 });
const denied = await pool.query("select has_table_privilege('chess_server', 'chess_private.profile_owners', 'select') as owners, has_table_privilege('chess_server', 'public.chess_posts', 'truncate') as trunc");
assert.equal(denied.rows[0].owners, false);
assert.equal(denied.rows[0].trunc, false);
await pool.query('select chess_service.chess_cleanup()');
const live = createChessApp({
  pool,
  origin,
  supabaseUrl: 'http://127.0.0.1:' + masterPort,
  supabaseKey: 'publishable-test-key'
});
await new Promise((resolve) => live.server.listen(0, '127.0.0.1', resolve));
const port = live.server.address().port;
async function signIn(appPort, jar, masterId) {
  const email = masterId + '@example.test';
  const started = await request(appPort, jar, 'POST', '/api/auth/start', { email });
  assert.equal(started.status, 200, started.text);
  assert.equal(started.json.sent, true);
  const state = jar.get('__Host-chess_auth');
  let challenge = '';
  for (const [key, value] of master.challenges) {
    if (value.email === email) challenge = key;
  }
  const code = randomToken();
  master.challenges.get(challenge).code = code;
  master.challenges.get(challenge).masterId = masterId;
  assert.equal(master.challenges.get(challenge).redirect, origin + '/api/auth/callback');
  const callback = await request(appPort, jar, 'GET', '/api/auth/callback?code=' + encodeURIComponent(code));
  assert.equal(callback.status, 303, callback.text);
  assert.equal(callback.location, origin + '/community/');
  assert.equal(callback.text.includes(code), false);
  assert.equal(callback.text.includes(masterSecret), false);
  assert.equal(jar.get('__Host-chess_session').length > 20, true);
  const session = await request(appPort, jar, 'GET', '/api/session');
  assert.equal(session.json.authenticated, true);
  assert.equal(session.json.profile, null);
  assert.equal(JSON.stringify(session.json).includes(masterId), false);
}

const ada = cookieJar();
const bob = cookieJar();
await signIn(port, ada, adaMaster);
await signIn(port, bob, bobMaster);
const adaJoin = await request(port, ada, 'POST', '/api/join', { displayName: 'Ada' }, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(adaJoin.status, 200, adaJoin.text);
assert.equal(JSON.stringify(adaJoin.json).includes(adaMaster), false);
const bobJoin = await request(port, bob, 'POST', '/api/join', { displayName: 'Bob' }, { 'x-csrf-token': bob.get('chess_csrf') });
assert.equal(bobJoin.status, 200, bobJoin.text);
const renamed = await request(port, ada, 'POST', '/api/profile/rename', { displayName: 'Ada Lovelace' }, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(renamed.status, 200, renamed.text);
assert.equal(renamed.json.displayName, 'Ada Lovelace');
const post = await request(port, ada, 'POST', '/api/posts', { body: 'Hello board' }, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(post.status, 200, post.text);
const reply = await request(port, bob, 'POST', '/api/replies', { postId: post.json.id, body: 'Hello Ada' }, { 'x-csrf-token': bob.get('chess_csrf') });
assert.equal(reply.status, 200, reply.text);
const anonPosts = await request(port, cookieJar(), 'GET', '/api/posts');
assert.equal(anonPosts.json.posts.length, 1);
const wrongOrigin = await request(port, bob, 'POST', '/api/posts/delete', { id: post.json.id }, { origin: 'https://evil.example', 'x-csrf-token': bob.get('chess_csrf') });
assert.equal(wrongOrigin.status, 403);
const crossDelete = await request(port, bob, 'POST', '/api/posts/delete', { id: post.json.id }, { 'x-csrf-token': bob.get('chess_csrf') });
assert.notEqual(crossDelete.status, 200);
const stillThere = await request(port, cookieJar(), 'GET', '/api/posts');
assert.equal(stillThere.json.posts.length, 1);
assert.equal(stillThere.json.posts[0].body, 'Hello board');
const missingCsrf = await request(port, ada, 'POST', '/api/posts', { body: 'no csrf' });
assert.equal(missingCsrf.status, 403);
const afterCsrf = await request(port, cookieJar(), 'GET', '/api/posts');
assert.equal(afterCsrf.json.posts.length, 1);
const hidden = await request(port, ada, 'POST', '/api/moderate/hide', { id: post.json.id }, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(hidden.status, 200, hidden.text);
const anonHidden = await request(port, cookieJar(), 'GET', '/api/posts');
assert.equal(anonHidden.json.posts.length, 0);
const repliesHidden = await request(port, bob, 'POST', '/api/replies/list', { postId: post.json.id }, { 'x-csrf-token': bob.get('chess_csrf') });
assert.equal(repliesHidden.json.replies.length, 0);
const deleted = await request(port, bob, 'POST', '/api/replies/delete', { id: reply.json.id }, { 'x-csrf-token': bob.get('chess_csrf') });
assert.equal(deleted.status, 200, deleted.text);
assert.deepEqual(Object.keys(deleted.json).sort(), ['deleted', 'id']);
assert.equal(deleted.json.body, undefined);
const report = await request(port, ada, 'POST', '/api/reports', { postId: post.json.id, reason: 'spam' }, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(report.status, 200, report.text);
const game = new Chess();
game.move('e4');
game.move('e5');
const record = {
  clientGameId: '33333333-3333-4333-8333-333333333333',
  pgn: game.pgn().replace('[Result "*"]', '[Result "0-1"]').replace(/\*\s*$/, '0-1'),
  startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  moves: game.history({ verbose: true }).map((move, index) => ({ ply: index + 1, san: move.san, uci: move.from + move.to, fen: move.after })),
  result: '0-1',
  termination: 'resign',
  playerColor: 'white',
  opponentName: 'Stockfish 19 Lite',
  opponentUciElo: 1600,
  rated: false,
  expectedProfileId: adaJoin.json.id,
  pieceStyle: 'standard',
  pieceColor: 'ink',
  palette: 'midnight'
};
const emptyProfile = await request(port, cookieJar(), 'GET', '/api/profiles/' + adaJoin.json.id);
assert.equal(emptyProfile.status, 200, emptyProfile.text);
assert.equal(emptyProfile.json.displayName, 'Ada Lovelace');
assert.ok(emptyProfile.json.createdAt);
const missingProfile = await request(port, cookieJar(), 'GET', '/api/profiles/99999999-9999-4999-8999-999999999999');
assert.equal(missingProfile.status, 404);
const badDraw = Object.assign({}, record, { result: '1/2-1/2', termination: 'draw', clientGameId: '55555555-5555-4555-8555-555555555555' });
const rejected = await request(port, ada, 'POST', '/api/games', badDraw, { 'x-csrf-token': ada.get('chess_csrf') });
assert.notEqual(rejected.status, 200);
const settings = await request(port, ada, 'POST', '/api/settings', {}, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(settings.json.autoSaveBotResults, false);
const saved = await request(port, ada, 'POST', '/api/games', record, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(saved.status, 200, saved.text);
assert.equal(saved.json.status, 'saved');
const again = await request(port, ada, 'POST', '/api/games', record, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(again.json.duplicate, true);
assert.equal(again.json.id, saved.json.id);
const changed = Object.assign({}, record, { pieceStyle: 'bold' });
const conflict = await request(port, ada, 'POST', '/api/games', changed, { 'x-csrf-token': ada.get('chess_csrf') });
assert.notEqual(conflict.status, 200);
const listed = await request(port, ada, 'POST', '/api/games/list', {}, { 'x-csrf-token': ada.get('chess_csrf') });
const replay = new Chess();
replay.loadPgn(listed.json.games[0].pgn);
assert.deepEqual(replay.history(), ['e4', 'e5']);
const bobGames = await request(port, bob, 'POST', '/api/games/list', {}, { 'x-csrf-token': bob.get('chess_csrf') });
assert.equal(bobGames.json.games.length, 0);
const rated = Object.assign({}, record, { clientGameId: '44444444-4444-4444-8444-444444444444', rated: true });
const ratedSave = await request(port, ada, 'POST', '/api/games', rated, { 'x-csrf-token': ada.get('chess_csrf') });
assert.notEqual(ratedSave.status, 200);
const burst = await Promise.all(Array.from({ length: 12 }, (_item, index) => request(port, ada, 'POST', '/api/posts', { body: 'burst ' + index }, { 'x-csrf-token': ada.get('chess_csrf') })));
const burstOk = burst.filter((item) => item.status === 200).length;
assert.equal(burstOk, 9, String(burstOk));
assert.equal(burst.some((item) => item.status !== 200), true);
psql(db, `update chess_private.browser_sessions set idle_expires_at = clock_timestamp() - interval '1 minute' where master_id = '${bobMaster}'`);
const expired = await request(port, bob, 'POST', '/api/settings', {}, { 'x-csrf-token': bob.get('chess_csrf') });
assert.notEqual(expired.status, 200);
const oldCookie = ada.header();
await request(port, ada, 'POST', '/api/logout', {}, { 'x-csrf-token': ada.get('chess_csrf') });
const stale = await fetch('http://127.0.0.1:' + port + '/api/settings', {
  method: 'POST',
  headers: { origin, cookie: oldCookie, 'content-type': 'application/json', 'x-csrf-token': 'stale' },
  body: '{}'
});
assert.equal(stale.status, 401);
const replayed = await request(port, ada, 'POST', '/api/posts', { body: 'after logout' }, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(replayed.status, 401);
const setting = await pool.query("select current_setting('chess.profile_id', true) as profile");
assert.equal(setting.rows[0].profile || '', '');
const revoked = await pool.query("select has_function_privilege('chess_server', 'chess_service.chess_revoke_master(uuid)', 'execute') as allowed");
assert.equal(revoked.rows[0].allowed, false);
live.server.close();
master.server.close();
await pool.end();
psql('postgres', `drop database if exists ${db};`);
console.log('chess service integration tests passed');

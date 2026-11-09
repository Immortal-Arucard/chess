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
  return result.stdout;
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
  psqlFile(db, 'supabase/chess_discussion.sql');
  psqlFile(db, 'supabase/chess_profile_card.sql');
  psqlFile(db, 'supabase/chess_human.sql');
  psqlFile(db, 'supabase/chess_roster.sql');
  psqlFile(db, 'supabase/chess_ratings.sql');
  psqlFile(db, 'supabase/chess_puzzles.sql');
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
  const control = { authorize: 'google' };
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
      if (body.email === 'fail@example.test') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"msg":"provider rejected"}');
        return;
      }
      challenges.set(body.code_challenge, { email: body.email, redirect: url.searchParams.get('redirect_to'), used: false });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/auth/v1/authorize') {
      if (req.headers.authorization || url.searchParams.get('provider') !== 'google' || url.searchParams.get('code_challenge_method') !== 's256') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"authorize"}');
        return;
      }
      if (url.searchParams.get('skip_http_redirect')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"authorize does not return json"}');
        return;
      }
      challenges.set(url.searchParams.get('code_challenge'), { email: 'google', redirect: url.searchParams.get('redirect_to'), used: false });
      const locations = {
        google: 'https://accounts.google.com/o/oauth2/v2/auth?state=test',
        evil: 'https://evil.example/phish',
        suffix: 'https://accounts.google.com.evil.example/o/oauth2/v2/auth',
        insecure: 'http://accounts.google.com/o/oauth2/v2/auth'
      };
      if (control.authorize === 'json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ url: locations.google }));
        return;
      }
      res.writeHead(302, { location: locations[control.authorize] || locations.google });
      res.end();
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
  return { server, challenges, control };
}

function assertReleaseRollsBack() {
  const name = 'chess_rollback_' + randomBytes(3).toString('hex');
  psql('postgres', `create database ${name}`);
  psql(name, `create schema if not exists auth; create table auth.users (id uuid primary key); do $$ begin create role anon nologin; exception when duplicate_object then null; end $$; do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$; create schema if not exists extensions; create extension if not exists pgcrypto schema extensions;`);
  const release = readFileSync(new URL('../supabase/chess_release.sql', import.meta.url), 'utf8');
  if ((release.match(/\bbegin\s*;/gi) || []).length !== 1 || (release.match(/\bcommit\s*;/gi) || []).length !== 1 || release.includes('\\ir')) {
    throw new Error('chess_release.sql is not one plain SQL transaction');
  }
  const broken = release.replace(/\bcommit\s*;\s*$/i, () => "do $$ begin raise exception 'intentional rollback'; end $$;\n");
  let failed = false;
  try { psql(name, broken); } catch (err) { failed = true; }
  if (!failed) throw new Error('the broken migration committed');
  const args = ['-d', name, '-tA', '-c', "select count(*) from pg_namespace where nspname in ('chess_private','chess_service')"];
  const probe = spawnSync(process.env.PGHOST ? 'psql' : 'sudo', process.env.PGHOST ? args : ['-u', 'postgres', 'psql', ...args], { encoding: 'utf8', env: process.env });
  if (probe.stdout.trim() !== '0') throw new Error('rollback left schemas ' + probe.stdout + probe.stderr);
  psql('postgres', `drop database if exists ${name}`);
}
assertReleaseRollsBack();
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

const missingState = await request(port, cookieJar(), 'GET', '/api/auth/callback?code=missing-browser');
assert.equal(missingState.status, 303);
assert.equal(missingState.location, origin + '/community/?auth=browser');
assert.equal(missingState.text.includes('eyJ'), false);
const providerDenied = await request(port, cookieJar(), 'GET', '/api/auth/callback?error=access_denied');
assert.equal(providerDenied.location, origin + '/community/?auth=rejected');
const failedStart = await request(port, cookieJar(), 'POST', '/api/auth/start', { email: 'fail@example.test' });
assert.equal(failedStart.status, 400);
assert.equal(failedStart.json.error, 'The account service could not send a sign-in link.');
assert.equal(failedStart.text.includes('provider rejected'), false);
const rejectedJar = cookieJar();
const rejectedStart = await request(port, rejectedJar, 'POST', '/api/auth/start', { email: 'reject@example.test' });
assert.equal(rejectedStart.status, 200);
const rejectedCallback = await request(port, rejectedJar, 'GET', '/api/auth/callback?code=not-the-issued-code');
assert.equal(rejectedCallback.status, 303);
assert.equal(rejectedCallback.location, origin + '/community/?auth=rejected');
assert.equal(rejectedJar.get('__Host-chess_session'), '');
const linkJar = cookieJar();
const linkEmail = adaMaster + '@example.test';
const linkStart = await request(port, linkJar, 'POST', '/api/auth/start', { email: linkEmail });
assert.equal(linkStart.status, 200, linkStart.text);
const savedState = linkJar.get('__Host-chess_auth');
let linkChallenge = '';
for (const [key, value] of master.challenges) {
  if (value.email === linkEmail && !value.code) linkChallenge = key;
}
const linkCode = randomToken();
master.challenges.get(linkChallenge).code = linkCode;
master.challenges.get(linkChallenge).masterId = adaMaster;
const linkOk = await request(port, linkJar, 'GET', '/api/auth/callback?code=' + encodeURIComponent(linkCode));
assert.equal(linkOk.location, origin + '/community/');
linkJar.store('__Host-chess_auth=' + encodeURIComponent(savedState) + '; Path=/; Secure; HttpOnly');
const reusedLink = await request(port, linkJar, 'GET', '/api/auth/callback?code=' + encodeURIComponent(linkCode));
assert.equal(reusedLink.location, origin + '/community/?auth=expired');
assert.equal(reusedLink.text.includes(adaMaster), false);
const googleJar = cookieJar();
const googleStart = await request(port, googleJar, 'POST', '/api/auth/google', {});
assert.equal(googleStart.status, 200, googleStart.text);
assert.equal(googleStart.json.url.startsWith('https://accounts.google.com/'), true);
assert.equal(JSON.stringify(googleStart.json).includes('eyJ'), false);
let googleChallenge = '';
for (const [key, value] of master.challenges) {
  if (value.email === 'google' && !value.code) googleChallenge = key;
}
const googleCode = randomToken();
master.challenges.get(googleChallenge).code = googleCode;
master.challenges.get(googleChallenge).masterId = adaMaster;
const googleCallback = await request(port, googleJar, 'GET', '/api/auth/callback?code=' + encodeURIComponent(googleCode));
assert.equal(googleCallback.status, 303, googleCallback.text);
assert.equal(googleCallback.location, origin + '/community/');
assert.equal(googleCallback.text.includes(adaMaster), false);
const googleSession = await request(port, googleJar, 'GET', '/api/session');
assert.equal(googleSession.json.authenticated, true);
assert.equal(googleSession.json.profile, null);
assert.equal(JSON.stringify(googleSession.json).includes(adaMaster), false);
await request(port, googleJar, 'POST', '/api/logout', {}, { 'x-csrf-token': googleJar.get('chess_csrf') });
const signedOut = await request(port, googleJar, 'GET', '/api/session');
assert.equal(signedOut.json.authenticated, false);
for (const mode of ['evil', 'json']) {
  master.control.authorize = mode;
  const badGoogle = await request(port, cookieJar(), 'POST', '/api/auth/google', {});
  assert.equal(badGoogle.status, 400, mode + ' ' + badGoogle.text);
  assert.equal(badGoogle.json.error, 'Google sign-in could not start.');
  assert.equal(badGoogle.text.includes('evil.example'), false);
  assert.equal(badGoogle.text.includes('accounts.google.com'), false);
}
master.control.authorize = 'google';
const joinWithoutSession = await request(port, cookieJar(), 'POST', '/api/join', { displayName: 'Nobody' });
assert.equal(joinWithoutSession.status, 401);
assert.equal(joinWithoutSession.text.includes('eyJ'), false);

const ada = cookieJar();
const bob = cookieJar();
await signIn(port, ada, adaMaster);
await signIn(port, bob, bobMaster);
const beforeJoin = await request(port, ada, 'POST', '/api/discussion', { body: 'too soon' }, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(beforeJoin.status, 400);
assert.equal(beforeJoin.json.error, 'Join Chess before doing that.');
const profilesBeforeJoin = psql(db, 'select count(*)::text from public.chess_profiles;');
const unjoinedRename = await request(port, ada, 'POST', '/api/profile/rename', { displayName: 'Implicit join', authorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(unjoinedRename.status, 400);
assert.equal(unjoinedRename.json.error, 'Join Chess before doing that.');
assert.equal(psql(db, 'select count(*)::text from public.chess_profiles;'), profilesBeforeJoin);
const stillUnjoined = await request(port, ada, 'GET', '/api/session');
assert.equal(stillUnjoined.json.profile, null);
const adaJoin = await request(port, ada, 'POST', '/api/join', { displayName: 'Ada' }, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(adaJoin.status, 200, adaJoin.text);
assert.equal(JSON.stringify(adaJoin.json).includes(adaMaster), false);
const bobJoin = await request(port, bob, 'POST', '/api/join', { displayName: 'Bob' }, { 'x-csrf-token': bob.get('chess_csrf') });
assert.equal(bobJoin.status, 200, bobJoin.text);
const signedOutDiscussion = await request(port, cookieJar(), 'POST', '/api/discussion', { body: 'nope' });
assert.equal(signedOutDiscussion.status, 401);
const adaLine = await request(port, ada, 'POST', '/api/discussion', { body: 'Ada in the room <b>safe</b>', authorId: adaJoin.json.id }, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(adaLine.status, 200, adaLine.text);
assert.equal(adaLine.json.authorId, adaJoin.json.id);
assert.equal(adaLine.json.body, 'Ada in the room <b>safe</b>');
assert.equal(JSON.stringify(adaLine.json).includes(adaMaster), false);
const bobLine = await request(port, bob, 'POST', '/api/discussion', { body: 'Bob in the same room', authorId: bobJoin.json.id }, { 'x-csrf-token': bob.get('chess_csrf') });
assert.equal(bobLine.status, 200, bobLine.text);
const room = await request(port, cookieJar(), 'GET', '/api/discussion?limit=20');
assert.equal(room.json.messages.map((item) => item.body).join('|'), 'Ada in the room <b>safe</b>|Bob in the same room');
assert.equal(JSON.stringify(room.json).includes(adaMaster), false);
assert.equal(JSON.stringify(room.json).includes(bobMaster), false);
const older = await request(port, cookieJar(), 'GET', '/api/discussion?limit=1');
assert.equal(older.json.messages.length, 1);
assert.equal(older.json.messages[0].body, 'Bob in the same room');
const earlier = await request(port, cookieJar(), 'GET', '/api/discussion?limit=1&before=' + encodeURIComponent(older.json.messages[0].createdAt) + '&beforeId=' + older.json.messages[0].id);
assert.equal(earlier.json.messages.length, 1);
assert.equal(earlier.json.messages[0].body, 'Ada in the room <b>safe</b>');
assert.notEqual(earlier.json.messages[0].id, older.json.messages[0].id);
const newer = await request(port, cookieJar(), 'GET', '/api/discussion?limit=20&after=' + encodeURIComponent(adaLine.json.createdAt) + '&afterId=' + adaLine.json.id);
assert.equal(newer.json.messages.length, 1);
assert.equal(newer.json.messages[0].id, bobLine.json.id);
const profilePage = await request(port, cookieJar(), 'GET', '/api/profiles/' + adaJoin.json.id);
assert.equal(profilePage.json.displayName, 'Ada');
assert.equal(JSON.stringify(profilePage.json).includes(adaMaster), false);
const forced = psql(db, "select relrowsecurity::text || ',' || relforcerowsecurity::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'chess_discussion_messages';");
assert.match(forced, /true,true/);
const asBob = await request(port, ada, 'POST', '/api/discussion', { body: 'sent as the wrong profile', authorId: bobJoin.json.id }, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(asBob.status, 400);
assert.equal(asBob.json.error, 'You can discuss only as your own Chess profile.');
const asAda = await request(port, bob, 'POST', '/api/discussion', { body: 'bob wearing ada', authorId: adaJoin.json.id }, { 'x-csrf-token': bob.get('chess_csrf') });
assert.equal(asAda.status, 400);
assert.equal(asAda.json.error, 'You can discuss only as your own Chess profile.');
const missingAuthor = await request(port, ada, 'POST', '/api/discussion', { body: 'no author' }, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(missingAuthor.status, 400);
assert.equal(missingAuthor.json.error, 'You can discuss only as your own Chess profile.');
const rejectedBodies = psql(db, "select count(*)::text from public.chess_discussion_messages where body in ('sent as the wrong profile', 'bob wearing ada', 'no author');");
assert.match(rejectedBodies, /\b0\b/);
psql(db, `
  insert into public.chess_discussion_messages (id, author_id, body, created_at)
  select ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(to_hex(n), 12, '0'))::uuid,
    '${adaJoin.json.id}'::uuid,
    'tie-' || n::text,
    timestamptz '2099-01-01 00:00:00+00'
  from generate_series(1, 30) as n;
`);
const tieStamp = '2099-01-01T00:00:00Z';
const tieId = (n) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + n.toString(16).padStart(12, '0');
const tieOne = await request(port, cookieJar(), 'GET', '/api/discussion?limit=1&after=' + encodeURIComponent(tieStamp) + '&afterId=' + tieId(1));
assert.equal(tieOne.json.messages.length, 1);
assert.equal(tieOne.json.messages[0].id, tieId(2));
assert.equal(tieOne.json.messages[0].body, 'tie-2');
const tiePage = await request(port, cookieJar(), 'GET', '/api/discussion?limit=20&after=' + encodeURIComponent(tieStamp) + '&afterId=' + tieId(1));
assert.equal(tiePage.json.messages.length, 20);
assert.equal(tiePage.json.messages[0].body, 'tie-2');
assert.equal(tiePage.json.messages[19].body, 'tie-21');
const tieRest = await request(port, cookieJar(), 'GET', '/api/discussion?limit=20&after=' + encodeURIComponent(tiePage.json.messages[19].createdAt) + '&afterId=' + tiePage.json.messages[19].id);
assert.deepEqual(tieRest.json.messages.map((item) => item.body), ['tie-22', 'tie-23', 'tie-24', 'tie-25', 'tie-26', 'tie-27', 'tie-28', 'tie-29', 'tie-30']);
const tieIds = new Set([...tiePage.json.messages, ...tieRest.json.messages].map((item) => item.id));
assert.equal(tieIds.size, 29);
assert.equal(tieIds.has(tieId(1)), false);
assert.equal(tieIds.has(tieId(10)), true);
const renamed = await request(port, ada, 'POST', '/api/profile/rename', { displayName: 'Ada Lovelace', authorId: adaJoin.json.id }, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(renamed.status, 200, renamed.text);
assert.equal(renamed.json.displayName, 'Ada Lovelace');
const post = await request(port, ada, 'POST', '/api/posts', { body: 'Hello board' }, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(post.status, 200, post.text);
const reply = await request(port, bob, 'POST', '/api/replies', { postId: post.json.id, body: 'Hello Ada' }, { 'x-csrf-token': bob.get('chess_csrf') });
assert.equal(reply.status, 200, reply.text);
await request(port, bob, 'POST', '/api/replies', { postId: post.json.id, body: 'Second' }, { 'x-csrf-token': bob.get('chess_csrf') });
const replyPage = await request(port, ada, 'POST', '/api/replies/list', { postId: post.json.id, limit: 1 }, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(replyPage.json.replies.length, 1);
const replyNext = await request(port, ada, 'POST', '/api/replies/list', { postId: post.json.id, limit: 1, before: replyPage.json.replies[0].createdAt, beforeId: replyPage.json.replies[0].id }, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(replyNext.json.replies.length, 1);
assert.notEqual(replyNext.json.replies[0].id, replyPage.json.replies[0].id);
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
assert.equal(emptyProfile.json.bio, '');
assert.equal(emptyProfile.json.hasPortrait, false);
assert.equal(emptyProfile.json.hasBackground, false);
const scriptBio = await request(port, ada, 'POST', '/api/profile/bio', { bio: '<script>alert(1)</script>', authorId: adaJoin.json.id }, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(scriptBio.status, 200, scriptBio.text);
assert.equal(scriptBio.json.bio, '<script>alert(1)</script>');
assert.equal(JSON.stringify(scriptBio.json).includes(adaMaster), false);
const bobEditsAda = await request(port, bob, 'POST', '/api/profile/bio', { bio: 'bob wrote this', authorId: adaJoin.json.id }, { 'x-csrf-token': bob.get('chess_csrf') });
assert.equal(bobEditsAda.status, 400);
assert.equal(bobEditsAda.json.error, 'You can edit only your own Chess profile.');
const adaEditsAsBob = await request(port, ada, 'POST', '/api/profile/bio', { bio: 'wrong owner', authorId: bobJoin.json.id }, { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(adaEditsAsBob.status, 400);
const unsignedBio = await request(port, cookieJar(), 'POST', '/api/profile/bio', { bio: 'nope', authorId: adaJoin.json.id });
assert.equal(unsignedBio.status, 401);
const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda00080001000100003f00fbffd9', 'hex');
const exif = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1, 0x00, 0x12]), Buffer.from('Exif\0SECRET-EXIF', 'ascii'), jpeg.subarray(2)]);
const uploaded = await fetch('http://127.0.0.1:' + port + '/api/profile/portrait', {
  method: 'POST',
  headers: { origin, cookie: ada.header(), 'content-type': 'image/jpeg', 'x-csrf-token': ada.get('chess_csrf'), 'x-chess-profile': adaJoin.json.id },
  body: exif
});
assert.equal(uploaded.status, 200, await uploaded.text());
const portrait = await fetch('http://127.0.0.1:' + port + '/api/profiles/' + adaJoin.json.id + '/portrait');
const portraitBytes = Buffer.from(await portrait.arrayBuffer());
assert.equal(portrait.status, 200);
assert.equal(portrait.headers.get('content-type'), 'image/jpeg');
assert.equal(portrait.headers.get('x-content-type-options'), 'nosniff');
assert.equal(portraitBytes.includes(Buffer.from('SECRET-EXIF')), false);
const svg = await fetch('http://127.0.0.1:' + port + '/api/profile/background', {
  method: 'POST',
  headers: { origin, cookie: ada.header(), 'content-type': 'image/svg+xml', 'x-csrf-token': ada.get('chess_csrf'), 'x-chess-profile': adaJoin.json.id },
  body: '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
});
assert.equal(svg.status, 400);
const remote = await fetch('http://127.0.0.1:' + port + '/api/profile/background', {
  method: 'POST',
  headers: { origin, cookie: ada.header(), 'content-type': 'text/plain', 'x-csrf-token': ada.get('chess_csrf'), 'x-chess-profile': adaJoin.json.id },
  body: 'https://evil.example/secret.png'
});
assert.equal(remote.status, 400);
const stolen = await fetch('http://127.0.0.1:' + port + '/api/profile/portrait', {
  method: 'POST',
  headers: { origin, cookie: bob.header(), 'content-type': 'image/jpeg', 'x-csrf-token': bob.get('chess_csrf'), 'x-chess-profile': adaJoin.json.id },
  body: jpeg
});
assert.equal(stolen.status, 400);
const card = await request(port, cookieJar(), 'GET', '/api/profiles/' + adaJoin.json.id);
assert.equal(card.json.bio, '<script>alert(1)</script>');
assert.equal(card.json.hasPortrait, true);
assert.equal(card.json.hasBackground, false);
assert.equal(Object.hasOwn(card.json, 'portrait'), false);
assert.equal(Object.hasOwn(card.json, 'background'), false);
let anonBlocked = false;
try { psql(db, 'set role anon; select portrait from public.chess_profiles;'); }
catch (err) { anonBlocked = /permission denied/i.test(String(err.message)); }
assert.equal(anonBlocked, true);
psql(db, `
  alter table public.chess_posts disable trigger user;
  insert into public.chess_posts (id, author_id, body, created_at) values
    ('cccccccc-cccc-4ccc-8ccc-000000000001', '${adaJoin.json.id}', 'tie-old', '2020-01-01 00:00:00+00'),
    ('cccccccc-cccc-4ccc-8ccc-000000000003', '${adaJoin.json.id}', 'tie-new', '2020-01-01 00:00:00+00'),
    ('cccccccc-cccc-4ccc-8ccc-000000000002', '${adaJoin.json.id}', 'tie-mid', '2020-01-01 00:00:00+00');
  alter table public.chess_posts enable trigger user;
`);
const newestPosts = await request(port, cookieJar(), 'GET', '/api/profiles/' + adaJoin.json.id + '/posts?limit=2');
assert.deepEqual(newestPosts.json.posts.map((item) => item.body), ['tie-new', 'tie-mid']);
const olderPosts = await request(port, cookieJar(), 'GET', '/api/profiles/' + adaJoin.json.id + '/posts?limit=2&before=' + encodeURIComponent(newestPosts.json.posts[1].createdAt) + '&beforeId=' + newestPosts.json.posts[1].id);
assert.equal(olderPosts.json.posts[0].body, 'tie-old');
const beforeNames = await request(port, cookieJar(), 'GET', '/api/profiles/' + adaJoin.json.id);
const bobBefore = await request(port, cookieJar(), 'GET', '/api/profiles/' + bobJoin.json.id);
const joinedSwitch = await request(port, bob, 'POST', '/api/profile/rename', { displayName: 'Stolen', authorId: adaJoin.json.id }, { 'x-csrf-token': bob.get('chess_csrf') });
assert.equal(joinedSwitch.status, 400);
assert.equal(joinedSwitch.json.error, 'You can edit only your own Chess profile.');
const adaAfterSwitch = await request(port, cookieJar(), 'GET', '/api/profiles/' + adaJoin.json.id);
const bobAfterSwitch = await request(port, cookieJar(), 'GET', '/api/profiles/' + bobJoin.json.id);
assert.equal(adaAfterSwitch.json.displayName, beforeNames.json.displayName);
assert.equal(bobAfterSwitch.json.displayName, bobBefore.json.displayName);
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
const feed1 = await request(port, cookieJar(), 'GET', '/api/posts?limit=2');
assert.equal(feed1.json.posts.length, 2);
const feed2 = await request(port, cookieJar(), 'GET', '/api/posts?limit=2&before=' + encodeURIComponent(feed1.json.posts[1].createdAt) + '&beforeId=' + feed1.json.posts[1].id);
assert.equal(feed2.json.posts.some((item) => feed1.json.posts.some((first) => first.id === item.id)), false);
let savedCount = 1;
while (savedCount < 20) {
  const extra = Object.assign({}, record, { clientGameId: '66666666-6666-4666-8666-' + String(savedCount).padStart(12, '0') });
  const result = await request(port, ada, 'POST', '/api/games', extra, { 'x-csrf-token': ada.get('chess_csrf') });
  assert.equal(result.status, 200, result.text);
  savedCount += 1;
}
const capped = await request(port, ada, 'POST', '/api/games', Object.assign({}, record, { clientGameId: '77777777-7777-4777-8777-777777777777' }), { 'x-csrf-token': ada.get('chess_csrf') });
assert.equal(capped.status, 400);
assert.equal(capped.json.error, 'This account has reached the saved-game limit.');
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
const revoked = await pool.query("select has_function_privilege('chess_server', 'chess_service.chess_revoke_master(uuid)', 'execute') as allowed, (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'chess_%') as public_definers");
assert.equal(revoked.rows[0].allowed, false);
const authority = await pool.query("select has_function_privilege('chess_authority', 'chess_service.chess_revoke_master(uuid)', 'execute') as allowed");
assert.equal(authority.rows[0].allowed, true);
const logins = await pool.query("select rolname, rolcanlogin from pg_roles where rolname in ('chess_server', 'chess_authority') order by rolname");
assert.deepEqual(logins.rows, [
  { rolname: 'chess_authority', rolcanlogin: false },
  { rolname: 'chess_server', rolcanlogin: true }
]);
assert.equal(Number(revoked.rows[0].public_definers), 0);
const workerMod = await import('./worker.mjs');
const workerEnv = {
  HYPERDRIVE: { connectionString: 'postgres://chess_server:' + encodeURIComponent(password) + '@127.0.0.1:5432/' + db },
  CHESS_ORIGIN: origin,
  SUPABASE_URL: 'http://127.0.0.1:' + masterPort,
  SUPABASE_ANON_KEY: 'publishable-test-key'
};
const firstWorker = await workerMod.default.fetch(new Request(origin + '/api/session'), workerEnv);
const both = await Promise.all([
  workerMod.default.fetch(new Request(origin + '/api/session'), workerEnv),
  workerMod.default.fetch(new Request(origin + '/api/posts'), workerEnv)
]);
assert.equal(firstWorker.status, 200);
assert.equal(both[0].status, 200);
assert.equal(both[1].status, 200);
const failedWorker = await workerMod.default.fetch(new Request(origin + '/api/session'), Object.assign({}, workerEnv, { HYPERDRIVE: { connectionString: 'postgres://chess_server:wrong@127.0.0.1:1/none' } }));
assert.equal(failedWorker.status, 503);
const afterFailure = await workerMod.default.fetch(new Request(origin + '/api/session'), workerEnv);
assert.equal(afterFailure.status, 200);
await workerMod.default.scheduled(null, workerEnv);
live.server.close();
master.server.close();
await pool.end();
psql('postgres', `drop database if exists ${db};`);
console.log('chess service integration tests passed');

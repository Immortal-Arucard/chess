import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { createServer as createHttp } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { codeChallenge, createChessApp, randomToken } from './chess-api.mjs';

const bundledCore = fileURLToPath(new URL('./node_modules/puppeteer-core/package.json', import.meta.url));
const require = createRequire(process.env.PUPPETEER_CORE || (existsSync(bundledCore) ? bundledCore : '/tmp/pw/node_modules/puppeteer-core/package.json'));
const puppeteer = require('puppeteer-core');
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const shotDir = (() => {
  const preferred = '/opt/cursor/artifacts';
  try {
    mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch (err) {
    const fallback = '/tmp/chess-shots';
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
})();
const root = fileURLToPath(new URL('..', import.meta.url));
const db = 'chess_browser_' + randomBytes(3).toString('hex');
const password = randomBytes(12).toString('hex');
const adaMaster = '11111111-1111-4111-8111-111111111111';
const bobMaster = '22222222-2222-4222-8222-222222222222';

function psql(database, sql) {
  const command = process.env.PGHOST ? ['psql', ['-d', database, '-v', 'ON_ERROR_STOP=1'], process.env] : ['sudo', ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1'], process.env];
  const result = spawnSync(command[0], command[1], { input: sql, encoding: 'utf8', env: command[2] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
function psqlValue(database, sql) {
  const command = process.env.PGHOST ? ['psql', ['-d', database, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql], process.env] : ['sudo', ['-u', 'postgres', 'psql', '-d', database, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql], process.env];
  const result = spawnSync(command[0], command[1], { encoding: 'utf8', env: command[2] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
function psqlFile(database, file) {
  const command = process.env.PGHOST ? ['psql', ['-d', database, '-v', 'ON_ERROR_STOP=1', '-f', file], process.env] : ['sudo', ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', file], process.env];
  const result = spawnSync(command[0], command[1], { encoding: 'utf8', env: command[2] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', '/tmp/chess-key.pem', '-out', '/tmp/chess-cert.pem', '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });

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
psql(db, `alter role chess_server login password '${password}'; grant connect on database ${db} to chess_server;`);

const challenges = new Map();
const tokens = new Map();
let masterPort = 0;
const master = createHttp(async (req, res) => {
  const url = new URL(req.url, 'http://master.local');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  if (req.method === 'POST' && url.pathname === '/auth/v1/otp') {
    challenges.set(body.code_challenge, { email: body.email, used: false });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  if (req.method === 'POST' && url.pathname === '/auth/v1/token') {
    const challenge = codeChallenge(body.code_verifier || '');
    const row = challenges.get(challenge);
    if (!row || row.used || body.auth_code !== row.code) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"invalid"}');
      return;
    }
    row.used = true;
    const issuer = 'http://127.0.0.1:' + masterPort + '/auth/v1';
    const access = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ aud: 'authenticated', sub: row.masterId, iss: issuer })).toString('base64url') + '.sig';
    tokens.set(access, row.masterId);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: access, user: { id: row.masterId } }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/auth/v1/user') {
    const access = String(req.headers.authorization || '').replace('Bearer ', '');
    if (!tokens.get(access)) { res.writeHead(401); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: tokens.get(access) }));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => master.listen(0, '127.0.0.1', resolve));
masterPort = master.address().port;

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.wasm': 'application/wasm', '.png': 'image/png' };
let app = null;
const server = createServer({ key: readFileSync('/tmp/chess-key.pem'), cert: readFileSync('/tmp/chess-cert.pem') }, (req, res) => {
  const url = new URL(req.url, 'https://127.0.0.1');
  if (url.pathname.startsWith('/api/')) return app.handle(req, res);
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = join(root, relative.endsWith('/') || relative === '' ? relative + 'index.html' : relative);
  if (!file.startsWith(root) || !existsSync(file) || extname(file) === '') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'https://127.0.0.1:' + server.address().port;
const pool = new pg.Pool({ host: '127.0.0.1', port: 5432, user: 'chess_server', password, database: db, max: 4 });
app = createChessApp({
  pool,
  origin,
  supabaseUrl: 'http://127.0.0.1:' + masterPort,
  supabaseKey: 'publishable-test-key'
});

const browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push('pageerror ' + err.message));
page.on('console', (msg) => { if (msg.type() === 'error') logs.push('console ' + msg.text()); });

async function signIn(email, name, masterId, target = page) {
  await target.goto(origin + '/community/', { waitUntil: 'domcontentloaded' });
  await target.waitForSelector('input[type=email]');
  await target.type('input[type=email]', email);
  await target.type('input[autocomplete=nickname]', name);
  await target.click('button[type=submit]');
  await target.waitForFunction(() => document.body.innerText.includes('Check '));
  const row = [...challenges.values()].find((item) => item.email === email && !item.code);
  const code = randomToken();
  row.code = code;
  row.masterId = masterId;
  await target.goto(origin + '/api/auth/callback?code=' + encodeURIComponent(code), { waitUntil: 'domcontentloaded' });
  await target.waitForSelector('#community-app input[type=text]');
  const box = await target.$('#community-app input[type=text]');
  await box.click({ clickCount: 3 });
  await box.type(name);
  await target.click('button[type=submit]');
  await target.waitForFunction((expected) => document.body.innerText.includes('Signed in as ' + expected), {}, name);
}

let intercept = false;
let armHold = false;
let heldSession = null;
let gameSaves = 0;
page.on('request', (request) => {
  if (!intercept) return;
  const url = new URL(request.url());
  if (request.method() === 'POST' && url.pathname === '/api/games') {
    gameSaves += 1;
    request.continue();
    return;
  }
  if (armHold && request.method() === 'GET' && url.pathname === '/api/session') {
    heldSession = request;
    return;
  }
  request.continue();
});

async function playE4() {
  await page.click('#start-game');
  await page.waitForFunction(() => document.getElementById('engine-status').textContent.includes('Engine ready'));
  const moveInfo = await page.evaluate(() => {
    const e2 = document.querySelector('#board-mount [data-square=e2]');
    if (e2) e2.click();
    const selected = document.querySelector('#board-mount .is-selected');
    const e4 = document.querySelector('#board-mount [data-square=e4]');
    if (e4) e4.click();
    return {
      e2: e2 && e2.getAttribute('aria-label'),
      selected: selected && selected.dataset.square,
      e4: e4 && e4.getAttribute('aria-label'),
      moves: document.getElementById('moves').textContent
    };
  });
  if (!String(moveInfo.moves).includes('e4')) throw new Error(JSON.stringify(moveInfo));
}

try {
  await signIn('ada@example.test', 'Ada Lovelace', adaMaster);
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(origin + '/community/discussion/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#discussion-body');
  await page.type('#discussion-body', 'Ada says hello <b>safe</b>');
  await page.click('#discussion-send');
  await page.waitForFunction(() => document.getElementById('discussion-log').innerText.includes('Ada says hello <b>safe</b>'));
  const markup = await page.$eval('#discussion-log', (el) => el.innerHTML);
  if (markup.includes('<b>')) throw new Error('the discussion parsed a message as HTML');
  const bobContext = await browser.createBrowserContext();
  const bobPage = await bobContext.newPage();
  bobPage.on('pageerror', (err) => logs.push('pageerror ' + err.message));
  await bobPage.setViewport({ width: 390, height: 844 });
  await signIn('bob@example.test', 'Bob Stone', bobMaster, bobPage);
  await bobPage.goto(origin + '/community/discussion/', { waitUntil: 'domcontentloaded' });
  await bobPage.waitForFunction(() => document.body.innerText.includes('Ada says hello <b>safe</b>'));
  await bobPage.click('#discussion-log a');
  await bobPage.waitForFunction(() => location.pathname.indexOf('/community/profile') === 0);
  await bobPage.reload({ waitUntil: 'domcontentloaded' });
  await bobPage.waitForFunction(() => document.body.innerText.includes('Ada Lovelace') && document.body.innerText.includes('Chess community profile'));
  await bobPage.goBack();
  await bobPage.waitForFunction(() => location.pathname.indexOf('/community/discussion') === 0);
  await bobPage.waitForSelector('#discussion-body');
  await bobPage.setOfflineMode(true);
  await bobPage.type('#discussion-body', 'offline bob');
  await bobPage.click('#discussion-send');
  await bobPage.waitForFunction(() => document.body.innerText.includes('not stored on this device'));
  const deviceCopy = await bobPage.evaluate(() => JSON.stringify(window.localStorage));
  if (deviceCopy.includes('offline bob')) throw new Error('an offline discussion message was stored on the device');
  await bobPage.setOfflineMode(false);
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(origin + '/bot/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#elo-choices button');
  await page.evaluate(() => [...document.querySelectorAll('#elo-choices button')].find((button) => button.textContent === '2000').click());
  await playE4();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('moves').textContent.includes('e4') && document.body.dataset.phase === 'playing');
  const recoveredSummary = await page.$eval('#game-summary', (el) => el.textContent);
  if (!recoveredSummary.includes('2000')) throw new Error('recovery dropped the starting limit: ' + recoveredSummary);
  await page.screenshot({ path: join(shotDir, 'browser-recovery-playing.png') });
  await page.evaluate(() => document.getElementById('resign').click());
  await page.waitForFunction(() => document.getElementById('save-status').textContent.includes('Not saved'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.dataset.phase === 'ended' && document.getElementById('moves').textContent.includes('e4') && document.getElementById('save-status').textContent.includes('Not saved'));
  await page.screenshot({ path: join(shotDir, 'browser-recovery-unsaved.png') });
  intercept = true;
  await page.setRequestInterception(true);
  armHold = true;
  await page.evaluate(() => document.getElementById('save-account').click());
  const holdStarted = Date.now();
  while (!heldSession) {
    if (Date.now() - holdStarted > 10000) throw new Error('the save did not reach the session check');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await page.evaluate(() => document.getElementById('discard-result').click());
  heldSession.continue();
  armHold = false;
  await page.waitForFunction(() => document.body.dataset.phase === 'setup');
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (gameSaves !== 0) throw new Error('discard let a save request through: ' + gameSaves);
  const stored = psqlValue(db, 'select count(*) from chess_private.bot_games');
  if (stored !== '0') throw new Error('discard stored ' + stored + ' games');
  await page.screenshot({ path: join(shotDir, 'browser-discard.png') });
  intercept = false;
  await page.setRequestInterception(false);
  console.log('recovery restored the move and limit; discard sent no save');
  await playE4();
  await page.evaluate(() => document.getElementById('resign').click());
  await page.click('#save-account');
  await page.waitForFunction(() => document.getElementById('save-status').textContent.includes('Saved'));
  const savedText = await page.$eval('#save-status', (el) => el.textContent);
  if (!savedText.includes('Saved')) throw new Error(savedText);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.dataset.phase === 'ended' && document.getElementById('leave-game'));
  await page.evaluate(() => {
    const bar = document.querySelector('.game-exitbar');
    if (bar) bar.removeAttribute('inert');
    document.getElementById('leave-game').click();
  });
  await page.waitForFunction(() => document.querySelector('.site-header') && document.querySelector('#saved-games-list button'));
  await page.evaluate(() => document.querySelector('#saved-games-list button').click());
  await page.waitForFunction(() => document.querySelectorAll('#replay-board .square').length === 64);
  const squares = await page.$$eval('#replay-board .square', (nodes) => nodes.length);
  if (squares !== 64) throw new Error('replay board squares ' + squares);
  const beforeBoard = await page.$eval('#replay-board', (el) => el.innerHTML);
  const before = await page.$eval('#replay-status', (el) => el.textContent);
  await page.evaluate(() => document.getElementById('replay-prev').click());
  const afterBoard = await page.$eval('#replay-board', (el) => el.innerHTML);
  const after = await page.$eval('#replay-status', (el) => el.textContent);
  if (before === after || beforeBoard === afterBoard) throw new Error('replay did not move the board');
  console.log('replay moved from ' + JSON.stringify(before) + ' to ' + JSON.stringify(after));
  await page.evaluate(() => {
    document.getElementById('game-window').hidden = true;
    document.getElementById('replay-panel').scrollIntoView({ block: 'center' });
  });
  await page.screenshot({ path: join(shotDir, 'browser-replay.png') });
  await page.evaluate(() => document.getElementById('autosave-bot').click());
  await page.waitForFunction(() => document.getElementById('autosave-note').textContent.includes('Finished bot games are saved'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  const checked = await page.$eval('#autosave-bot', (el) => el.checked);
  if (!checked) throw new Error('autosave did not persist');
  await page.goto(origin + '/community/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent === 'Sign out'));
  await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Sign out').click());
  await page.waitForSelector('input[type=email]');
  await signIn('bob@example.test', 'Bob Stone', bobMaster);
  await page.goto(origin + '/bot/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.dataset.phase === 'setup' && document.querySelector('header.site-header') && document.getElementById('game-window').hidden);
  const bobList = await page.$eval('#saved-games-list', (el) => el.textContent);
  if (bobList.includes('Replay')) throw new Error('the other account listed the first game');
  await page.screenshot({ path: join(shotDir, 'browser-account-switch.png') });
  console.log('browser recovery, pre-send discard, save, reload, replay, settings, and owner switch passed');
} catch (err) {
  console.error(err && err.stack);
  console.error(logs.join('\n'));
  console.error(await page.evaluate(() => document.body.innerText).catch(() => ''));
  throw err;
} finally {
  await browser.close();
  await pool.end();
  server.close();
  master.close();
  psql('postgres', `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${db}' and pid <> pg_backend_pid()`);
  psql('postgres', `drop database if exists ${db}`);
}

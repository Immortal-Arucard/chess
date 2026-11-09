import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createChessApp } from './chess-api.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const puppeteer = createRequire(fileURLToPath(new URL('./node_modules/puppeteer-core/package.json', import.meta.url)))('puppeteer-core');
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const db = 'chess_pic_ui_' + randomBytes(3).toString('hex');
const password = randomBytes(12).toString('hex');
const master = '11111111-1111-4111-8111-111111111111';
const profile = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const token = 'browser-session-token-profile-picture';
const csrf = 'browser-csrf-token-profile-picture';
const pngPath = '/tmp/chess-profile-tiny.png';
writeFileSync(pngPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

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

spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', '/tmp/chess-key.pem', '-out', '/tmp/chess-cert.pem', '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
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
  insert into public.chess_profiles (id, display_name) values ('${profile}', 'Ada Lovelace');
  insert into chess_private.profile_owners (profile_id, owner_id) values ('${profile}', '${master}');
  insert into chess_private.browser_sessions (token_hash, csrf_hash, master_id, profile_id, expires_at, idle_expires_at)
  values (chess_private.token_hash('${token}'), chess_private.token_hash('${csrf}'), '${master}', '${profile}', clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day');
`);
const host = process.env.PGHOST || '127.0.0.1';
const pgPort = process.env.PGPORT || '5432';
const pool = new pg.Pool({ connectionString: `postgres://chess_server:${encodeURIComponent(password)}@${host}:${pgPort}/${db}` });
let origin = 'https://127.0.0.1';
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const app = { current: null };
const server = createServer({ key: readFileSync('/tmp/chess-key.pem'), cert: readFileSync('/tmp/chess-cert.pem') }, (req, res) => {
  const url = new URL(req.url, origin);
  if (url.pathname.startsWith('/api/')) {
    app.current.handle(req, res);
    return;
  }
  const relative = (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname).replace(/^\/+/, '');
  const file = normalize(join(root, relative));
  if (file !== root && !file.startsWith(root + '/')) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    res.writeHead(404);
    res.end('missing');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
origin = 'https://127.0.0.1:' + server.address().port;
app.current = createChessApp({
  pool,
  origin,
  supabaseUrl: 'https://example.supabase.co',
  supabaseKey: 'publishable-test-key'
});
const browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'] });
const page = await browser.newPage();
try {
  await page.setCookie(
    { name: '__Host-chess_session', value: token, url: origin, secure: true, path: '/' },
    { name: 'chess_csrf', value: csrf, url: origin, secure: true, path: '/' }
  );
  await page.goto(origin + '/community/profile/?id=' + profile, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#portrait-file');
  const made = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2200;
    canvas.height = 1500;
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      pixels.data[i] = (i * 13) % 255;
      pixels.data[i + 1] = (i * 7) % 255;
      pixels.data[i + 2] = (i * 3) % 255;
      pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    const file = new File([blob], 'phone.jpg', { type: '' });
    const list = new DataTransfer();
    list.items.add(file);
    document.getElementById('portrait-file').files = list.files;
    return blob.size;
  });
  assert.ok(made > 512 * 1024, 'fixture was only ' + made + ' bytes');
  const save = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save profile picture'));
  await save.click();
  await page.waitForFunction(() => {
    const image = document.querySelector('.profile-portrait img');
    return image && image.complete && image.naturalWidth > 0;
  });
  const shown = await page.evaluate(() => {
    const image = document.querySelector('.profile-portrait img');
    return { width: image.naturalWidth, height: image.naturalHeight, text: document.body.innerText };
  });
  assert.ok(shown.width > 0 && shown.width <= 1600, JSON.stringify(shown));
  assert.ok(shown.height > 0 && shown.height <= 1600);
  assert.equal(shown.text.includes('No profile picture yet'), false);
  const stored = await page.evaluate(async (id) => {
    const response = await fetch('/api/profiles/' + id + '/portrait', { cache: 'no-store' });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, type: response.headers.get('content-type'), size: bytes.length, jpeg: bytes[0] === 0xff && bytes[1] === 0xd8 };
  }, profile);
  assert.equal(stored.status, 200);
  assert.equal(stored.type, 'image/jpeg');
  assert.equal(stored.jpeg, true);
  assert.ok(stored.size <= 512 * 1024);
  const bad = await page.evaluate(async () => {
    const file = new File(['not an image'], 'note.txt', { type: 'text/plain' });
    const list = new DataTransfer();
    list.items.add(file);
    document.getElementById('portrait-file').files = list.files;
    document.querySelectorAll('button').forEach((button) => {
      if (button.textContent === 'Save profile picture') button.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return document.body.innerText;
  });
  assert.match(bad, /could not be read/);
  console.log('browser profile picture save passed', { sourceBytes: made, storedBytes: stored.size, width: shown.width, height: shown.height });
} finally {
  await browser.close();
  server.close();
  await pool.end();
  psql('postgres', `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${db}' and pid <> pg_backend_pid()`);
  psql('postgres', `drop database if exists ${db}`);
}

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createChessApp } from './chess-api.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const puppeteer = createRequire(fileURLToPath(new URL('./node_modules/puppeteer-core/package.json', import.meta.url)))('puppeteer-core');
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const shots = process.env.CHESS_SHOTS || '/tmp/chess-human-shots';
mkdirSync(shots, { recursive: true });
const db = 'chess_human_ui_' + randomBytes(3).toString('hex');
const password = randomBytes(12).toString('hex');
const mina = { master: '11111111-1111-4111-8111-111111111111', profile: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', name: 'Mina Chen', token: 'mina-ui-session', csrf: 'mina-ui-csrf' };
const julian = { master: '22222222-2222-4222-8222-222222222222', profile: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', name: 'Julian Park', token: 'julian-ui-session', csrf: 'julian-ui-csrf' };

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
  create schema if not exists auth; create table auth.users (id uuid primary key);
  do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
  create schema if not exists extensions; create extension if not exists pgcrypto schema extensions;
`);
psqlFile(db, 'supabase/chess_release.sql');
psqlFile(db, 'supabase/chess_discussion.sql');
psqlFile(db, 'supabase/chess_profile_card.sql');
psqlFile(db, 'supabase/chess_human.sql');
psqlFile(db, 'supabase/chess_roster.sql');
psqlFile(db, 'supabase/chess_ratings.sql');
psqlFile(db, 'supabase/chess_puzzles.sql');
psqlFile(db, 'supabase/chess_puzzle_serial.sql');
psql(db, `
  alter role chess_server login password '${password}';
  grant connect on database ${db} to chess_server;
  insert into auth.users (id) values ('${mina.master}'), ('${julian.master}');
  insert into public.chess_profiles (id, display_name) values ('${mina.profile}', '${mina.name}'), ('${julian.profile}', '${julian.name}');
  insert into chess_private.profile_owners (profile_id, owner_id) values ('${mina.profile}', '${mina.master}'), ('${julian.profile}', '${julian.master}');
  insert into chess_private.browser_sessions (token_hash, csrf_hash, master_id, profile_id, expires_at, idle_expires_at) values
    (chess_private.token_hash('${mina.token}'), chess_private.token_hash('${mina.csrf}'), '${mina.master}', '${mina.profile}', clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day'),
    (chess_private.token_hash('${julian.token}'), chess_private.token_hash('${julian.csrf}'), '${julian.master}', '${julian.profile}', clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day');
`);
const pool = new pg.Pool({ connectionString: `postgres://chess_server:${encodeURIComponent(password)}@${process.env.PGHOST || '127.0.0.1'}:${process.env.PGPORT || '5432'}/${db}` });
let origin = 'https://127.0.0.1';
const app = { current: null };
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.txt': 'text/plain;charset=utf-8' };
const server = createServer({ key: readFileSync('/tmp/chess-key.pem'), cert: readFileSync('/tmp/chess-cert.pem') }, (req, res) => {
  const url = new URL(req.url, origin);
  if (url.pathname.startsWith('/api/')) return app.current.handle(req, res);
  const relative = (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname).replace(/^\/+/, '');
  const file = normalize(join(root, relative));
  if (file !== root && !file.startsWith(root + '/')) { res.writeHead(400); res.end('bad'); return; }
  try {
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch (err) { res.writeHead(404); res.end('missing'); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
origin = 'https://127.0.0.1:' + server.address().port;
app.current = createChessApp({ pool, origin, supabaseUrl: 'https://example.supabase.co', supabaseKey: 'publishable-test-key' });
const browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'] });
async function shot(page, name) {
  await page.evaluate(() => {
    if (document.getElementById('sample-banner')) return;
    const note = document.createElement('p');
    note.id = 'sample-banner';
    note.textContent = 'Sample preview. Mina Chen and Julian Park are not live accounts.';
    document.querySelector('main').prepend(note);
  });
  await page.screenshot({ path: join(shots, name), fullPage: true });
}
async function cookies(page, person) {
  await page.setCookie(
    { name: '__Host-chess_session', value: person.token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' },
    { name: 'chess_csrf', value: person.csrf, url: origin, secure: true, sameSite: 'Lax' }
  );
}
try {
  const page = await browser.newPage();
  const client = await page.createCDPSession();
  await client.send('Network.setBypassServiceWorker', { bypass: true });
  page.on('pageerror', (err) => console.log('PAGE', err.message));
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin + '/human/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('mode-pass'), { timeout: 10000 });
  await page.evaluate(() => document.getElementById('mode-pass').click());
  await page.waitForFunction(() => document.body.innerText.includes('Bullet') && document.body.innerText.includes('Daily'), { timeout: 10000 });
  await shot(page, 'human_setup_desktop.png');
  await page.evaluate(() => document.getElementById('start-game').click());
  await page.evaluate(() => {
    document.querySelector('#board [data-square="e2"]').click();
    document.querySelector('#board [data-square="e4"]').click();
  });
  await page.waitForFunction(() => document.body.innerText.includes('e4'), { timeout: 10000 });
  const passChrome = await page.evaluate(() => ({
    header: !!document.querySelector('header.site-header'),
    footer: !!document.querySelector('footer.site-footer'),
    sections: !!document.querySelector('nav.page-nav'),
    crumbs: !!document.querySelector('nav.crumbs'),
    skip: !!document.querySelector('a.skip'),
    title: !!document.querySelector('h1'),
    lead: !!document.querySelector('p.lead')
  }));
  assert.equal(passChrome.header, false);
  assert.equal(passChrome.footer, false);
  assert.equal(passChrome.sections, false);
  assert.equal(passChrome.crumbs, false);
  assert.equal(passChrome.skip, false);
  assert.equal(passChrome.title, false);
  assert.equal(passChrome.lead, false);
  await shot(page, 'human_game_desktop.png');
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await shot(page, 'human_game_phone.png');

  const minaContext = await browser.createBrowserContext();
  const julianContext = await browser.createBrowserContext();
  const minaPage = await minaContext.newPage();
  const julianPage = await julianContext.newPage();
  await (await minaPage.createCDPSession()).send('Network.setBypassServiceWorker', { bypass: true });
  await (await julianPage.createCDPSession()).send('Network.setBypassServiceWorker', { bypass: true });
  await minaPage.setViewport({ width: 1280, height: 900 });
  await julianPage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await cookies(minaPage, mina);
  await cookies(julianPage, julian);
  await minaPage.goto(origin + '/human/', { waitUntil: 'domcontentloaded' });
  await minaPage.waitForFunction(() => document.getElementById('mode-online'), { timeout: 10000 });
  await minaPage.evaluate(() => document.getElementById('mode-online').click());
  await minaPage.waitForSelector('#name-search', { timeout: 10000 });
  await minaPage.type('#name-search', 'Julian');
  await minaPage.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent === 'Search').click());
  await minaPage.waitForFunction(() => [...document.querySelectorAll('button')].some((node) => node.textContent === 'Julian Park'), { timeout: 10000 });
  await minaPage.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent === 'Julian Park').click());
  await minaPage.evaluate(() => document.getElementById('send-named').click());
  await minaPage.waitForFunction(() => document.body.innerText.includes('Invite link'), { timeout: 10000 });
  await shot(minaPage, 'human_invite_desktop.png');
  await julianPage.goto(origin + '/human/', { waitUntil: 'domcontentloaded' });
  await julianPage.waitForFunction(() => document.getElementById('mode-online'), { timeout: 10000 });
  await julianPage.evaluate(() => document.getElementById('mode-online').click());
  await julianPage.waitForFunction(() => [...document.querySelectorAll('button')].some((node) => node.textContent === 'Accept'), { timeout: 10000 });
  await julianPage.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent === 'Accept').click());
  await julianPage.waitForSelector('#game-chat');
  await julianPage.waitForSelector('#board');
  const normal = await julianPage.$eval('#game-chat', (node) => ({
    min: !!node.querySelector('[title="Minimize"]'),
    max: !!node.querySelector('[title="Maximize"]'),
    restore: !!node.querySelector('[title="Restore"]')
  }));
  assert.equal(normal.min, true);
  assert.equal(normal.max, true);
  assert.equal(normal.restore, false);
  await minaPage.goto(origin + '/human/', { waitUntil: 'domcontentloaded' });
  await minaPage.waitForFunction(() => document.getElementById('mode-online'), { timeout: 10000 });
  await minaPage.evaluate(() => document.getElementById('mode-online').click());
  await minaPage.waitForFunction(() => [...document.querySelectorAll('button')].some((node) => node.textContent === 'Open'));
  await minaPage.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent === 'Open').click());
  await minaPage.waitForSelector('#chat-body');
  await minaPage.type('#chat-body', 'Good evening.');
  await minaPage.evaluate(() => document.getElementById('chat-send').click());
  await minaPage.waitForFunction(() => document.getElementById('chat-body') && document.getElementById('chat-body').value === '');
  await julianPage.waitForFunction(() => document.body.innerText.includes('Good evening.'));
  const onlineChrome = await julianPage.evaluate(() => ({
    header: !!document.querySelector('header.site-header'),
    footer: !!document.querySelector('footer.site-footer'),
    sections: !!document.querySelector('nav.page-nav'),
    crumbs: !!document.querySelector('nav.crumbs'),
    skip: !!document.querySelector('a.skip'),
    title: !!document.querySelector('h1'),
    links: document.querySelectorAll('.human-players a, #game-chat a').length,
    chips: [...document.querySelectorAll('.author-chip')].map((node) => node.tagName)
  }));
  assert.equal(onlineChrome.header, false);
  assert.equal(onlineChrome.footer, false);
  assert.equal(onlineChrome.sections, false);
  assert.equal(onlineChrome.crumbs, false);
  assert.equal(onlineChrome.skip, false);
  assert.equal(onlineChrome.title, false);
  assert.equal(onlineChrome.links, 0);
  assert.ok(onlineChrome.chips.length >= 2);
  assert.ok(onlineChrome.chips.every((tag) => tag === 'SPAN'));
  await julianPage.evaluate(() => document.querySelector('#game-chat [title="Minimize"]').click());
  await julianPage.waitForFunction(() => document.querySelector('#game-chat [title="Restore"]'));
  const minimized = await julianPage.$eval('#game-chat', (node) => ({
    bodyHidden: getComputedStyle(node.querySelector('.human-chat-body') || document.body).display === 'none' || !node.querySelector('.human-chat-body'),
    board: !!document.querySelector('#board'),
    label: node.querySelector('[title="Restore"]').getAttribute('aria-label')
  }));
  assert.equal(minimized.board, true);
  assert.equal(minimized.label, 'Restore');
  await minaPage.type('#chat-body', 'Your move.');
  await minaPage.evaluate(() => document.getElementById('chat-send').click());
  await julianPage.waitForFunction(() => document.body.innerText.includes('unread'));
  await shot(julianPage, 'human_chat_minimized_phone.png');
  await julianPage.evaluate(() => document.querySelector('#game-chat [title="Restore"]').click());
  await julianPage.waitForSelector('[title="Maximize"]');
  await julianPage.evaluate(() => document.querySelector('[title="Maximize"]').click());
  const maximized = await julianPage.$eval('#game-chat [title="Restore"]', (node) => node.getAttribute('aria-label'));
  assert.equal(maximized, 'Restore');
  await julianPage.keyboard.press('Escape');
  await julianPage.waitForSelector('[title="Maximize"]');
  await shot(julianPage, 'human_online_phone.png');
  await shot(minaPage, 'human_online_desktop.png');
  await julianPage.goBack();
  await julianPage.waitForFunction(() => document.body.innerText.includes('It will be aborted'));
  assert.equal(await julianPage.evaluate(() => !!document.querySelector('header.site-header')), false);
  await julianPage.evaluate(() => document.getElementById('leave-no').click());
  await julianPage.waitForFunction(() => document.getElementById('game-chat') && !document.querySelector('header.site-header'));
  await minaPage.evaluate(() => document.getElementById('draw').click());
  await julianPage.waitForSelector('#decline-draw', { timeout: 10000 });
  await julianPage.evaluate(() => document.getElementById('decline-draw').click());
  await minaPage.waitForFunction(() => {
    const button = document.getElementById('draw');
    return button && button.textContent === 'Offer draw';
  }, { timeout: 10000 });
  await minaPage.mouse.move(120, 280);
  await minaPage.mouse.move(120, 4);
  await minaPage.waitForFunction(() => document.body.classList.contains('exit-revealed'));
  await shot(minaPage, 'human_online_exit_desktop.png');
  await julianPage.mouse.move(40, 280);
  await julianPage.mouse.move(40, 3);
  await julianPage.waitForFunction(() => document.body.classList.contains('exit-revealed'));
  await shot(julianPage, 'human_online_exit_phone.png');
  console.log('human browser tests passed');
} finally {
  await browser.close();
  server.close();
  await pool.end();
  psql('postgres', `drop database if exists ${db};`);
}
writeFileSync(join(shots, 'README.txt'), 'Sample screenshots. Mina Chen and Julian Park are local preview accounts.\n');

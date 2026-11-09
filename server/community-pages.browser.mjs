import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const puppeteer = createRequire(fileURLToPath(new URL('./node_modules/puppeteer-core/package.json', import.meta.url)))('puppeteer-core');
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const shots = '/opt/cursor/artifacts';
mkdirSync(shots, { recursive: true });
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.txt': 'text/plain;charset=utf-8' };

function fileFor(urlPath) {
  const relative = (urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath).replace(/^\/+/, '');
  const file = normalize(join(root, relative));
  if (file !== root && !file.startsWith(root + '/')) return null;
  return file;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/session') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ authenticated: false, configured: true, profile: null, master: null }));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  const file = fileFor(url.pathname);
  if (!file) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }
  try {
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  } catch (err) {
    res.writeHead(404);
    res.end('missing');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

async function shot(page, name) {
  await page.evaluate(() => {
    if (document.getElementById('sample-banner')) return;
    const note = document.createElement('p');
    note.id = 'sample-banner';
    note.textContent = 'Sample preview. These are not live accounts.';
    const main = document.querySelector('main');
    if (main) main.prepend(note);
  });
  await page.screenshot({ path: join(shots, name), fullPage: false });
}

try {
  const page = await browser.newPage();
  const client = await page.createCDPSession();
  await client.send('Network.setBypassServiceWorker', { bypass: true });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#account-sign-in');
  const home = await page.$eval('main', (main) => ({
    community: [...main.querySelectorAll('a[href="/community/"]')].length,
    discussion: [...main.querySelectorAll('a[href="/community/discussion/"]')].length,
    roster: [...main.querySelectorAll('a[href="/community/roster/"]')].length,
    strong: [...main.querySelectorAll('strong')].filter((node) => node.textContent.trim() === 'Community').length
  }));
  assert.equal(home.community, 1);
  assert.equal(home.strong, 1);
  assert.equal(home.discussion, 0);
  assert.equal(home.roster, 0);
  const nested = await page.evaluate(() => {
    const link = [...document.querySelectorAll('#site-menu a')].find((anchor) => anchor.textContent === 'Community');
    const branch = link && link.parentElement.nextElementSibling;
    return branch ? [...branch.querySelectorAll(':scope > .nav-item > a')].map((anchor) => anchor.textContent) : [];
  });
  assert.deepEqual(nested, ['Discussion', 'Roster']);
  let box = await page.evaluate(() => {
    const slot = document.getElementById('account-slot').getBoundingClientRect();
    const title = document.querySelector('.site-name').getBoundingClientRect();
    return { overlap: slot.left < title.right - 1, overflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
  });
  assert.equal(box.overlap, false);
  assert.equal(box.overflow, false);
  await page.evaluate(() => {
    if (document.getElementById('sample-banner')) return;
    const note = document.createElement('p');
    note.id = 'sample-banner';
    note.textContent = 'Sample preview. These are not live accounts.';
    document.querySelector('main').prepend(note);
  });
  await page.screenshot({ path: join(shots, 'chess_home_desktop.png'), fullPage: true });

  await page.setViewport({ width: 390, height: 844 });
  box = await page.evaluate(() => {
    const slot = document.getElementById('account-slot').getBoundingClientRect();
    const title = document.querySelector('.site-name').getBoundingClientRect();
    return { overlap: slot.left < title.right - 1, overflow: document.documentElement.scrollWidth > window.innerWidth + 1, slotRight: slot.right };
  });
  assert.equal(box.overlap, false, JSON.stringify(box));
  assert.equal(box.overflow, false);
  assert.ok(box.slotRight <= 391);
  await page.$eval('main a[href="/community/"]', (node) => node.scrollIntoView({ block: 'center' }));
  await shot(page, 'chess_home_phone.png');

  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin + '/community/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a.entry[href="/community/discussion/"]');
  const community = await page.evaluate(() => ({
    discussion: document.querySelector('a.entry[href="/community/discussion/"]').textContent,
    roster: document.querySelector('a.entry[href="/community/roster/"]').textContent,
    height: document.querySelector('a.entry[href="/community/discussion/"]').getBoundingClientRect().height,
    crumbs: [...document.querySelectorAll('.crumbs li')].map((node) => node.textContent.trim())
  }));
  assert.match(community.discussion, /Discussion/);
  assert.match(community.roster, /Roster/);
  assert.ok(community.height >= 72);
  assert.deepEqual(community.crumbs.slice(-2), ['Chess', 'Community']);
  await shot(page, 'chess_community_desktop.png');
  await page.setViewport({ width: 390, height: 844 });
  const phone = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  assert.equal(phone, true);
  await shot(page, 'chess_community_phone.png');

  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin + '/discussion/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => location.pathname === '/community/discussion/');
  const discussionCrumbs = await page.$$eval('.crumbs li', (nodes) => nodes.map((node) => node.textContent.trim()));
  assert.deepEqual(discussionCrumbs.slice(-3), ['Chess', 'Community', 'Discussion']);
  await page.goto(origin + '/roster/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => location.pathname === '/community/roster/');
  const rosterCrumbs = await page.$$eval('.crumbs li', (nodes) => nodes.map((node) => node.textContent.trim()));
  assert.deepEqual(rosterCrumbs.slice(-3), ['Chess', 'Community', 'Roster']);

  await page.goto(origin + '/community/profile/?id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#account-sign-in');
  assert.equal(await page.$('.site-nav'), null);
  assert.equal(await page.$('footer'), null);
  console.log('community pages browser tests passed');
} finally {
  await browser.close();
  server.close();
}

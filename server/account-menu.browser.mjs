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
const mina = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.txt': 'text/plain;charset=utf-8' };
let signedIn = false;
const sessionWaiters = [];
let holdSession = true;
function releaseSession() {
  holdSession = false;
  sessionWaiters.splice(0).forEach((resume) => resume());
}

function fileFor(urlPath) {
  const relative = (urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath).replace(/^\/+/, '');
  const file = normalize(join(root, relative));
  if (file !== root && !file.startsWith(root + '/')) return null;
  return file;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (body, status, type) => {
    res.writeHead(status || 200, { 'content-type': type || 'application/json', 'cache-control': 'no-store' });
    res.end(body);
  };
  if (url.pathname === '/api/session') {
    const reply = () => send(JSON.stringify(signedIn
      ? { authenticated: true, configured: true, profile: { id: mina, displayName: 'Mina Chen the Very Long Chess Name', hasPortrait: true } }
      : { authenticated: false, configured: true, profile: null }));
    if (holdSession) sessionWaiters.push(reply);
    else reply();
    return;
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    signedIn = false;
    return send(JSON.stringify({ authenticated: false }));
  }
  if (url.pathname === '/api/auth/start' && req.method === 'POST') return send(JSON.stringify({ sent: true }));
  if (url.pathname === '/api/profiles/' + mina + '/portrait') return send('{}', 404);
  if (url.pathname.startsWith('/api/')) return send('{}', 404);
  const file = fileFor(url.pathname);
  if (!file) return send('bad', 400, 'text/plain');
  try { send(readFileSync(file), 200, types[extname(file)] || 'application/octet-stream'); }
  catch (err) { send('missing', 404, 'text/plain'); }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

async function shot(page, name) {
  await page.evaluate(() => {
    if (document.getElementById('sample-banner')) return;
    const note = document.createElement('p');
    note.id = 'sample-banner';
    note.textContent = 'Sample preview. Mina Chen is not a live account.';
    document.querySelector('main').prepend(note);
  });
  await page.screenshot({ path: join(shots, name), fullPage: false });
}

function layout(page) {
  return page.evaluate(() => {
    const slot = document.getElementById('account-slot').getBoundingClientRect();
    const title = document.querySelector('.site-name').getBoundingClientRect();
    const header = document.querySelector('header.site-header').getBoundingClientRect();
    return {
      slotRight: slot.right,
      slotLeft: slot.left,
      titleRight: title.right,
      headerRight: header.right,
      width: window.innerWidth,
      overlap: slot.left < title.right - 1,
      inHeader: slot.top >= header.top - 1 && slot.bottom <= header.bottom + 1
    };
  });
}

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err.message || err)));
  const client = await page.createCDPSession();
  await client.send('Network.setBypassServiceWorker', { bypass: true });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.account-pending');
  const loading = await page.evaluate(() => ({
    pending: !!document.querySelector('.account-pending'),
    signIn: !!document.getElementById('account-sign-in'),
    name: !!document.querySelector('.account-name')
  }));
  assert.equal(loading.pending, true);
  assert.equal(loading.signIn, false);
  assert.equal(loading.name, false);
  releaseSession();
  await page.waitForSelector('#account-sign-in');
  assert.equal(await page.$eval('#account-sign-in', (node) => node.textContent), 'Sign in');
  let box = await layout(page);
  assert.equal(box.overlap, false);
  assert.equal(box.inHeader, true);
  assert.ok(box.slotRight <= box.width + 1);
  await shot(page, 'account_signed_out_desktop.png');
  await page.evaluate(() => document.getElementById('account-sign-in').click());
  await page.waitForSelector('#account-create');
  assert.equal(await page.$eval('#account-dialog-title', (node) => node.textContent), 'Sign in');
  await page.evaluate(() => document.getElementById('account-create').click());
  await page.waitForFunction(() => document.getElementById('account-dialog-title').textContent === 'Create an account' && document.getElementById('account-submit').textContent === 'Create an account');
  await page.evaluate(() => document.getElementById('account-close').click());
  await page.waitForSelector('#account-sign-in');

  await page.setViewport({ width: 390, height: 844 });
  box = await layout(page);
  assert.equal(box.overlap, false, JSON.stringify(box));
  assert.ok(box.slotRight <= 391);
  await shot(page, 'account_signed_out_phone.png');

  signedIn = true;
  await page.setViewport({ width: 1280, height: 900 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#account-menu-button');
  const signed = await page.$eval('#account-menu-button', (node) => ({
    label: node.getAttribute('aria-label'),
    name: node.querySelector('.account-name').textContent,
    avatar: !!node.querySelector('.account-avatar')
  }));
  assert.equal(signed.label, 'Mina Chen the Very Long Chess Name');
  assert.equal(signed.name, signed.label);
  assert.equal(signed.avatar, true);
  assert.equal(await page.$eval('.account-name', (node) => getComputedStyle(node).textOverflow), 'ellipsis');
  assert.ok(await page.$eval('.account-name', (node) => node.scrollWidth > node.clientWidth));
  box = await layout(page);
  assert.equal(box.overlap, false, JSON.stringify(box));
  await shot(page, 'account_signed_in_desktop.png');
  await page.evaluate(() => document.getElementById('account-menu-button').click());
  await page.waitForSelector('#account-profile');
  assert.equal(await page.$eval('#account-profile', (node) => node.getAttribute('href')), '/community/profile/?id=' + mina);
  await page.evaluate(() => document.getElementById('account-sign-out').click());
  await page.waitForSelector('#account-sign-in');
  assert.equal(await page.$eval('#account-sign-in', (node) => node.textContent), 'Sign in');

  signedIn = true;
  await page.setViewport({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#account-menu-button');
  const phoneName = await page.$eval('.account-name', (node) => getComputedStyle(node).position);
  assert.equal(phoneName, 'absolute');
  box = await layout(page);
  assert.equal(box.overlap, false, JSON.stringify(box));
  assert.ok(box.slotRight <= 391);
  assert.equal(await page.$eval('#account-menu-button', (node) => node.getAttribute('aria-label')), 'Mina Chen the Very Long Chess Name');
  await shot(page, 'account_signed_in_phone.png');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('account menu browser tests passed');
} finally {
  await browser.close();
  server.close();
}

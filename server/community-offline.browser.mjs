import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const puppeteer = createRequire(fileURLToPath(new URL('./node_modules/puppeteer-core/package.json', import.meta.url)))('puppeteer-core');
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.txt': 'text/plain;charset=utf-8' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const relative = (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname).replace(/^\/+/, '');
  const file = normalize(join(root, relative));
  if (file !== root && !file.startsWith(root + '/')) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch (err) {
    res.writeHead(404);
    res.end('missing');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(String(err.message || err)));
page.on('requestfailed', (request) => {
  if (request.url().includes('/assets/chess/')) errors.push('failed ' + request.url());
});
const screens = [
  '/community/',
  '/community/discussion/',
  '/community/profile/?id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
];
try {
  await page.goto(origin + '/community/', { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 15000;
  let cached = false;
  while (Date.now() < deadline) {
    cached = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration || !registration.active) return false;
      const cache = await caches.open('chess-v9');
      const keys = await cache.keys();
      return keys.some((key) => key.url.endsWith('/assets/chess/profile-picture.js'))
        && keys.some((key) => key.url.endsWith('/assets/chess/community-view.js'));
    });
    if (cached) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(cached, true, 'chess-v9 did not precache profile-picture.js');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setOfflineMode(true);
  for (const path of screens) {
    errors.length = 0;
    await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
    const shown = await page.evaluate(async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const app = document.getElementById('community-app');
        const text = app ? app.textContent : '';
        if (text && (text.includes('could not be reached') || text.includes('Not configured') || text.includes('Discussion'))) return text;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const app = document.getElementById('community-app');
      return app ? app.textContent : document.body.innerText.slice(0, 300);
    });
    assert.match(shown, /could not be reached/, path + ' showed: ' + shown);
    const moduleResponse = await page.evaluate(async () => {
      const response = await fetch('/assets/chess/profile-picture.js');
      return { ok: response.ok, text: (await response.text()).includes('prepareProfileImage') };
    });
    assert.equal(moduleResponse.ok, true, path);
    assert.equal(moduleResponse.text, true, path);
    assert.equal(errors.some((item) => item.includes('profile-picture') || item.includes('/assets/chess/')), false, path + ' ' + errors.join('\n'));
  }
  console.log('offline community screens loaded profile-picture.js');
} finally {
  await browser.close();
  server.close();
}

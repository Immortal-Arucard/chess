import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const puppeteer = createRequire(fileURLToPath(new URL('./node_modules/puppeteer-core/package.json', import.meta.url)))('puppeteer-core');
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.txt': 'text/plain;charset=utf-8' };
let generation = 'stale';
let apiHits = 0;
const shellRequests = [];

function fileFor(urlPath) {
  const relative = (urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath).replace(/^\/+/, '');
  const file = normalize(join(root, relative));
  if (file !== root && !file.startsWith(root + '/')) return null;
  return file;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/ping') {
    apiHits += 1;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end('{"ok":true}');
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end('{}');
    return;
  }
  if (url.pathname === '/assets/site.js') {
    shellRequests.push({
      cache: req.headers['cache-control'] || '',
      pragma: req.headers.pragma || '',
      generation
    });
  }
  const file = fileFor(url.pathname);
  if (!file) {
    res.writeHead(404);
    res.end('missing');
    return;
  }
  let body = readFileSync(file);
  if (url.pathname === '/assets/site.js') body = Buffer.concat([body, Buffer.from('\nself.__CHESS_SHELL=' + JSON.stringify(generation) + ';\n')]);
  res.writeHead(200, {
    'content-type': types[extname(file)] || 'application/octet-stream',
    'cache-control': 'max-age=14400'
  });
  res.end(body);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => sessionStorage.setItem('chess-sw-reload', 'chess-v18'));
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 15000;
  let active = false;
  while (Date.now() < deadline) {
    active = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return !!(registration && registration.active);
    });
    if (active && shellRequests.length) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(active, true);
  assert.ok(shellRequests.some((item) => item.cache.includes('no-cache') || item.pragma.includes('no-cache')), JSON.stringify(shellRequests));
  generation = 'fresh';
  const seen = shellRequests.length;
  const text = await page.evaluate(async () => {
    const response = await fetch('/assets/site.js?v=18');
    return response.text();
  });
  assert.match(text, /__CHESS_SHELL="fresh"/);
  assert.ok(shellRequests.length > seen, JSON.stringify(shellRequests));
  assert.ok(shellRequests.slice(seen).some((item) => item.generation === 'fresh'), JSON.stringify(shellRequests.slice(seen)));
  const ping = await page.evaluate(async () => {
    const response = await fetch('/api/ping');
    return response.status;
  });
  assert.equal(ping, 200);
  assert.equal(apiHits, 1);
  await page.setOfflineMode(true);
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('h1') && document.querySelector('h1').textContent === 'Chess');
  console.log('service worker reload tests passed');
} finally {
  await browser.close();
  server.close();
}

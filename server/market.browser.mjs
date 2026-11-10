import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const puppeteer = createRequire(fileURLToPath(new URL('./node_modules/puppeteer-core/package.json', import.meta.url)))('puppeteer-core');
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.txt': 'text/plain;charset=utf-8' };
const listing = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  sellerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  sellerName: 'Julian',
  title: 'Rosewood board',
  description: 'A chess board.',
  category: 'boards',
  condition: 'good',
  priceCents: 4000,
  quantity: 1,
  fulfillment: 'shipping',
  location: 'Austin',
  openToTrades: true,
  status: 'active',
  photos: [],
  mine: false,
  checkoutEnabled: false
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (body, status, type) => {
    res.writeHead(status || 200, { 'content-type': type || 'application/json', 'cache-control': 'no-store' });
    res.end(body);
  };
  if (url.pathname === '/api/session') return send(JSON.stringify({ authenticated: false, profile: null }));
  if (url.pathname === '/api/market/config') return send(JSON.stringify({ checkoutEnabled: false, admin: false, profileId: null, feeBps: 0 }));
  if (url.pathname === '/api/market/listings') return send(JSON.stringify({ listings: [listing], checkoutEnabled: false }));
  if (url.pathname === '/api/market/listings/' + listing.id) return send(JSON.stringify(listing));
  if (url.pathname.startsWith('/api/')) return send('{}', 404);
  const relative = (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname).replace(/^\/+/, '');
  const file = normalize(join(root, relative));
  if (file !== root && !file.startsWith(root + '/')) return send('bad', 400, 'text/plain');
  try { send(readFileSync(file), 200, types[extname(file)] || 'application/octet-stream'); }
  catch (err) { send('missing', 404, 'text/plain'); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
const client = await page.createCDPSession();
await client.send('Network.setBypassServiceWorker', { bypass: true });
try {
  await page.setViewport({ width: 390, height: 800 });
  await page.goto(origin + '/marketplace/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('Checkout not yet enabled') && document.body.innerText.includes('Rosewood board'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, '390 overflow');
  await page.setViewport({ width: 1280, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, '1280 overflow');
  await page.evaluate(() => document.querySelector('.market-card a').click());
  await page.waitForFunction(() => document.body.innerText.includes('Not chess-related'));
  const buy = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Checkout not yet enabled'));
    return button ? button.disabled : null;
  });
  assert.equal(buy, true);
  await page.goto(origin + '/analysis/', { waitUntil: 'domcontentloaded' });
  const exchange = await page.evaluate(() => {
    const link = [...document.querySelectorAll('.page-nav a')].find((item) => item.getAttribute('href') === '/exchange/' && item.querySelector('span'));
    return link ? link.textContent : '';
  });
  assert.match(exchange, /Simulated ratings trading in AMU/);
  assert.equal(exchange.includes('Not operational'), false);
  console.log('marketplace browser tests passed');
} finally {
  await browser.close();
  server.close();
}

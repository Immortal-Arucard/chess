import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const puppeteer = createRequire(fileURLToPath(new URL('./node_modules/puppeteer-core/package.json', import.meta.url)))('puppeteer-core');
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const shots = '/opt/cursor/artifacts';
mkdirSync(shots, { recursive: true });
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.txt': 'text/plain;charset=utf-8' };
const instrument = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
let signed = false;
let balance = '1000000000000';
let holdings = [];

function fileFor(urlPath) {
  const relative = (urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath).replace(/^\/+/, '');
  const file = normalize(join(root, relative));
  if (file !== root && !file.startsWith(root + '/')) return null;
  return file;
}

const quote = {
  id: instrument,
  marketId: 'fide:standard',
  symbol: 'CARLSEN',
  name: 'Magnus Carlsen',
  referenceRating: 2823,
  referenceAsOf: '2026-11-01T00:00:00Z',
  referenceSource: 'ChessBase publication of the FIDE standard list, 2 November 2026',
  referenceKind: 'snapshot',
  live: false,
  lastPrice: '2823000',
  seedPrice: '2823000',
  bid: '2808885',
  ask: '2837115',
  bidIsMarketMaker: true,
  askIsMarketMaker: true,
  marketMakerLabel: 'Simulated market maker'
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch (err) { /* keep the raw path */ }
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (path === '/api/test/sign-in' && req.method === 'POST') {
    signed = true;
    return send(200, { ok: true });
  }
  if (path === '/api/session') {
    return send(200, signed
      ? { authenticated: true, configured: true, profile: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', displayName: 'Mina Chen' } }
      : { authenticated: false, configured: true, profile: null });
  }
  if (path === '/api/exchange/markets') {
    return send(200, {
      simulated: true, currency: 'AMU', live: false, disclaimer: 'Simulated, not real money.', startingBalance: '1000000000000',
      markets: [{ id: 'fide:standard', title: 'FIDE Standard', source: 'fide', category: 'standard', ratingLabel: 'FIDE Standard rating', referenceKind: 'snapshot', referenceSource: quote.referenceSource, asOf: quote.referenceAsOf, live: false, listed: 1 }]
    });
  }
  if (path === '/api/exchange/markets/fide:standard') {
    return send(200, { simulated: true, currency: 'AMU', live: false, disclaimer: 'Simulated, not real money. The reference rating is not the market price.', market: { id: 'fide:standard', title: 'FIDE Standard', ratingLabel: 'FIDE Standard rating', referenceKind: 'snapshot', referenceSource: quote.referenceSource, asOf: quote.referenceAsOf, live: false }, instruments: [quote] });
  }
  if (path === '/api/exchange/instruments/' + instrument) {
    return send(200, {
      simulated: true, currency: 'AMU', live: false,
      disclaimer: 'Simulated, not real money. The reference rating is not the market price.',
      market: { id: 'fide:standard', title: 'FIDE Standard', ratingLabel: 'FIDE Standard rating', referenceKind: 'snapshot', referenceSource: quote.referenceSource, asOf: quote.referenceAsOf, live: false },
      instrument: quote,
      book: { bids: [{ price: '2808885', quantity: 100, makerQuantity: 100 }], asks: [{ price: '2837115', quantity: 100, makerQuantity: 100 }] },
      trades: [],
      chart: [{ price: '2823000', at: '2026-11-10T05:04:00Z', opening: true }]
    });
  }
  if (path === '/api/exchange/portfolio') {
    if (!signed) return send(401, { error: 'Sign in before doing that.' });
    return send(200, {
      simulated: true, currency: 'AMU', live: false, disclaimer: 'Simulated, not real money.',
      balance, reserved: '0', equity: balance, realizedPnl: '0', unrealizedPnl: '0',
      holdings, openOrders: [], trades: []
    });
  }
  if (path === '/api/exchange/leaderboard') {
    return send(200, { simulated: true, currency: 'AMU', live: false, disclaimer: 'Simulated, not real money.', entries: [{ rank: 1, profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', displayName: 'Mina Chen', equity: balance }] });
  }
  if (req.method === 'POST' && path === '/api/exchange/orders') {
    if (!signed) return send(401, { error: 'Sign in before doing that.' });
    balance = '999997162885';
    holdings = [{ instrumentId: instrument, symbol: 'CARLSEN', name: 'Magnus Carlsen', marketId: 'fide:standard', quantity: 1, avgCost: '2837115', lastPrice: '2837115', referenceRating: 2823, marketValue: '2837115' }];
    return send(200, { simulated: true, currency: 'AMU', order: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'filled', side: 'buy', orderType: 'market', price: null, quantity: 1, filled: 1 }, instrument: quote });
  }
  if (path.startsWith('/api/')) return send(404, { error: 'Not found.' });
  const file = fileFor(path);
  if (!file) return send(400, { error: 'bad path' });
  try {
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch (err) {
    res.writeHead(404);
    res.end('missing');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  const api = [];
  page.on('response', (response) => {
    if (response.url().includes('/api/')) api.push(response.status() + ' ' + response.url());
  });
  page.on('pageerror', (err) => api.push('pageerror ' + err.message));
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(origin + '/exchange/#/m/fide:standard', { waitUntil: 'networkidle0' });
  const phone = await page.evaluate(() => {
    const text = document.body.textContent;
    const wide = [...document.querySelectorAll('body *')].filter((node) => node.scrollWidth > document.documentElement.clientWidth + 1).slice(0, 6).map((node) => node.className + ' ' + node.tagName);
    return {
      banner: text.includes('Simulated, not real money'),
      rating: !!document.querySelector('.ex-ref'),
      price: !!document.querySelector('.ex-price'),
      separate: text.includes('2,823') && text.includes('2,823,000'),
      overflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      wide,
      ticket: text.includes('Sign in and join Chess to place a simulated order.')
    };
  });
  assert.equal(phone.banner && phone.rating && phone.price && phone.separate && phone.overflow && phone.ticket === false, true, JSON.stringify({ phone, api }));
  await page.click('button.ex-card');
  await page.waitForFunction(() => document.body.innerText.includes('Sign in and join Chess to place a simulated order.'));
  const instrumentText = await page.evaluate(() => document.body.textContent);
  assert.match(instrumentText, /Reference rating/);
  assert.match(instrumentText, /Simulated last price/);
  assert.match(instrumentText, /Simulated market maker/);
  assert.equal(instrumentText.includes('2,823') && instrumentText.includes('2,823,000 AMU'), true);
  await page.screenshot({ path: shots + '/exchange-390.png', fullPage: true });
  await page.evaluate(() => fetch('/api/test/sign-in', { method: 'POST' }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const button = document.querySelector('button.ex-btn.primary');
    return button && button.disabled === false;
  });
  const selects = await page.$$('select');
  await selects[1].select('market');
  await page.click('button.ex-btn.primary');
  await page.waitForFunction(() => {
    const note = document.getElementById('order-notice');
    return note && note.textContent.includes('Filled 1 of 1');
  });
  await page.goto(origin + '/exchange/#/portfolio', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('999,997,162,885 AMU'));
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(origin + '/exchange/#/m/fide:standard', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button.ex-card');
  const desktop = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  assert.equal(desktop, true);
  await page.screenshot({ path: shots + '/exchange-1280.png', fullPage: true });
  console.log('exchange browser tests passed');
} finally {
  await browser.close();
  server.close();
}

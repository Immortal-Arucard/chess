import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const puppeteer = createRequire(fileURLToPath(new URL('./node_modules/puppeteer-core/package.json', import.meta.url)))('puppeteer-core');
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.txt': 'text/plain;charset=utf-8' };
const pgn = `[Event "One"]
[White "Ada"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0

[Event "Two"]
[White "Cara"]
[Black "Dee"]
[Result "*"]

1. d4 d5 *`;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('analysis must not call the api');
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
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch (err) {
    res.writeHead(404);
    res.end('missing');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
const errors = [];
const apiCalls = [];
page.on('pageerror', (err) => errors.push(String(err.message || err)));
page.on('request', (request) => {
  if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls.push(request.url());
});
const client = await page.createCDPSession();
await client.send('Network.setBypassServiceWorker', { bypass: true });

async function clickSquare(square) {
  await page.evaluate((name) => document.querySelector('[data-square="' + name + '"]').click(), square);
}

try {
  await page.setViewport({ width: 390, height: 800 });
  await page.goto(origin + '/analysis/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.board [data-square="e2"]');
  const phone = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    bar: Boolean(document.querySelector('.eval-bar')),
    graph: Boolean(document.querySelector('.eval-graph')),
    copy: [...document.querySelectorAll('button')].some((button) => button.textContent === 'Copy FEN')
  }));
  assert.equal(phone.overflow, false, '390 overflow');
  assert.equal(phone.bar, true);
  assert.equal(phone.graph, true);
  assert.equal(phone.copy, true);
  await page.setViewport({ width: 1280, height: 800 });
  const desktop = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(desktop, false, '1280 overflow');
  await page.evaluate((text) => { document.querySelector('textarea').value = text; }, pgn);
  await page.evaluate(() => document.querySelector('.analysis-import').requestSubmit());
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent === 'Game 2'));
  await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Game 2').click());
  await page.waitForFunction(() => document.querySelector('.move-tree') && document.querySelector('.move-tree').textContent.includes('d4'));
  await page.evaluate(() => document.querySelector('.eval-graph button').click());
  const jumped = await page.evaluate(() => document.querySelector('.move-tree button.is-here').textContent);
  assert.match(jumped, /d4/);
  await page.keyboard.press('ArrowLeft');
  await clickSquare('e2');
  await clickSquare('e3');
  const branched = await page.evaluate(() => document.querySelector('.move-tree').textContent);
  assert.match(branched, /e3/);
  assert.match(branched, /d4/);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Main line').click());
  const here = await page.evaluate(() => document.querySelector('.move-tree button.is-here').textContent);
  assert.match(here, /d4/);
  await page.keyboard.press('ArrowLeft');
  const back = await page.evaluate(() => document.querySelector('.move-tree button.is-here'));
  assert.equal(back, null);
  await page.evaluate((text) => { document.querySelector('textarea').value = text; }, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
  await page.evaluate(() => document.querySelector('.analysis-import').requestSubmit());
  await page.waitForFunction(() => {
    const square = document.querySelector('[data-square="e4"]');
    return square && square.getAttribute('aria-label').includes('white pawn');
  });
  const deadline = Date.now() + 20000;
  let engineLine = '';
  while (Date.now() < deadline) {
    engineLine = await page.evaluate(() => {
      const item = document.querySelector('.engine-lines li');
      return item ? item.textContent : '';
    });
    if (engineLine.includes('Depth')) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.match(engineLine, /Depth/);
  const writes = apiCalls.filter((url) => !new URL(url).pathname.endsWith('/api/session'));
  assert.equal(writes.length, 0, writes.join(','));
  assert.equal(errors.length, 0, errors.join('\n'));
  const bot = await page.goto(origin + '/bot/', { waitUntil: 'domcontentloaded' });
  assert.equal(bot.ok(), true);
  const analyze = await page.evaluate(() => {
    const link = document.getElementById('analyze-game');
    return link ? link.textContent + ' ' + link.getAttribute('href') : '';
  });
  assert.equal(analyze, 'Analyze /analysis/');
  console.log('analysis browser tests passed');
} finally {
  await browser.close();
  server.close();
}

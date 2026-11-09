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
const julian = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const gameId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.txt': 'text/plain;charset=utf-8' };
const ratings = { bullet: 1510, blitz: 1000, rapid: 1480, daily: 1400, untimed: 40, puzzles: null };
const opponentRatings = { bullet: 1490, blitz: 1101, rapid: 1500, daily: 1390, untimed: 10, puzzles: null };

function fileFor(urlPath) {
  const relative = (urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath).replace(/^\/+/, '');
  const file = normalize(join(root, relative));
  if (file !== root && !file.startsWith(root + '/')) return null;
  return file;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (body) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/api/session') return send({ authenticated: true, configured: true, profile: { id: mina, displayName: 'Mina Chen' } });
  if (url.pathname === '/api/settings' && req.method === 'POST') return send({ autoSaveBotResults: false, autoRecordHumanChat: false });
  if (url.pathname === '/api/human/results') return send({ games: [] });
  if (url.pathname === '/api/human/incoming') return send({ games: [] });
  if (url.pathname === '/api/human/lobby') return send({ games: [] });
  if (url.pathname === '/api/human/mine') {
    return send({ games: [{
      id: gameId, status: 'active', category: 'blitz', timeLabel: '3+2', rated: true, creatorColor: 'white',
      creatorId: mina, creatorName: 'Mina Chen', creatorRating: 1000, opponentRating: 1101, turn: 'white'
    }] });
  }
  if (url.pathname === '/api/profiles/' + mina) return send({ id: mina, displayName: 'Mina Chen', createdAt: '2026-01-01T00:00:00Z', bio: '', hasPortrait: false, hasBackground: false, ratings });
  if (url.pathname === '/api/profiles/' + julian) return send({ id: julian, displayName: 'Julian Park', createdAt: '2026-01-02T00:00:00Z', bio: '', hasPortrait: false, hasBackground: false, ratings: opponentRatings });
  if (url.pathname === '/api/human/search') {
    return send({ profiles: [{ id: julian, displayName: 'Julian Park', hasPortrait: false, ratings: opponentRatings }] });
  }
  if (url.pathname === '/api/human/games/' + gameId) {
    return send({
      id: gameId, status: 'finished', result: '1-0', termination: 'resign', category: 'blitz', timeLabel: '3+2', rated: true,
      version: 4, sans: ['e4', 'e5'], whiteId: mina, blackId: julian, whiteName: 'Mina Chen', blackName: 'Julian Park',
      myColor: 'white', turn: null, baseMs: 180000, incrementMs: 2000, whiteMs: 180000, blackMs: 170000,
      clockAt: new Date().toISOString(), serverNow: new Date().toISOString(), messages: [], iAmRecording: false,
      whiteRatingBefore: 1000, blackRatingBefore: 1101, whiteRating: 1012, blackRating: 1088, whiteDelta: 12, blackDelta: -13
    });
  }
  if (url.pathname.endsWith('/posts')) return send({ posts: [] });
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

try {
  const page = await browser.newPage();
  const client = await page.createCDPSession();
  await client.send('Network.setBypassServiceWorker', { bypass: true });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin + '/human/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mode-online');
  await page.evaluate(() => document.getElementById('mode-online').click());
  await page.waitForSelector('#rated-off');
  const initial = await page.evaluate(() => ({
    unrated: document.getElementById('rated-off').getAttribute('aria-pressed'),
    rated: document.getElementById('rated-on').getAttribute('aria-pressed'),
    text: document.body.innerText
  }));
  assert.equal(initial.unrated, 'true');
  assert.equal(initial.rated, 'false');
  assert.match(initial.text, /Your blitz rating is 1000/);
  await page.evaluate(() => document.getElementById('rated-on').click());
  await page.waitForFunction(() => document.getElementById('rated-on').getAttribute('aria-pressed') === 'true');
  await page.type('#name-search', 'Julian');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent === 'Search').click());
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((node) => node.textContent === 'Julian Park'));
  await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent === 'Julian Park').click());
  await page.waitForFunction(() => document.body.innerText.includes("Julian Park is 1101"));
  await shot(page, 'rating_challenge_desktop.png');
  await page.setViewport({ width: 390, height: 844 });
  await shot(page, 'rating_challenge_phone.png');
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent === 'Open').click());
  await page.waitForSelector('#rating-result');
  const result = await page.$eval('#rating-result', (node) => node.textContent);
  assert.equal(result, 'White +12 · Black -13');
  assert.match(await page.evaluate(() => document.body.innerText), /Rated/);
  await shot(page, 'rating_result_desktop.png');
  await page.setViewport({ width: 390, height: 844 });
  await shot(page, 'rating_result_phone.png');
  await page.goto(origin + '/community/profile/?id=' + mina, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('Bullet 1510') && document.body.innerText.includes('Untimed 40') && document.body.innerText.includes('Puzzles Unrated'));
  console.log('rating browser tests passed');
} finally {
  await browser.close();
  server.close();
}

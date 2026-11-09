import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Chess } from '../assets/vendor/chess.js/chess.js';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const puppeteer = createRequire(fileURLToPath(new URL('./node_modules/puppeteer-core/package.json', import.meta.url)))('puppeteer-core');
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const shots = '/opt/cursor/artifacts';
mkdirSync(shots, { recursive: true });
const mina = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const attemptId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const practice = JSON.parse(readFileSync(new URL('../puzzles/practice.json', import.meta.url), 'utf8'));
const sample = practice.find((row) => row.moves[1].length === 4);
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.txt': 'text/plain;charset=utf-8' };
const game = new Chess(sample.fen);
const sans = sample.moves.map((uci) => {
  const played = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
  return played.san;
});
const active = {
  attemptId, puzzleId: sample.id, lichessId: sample.id, serial: 1042, puzzleRating: sample.rating, themes: sample.themes,
  setupFen: sample.fen, applied: [sample.moves[0]], status: 'active', finished: false, summoned: false,
  solution: null, played: [], streak: 4, best: 6, userRating: 1200, delta: null, bonus: null, gain: 0
};
const solved = Object.assign({}, active, {
  status: 'solved', finished: true, applied: sample.moves, solution: sample.moves, solutionSans: sans,
  played: [{ ply: 1, uci: sample.moves[1], correct: true, millis: 1800 }],
  delta: 13, bonus: 2, gain: 11, streak: 5, streakBefore: 4, streakAfter: 5, userRating: 1213, ratingAfter: 1213
});
let stage = 'home';

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
  if (url.pathname === '/api/settings') return send({ autoSaveBotResults: false, autoRecordHumanChat: false, puzzleOrder: 'tier', puzzleMin: 800, puzzleMax: 1600, puzzleTier: 800, puzzleStreak: 4, puzzleBest: 6, puzzleRating: 1200 });
  if (url.pathname === '/api/puzzles/current') return send({ attempt: stage === 'home' ? null : active, streak: 4, best: 6, userRating: 1200 });
  if (url.pathname === '/api/puzzles/next') {
    stage = 'play';
    return send({ exhausted: false, attempt: active, streak: 4, best: 6, userRating: 1200 });
  }
  if (url.pathname === '/api/puzzles/move') {
    stage = 'solved';
    return send(solved);
  }
  if (url.pathname === '/api/profiles/' + mina) return send({ id: mina, displayName: 'Mina Chen', createdAt: '2026-01-01T00:00:00Z', bio: '', hasPortrait: false, hasBackground: false, ratings: { bullet: 1510, blitz: 1602, rapid: 1488, daily: 1400, untimed: 900, puzzles: 1213 } });
  if (url.pathname === '/api/puzzles/attempts' && req.method === 'GET') {
    return send({ attempts: [{ id: attemptId, puzzleId: sample.id, lichessId: sample.id, serial: 1042, puzzleRating: sample.rating, status: 'solved', summoned: false, delta: 13, bonus: 2, streakBefore: 4, streakAfter: 5, finishedAt: '2026-11-09T20:00:00.000Z' }], next: { finishedAt: '2026-11-09T19:00:00.000Z', id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } });
  }
  if (url.pathname === '/api/puzzles/attempts/' + attemptId) return send(solved);
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
    note.textContent = 'Sample preview. Mina Chen is not a live account.';
    document.querySelector('main').prepend(note);
  });
  await page.screenshot({ path: join(shots, name), fullPage: true });
}

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err.message || err)));
  const client = await page.createCDPSession();
  await client.send('Network.setBypassServiceWorker', { bypass: true });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin + '/puzzles/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('Puzzle rating 1200') && document.body.innerText.includes('Weakest to strongest') && document.body.innerText.toLowerCase().includes('go to puzzle'));
  assert.equal(await page.$eval('#puzzle-order', (node) => node.value), 'tier');
  assert.equal(await page.$eval('#puzzle-min', (node) => node.value), '800');
  await shot(page, 'puzzle_settings_desktop.png');
  await page.setViewport({ width: 390, height: 844 });
  await shot(page, 'puzzle_settings_phone.png');
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluate(() => document.getElementById('puzzle-start').click());
  await page.waitForFunction((id) => document.body.innerText.includes('Puzzle #1042') && document.body.innerText.includes('Lichess ' + id) && document.getElementById('puzzle-copy'), {}, sample.id);
  await page.waitForSelector('#puzzle-board .square');
  await shot(page, 'puzzle_board_desktop.png');
  await page.setViewport({ width: 390, height: 844 });
  await shot(page, 'puzzle_board_phone.png');
  await page.setViewport({ width: 1280, height: 900 });
  const from = sample.moves[1].slice(0, 2);
  const to = sample.moves[1].slice(2, 4);
  await page.evaluate((source, target) => {
    document.querySelector(`[data-square="${source}"]`).click();
    document.querySelector(`[data-square="${target}"]`).click();
  }, from, to);
  await page.waitForFunction(() => document.getElementById('puzzle-outcome') && document.getElementById('puzzle-outcome').textContent === 'Solved. +11 +2 streak');
  await shot(page, 'puzzle_result_desktop.png');
  await page.setViewport({ width: 390, height: 844 });
  await shot(page, 'puzzle_result_phone.png');
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluate(() => document.getElementById('puzzle-review').click());
  await page.waitForFunction(() => document.body.innerText.includes('Solution') && document.body.innerText.includes('Your moves') && document.body.innerText.includes('1.8s'));
  await page.evaluate(() => document.getElementById('review-next').click());
  await page.waitForSelector('.puzzle-line .is-current');
  await shot(page, 'puzzle_review_desktop.png');
  await page.setViewport({ width: 390, height: 844 });
  await shot(page, 'puzzle_review_phone.png');

  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin + '/community/profile/?id=' + mina, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((id) => document.body.innerText.includes('Puzzle attempts') && document.body.innerText.includes('#1042') && document.body.innerText.includes('Puzzle ' + id) && document.body.innerText.includes('Solved') && document.body.innerText.includes('+11 +2 streak') && document.body.innerText.includes('Open #1042') && document.body.innerText.includes('Puzzles 1213'), {}, sample.id);
  await page.evaluate(() => document.querySelector('.puzzle-attempt button').click());
  await page.waitForFunction((uci) => document.body.innerText.includes('Move 1 ' + uci) && document.body.innerText.includes('1.8s') && document.body.innerText.includes('Solution'), {}, sample.moves[1]);
  await shot(page, 'puzzle_history_desktop.png');
  await page.setViewport({ width: 390, height: 844 });
  await shot(page, 'puzzle_history_phone.png');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('puzzle browser tests passed');
} finally {
  await browser.close();
  server.close();
}

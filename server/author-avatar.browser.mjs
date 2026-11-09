import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const puppeteer = createRequire(fileURLToPath(new URL('./node_modules/puppeteer-core/package.json', import.meta.url)))('puppeteer-core');
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const shots = process.env.CHESS_SHOTS || '';
if (shots) mkdirSync(shots, { recursive: true });
const mina = '11111111-1111-4111-8111-111111111111';
const julian = '22222222-2222-4222-8222-222222222222';
const nora = '33333333-3333-4333-8333-333333333333';
const portraitHits = [];
let announced = false;

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let bit = 0; bit < 8; bit += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, sum]);
}
function portraitPng() {
  const size = 64;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const dx = x - 32;
      const dy = y - 32;
      const inside = dx * dx + dy * dy < 30 * 30;
      const face = (x - 32) * (x - 32) + (y - 36) * (y - 36) < 14 * 14;
      const eye = (x - 26) * (x - 26) + (y - 32) * (y - 32) < 3 * 3 || (x - 38) * (x - 38) + (y - 32) * (y - 32) < 3 * 3;
      const color = eye ? [20, 24, 28, 255] : face ? [244, 214, 186, 255] : inside ? [79, 195, 255, 255] : [0, 0, 0, 0];
      const i = row + 1 + x * 4;
      raw[i] = color[0];
      raw[i + 1] = color[1];
      raw[i + 2] = color[2];
      raw[i + 3] = color[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
const png = portraitPng();
const messages = [
  { id: 'm1', authorId: mina, authorName: 'Mina Chen', body: 'Good evening. The main room is open.', createdAt: '8 Nov 2026, 9:04 PM' },
  { id: 'm2', authorId: julian, authorName: 'Julian Park', body: 'I am reading along from the side.', createdAt: '8 Nov 2026, 9:06 PM' },
  { id: 'm3', authorId: mina, authorName: 'Mina Chen', body: 'The same picture belongs on this note too.', createdAt: '8 Nov 2026, 9:08 PM' }
];
const later = { id: 'm4', authorId: mina, authorName: 'Mina Chen', body: 'A new note arrived without clearing the draft.', createdAt: '8 Nov 2026, 9:10 PM' };
const posts = [
  { id: 'p1', authorId: mina, authorName: 'Mina Chen', body: 'The rook ending from last night still feels unfinished.', createdAt: '8 Nov 2026, 8:40 PM' },
  { id: 'p2', authorId: nora, authorName: 'Nora Ellison', body: 'I left a short game beside the puzzles.', createdAt: '8 Nov 2026, 8:12 PM' }
];
const profile = {
  id: mina,
  displayName: 'Mina Chen',
  createdAt: '2 Mar 2026',
  bio: 'Studies quiet endgames and keeps a short notebook of ideas.',
  hasPortrait: true,
  hasBackground: false
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.txt': 'text/plain;charset=utf-8' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/session') return sendJson(res, 200, { authenticated: true, configured: true, profile });
  if (url.pathname === '/api/discussion') {
    const after = url.searchParams.get('afterId');
    if (after) {
      const page = announced ? [] : [later];
      announced = true;
      return sendJson(res, 200, { messages: page });
    }
    return sendJson(res, 200, { messages });
  }
  if (url.pathname === '/api/posts') return sendJson(res, 200, { posts });
  if (req.method === 'POST' && url.pathname === '/api/replies/list') {
    await readBody(req);
    return sendJson(res, 200, { replies: [{ id: 'r1', postId: 'p1', authorId: julian, authorName: 'Julian Park', body: 'The second rank decides that ending.', createdAt: '8 Nov 2026, 8:51 PM' }] });
  }
  const image = url.pathname.match(/^\/api\/profiles\/([0-9a-f-]{36})\/portrait$/i);
  if (image) {
    portraitHits.push(image[1]);
    if (image[1] === julian) return sendJson(res, 404, { error: 'That profile was not found.' });
    if (image[1] === nora) {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(Buffer.from('this is not a jpeg'));
      return;
    }
    if (image[1] === mina) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(png);
      return;
    }
    return sendJson(res, 404, { error: 'That profile was not found.' });
  }
  if (url.pathname === '/api/profiles/' + mina) return sendJson(res, 200, profile);
  if (url.pathname === '/api/profiles/' + mina + '/posts') return sendJson(res, 200, { posts: [posts[0]] });
  if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found.' });
  const relative = (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname).replace(/^\/+/, '');
  const file = normalize(join(root, relative));
  if (file !== root && !file.startsWith(root + '/')) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
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
async function shot(name) {
  if (!shots) return;
  await page.screenshot({ path: join(shots, name), fullPage: true });
}
async function placement(selector) {
  return page.$$eval(selector, (nodes) => nodes.map((node) => {
    const avatar = node.querySelector('.author-avatar');
    const name = node.querySelector('.author-name');
    const chip = node.querySelector('.author-chip');
    const a = avatar.getBoundingClientRect();
    const n = name.getBoundingClientRect();
    return {
      left: a.right <= n.left + 0.5,
      row: Math.abs((a.top + a.height / 2) - (n.top + n.height / 2)) <= 14,
      width: Math.round(a.width),
      height: Math.round(a.height),
      href: chip.getAttribute('href'),
      name: name.textContent,
      state: avatar.className,
      picture: !!avatar.querySelector('img')
    };
  }));
}
function count(id) {
  return portraitHits.filter((hit) => hit === id).length;
}
try {
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin + '/community/discussion/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('The same picture belongs on this note too.'));
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.discussion-line img')];
    return images.length >= 2 && images.every((img) => img.complete && img.naturalWidth > 0);
  });
  await page.waitForFunction(() => document.querySelector('.author-avatar.is-absent'));
  const desktopDiscussion = await placement('.discussion-line');
  assert.equal(desktopDiscussion.length, 3);
  desktopDiscussion.forEach((row) => {
    assert.equal(row.left, true, JSON.stringify(row));
    assert.equal(row.row, true, JSON.stringify(row));
    assert.equal(row.width, 32);
    assert.equal(row.height, 32);
  });
  assert.equal(desktopDiscussion[0].picture, true);
  assert.equal(desktopDiscussion[1].picture, false);
  assert.equal(desktopDiscussion[1].state.includes('is-absent'), true);
  assert.equal(desktopDiscussion[2].picture, true);
  assert.equal(desktopDiscussion[0].href, '/community/profile/?id=' + mina);
  assert.equal(count(mina), 1);
  assert.equal(count(julian), 1);
  const box = await page.$('#discussion-body');
  await box.focus();
  await box.type('Holding a thought');
  await page.waitForFunction(() => document.body.innerText.includes('A new note arrived without clearing the draft.'));
  const kept = await page.evaluate((node) => ({
    same: document.getElementById('discussion-body') === node,
    value: document.getElementById('discussion-body').value,
    active: document.activeElement && document.activeElement.id
  }), box);
  assert.equal(kept.same, true);
  assert.equal(kept.value, 'Holding a thought');
  assert.equal(kept.active, 'discussion-body');
  assert.equal(count(mina), 1);
  await shot('discussion_avatars_desktop.png');

  await page.setOfflineMode(true);
  const offline = await page.evaluate(async () => {
    const mod = await import('/assets/chess/author-avatar.js');
    const link = mod.authorChip('Helen Ward', '44444444-4444-4444-8444-444444444444');
    document.body.append(link);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      state: link.querySelector('.author-avatar').className,
      picture: !!link.querySelector('img'),
      kept: document.querySelector('.discussion-line img') && document.querySelector('.discussion-line img').complete
    };
  });
  assert.equal(offline.state.includes('is-unavailable'), true);
  assert.equal(offline.picture, false);
  assert.equal(offline.kept, true);
  assert.equal(count('44444444-4444-4444-8444-444444444444'), 0);
  await page.setOfflineMode(false);

  await page.click('.discussion-line .author-name');
  await page.waitForFunction(() => location.pathname.startsWith('/community/profile/') && document.body.innerText.includes('Studies quiet endgames'));
  assert.equal(page.url().includes(mina), true);
  await page.waitForFunction(() => {
    const post = document.querySelector('.community-post .author-avatar img');
    return post && post.complete && post.naturalWidth > 0;
  });
  const profileRows = await placement('.community-post');
  assert.equal(profileRows.length, 1);
  assert.equal(profileRows[0].left, true);
  assert.equal(profileRows[0].name, 'Mina Chen');
  assert.equal(profileRows[0].href, '/community/profile/?id=' + mina);
  const exits = await page.$$eval('a.profile-exit, a.profile-back', (nodes) => nodes.map((node) => node.getAttribute('href')));
  assert.deepEqual(exits, ['/community/', '/community/']);
  await shot('profile_posts_desktop.png');

  await page.goto(origin + '/community/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('The rook ending from last night'));
  await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent === 'Show replies').click());
  await page.waitForFunction(() => document.body.innerText.includes('The second rank decides that ending.'));
  await page.waitForFunction(() => document.querySelector('.author-avatar.is-unavailable'));
  const feed = await placement('.community-post, .community-reply');
  assert.equal(feed.length, 3);
  feed.forEach((row) => {
    assert.equal(row.left, true, JSON.stringify(row));
    assert.equal(row.row, true, JSON.stringify(row));
    assert.equal(row.width, 32);
    assert.equal(row.height, 32);
  });
  assert.equal(feed[0].name, 'Mina Chen');
  assert.equal(feed[0].picture, true);
  assert.equal(feed[1].name, 'Julian Park');
  assert.equal(feed[1].state.includes('is-absent'), true);
  assert.equal(feed[2].name, 'Nora Ellison');
  assert.equal(feed[2].state.includes('is-unavailable'), true);
  assert.equal(feed[2].picture, false);
  assert.equal(count(nora), 1);
  await shot('community_posts_desktop.png');

  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(origin + '/community/discussion/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.discussion-line img').length >= 2);
  const phoneDiscussion = await placement('.discussion-line');
  phoneDiscussion.forEach((row) => {
    assert.equal(row.left, true, JSON.stringify(row));
    assert.equal(row.width, 32);
    assert.equal(row.height, 32);
  });
  await shot('discussion_avatars_phone.png');
  await page.goto(origin + '/community/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('I left a short game beside the puzzles.'));
  await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent === 'Show replies').click());
  await page.waitForFunction(() => document.body.innerText.includes('The second rank decides that ending.'));
  const phoneFeed = await placement('.community-post, .community-reply');
  phoneFeed.forEach((row) => {
    assert.equal(row.left, true, JSON.stringify(row));
    assert.equal(row.row, true, JSON.stringify(row));
    assert.equal(row.width, 32);
  });
  await shot('community_posts_phone.png');
  console.log('author avatar browser tests passed', { portraits: { mina: count(mina), julian: count(julian), nora: count(nora) } });
} finally {
  await browser.close();
  server.close();
}

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
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const mina = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const julian = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const nora = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const empty = { bullet: 0, blitz: 0, rapid: 0, daily: 0, untimed: 0, puzzles: null };
const members = [
  { id: julian, displayName: 'Julian Park', hasPortrait: false, ratings: { bullet: 1510, blitz: 1602, rapid: 1488, daily: 1400, untimed: 900, puzzles: null } },
  { id: mina, displayName: 'Mina Chen', hasPortrait: true, ratings: empty },
  { id: nora, displayName: 'Nora <b>Ellison</b> with a very long display name', hasPortrait: false, ratings: empty }
];
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.txt': 'text/plain;charset=utf-8' };

function fileFor(urlPath) {
  const relative = (urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath).replace(/^\/+/, '');
  const file = normalize(join(root, relative));
  if (file !== root && !file.startsWith(root + '/')) return null;
  return file;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/community/roster') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const rows = members.filter((member) => !q || member.displayName.toLowerCase().includes(q));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ total: rows.length, sort: 'name', ratingSort: false, members: rows, next: null }));
    return;
  }
  if (url.pathname === '/api/profiles/' + mina + '/portrait') {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    res.end(png);
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
    note.textContent = 'Sample preview. These are not live accounts.';
    document.querySelector('main').prepend(note);
  });
  await page.screenshot({ path: join(shots, name), fullPage: true });
}

try {
  const page = await browser.newPage();
  const client = await page.createCDPSession();
  await client.send('Network.setBypassServiceWorker', { bypass: true });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin + '/community/', { waitUntil: 'domcontentloaded' });
  const entry = await page.$eval('a.entry[href="/community/roster/"]', (node) => ({
    text: node.textContent,
    height: node.getBoundingClientRect().height
  }));
  assert.match(entry.text, /Roster/);
  assert.ok(entry.height >= 72);
  await page.goto(origin + '/community/roster/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.roster-row').length === 3);
  const desktop = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.roster-row')];
    const nora = rows.find((row) => row.textContent.includes('Ellison'));
    const name = nora.querySelector('.author-name');
    const ratings = rows[0].querySelector('.roster-ratings').getBoundingClientRect();
    return {
      hrefs: rows.map((row) => row.getAttribute('href')),
      markup: document.getElementById('roster-list').innerHTML.includes('<b>Ellison</b>'),
      text: nora.textContent,
      scores: [...rows[0].querySelectorAll('.roster-score')].map((node) => node.textContent),
      labels: [...rows[0].querySelectorAll('.roster-score')].map((node) => node.getAttribute('aria-label')),
      ratingsRight: ratings.right,
      width: window.innerWidth,
      count: document.querySelector('.roster-count').textContent
    };
  });
  assert.deepEqual(desktop.hrefs, [
    '/community/profile/?id=' + julian,
    '/community/profile/?id=' + mina,
    '/community/profile/?id=' + nora
  ]);
  assert.equal(desktop.markup, false);
  assert.match(desktop.text, /Nora <b>Ellison<\/b>/);
  assert.deepEqual(desktop.scores, ['1510', '1602', '1488', '1400', '900', '\u2014']);
  assert.deepEqual(desktop.labels, ['1510', '1602', '1488', '1400', '900', 'Unrated']);
  assert.ok(desktop.ratingsRight <= desktop.width + 1);
  assert.equal(await page.$eval('#roster-sort', (node) => [...node.options].some((option) => option.value === 'untimed' && !option.disabled)), true);
  assert.equal(desktop.count, '3 accounts');
  await page.waitForFunction(() => {
    const image = document.querySelector('.roster-row img');
    return image && image.complete && image.naturalWidth > 0;
  });
  await shot(page, 'roster_desktop.png');
  await page.setViewport({ width: 390, height: 844 });
  const phone = await page.evaluate(() => {
    const row = document.querySelector('.roster-row');
    const ratings = row.querySelector('.roster-ratings').getBoundingClientRect();
    const visible = [...row.querySelectorAll('.roster-rating')].every((node) => {
      const box = node.getBoundingClientRect();
      return box.width > 20 && box.right <= window.innerWidth + 1 && box.left >= -1;
    });
    const name = [...document.querySelectorAll('.author-name')].find((node) => node.textContent.includes('Ellison'));
    return { visible, ratingsRight: ratings.right, width: window.innerWidth, clipped: name.scrollWidth > name.clientWidth };
  });
  assert.equal(phone.visible, true);
  assert.equal(phone.clipped, true);
  assert.ok(phone.ratingsRight <= phone.width + 1);
  await shot(page, 'roster_phone.png');
  await page.type('#roster-search', 'Julian');
  await page.evaluate(() => document.getElementById('roster-find').click());
  await page.waitForFunction(() => document.querySelectorAll('.roster-row').length === 1 && document.body.innerText.includes('1 account'));
  const only = await page.$eval('.roster-row', (row) => row.getAttribute('href'));
  assert.equal(only, '/community/profile/?id=' + julian);
  console.log('community roster browser tests passed');
} finally {
  await browser.close();
  server.close();
}

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const puppeteer = createRequire(fileURLToPath(new URL('./node_modules/puppeteer-core/package.json', import.meta.url)))('puppeteer-core');
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const mina = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const julian = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.txt': 'text/plain;charset=utf-8' };
const thread = {
  threadId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
  with: { id: julian, displayName: 'Julian Park' },
  messages: [
    { id: 'm1', authorId: julian, body: 'Your move.', createdAt: '2026-11-09T00:00:01Z' },
    { id: 'm2', authorId: julian, body: 'Still your move.', createdAt: '2026-11-09T00:00:02Z' },
    { id: 'm3', authorId: mina, body: 'I see it.', createdAt: '2026-11-09T00:00:03Z' },
    { id: 'm4', authorId: mina, body: 'Playing now.', createdAt: '2026-11-09T00:00:04Z' }
  ]
};

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
    return send(JSON.stringify({
      authenticated: true,
      profile: { id: mina, displayName: 'Mina Chen' },
      master: { displayName: 'Mina Chen', avatarUrl: 'https://cdn.example/mina.png', avatarType: null }
    }));
  }
  if (url.pathname === '/api/messages' && url.searchParams.get('with') === julian) return send(JSON.stringify(thread));
  if (url.pathname === '/api/profiles/' + julian + '/portrait') return send(png, 200, 'image/png');
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

function measure(page) {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll('.message-line')];
    return {
      count: lines.length,
      labels: lines.map((line) => line.querySelector('.author-mini').getAttribute('aria-label')),
      left: lines.every((line) => {
        const icon = line.querySelector('.author-mini').getBoundingClientRect();
        const bubble = line.querySelector('.message-bubble').getBoundingClientRect();
        return icon.left < bubble.left && icon.right <= bubble.left + 1;
      }),
      icons: lines.map((line) => line.firstElementChild.className),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1
    };
  });
}

try {
  const page = await browser.newPage();
  const client = await page.createCDPSession();
  await client.send('Network.setBypassServiceWorker', { bypass: true });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin + '/community/messages/?with=' + julian, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.message-line').length === 4);
  await page.waitForFunction(() => {
    const lines = [...document.querySelectorAll('.message-line')];
    return lines.every((line) => !line.querySelector('.author-avatar.is-pending'));
  });
  const desktop = await measure(page);
  assert.equal(desktop.count, 4);
  assert.deepEqual(desktop.labels, ['Julian Park', 'Julian Park', 'Mina Chen', 'Mina Chen']);
  assert.deepEqual(desktop.icons, ['author-mini', 'author-mini', 'author-mini', 'author-mini']);
  assert.equal(desktop.left, true);
  assert.equal(desktop.overflow, false);
  const pictures = await page.$$eval('.message-line .author-avatar', (nodes) => nodes.map((node) => node.className));
  assert.equal(pictures[0], 'author-avatar is-picture');
  assert.equal(pictures[1], 'author-avatar is-picture');
  assert.equal(pictures[2], 'author-avatar is-picture');
  assert.equal(pictures[3], 'author-avatar is-picture');
  const minaSrc = await page.$eval('.message-line:nth-child(3) img', (img) => img.getAttribute('src'));
  assert.equal(minaSrc, 'https://cdn.example/mina.png');
  await page.setViewport({ width: 390, height: 844 });
  const phone = await measure(page);
  assert.equal(phone.left, true);
  assert.equal(phone.overflow, false);
  assert.equal(phone.labels.length, 4);
  console.log('direct message avatar tests passed');
} finally {
  await browser.close();
  server.close();
}

import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { profileExitHref } from '../assets/chess/community-model.js';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const require = createRequire(fileURLToPath(new URL('./node_modules/puppeteer-core/package.json', import.meta.url)));
const puppeteer = require('puppeteer-core');
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const shotDir = '/opt/cursor/artifacts';
mkdirSync(shotDir, { recursive: true });
const ada = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const missing = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const empty = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const bad = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };

function fileFor(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const relative = (clean.endsWith('/') ? clean + 'index.html' : clean).replace(/^\/+/, '');
  const full = normalize(join(root, relative));
  if (full !== root && !full.startsWith(root + '/')) return null;
  return full;
}

const portraitRequests = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const signedOut = String(req.headers.cookie || '').includes('chess_test_mode=out');
  if (url.pathname === '/api/session') {
    const body = signedOut
      ? { authenticated: false, configured: true, profile: null }
      : { authenticated: true, configured: true, profile: { id: ada, displayName: 'Ada Lovelace', createdAt: '2026-11-08T00:00:00.000Z' } };
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
    return;
  }
  const profileMatch = url.pathname.match(/^\/api\/profiles\/([0-9a-f-]{36})$/i);
  const postsMatch = url.pathname.match(/^\/api\/profiles\/([0-9a-f-]{36})\/posts$/i);
  const imageMatch = url.pathname.match(/^\/api\/profiles\/([0-9a-f-]{36})\/(portrait|background)$/i);
  if (imageMatch) {
    portraitRequests.push(url.pathname);
    if (imageMatch[1].toLowerCase() === bad && imageMatch[2] === 'portrait') {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(Buffer.from('not-a-real-jpeg-file'));
      return;
    }
    if (imageMatch[1].toLowerCase() !== ada) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(png);
    return;
  }
  if (profileMatch) {
    const id = profileMatch[1].toLowerCase();
    if (id !== ada && id !== empty && id !== bad) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'That profile was not found.' }));
      return;
    }
    const card = id === ada
      ? { id: ada, displayName: 'Ada Lovelace', createdAt: '2026-11-08T00:00:00.000Z', bio: '<script>alert(1)</script>', hasPortrait: true, hasBackground: true }
      : id === bad
        ? { id: bad, displayName: 'Broken Frame', createdAt: '2026-11-08T00:00:00.000Z', bio: 'The large picture could not be decoded.', hasPortrait: true, hasBackground: false }
        : { id: empty, displayName: 'Empty Board', createdAt: '2026-11-08T00:00:00.000Z', bio: '', hasPortrait: false, hasBackground: false };
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(card));
    return;
  }
  if (postsMatch) {
    const posts = postsMatch[1].toLowerCase() === ada
        ? [
          { id: 'post-1', authorId: ada, authorName: 'Ada Lovelace', body: 'Older note', createdAt: '2026-11-08T00:00:00.000Z' },
          { id: 'post-2', authorId: ada, authorName: 'Ada Lovelace', body: 'Newest note', createdAt: '2026-11-08T00:00:00.000Z' }
        ]
      : postsMatch[1].toLowerCase() === bad
        ? [{ id: 'post-bad', authorId: bad, authorName: 'Broken Frame', body: 'The picture did not survive.', createdAt: '2026-11-08T00:00:00.000Z' }]
        : [];
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ posts }));
    return;
  }
  if (url.pathname === '/api/posts' || url.pathname === '/api/discussion') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(url.pathname === '/api/posts' ? { posts: [] } : { messages: [] }));
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
const browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
const seenPortraits = [];
page.on('request', (request) => {
  const parsed = new URL(request.url());
  if (parsed.pathname.endsWith('/portrait')) seenPortraits.push(parsed);
});

async function layout() {
  return page.evaluate(() => {
    const bar = document.querySelector('.profile-exitbar');
    const frame = document.querySelector('.profile-frame');
    const barBox = bar ? bar.getBoundingClientRect() : null;
    const frameBox = frame ? frame.getBoundingClientRect() : null;
    return {
      hasHeader: !!document.querySelector('.site-header'),
      hasNav: !!document.querySelector('.site-nav, .page-nav, footer'),
      links: [...document.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href')),
      texts: [...document.querySelectorAll('a')].map((anchor) => anchor.textContent.trim()),
      barTop: barBox && barBox.top,
      barWidth: barBox && barBox.width,
      barHeight: barBox && barBox.height,
      frameHeight: frameBox && frameBox.height,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      text: document.body.innerText
    };
  });
}

function assertImmersive(info, label) {
  assert.equal(info.hasHeader, false, label + ' showed the site header');
  assert.equal(info.hasNav, false, label + ' showed ordinary site navigation');
  assert.ok(info.barTop <= 1, label + ' exit bar is not at the top');
  assert.ok(info.barWidth >= info.innerWidth - 2, label + ' exit bar does not span the page');
  assert.ok(info.barHeight >= 56, label + ' exit control is too small');
  assert.ok(info.frameHeight >= info.innerHeight - 1, label + ' profile does not occupy the page');
  assert.ok(info.texts.includes('Exit profile'), label + ' missing Exit profile');
  assert.ok(info.texts.includes('Back to Community'), label + ' missing Back to Community');
  for (const href of info.links) {
    assert.equal(typeof href, 'string', label);
    if (href === '#main') continue;
    assert.equal(href.startsWith('/'), true, label + ' ' + href);
    assert.equal(href.startsWith('//'), false, label + ' ' + href);
    assert.equal(/^[a-z][a-z0-9+.-]*:/i.test(href), false, label + ' ' + href);
    assert.equal(href.includes('evil'), false, label + ' ' + href);
  }
  const exits = info.links.filter((href) => href === profileExitHref('https://evil.example'));
  assert.ok(exits.length >= 2, label + ' exit links changed');
  assert.equal(info.text.includes('Philosophy'), false, label);
  assert.equal(info.text.includes('Marketplace'), false, label);
  assert.equal(info.text.includes('DRP Compass'), false, label);
}

try {
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  const home = await page.$eval('.community-entries', (nav) => ({
    text: nav.innerText,
    hrefs: [...nav.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href')),
    tall: [...nav.querySelectorAll('a')].every((anchor) => anchor.getBoundingClientRect().height >= 72)
  }));
  assert.deepEqual(home.hrefs, ['/community/', '/community/discussion/', '/community/roster/']);
  assert.equal(home.tall, true);
  assert.match(home.text, /Community/);
  assert.match(home.text, /Discussion/);
  await page.screenshot({ path: join(shotDir, 'community-home-desktop.png'), fullPage: false });

  await page.goto(origin + '/community/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('Signed in as Ada Lovelace'));
  await page.waitForSelector('#your-profile');
  const signedIn = await page.evaluate(() => ({
    state: document.getElementById('community-state').textContent,
    profile: document.getElementById('your-profile').getAttribute('href'),
    discussion: !!document.querySelector('a.entry[href="/community/discussion/"]'),
    header: !!document.querySelector('.site-header')
  }));
  assert.equal(signedIn.state, 'Signed in as Ada Lovelace.');
  assert.equal(signedIn.profile, '/community/profile/?id=' + ada);
  assert.equal(signedIn.discussion, true);
  assert.equal(signedIn.header, true);
  assert.equal((await page.$eval('#your-profile', (el) => el.getBoundingClientRect().height)) >= 72, true);
  await page.screenshot({ path: join(shotDir, 'community-signed-in-desktop.png'), fullPage: false });

  await page.click('#your-profile');
  await page.waitForFunction(() => location.pathname.indexOf('/community/profile') === 0);
  await page.waitForFunction(() => document.body.innerText.includes('Newest note'));
  await page.waitForFunction(() => {
    const image = document.querySelector('.profile-portrait img');
    return image && image.complete && image.naturalWidth > 0;
  });
  let info = await layout();
  assertImmersive(info, 'desktop profile');
  assert.match(info.text, /Ada Lovelace/);
  assert.match(info.text, /Chess community profile/);
  assert.equal(info.text.includes('ada@'), false);
  const postOrder = await page.$$eval('.community-post .community-body', (nodes) => nodes.map((node) => node.textContent));
  assert.deepEqual(postOrder, ['Newest note', 'Older note']);
  const card = await page.evaluate(() => ({
    bio: document.querySelector('.profile-bio').textContent,
    scripts: document.querySelectorAll('script').length,
    portrait: document.querySelector('.profile-portrait img').getAttribute('src'),
    background: document.querySelector('.profile-banner').style.backgroundImage,
    files: !!document.getElementById('portrait-file') && !!document.getElementById('background-file'),
    bannerHeight: document.querySelector('.profile-banner').getBoundingClientRect().height
  }));
  assert.equal(card.bio, '<script>alert(1)</script>');
  assert.equal(card.scripts <= 2, true);
  const adaPortraits = seenPortraits.filter((parsed) => parsed.pathname === '/api/profiles/' + ada + '/portrait');
  assert.equal(adaPortraits.length, 1);
  assert.equal(adaPortraits[0].origin, new URL(page.url()).origin);
  assert.equal(portraitRequests.filter((path) => path === '/api/profiles/' + ada + '/portrait').length, 1);
  const decoded = await page.evaluate(async (encoded) => {
    const shown = document.querySelector('.profile-portrait img');
    const reference = new Image();
    reference.src = 'data:image/png;base64,' + encoded;
    await reference.decode();
    const pixel = (image) => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(0, 0, image.naturalWidth, image.naturalHeight).data);
    };
    return { width: shown.naturalWidth, height: shown.naturalHeight, shown: pixel(shown), reference: pixel(reference) };
  }, png.toString('base64'));
  assert.equal(decoded.width, 1);
  assert.equal(decoded.height, 1);
  assert.deepEqual(decoded.shown, decoded.reference);
  assert.equal(card.portrait.startsWith('blob:' + adaPortraits[0].origin + '/'), true);
  assert.match(card.background, /\/background/);
  assert.equal(card.files, true);
  assert.ok(card.bannerHeight >= 140);
  await page.screenshot({ path: join(shotDir, 'profile-desktop.png'), fullPage: true });

  await page.setViewport({ width: 390, height: 844 });
  info = await layout();
  assertImmersive(info, 'mobile profile');
  await page.screenshot({ path: join(shotDir, 'profile-mobile.png'), fullPage: true });
  await page.click('.profile-exit');
  await page.waitForFunction(() => location.pathname === '/community/' || location.pathname === '/community/index.html');
  await page.waitForSelector('.site-header');
  assert.equal(await page.$eval('.site-header', () => true), true);
  await page.screenshot({ path: join(shotDir, 'community-after-exit-mobile.png'), fullPage: false });
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => location.pathname.indexOf('/community/profile') === 0);
  info = await layout();
  assertImmersive(info, 'mobile back');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('Ada Lovelace'));
  info = await layout();
  assertImmersive(info, 'mobile reload');

  await page.goto(origin + '/community/profile/?id=' + bad, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('Profile picture unavailable') && document.body.innerText.includes('The picture did not survive.'));
  assert.equal(await page.$('.profile-portrait img'), null);
  assert.equal(await page.$eval('.author-avatar', (node) => node.className), 'author-avatar is-unavailable');
  await page.goto(origin + '/community/profile/?id=' + empty, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('No profile picture yet') && document.body.innerText.includes('No background image yet') && document.body.innerText.includes('No bio yet.'));
  assert.equal(await page.$('#portrait-file'), null);
  info = await layout();
  assertImmersive(info, 'empty profile');
  await page.goto(origin + '/community/profile/?id=' + missing, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('No community profile uses this address.'));
  info = await layout();
  assertImmersive(info, 'missing profile');

  await page.goto(origin + '/community/profile/?id=' + ada + '&next=https://evil.example', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('Ada Lovelace'));
  info = await layout();
  assertImmersive(info, 'evil query');
  assert.equal(info.links.some((href) => href.includes('evil.example')), false);

  await page.setCookie({ name: 'chess_test_mode', value: 'out', url: origin });
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(origin + '/community/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('community-state').textContent.includes('Not signed in'));
  assert.equal(await page.$('#your-profile'), null);
  assert.match(await page.$eval('#community-state', (el) => el.textContent), /Join Chess is available only after you sign in/);
  await page.screenshot({ path: join(shotDir, 'community-signed-out-desktop.png'), fullPage: false });
  console.log('profile layout checks passed');
} finally {
  await browser.close();
  server.close();
}

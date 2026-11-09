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
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.txt': 'text/plain;charset=utf-8', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
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

function chromeState() {
  return {
    header: !!document.querySelector('header.site-header'),
    footer: !!document.querySelector('footer.site-footer'),
    sections: !!document.querySelector('nav.page-nav'),
    crumbs: !!document.querySelector('nav.crumbs'),
    skip: !!document.querySelector('a.skip'),
    eyebrow: !!document.querySelector('p.eyebrow'),
    title: !!document.querySelector('h1'),
    lead: !!document.querySelector('p.lead'),
    revealed: document.body.classList.contains('exit-revealed'),
    inert: !!(document.querySelector('.game-exitbar') && document.querySelector('.game-exitbar').hasAttribute('inert')),
    leave: document.getElementById('leave-game') ? document.getElementById('leave-game').textContent : '',
    note: document.querySelector('.game-exit-note') ? document.querySelector('.game-exit-note').textContent : '',
    fullscreenRequests: window.__fullscreenRequested || 0
  };
}

async function prepare(page) {
  const client = await page.createCDPSession();
  await client.send('Network.setBypassServiceWorker', { bypass: true });
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.evaluateOnNewDocument(() => {
    const request = function () {
      window.__fullscreenRequested = (window.__fullscreenRequested || 0) + 1;
      return Promise.resolve();
    };
    Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, writable: true, value: request });
    Object.defineProperty(Element.prototype, 'webkitRequestFullscreen', { configurable: true, writable: true, value: request });
  });
}

async function shot(page, name) {
  await page.screenshot({ path: join(shots, name), fullPage: true });
}

try {
  const page = await browser.newPage();
  await prepare(page);
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin + '/bot/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#start-game');
  const before = await page.evaluate(chromeState);
  assert.equal(before.header, true);
  assert.equal(before.footer, true);
  assert.equal(before.sections, true);
  await page.evaluate(() => document.getElementById('start-game').click());
  await page.waitForFunction(() => document.body.dataset.phase === 'playing' && !document.querySelector('header.site-header'));
  const playing = await page.evaluate(chromeState);
  assert.equal(playing.header, false);
  assert.equal(playing.footer, false);
  assert.equal(playing.sections, false);
  assert.equal(playing.crumbs, false);
  assert.equal(playing.skip, false);
  assert.equal(playing.title, false);
  assert.equal(playing.lead, false);
  assert.equal(playing.revealed, false);
  assert.equal(playing.inert, true);
  assert.equal(playing.leave, 'Leave game');
  assert.ok(playing.fullscreenRequests >= 1);
  await page.evaluate(() => {
    const toast = document.createElement('div');
    toast.id = 'outside-toast';
    toast.textContent = 'New community post';
    document.body.append(toast);
  });
  await page.waitForFunction(() => !document.getElementById('outside-toast'));
  await shot(page, 'bot_stage_desktop.png');
  await page.mouse.move(160, 240);
  await page.mouse.move(160, 4);
  await page.waitForFunction(() => document.body.classList.contains('exit-revealed'));
  await shot(page, 'bot_stage_exit_desktop.png');
  await page.mouse.move(200, 500);
  await page.waitForFunction(() => !document.body.classList.contains('exit-revealed'), { timeout: 8000 });
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.body.classList.contains('exit-revealed') && document.activeElement && document.activeElement.id === 'leave-game');
  await page.evaluate(() => document.dispatchEvent(new Event('fullscreenchange')));
  const stayed = await page.evaluate(() => ({
    phase: document.body.dataset.phase,
    header: !!document.querySelector('header.site-header'),
    revealed: document.body.classList.contains('exit-revealed')
  }));
  assert.equal(stayed.phase, 'playing');
  assert.equal(stayed.header, false);
  assert.equal(stayed.revealed, true);
  await page.evaluate(() => document.getElementById('leave-game').blur());
  await page.mouse.move(240, 520);
  await page.waitForFunction(() => !document.body.classList.contains('exit-revealed'), { timeout: 8000 });
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('.game-exit-note') && !document.querySelector('.game-exit-note').hidden);
  const backing = await page.evaluate(chromeState);
  assert.equal(backing.header, false);
  assert.match(backing.note, /Leave this unfinished game/);
  await page.evaluate(() => document.getElementById('leave-no').click());
  await page.waitForFunction(() => document.body.dataset.phase === 'playing' && !document.querySelector('header.site-header'));
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await page.waitForFunction(() => !document.body.classList.contains('exit-revealed'), { timeout: 8000 });
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await shot(page, 'bot_stage_phone.png');
  await page.touchscreen.touchStart(30, 2);
  await page.touchscreen.touchMove(30, 90);
  await page.touchscreen.touchEnd();
  await page.waitForFunction(() => document.body.classList.contains('exit-revealed'));
  await shot(page, 'bot_stage_exit_phone.png');
  await page.goBack();
  await page.waitForSelector('#leave-yes');
  await page.evaluate(() => document.getElementById('leave-yes').click());
  await page.waitForFunction(() => document.querySelector('header.site-header') && document.body.dataset.phase === 'setup');
  const restored = await page.evaluate(chromeState);
  assert.equal(restored.header, true);
  assert.equal(restored.footer, true);
  assert.equal(restored.sections, true);
  assert.equal(restored.leave, '');

  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin + '/human/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mode-pass');
  await page.evaluate(() => document.getElementById('mode-pass').click());
  await page.waitForSelector('#start-game');
  assert.equal(await page.evaluate(() => !!document.querySelector('header.site-header')), true);
  await page.evaluate(() => document.getElementById('start-game').click());
  await page.waitForFunction(() => document.getElementById('board') && !document.querySelector('header.site-header') && !document.querySelector('footer.site-footer'));
  const pass = await page.evaluate(chromeState);
  assert.equal(pass.header, false);
  assert.equal(pass.footer, false);
  assert.equal(pass.sections, false);
  assert.equal(pass.crumbs, false);
  assert.equal(pass.skip, false);
  assert.equal(pass.eyebrow, false);
  assert.equal(pass.title, false);
  assert.equal(pass.lead, false);
  assert.equal(pass.revealed, false);
  await shot(page, 'human_stage_pass_desktop.png');
  await page.mouse.move(180, 300);
  await page.mouse.move(180, 3);
  await page.waitForFunction(() => document.body.classList.contains('exit-revealed'));
  await shot(page, 'human_stage_pass_exit_desktop.png');
  await page.mouse.move(180, 500);
  await page.waitForFunction(() => !document.body.classList.contains('exit-revealed'), { timeout: 8000 });
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'leave-game');
  await page.goBack();
  await page.waitForFunction(() => document.body.innerText.includes('moves on this device'));
  assert.equal(await page.evaluate(() => !!document.querySelector('header.site-header')), false);
  await page.evaluate(() => document.getElementById('leave-no').click());
  await page.waitForFunction(() => !document.querySelector('header.site-header') && document.getElementById('board'));
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await page.waitForFunction(() => !document.body.classList.contains('exit-revealed'), { timeout: 8000 });
  await page.setViewport({ width: 390, height: 844 });
  await shot(page, 'human_stage_pass_phone.png');
  await page.mouse.move(40, 240);
  await page.mouse.move(40, 2);
  await page.waitForFunction(() => document.body.classList.contains('exit-revealed'));
  await shot(page, 'human_stage_pass_exit_phone.png');
  await page.goBack();
  await page.waitForSelector('#leave-yes');
  await page.evaluate(() => document.getElementById('leave-yes').click());
  await page.waitForFunction(() => document.querySelector('header.site-header') && document.getElementById('mode-pass'));
  const passHome = await page.evaluate(chromeState);
  assert.equal(passHome.header, true);
  assert.equal(passHome.footer, true);
  assert.equal(passHome.sections, true);
  console.log('game stage browser tests passed');
} finally {
  await browser.close();
  server.close();
}

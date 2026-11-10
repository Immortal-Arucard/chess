const CACHE = 'chess-v25';
const ROUTES = [
  '/',
  '/theory/',
  '/human/',
  '/bot/',
  '/puzzles/',
  '/analysis/',
  '/community/',
  '/community/discussion/',
  '/community/messages/',
  '/community/roster/',
  '/community/profile/',
  '/marketplace/',
  '/exchange/'
];
const ASSETS = [
  '/',
  '/index.html',
  '/theory/',
  '/theory/index.html',
  '/human/',
  '/human/index.html',
  '/bot/',
  '/bot/index.html',
  '/puzzles/',
  '/puzzles/index.html',
  '/analysis/',
  '/analysis/index.html',
  '/analysis/analysis.js',
  '/community/',
  '/community/index.html',
  '/community/profile/',
  '/community/profile/index.html',
  '/community/discussion/',
  '/community/discussion/index.html',
  '/community/messages/',
  '/community/messages/index.html',
  '/community/roster/',
  '/community/roster/index.html',
  '/marketplace/',
  '/marketplace/index.html',
  '/exchange/',
  '/exchange/index.html',
  '/manifest.webmanifest',
  '/assets/site.css',
  '/assets/site.js',
  '/assets/chess/analysis-model.js',
  '/assets/chess/analysis-engine.js',
  '/assets/chess/analysis.css',
  '/assets/chess/account-menu.js',
  '/assets/chess/chess-section.js',
  '/assets/account-sections.js',
  '/assets/master-account.js',
  '/assets/section-account.js',
  '/assets/chess/rules.js',
  '/assets/chess/engine.js',
  '/assets/chess/board.js',
  '/assets/chess/board.css',
  '/assets/chess/bot-prefs.js',
  '/assets/chess/piece-sets.js',
  '/assets/chess/piece-sets-LICENSE.txt',
  '/assets/chess/bot-results.js',
  '/assets/chess/community.css',
  '/assets/chess/community-config.js',
  '/assets/chess/community-model.js',
  '/assets/chess/community-view.js',
  '/assets/chess/author-avatar.js',
  '/assets/chess/profile-picture.js',
  '/assets/chess/community-gateway.js',
  '/assets/chess/community-app.js',
  '/assets/chess/mentions.js',
  '/assets/chess/push-config.js',
  '/assets/chess/push-client.js',
  '/assets/chess/roster.js',
  '/assets/chess/roster.css',
  '/human/human.js',
  '/assets/chess/human-rules.js',
  '/assets/chess/rating.js',
  '/puzzles/puzzle.js',
  '/assets/chess/puzzle.css',
  '/puzzles/practice.json',
  '/assets/chess/human.css',
  '/assets/chess/game-stage.js',
  '/bot/bot.js',
  '/assets/vendor/chess.js/chess.js',
  '/assets/vendor/chess.js/LICENSE',
  '/assets/vendor/stockfish/stockfish-19-lite-single.js',
  '/assets/vendor/stockfish/stockfish-19-lite-single.wasm',
  '/assets/vendor/stockfish/Copying.txt',
  '/assets/vendor/stockfish/SOURCE.txt',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png'
];

function lookup(pathname) {
  if (ASSETS.indexOf(pathname) !== -1) return pathname;
  if (pathname.length > 1 && pathname.endsWith('/index.html')) {
    const dir = pathname.slice(0, -'index.html'.length);
    if (ROUTES.indexOf(dir) !== -1) return dir;
  }
  if (pathname.length > 1 && !pathname.endsWith('/')) {
    const slashed = pathname + '/';
    if (ROUTES.indexOf(slashed) !== -1) return slashed;
  }
  if (ROUTES.indexOf(pathname) !== -1) return pathname;
  return null;
}

function revalidate(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const shell = path.endsWith('.html') || path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.css') || path.endsWith('/') || ROUTES.indexOf(path) !== -1;
  if (!shell) return request;
  return new Request(path + url.search, { cache: 'no-cache', credentials: 'same-origin' });
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((clients) => Promise.all(clients.map((client) => client.postMessage({ type: 'chess-sw', cache: CACHE }))))
  );
});

const REDIRECTS = {
  '/discussion': '/community/discussion/',
  '/discussion/': '/community/discussion/',
  '/roster': '/community/roster/',
  '/roster/': '/community/roster/'
};

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch (err) { payload = { title: 'Chess', body: event.data ? event.data.text() : '' }; }
  const title = String(payload.title || 'Chess').slice(0, 120);
  const body = String(payload.body || '').slice(0, 180);
  const url = typeof payload.url === 'string' && payload.url.charAt(0) === '/' && payload.url.charAt(1) !== '/' ? payload.url : '/';
  event.waitUntil(self.registration.showNotification(title, { body, data: { url } }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = event.notification.data && event.notification.data.url;
  const target = new URL(typeof path === 'string' && path.charAt(0) === '/' ? path : '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const open = windows.find((client) => client.url === target);
    if (open && open.focus) return open.focus();
    if (self.clients.openWindow) return self.clients.openWindow(target);
    return null;
  }));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const redirectTo = REDIRECTS[url.pathname];
  if (redirectTo) {
    event.respondWith(Response.redirect(new URL(redirectTo, self.location.origin).href, 301));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;
  const key = lookup(url.pathname);
  if (!key) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(revalidate(request));
      if (response && response.ok && response.type === 'basic' && !response.redirected) {
        const copy = response.clone();
        const cache = await caches.open(CACHE);
        try { await cache.put(key, copy); } catch (e) {}
      }
      return response;
    } catch (err) {
      return (await caches.match(key)) || (await caches.match(url.pathname)) || Response.error();
    }
  })());
});

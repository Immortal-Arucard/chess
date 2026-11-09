const CACHE = 'chess-v9';
const ROUTES = [
  '/',
  '/theory/',
  '/human/',
  '/bot/',
  '/puzzles/',
  '/analysis/',
  '/community/',
  '/community/discussion/',
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
  '/community/',
  '/community/index.html',
  '/community/profile/',
  '/community/profile/index.html',
  '/community/discussion/',
  '/community/discussion/index.html',
  '/marketplace/',
  '/marketplace/index.html',
  '/exchange/',
  '/exchange/index.html',
  '/manifest.webmanifest',
  '/assets/site.css',
  '/assets/site.js',
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
  '/assets/chess/profile-picture.js',
  '/assets/chess/community-gateway.js',
  '/assets/chess/community-app.js',
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

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  const key = lookup(url.pathname);
  if (!key) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
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

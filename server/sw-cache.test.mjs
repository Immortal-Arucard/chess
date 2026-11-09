import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
assert.match(sw, /const CACHE = 'chess-v20'/);
assert.match(sw, /new Request\(url, \{ cache: 'reload' \}\)/);
assert.match(sw, /cache: 'no-cache'/);
assert.match(sw, /pathname\.startsWith\('\/api\/'\)\) return/);
assert.match(sw, /skipWaiting\(\)/);
assert.match(sw, /clients\.claim\(\)/);
assert.match(sw, /caches\.delete\(key\)/);
assert.equal(sw.includes('cache.addAll(ASSETS)'), false);
assert.match(sw, /type: 'chess-sw'/);
assert.match(sw, /'\/discussion\/': '\/community\/discussion\/'/);
assert.match(sw, /'\/roster\/': '\/community\/roster\/'/);
assert.match(sw, /Response\.redirect/);
console.log('service worker cache tests passed');

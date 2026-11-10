import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('../exchange/instruments.json', import.meta.url), 'utf8'));
const sql = readFileSync(new URL('../supabase/chess_exchange.sql', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

assert.equal(catalog.simulated, true);
assert.equal(catalog.live, false);
assert.match(catalog.disclaimer, /not real money/i);
assert.equal((sql.match(/\bbegin\s*;/gi) || []).length, 1);
assert.equal((sql.match(/\bcommit\s*;/gi) || []).length, 1);
assert.match(sql, /amount = 1000000000000/);
assert.match(sql, /exchange_markets_not_live check \(live = false\)/);
assert.match(sw, /const CACHE = 'chess-v28'/);

const ids = new Set();
for (const market of catalog.markets) {
  assert.equal(ids.has(market.id), false, market.id);
  ids.add(market.id);
  assert.equal(market.live, false);
  assert.match(market.referenceKind, /snapshot|cached_public_api|site_rating/);
  assert.equal(sql.includes("'" + market.id + "'"), true, market.id);
  const symbols = new Set();
  if (market.source === 'site') {
    assert.equal(market.players.length, 0);
    continue;
  }
  assert.equal(market.players.length, 20, market.id);
  for (const player of market.players) {
    assert.equal(symbols.has(player.symbol), false, market.id + ' ' + player.symbol);
    symbols.add(player.symbol);
    assert.match(player.symbol, /^[A-Z0-9]{2,12}$/);
    assert.equal(player.rating >= 1 && player.rating <= 4000, true);
    assert.equal(sql.includes("'" + player.symbol + "'"), true);
    assert.equal(sql.includes(String(player.rating * 1000)), true);
  }
}
assert.equal(ids.has('fide:standard'), true);
assert.equal(ids.has('chesscom:blitz'), true);
assert.equal(ids.has('lichess:classical'), true);
assert.equal(ids.has('site:untimed'), true);
const carlsen = catalog.markets.find((market) => market.id === 'fide:standard').players[0];
assert.equal(carlsen.name, 'Magnus Carlsen');
assert.equal(carlsen.rating, 2823);
console.log('exchange catalog tests passed');

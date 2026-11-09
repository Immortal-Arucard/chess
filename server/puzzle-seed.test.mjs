import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Chess } from '../assets/vendor/chess.js/chess.js';

const rated = JSON.parse(readFileSync(new URL('../puzzles/lichess-open-subset.json', import.meta.url), 'utf8'));
const practice = JSON.parse(readFileSync(new URL('../puzzles/practice.json', import.meta.url), 'utf8'));
const ids = new Set(rated.map((row) => row.id));
const bands = new Map();

assert.ok(rated.length >= 3000);
assert.equal(practice.length, 50);
assert.equal(practice.some((row) => ids.has(row.id)), false);
for (const row of rated.concat(practice)) {
  assert.match(row.id, /^[A-Za-z0-9]{4,12}$/);
  assert.ok(row.rating >= 400 && row.rating < 2900);
  assert.ok(row.moves.length >= 2);
  const band = Math.floor(row.rating / 100) * 100;
  bands.set(band, (bands.get(band) || 0) + (ids.has(row.id) ? 1 : 0));
}
assert.ok(Math.min(...rated.map((row) => row.rating)) < 500);
assert.ok(Math.max(...rated.map((row) => row.rating)) >= 2800);
for (const band of [400, 800, 1200, 1600, 2000, 2400, 2800]) {
  assert.ok(bands.get(band) >= 100, 'band ' + band);
}

function replay(row) {
  const game = new Chess(row.fen);
  row.moves.forEach((uci) => {
    const played = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
    if (!played) throw new Error(row.id + ' ' + uci);
  });
}
rated.slice(0, 20).forEach(replay);
practice.slice(0, 10).forEach(replay);
console.log('puzzle seed checks passed');

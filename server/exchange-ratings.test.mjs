import assert from 'node:assert/strict';
import { quotesFromChesscom, quotesFromLichess, refreshExternalQuotes } from './exchange-ratings.mjs';

const fetchedAt = '2026-11-10T05:04:00.000Z';
const lichess = quotesFromLichess('blitz', {
  users: [
    { id: 'DrNykterstein', username: 'DrNykterstein', perfs: { blitz: { rating: 3200 } } },
    { id: 'skip', perfs: { blitz: { rating: 9000 } } },
    { username: 'no-id', perfs: { blitz: { rating: 1500 } } }
  ]
}, fetchedAt);
assert.equal(lichess.length, 2);
assert.equal(lichess[0].marketId, 'lichess:blitz');
assert.equal(lichess[0].externalRef, 'drnykterstein');
assert.equal(lichess[0].kind, 'cached_public_api');
assert.equal(lichess[0].live, undefined);
assert.equal(Object.hasOwn(lichess[0], 'lastPrice'), false);

const chesscom = quotesFromChesscom({
  live_blitz: [{ username: 'Hikaru', score: 3455 }, { username: 'bad', score: 1.5 }],
  live_bullet: [{ username: 'ArkadiiKhromaev', score: 3602 }],
  tactics: [{ username: 'ElCrazyKnight', score: 4000 }]
}, fetchedAt);
assert.deepEqual(chesscom.map((quote) => quote.marketId + ':' + quote.externalRef), [
  'chesscom:bullet:arkadiikhromaev',
  'chesscom:blitz:hikaru'
]);

let calls = 0;
const quotes = await refreshExternalQuotes(async (url) => {
  calls += 1;
  if (String(url).includes('lichess.org')) {
    const category = String(url).split('/').pop();
    return { ok: true, json: async () => ({ users: [{ id: 'ada', perfs: { [category]: { rating: 2100 } } }] }) };
  }
  return { ok: true, json: async () => ({ live_rapid: [{ username: 'Bob', score: 1800 }] }) };
}, new Date(fetchedAt));
assert.equal(calls, 5);
assert.equal(quotes.filter((quote) => quote.marketId.startsWith('lichess:')).length, 4);
assert.equal(quotes.find((quote) => quote.marketId === 'chesscom:rapid').externalRef, 'bob');
assert.equal(quotes.some((quote) => quote.kind !== 'cached_public_api' || quote.asOf !== fetchedAt), false);

let failed = false;
try {
  await refreshExternalQuotes(async () => ({ ok: false, json: async () => ({}) }), new Date());
} catch (err) {
  failed = true;
  assert.match(err.message, /not available/);
}
assert.equal(failed, true);
console.log('exchange rating cache tests passed');

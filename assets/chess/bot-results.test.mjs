import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Chess } from '../vendor/chess.js/chess.js';
import {
  ACCOUNT_SAVE_UNAVAILABLE,
  accountSaveService,
  accountSettingsView,
  applySave,
  buildGameRecord,
  createResultBook,
  loadAutoSavePreference,
  readDeviceRecovery,
  recordReplayErrors,
  rememberDeviceRecovery,
  replayRecord
} from './bot-results.js';

const source = readFileSync(new URL('./bot-results.js', import.meta.url), 'utf8');
assert.equal(source.includes('localStorage'), false);
assert.equal(accountSaveService().live, false);

function play(startFen, sans, extra) {
  return buildGameRecord(Object.assign({
    id: 'game-1',
    startFen,
    sans,
    result: '1-0',
    termination: 'checkmate',
    playerColor: 'white',
    opponentName: 'Stockfish 19 Lite',
    opponentUciElo: 1600,
    white: 'Player',
    black: 'Stockfish 19 Lite',
    boundAccountId: 'profile-a'
  }, extra));
}

function assertRoundTrip(record) {
  assert.deepEqual(recordReplayErrors(record), []);
  const replay = replayRecord(record);
  assert.deepEqual(replay.sans, record.moves.map((move) => move.san));
  assert.equal(replay.finalFen, record.finalFen);
  assert.equal(replay.result, record.result);
  assert.equal(replay.headers.Rated, 'false');
  assert.equal(replay.headers.RatingKind, 'uncalibrated engine limit');
  assert.equal(replay.headers.OpponentUCIElo, String(record.opponentUciElo));
}

const castle = play(undefined, ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O'], { result: '*', termination: 'play' });
assert.ok(castle.moves.some((move) => move.san === 'O-O' && move.uci === 'e1g1'));
assert.match(castle.pgn, /O-O/);
assertRoundTrip(castle);

const passant = play(undefined, ['e4', 'a6', 'e5', 'd5', 'exd6'], { result: '*', termination: 'play' });
assert.equal(passant.moves[4].san, 'exd6');
assert.equal(passant.moves[4].uci, 'e5d6');
assert.match(passant.pgn, /exd6/);
assertRoundTrip(passant);

const promoFen = '8/P7/8/8/8/8/8/4k2K w - - 0 1';
const promo = play(promoFen, ['a8=Q'], { result: '*', termination: 'play' });
assert.equal(promo.moves[0].uci, 'a7a8q');
assert.match(promo.pgn, /\[SetUp "1"\]/);
assert.match(promo.pgn, /\[FEN "8\/P7\/8\/8\/8\/8\/8\/4k2K w - - 0 1"\]/);
assert.match(promo.pgn, /a8=Q/);
assertRoundTrip(promo);
assert.equal(replayRecord(promo).finalFen.startsWith('Q'), true);

const summary = {
  id: 'sum',
  pgn: '[Result "1-0"]\n\n1-0\n',
  startFen: promo.startFen,
  result: '1-0',
  moves: [{ ply: 1, san: 'e4', uci: 'e2e4', fen: 'x' }],
  finalFen: 'x'
};
assert.ok(recordReplayErrors(summary).length > 0);

const owner = { available: true, id: 'profile-a', role: 'owner', autoSaveBotResults: true };
const preference = loadAutoSavePreference(owner);
assert.equal(preference.enabled, true);
const book = createResultBook();
const first = applySave('auto', owner, preference, castle, book);
const second = applySave('manual', owner, preference, castle, book);
assert.equal(first.status, 'unsaved');
assert.equal(first.outcome, 'unavailable');
assert.equal(second.status, 'unsaved');
assert.notEqual(first.outcome, 'saved');
assert.notEqual(second.outcome, 'saved');
assert.equal(first.record, castle);
assert.equal(second.record.pgn, castle.pgn);
assert.equal(second.record.moves.length, castle.moves.length);
assert.equal(book.posts.length, 0);
assert.equal(book.savedCount(), 0);

const pageBook = createResultBook();
const unavailable = applySave('manual', owner, preference, castle, pageBook);
assert.equal(unavailable.outcome, 'unavailable');
assert.equal(unavailable.status, 'unsaved');
assert.equal(unavailable.record, castle);
assert.match(unavailable.error, /not available/);
assert.equal(pageBook.posts.length, 0);
assert.equal(ACCOUNT_SAVE_UNAVAILABLE.includes('not an account save'), true);
assert.equal(source.includes("outcome: 'saved'"), false);
assert.equal(source.includes('book.posts.push'), false);

const discardBook = createResultBook();
discardBook.noteDiscard(castle.id);
const later = applySave('auto', owner, preference, castle, discardBook);
assert.equal(later.outcome, 'discarded-not-replayed');
assert.equal(discardBook.posts.length, 0);

const other = applySave('manual', { available: true, id: 'profile-b', role: 'owner' }, preference, castle, createResultBook());
assert.equal(other.outcome, 'wrong-account');
assert.equal(other.status, 'unsaved');
const stranger = applySave('manual', { available: true, id: 'profile-a', role: 'authenticated' }, preference, castle, createResultBook());
assert.equal(stranger.outcome, 'unavailable');
assert.equal(stranger.status, 'unsaved');
const anon = applySave('manual', { available: false, id: null, role: 'anon' }, loadAutoSavePreference(null), castle, createResultBook());
assert.equal(anon.outcome, 'unavailable');

const broken = loadAutoSavePreference({ available: true, id: 'profile-a', settingsError: 'settings failed' });
assert.equal(broken.enabled, false);
assert.equal(broken.available, false);
const brokenSave = applySave('auto', owner, broken, castle, createResultBook());
assert.equal(brokenSave.status, 'unsaved');
assert.notEqual(brokenSave.outcome, 'saved');

const view = accountSettingsView({ available: false });
assert.equal(view.checked, false);
assert.equal(view.disabled, true);
assert.match(view.note, /off by default/);
assert.match(view.note, /not on this device/);

const offline = applySave('manual', Object.assign({}, owner, { offline: true }), preference, promo, createResultBook());
assert.equal(offline.status, 'unsaved');
assert.equal(offline.record, promo);
assert.equal(offline.record.moves[0].uci, 'a7a8q');

const game = new Chess();
game.move('e4');
assert.equal(game.history().length, 1);

const device = rememberDeviceRecovery({ setItem(_key, value) { this.value = value; }, value: null }, {
  phase: 'ended',
  startFen: castle.startFen,
  sans: castle.moves.map((move) => move.san),
  player: 'w',
  clientGameId: castle.id,
  record: castle,
  discardedIds: []
});
assert.equal(device.accountSave, false);
assert.match(device.note, /Not an account save/);
assert.equal(device.record.pgn, castle.pgn);

console.log('bot result record tests passed');

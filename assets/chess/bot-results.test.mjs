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
  recordReplayErrors,
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
const live = { live: true };
const book = createResultBook();
const first = applySave('auto', owner, preference, castle, book, { service: live });
assert.equal(first.outcome, 'saved');
assert.equal(first.record, castle);
assert.equal(book.posts.length, 1);
assert.equal(book.posts[0].record.pgn, castle.pgn);
assert.equal(book.posts[0].record.moves.length, castle.moves.length);
const second = applySave('auto', owner, preference, castle, book, { service: live });
assert.equal(second.outcome, 'already-saved');
assert.equal(book.posts.length, 1);

const failing = { live: true, fail: 'The account service rejected the save.' };
const retryBook = createResultBook();
const failed = applySave('manual', owner, preference, passant, retryBook, { service: failing });
assert.equal(failed.outcome, 'error');
assert.equal(failed.status, 'unsaved');
assert.equal(failed.record, passant);
assert.equal(retryBook.posts.length, 0);
const retried = applySave('manual', owner, preference, failed.record, retryBook, { service: live });
assert.equal(retried.outcome, 'saved');
assert.equal(retried.record.pgn, passant.pgn);
assert.equal(retryBook.posts.length, 1);
assert.equal(applySave('manual', owner, preference, passant, retryBook, { service: live }).outcome, 'already-saved');

const offOwner = Object.assign({}, owner, { autoSaveBotResults: false });
const offBook = createResultBook();
const skipped = applySave('auto', offOwner, loadAutoSavePreference(offOwner), castle, offBook, { service: live });
assert.equal(skipped.outcome, 'manual');
assert.equal(offBook.posts.length, 0);
const manual = applySave('manual', offOwner, loadAutoSavePreference(offOwner), castle, offBook, { service: live });
assert.equal(manual.outcome, 'saved');
assert.equal(offBook.posts[0].record.moves.length, castle.moves.length);

const pageBook = createResultBook();
const unavailable = applySave('manual', owner, preference, castle, pageBook);
assert.equal(unavailable.outcome, 'unavailable');
assert.equal(unavailable.status, 'unsaved');
assert.equal(unavailable.record, castle);
assert.match(unavailable.error, /not available/);
assert.equal(pageBook.posts.length, 0);
assert.equal(ACCOUNT_SAVE_UNAVAILABLE.includes('not an account save'), true);

const discardBook = createResultBook();
discardBook.noteDiscard(castle.id);
const later = applySave('auto', owner, preference, castle, discardBook, { service: live });
assert.equal(later.outcome, 'discarded-not-replayed');
assert.equal(discardBook.posts.length, 0);

const other = applySave('manual', { available: true, id: 'profile-b', role: 'owner' }, preference, castle, createResultBook(), { service: live });
assert.equal(other.outcome, 'wrong-account');
const stranger = applySave('manual', { available: true, id: 'profile-a', role: 'authenticated' }, preference, castle, createResultBook(), { service: live });
assert.equal(stranger.outcome, 'forbidden');
const anon = applySave('manual', { available: false, id: null, role: 'anon' }, loadAutoSavePreference(null), castle, createResultBook(), { service: live });
assert.equal(anon.outcome, 'unavailable');

const broken = loadAutoSavePreference({ available: true, id: 'profile-a', settingsError: 'settings failed' });
assert.equal(broken.enabled, false);
assert.equal(broken.available, false);
const brokenSave = applySave('auto', owner, broken, castle, createResultBook(), { service: live });
assert.equal(brokenSave.outcome, 'manual');

const view = accountSettingsView({ available: false });
assert.equal(view.checked, false);
assert.equal(view.disabled, true);
assert.match(view.note, /off by default/);
assert.match(view.note, /not on this device/);

const offline = applySave('manual', Object.assign({}, owner, { offline: true }), preference, promo, createResultBook(), { service: live });
assert.equal(offline.outcome, 'error');
assert.equal(offline.record.moves[0].uci, 'a7a8q');

const game = new Chess();
game.move('e4');
assert.equal(game.history().length, 1);

console.log('bot result record tests passed');

import assert from 'node:assert/strict';
import { Chess } from '../assets/vendor/chess.js/chess.js';
import { validateGame } from './game-record.mjs';
import { routeApi } from './worker.mjs';

const game = new Chess();
game.move('e4');
game.move('e5');
const moves = game.history({ verbose: true }).map((move, index) => ({
  ply: index + 1,
  san: move.san,
  uci: move.from + move.to,
  fen: move.after
}));
const pgn = game.pgn().replace('[Result "*"]', '[Result "0-1"]').replace(/\*\s*$/, '0-1');
const record = {
  pgn,
  startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  moves,
  result: '0-1',
  termination: 'resign',
  playerColor: 'white',
  opponentName: 'Stockfish 19 Lite',
  opponentUciElo: 1600,
  rated: false,
  pieceStyle: 'standard',
  pieceColor: 'ink',
  palette: 'midnight'
};
assert.equal(typeof validateGame(record), 'string');
assert.throws(() => validateGame(Object.assign({}, record, { result: '1/2-1/2', termination: 'draw' })), /match/);
const shifted = Object.assign({}, record, { pgn: record.pgn.replace('[Result "0-1"]', '[SetUp "1"]\n[FEN "8/8/8/8/8/8/8/4k2K w - - 0 1"]\n[Result "0-1"]') });
assert.throws(() => validateGame(shifted), /starting position/);
assert.throws(() => validateGame(Object.assign({}, record, { rated: true })), /rated/);
assert.equal(routeApi('/api/session'), true);
assert.equal(routeApi('/bot/'), false);
console.log('game record tests passed');

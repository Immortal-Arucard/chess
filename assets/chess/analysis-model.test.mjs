import assert from 'node:assert/strict';
import {
  addChild,
  classifyLoss,
  loadPgnGame,
  mainlineAt,
  mainlineNodes,
  moverLoss,
  moveAccuracy,
  onMainline,
  parseFen,
  parseInfo,
  sideAccuracy,
  splitPgnGames,
  treeFromLine,
  whiteCp
} from './analysis-model.js';

const sample = `[Event "One"]
[White "Ada"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0

[Event "Two"]
[White "Cara"]
[Black "Dee"]
[Result "*"]

1. d4 d5 *`;

const games = splitPgnGames(sample);
assert.equal(games.length, 2);
const first = loadPgnGame(games[0]);
assert.equal(first.ok, true);
assert.equal(first.headers.white, 'Ada');
assert.equal(first.sans[0], 'e4');
assert.equal(first.sans[first.sans.length - 1], 'Qxf7#');
const second = loadPgnGame(games[1]);
assert.equal(second.ok, true);
assert.equal(second.sans.join(' '), 'd4 d5');
assert.equal(loadPgnGame('not a game').ok, false);
const fromFen = loadPgnGame('[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"]\n\n1... e5');
assert.equal(fromFen.ok, true);
assert.equal(fromFen.sans[0], 'e5');
assert.match(fromFen.startFen, /^rnbqkbnr\/pppppppp\/8\/8\/4P3/);

const fen = parseFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
assert.equal(fen.ok, true);
assert.equal(parseFen('8/8/8/8/8/8/8/8 w - - 0 1').ok, false);

const root = treeFromLine(first.startFen, first.sans, first.ucis, first.fens);
const line = mainlineNodes(root);
assert.equal(line.length, first.sans.length);
assert.equal(onMainline(line[line.length - 1]), true);
const branch = addChild(line[0], { san: 'c5', uci: 'c7c5', fen: 'side' });
const side = addChild(branch, { san: 'Nf3', uci: 'g1f3', fen: 'deeper' });
assert.equal(onMainline(side), false);
assert.equal(mainlineAt(side).san, 'e5');
assert.equal(mainlineAt(line[2]), line[2]);

assert.equal(classifyLoss(0, true), 'Best');
assert.equal(classifyLoss(10, false), 'Best');
assert.equal(classifyLoss(11, false), 'Excellent');
assert.equal(classifyLoss(25, false), 'Excellent');
assert.equal(classifyLoss(26, false), 'Good');
assert.equal(classifyLoss(50, false), 'Good');
assert.equal(classifyLoss(51, false), 'Inaccuracy');
assert.equal(classifyLoss(100, false), 'Inaccuracy');
assert.equal(classifyLoss(101, false), 'Mistake');
assert.equal(classifyLoss(250, false), 'Mistake');
assert.equal(classifyLoss(251, false), 'Blunder');
assert.equal(moverLoss(40, 10, 'w'), 30);
assert.equal(moverLoss(40, 10, 'b'), -30);
assert.equal(whiteCp({ cp: 30 }, 'w'), 30);
assert.equal(whiteCp({ cp: 30 }, 'b'), -30);
assert.equal(moveAccuracy(0) > 95, true);
assert.equal(moveAccuracy(300) < 20, true);
assert.equal(sideAccuracy([0, 0]), moveAccuracy(0));

const info = parseInfo('info depth 12 seldepth 18 multipv 2 score cp -15 nodes 1000 pv e7e5 g1f3');
assert.equal(info.depth, 12);
assert.equal(info.multipv, 2);
assert.equal(info.cp, -15);
assert.deepEqual(info.pv, ['e7e5', 'g1f3']);
assert.equal(parseInfo('info depth 4 currmove e2e4'), null);
const mate = parseInfo('info depth 8 multipv 1 score mate 2 pv f7f8q');
assert.equal(mate.mate, 2);
console.log('analysis model tests passed');

import { Chess } from '/assets/vendor/chess.js/chess.js';
import { mountBoard } from '/assets/chess/board.js';
import { PALETTES, PIECE_COLORS, PIECE_STYLES, loadPrefs, pieceColors, savePrefs } from '/assets/chess/bot-prefs.js';
import { applyUci, kingSquare, legalTargets, outcome, pieceMap } from '/assets/chess/rules.js';
import { createAnalysisEngine } from '/assets/chess/analysis-engine.js';
import {
  addChild,
  gradeMove,
  loadPgnGame,
  mainlineAt,
  mainlineNodes,
  moveRows,
  moverLoss,
  onMainline,
  parseFen,
  readAnalysis,
  rememberAnalysis,
  sideAccuracy,
  sideLabel,
  sideVariations,
  splitPgnGames,
  treeFromLine,
  whiteCp
} from '/assets/chess/analysis-model.js';

const ENGINE_URL = '/assets/vendor/stockfish/stockfish-19-lite-single.js';
const root = document.getElementById('analysis-app');
const engine = createAnalysisEngine(ENGINE_URL);
let prefs = loadPrefs(localStorage);
let tree = null;
let current = null;
let headers = { white: 'White', black: 'Black', result: '*' };
let orientation = 'w';
let selected = null;
let lines = [];
let depth = 12;
let movetime = 0;
let multipv = 2;
let reviewing = false;
let notice = '';
let choices = [];
const boardApi = { current: null };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function chessAt(node) {
  return new Chess(node.fen);
}

function turnOf(fen) {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

function uciOf(move) {
  return move.from + move.to + (move.promotion || '');
}

function show(game) {
  const loaded = game.fen && !game.sans
    ? { ok: true, startFen: game.fen, sans: [], ucis: [], fens: [], headers: { white: game.white || 'White', black: game.black || 'Black', result: game.result || '*' }, pgn: '' }
    : loadPgnGame(game.pgn || '');
  if (!loaded.ok) { notice = loaded.error; render(); return; }
  headers = loaded.headers;
  tree = treeFromLine(loaded.startFen, loaded.sans, loaded.ucis, loaded.fens);
  current = tree;
  lines = [];
  notice = '';
  render();
  askEngine();
}

function askEngine() {
  if (!engine.ready || !current) return;
  engine.search(current.fen, { multipv, depth: movetime ? 0 : depth, ms: movetime || 400 });
}

function playSquare(square) {
  if (!current) return;
  const chess = chessAt(current);
  if (selected && legalTargets(chess, selected).includes(square)) {
    const promotions = chess.moves({ square: selected, verbose: true }).filter((move) => move.to === square && move.promotion);
    const choice = promotions.length ? 'q' : undefined;
    const played = chess.move({ from: selected, to: square, promotion: choice });
    if (!played) return;
    current = addChild(current, { san: played.san, uci: uciOf(played), fen: played.after });
    selected = null;
    lines = [];
    render();
    askEngine();
    return;
  }
  const piece = chess.get(square);
  selected = piece && piece.color === chess.turn() ? square : null;
  render();
}

function go(node) {
  current = node;
  selected = null;
  lines = [];
  render();
  askEngine();
}

function step(direction) {
  if (!current) return;
  if (direction < 0) {
    if (current.parent) go(current.parent);
    return;
  }
  if (current.children[0]) go(current.children[0]);
}

function sibling(direction) {
  if (!current || !current.parent) return;
  const kids = current.parent.children;
  const index = kids.indexOf(current);
  const next = kids[index + direction];
  if (next) go(next);
}

async function review() {
  if (!tree || reviewing) return;
  reviewing = true;
  notice = 'Reviewing the main line.';
  render();
  const nodes = [tree].concat(mainlineNodes(tree));
  for (let index = 0; index < nodes.length; index += 1) {
    const found = await once(nodes[index].fen);
    if (!found) break;
    nodes[index].evalCp = whiteCp(found.lines[0], turnOf(nodes[index].fen));
    nodes[index].best = found.uci;
    notice = 'Reviewed ' + (index + 1) + ' of ' + nodes.length + '.';
    render();
  }
  mainlineNodes(tree).forEach((node) => {
    const mover = turnOf(node.fen) === 'w' ? 'b' : 'w';
    const loss = moverLoss(node.parent.evalCp, node.evalCp, mover);
    const graded = gradeMove({
      lossCp: loss,
      matchedBest: node.uci === node.parent.best,
      checkmate: chessAt(node).isCheckmate()
    });
    node.loss = graded.lossCp;
    node.mark = graded.mark;
  });
  reviewing = false;
  notice = 'Review finished. Ratings and stored results were not changed.';
  render();
}

function once(fen) {
  return new Promise((resolve) => {
    if (!engine.search(fen, { multipv: 1, depth: movetime ? 0 : depth, ms: movetime || 300 })) {
      resolve(null);
      return;
    }
    const listener = (type, detail) => {
      if (type === 'error' || (type === 'done' && detail.fen === fen)) {
        engine.off(listener);
        resolve(type === 'done' ? detail : null);
      }
    };
    engine.on(listener);
  });
}

function accuracy() {
  const white = [];
  const black = [];
  mainlineNodes(tree).forEach((node) => {
    if (node.loss == null) return;
    const mover = turnOf(node.fen) === 'w' ? 'b' : 'w';
    (mover === 'w' ? white : black).push(node.loss);
  });
  return { white: sideAccuracy(white), black: sideAccuracy(black) };
}

function moveButton(node) {
  const button = el('button', node === current ? 'is-here' : '');
  button.type = 'button';
  button.append(document.createTextNode(node.san));
  if (node.mark) button.append(el('span', 'mark mark-' + node.mark.toLowerCase(), node.mark));
  button.addEventListener('click', () => go(node));
  return button;
}

function renderLine(lineStart, host) {
  moveRows(lineStart).forEach((row) => {
    const item = el('div', 'move-row');
    item.append(el('span', 'move-no', row.number + (row.white ? '.' : '...')));
    if (row.white) item.append(moveButton(row.white));
    if (row.black) item.append(moveButton(row.black));
    host.append(item);
    const branches = [];
    if (row.white) branches.push(...sideVariations(row.white));
    if (row.black) branches.push(...sideVariations(row.black));
    branches.forEach((variation) => {
      const nest = el('div', 'move-vars');
      renderLine(variation, nest);
      host.append(nest);
    });
  });
}

function drawArrows(host) {
  const svg = host.querySelector('.analysis-arrows');
  const board = host.querySelector('.board');
  if (!svg || !board) return;
  const box = board.getBoundingClientRect();
  svg.setAttribute('viewBox', '0 0 ' + box.width + ' ' + box.height);
  svg.replaceChildren();
  const best = lines[0] && lines[0].pv && lines[0].pv[0];
  if (!best || best.length < 4) return;
  const from = board.querySelector('[data-square="' + best.slice(0, 2) + '"]');
  const to = board.querySelector('[data-square="' + best.slice(2, 4) + '"]');
  if (!from || !to) return;
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', a.left - box.left + a.width / 2);
  line.setAttribute('y1', a.top - box.top + a.height / 2);
  line.setAttribute('x2', b.left - box.left + b.width / 2);
  line.setAttribute('y2', b.top - box.top + b.height / 2);
  line.setAttribute('stroke', '#4fc3ff');
  line.setAttribute('stroke-width', '6');
  line.setAttribute('stroke-linecap', 'round');
  svg.append(line);
}

function lineText(line) {
  const shown = whiteCp(line, current ? turnOf(current.fen) : 'w');
  const chess = current ? chessAt(current) : new Chess();
  const moves = (line.pv || []).slice(0, 8).map((uci) => {
    const played = applyUci(chess, uci);
    return played ? played.san : uci;
  }).join(' ');
  return 'Depth ' + line.depth + ' · ' + (line.multipv || 1) + ' · ' + (shown == null ? '' : (shown / 100).toFixed(2)) + ' · ' + moves;
}

function render() {
  const importer = root.querySelector('.analysis-import');
  root.replaceChildren();
  const tools = el('div', 'analysis-tools');
  const back = el('button', 'tool', 'Back');
  back.type = 'button';
  back.addEventListener('click', () => step(-1));
  const forward = el('button', 'tool', 'Forward');
  forward.type = 'button';
  forward.addEventListener('click', () => step(1));
  const main = el('button', 'tool', 'Main line');
  main.type = 'button';
  main.addEventListener('click', () => { if (current) go(mainlineAt(current)); });
  const flip = el('button', 'tool', 'Flip board');
  flip.type = 'button';
  flip.addEventListener('click', () => { orientation = orientation === 'w' ? 'b' : 'w'; render(); });
  const reviewButton = el('button', 'tool', reviewing ? 'Reviewing…' : 'Review game');
  reviewButton.type = 'button';
  reviewButton.disabled = reviewing;
  reviewButton.addEventListener('click', () => { void review(); });
  tools.append(back, forward, main, flip, reviewButton);
  const depthChoice = document.createElement('select');
  depthChoice.setAttribute('aria-label', 'Engine depth or time');
  [[12, 0, 'Depth 12'], [8, 0, 'Depth 8'], [16, 0, 'Depth 16'], [0, 300, '0.3 seconds'], [0, 1000, '1 second']].forEach((choice) => {
    const option = el('option', null, choice[2]);
    option.value = choice[0] + ':' + choice[1];
    if (choice[0] === depth && choice[1] === movetime) option.selected = true;
    depthChoice.append(option);
  });
  depthChoice.addEventListener('change', () => {
    const parts = depthChoice.value.split(':');
    depth = Number(parts[0]);
    movetime = Number(parts[1]);
    askEngine();
  });
  const pvChoice = document.createElement('select');
  pvChoice.setAttribute('aria-label', 'Number of engine lines');
  [1, 2, 3].forEach((count) => {
    const option = el('option', null, count + (count === 1 ? ' line' : ' lines'));
    option.value = String(count);
    if (count === multipv) option.selected = true;
    pvChoice.append(option);
  });
  pvChoice.addEventListener('change', () => { multipv = Number(pvChoice.value); askEngine(); });
  tools.append(depthChoice, pvChoice);
  root.append(tools);
  if (notice) root.append(el('p', 'analysis-accuracy', notice));
  if (tree) {
    const scores = accuracy();
    if (scores.white != null || scores.black != null) {
      root.append(el('p', 'analysis-accuracy', 'Accuracy ' + sideLabel(headers.white, 'White') + ' ' + (scores.white == null ? '—' : scores.white) + ' · ' + sideLabel(headers.black, 'Black') + ' ' + (scores.black == null ? '—' : scores.black)));
    }
  }
  const layout = el('div', 'analysis-layout');
  const stage = el('div', 'analysis-stage');
  const bar = el('div', 'eval-bar');
  bar.setAttribute('aria-hidden', 'true');
  const fill = document.createElement('i');
  const cp = lines[0] ? whiteCp(lines[0], current ? turnOf(current.fen) : 'w') : (current && current.evalCp);
  const clamped = cp == null ? 0 : Math.max(-800, Math.min(800, cp));
  fill.style.height = (50 + clamped / 16) + '%';
  bar.append(fill);
  const boardWrap = el('div', 'analysis-board');
  const frame = el('div', 'board-frame');
  const board = el('div');
  const arrows = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arrows.setAttribute('class', 'analysis-arrows');
  frame.append(board, arrows);
  boardWrap.append(frame);
  stage.append(bar, boardWrap);
  const side = el('div');
  const readout = el('p', 'eval-readout', cp == null ? 'Engine' : (cp / 100).toFixed(2));
  const list = el('ol', 'engine-lines');
  lines.forEach((line) => list.append(el('li', null, lineText(line))));
  side.append(readout, list);
  if (tree) {
    const graph = el('div', 'eval-graph');
    graph.setAttribute('role', 'group');
    graph.setAttribute('aria-label', 'Evaluation graph');
    mainlineNodes(tree).forEach((node, index) => {
      const point = el('button');
      point.type = 'button';
      point.setAttribute('aria-label', 'Move ' + (index + 1) + (node.mark ? ', ' + node.mark : ''));
      const value = node.evalCp == null ? 0 : Math.max(-400, Math.min(400, node.evalCp));
      point.style.height = (20 + Math.abs(value) / 8) + 'px';
      if (node === current || (current && onMainline(current) && node === current)) point.className = 'is-here';
      point.addEventListener('click', () => go(node));
      graph.append(point);
    });
    const moves = el('div', 'move-tree');
    if (tree.children[0]) renderLine(tree.children[0], moves);
    side.append(graph, moves);
  }
  layout.append(stage, side);
  root.append(layout);
  const chess = current ? chessAt(current) : new Chess();
  const state = outcome(chess);
  boardApi.current = mountBoard(board, playSquare);
  boardApi.current.render({
    orientation,
    pieces: pieceMap(chess),
    selected,
    legal: selected ? legalTargets(chess, selected) : [],
    lastMove: current && current.uci ? { from: current.uci.slice(0, 2), to: current.uci.slice(2, 4) } : null,
    checkSquare: state.check ? kingSquare(chess, chess.turn()) : null,
    interactive: true,
    palette: prefs.palette,
    pieceStyle: prefs.pieceStyle,
    pieceColor: prefs.pieceColor,
    pieceColors: pieceColors(prefs.pieceColor)
  });
  requestAnimationFrame(() => drawArrows(frame));
  const copies = el('div', 'analysis-tools');
  const fen = el('button', 'tool', 'Copy FEN');
  fen.type = 'button';
  fen.addEventListener('click', () => {
    if (current && navigator.clipboard) navigator.clipboard.writeText(current.fen).catch(() => {});
  });
  const pgn = el('button', 'tool', 'Copy PGN');
  pgn.type = 'button';
  pgn.addEventListener('click', () => {
    if (navigator.clipboard) navigator.clipboard.writeText(exportPgn()).catch(() => {});
  });
  copies.append(fen, pgn);
  [['palette', PALETTES], ['pieceStyle', PIECE_STYLES], ['pieceColor', PIECE_COLORS]].forEach(([key, options]) => {
    const select = document.createElement('select');
    select.setAttribute('aria-label', key);
    options.forEach((option) => {
      const node = el('option', null, option.label);
      node.value = option.id;
      if (prefs[key] === option.id) node.selected = true;
      select.append(node);
    });
    select.addEventListener('change', () => {
      prefs = savePrefs(localStorage, Object.assign({}, prefs, { [key]: select.value }));
      render();
    });
    copies.append(select);
  });
  root.append(copies, importer || importBox());
}

function exportPgn() {
  if (!tree) return '';
  const chess = new Chess(tree.fen);
  mainlineNodes(tree).forEach((node) => { applyUci(chess, node.uci); });
  chess.header('Event', 'Analysis', 'White', headers.white, 'Black', headers.black, 'Result', headers.result);
  return chess.pgn();
}

function importBox() {
  const box = el('form', 'analysis-import');
  const area = document.createElement('textarea');
  area.setAttribute('aria-label', 'PGN or FEN');
  const load = el('button', 'tool', 'Load');
  load.type = 'submit';
  const picker = document.createElement('div');
  box.append(area, load, picker);
  box.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = area.value.trim();
    const fen = parseFen(text);
    if (fen.ok && !text.includes('[')) {
      rememberAnalysis({ fen: fen.fen });
      show({ fen: fen.fen, sans: null });
      return;
    }
    const games = splitPgnGames(text);
    if (games.length < 1) { notice = 'Paste a PGN or a FEN.'; render(); return; }
    if (games.length === 1) {
      rememberAnalysis({ pgn: games[0] });
      show({ pgn: games[0] });
      return;
    }
    choices = games;
    picker.replaceChildren();
    games.forEach((game, index) => {
      const button = el('button', 'tool', 'Game ' + (index + 1));
      button.type = 'button';
      button.addEventListener('click', () => {
        rememberAnalysis({ pgn: game });
        show({ pgn: game });
      });
      picker.append(button);
    });
  });
  return box;
}

engine.on((type, detail) => {
  if (type === 'info' && current && detail.fen === current.fen) {
    lines = detail.lines;
    const readout = root.querySelector('.eval-readout');
    const list = root.querySelector('.engine-lines');
    if (readout && list && lines[0]) {
      const cp = whiteCp(lines[0], turnOf(current.fen));
      readout.textContent = cp == null ? 'Engine' : (cp / 100).toFixed(2);
      list.replaceChildren();
      lines.forEach((line) => list.append(el('li', null, lineText(line))));
      const fill = root.querySelector('.eval-bar i');
      if (fill && cp != null) fill.style.height = (50 + Math.max(-800, Math.min(800, cp)) / 16) + '%';
      const wrap = root.querySelector('.analysis-board');
      if (wrap) drawArrows(wrap);
    }
  }
  if (type === 'ready') askEngine();
  if (type === 'error') {
    notice = detail.message;
    render();
  }
});

document.addEventListener('keydown', (event) => {
  const tag = event.target && event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (event.target && event.target.classList && event.target.classList.contains('square'))) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
  if (event.key === 'ArrowUp') { event.preventDefault(); sibling(-1); }
  if (event.key === 'ArrowDown') { event.preventDefault(); sibling(1); }
});

const stored = readAnalysis();
if (stored && stored.pgn) show(stored);
else if (stored && stored.fen) show({ fen: stored.fen, sans: null, white: stored.white, black: stored.black, result: stored.result });
else show({ fen: new Chess().fen(), sans: null });
engine.start();

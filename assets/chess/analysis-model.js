import { Chess, validateFen } from '../vendor/chess.js/chess.js';

export const CLASS_LIMITS = { best: 10, excellent: 25, good: 50, inaccuracy: 100, mistake: 250 };
export const ANALYSIS_KEY = 'chess.analysis.game';

export function splitPgnGames(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const games = [];
  let current = [];
  let sawMoves = false;
  lines.forEach((line) => {
    const header = /^\s*\[/.test(line);
    if (header && sawMoves && current.length) {
      games.push(current.join('\n').trim());
      current = [line];
      sawMoves = false;
      return;
    }
    current.push(line);
    if (line.trim() && !header) sawMoves = true;
  });
  const last = current.join('\n').trim();
  if (last) games.push(last);
  return games;
}

export function loadPgnGame(pgn) {
  const chess = new Chess();
  try {
    chess.loadPgn(String(pgn || ''), { strict: false });
  } catch (err) {
    return { ok: false, error: 'That PGN could not be read.' };
  }
  if (!chess.history().length && chess.fen() === new Chess().fen()) {
    return { ok: false, error: 'That PGN has no moves.' };
  }
  const verbose = chess.history({ verbose: true });
  return {
    ok: true,
    startFen: verbose.length ? verbose[0].before : chess.fen(),
    sans: verbose.map((move) => move.san),
    ucis: verbose.map((move) => move.from + move.to + (move.promotion || '')),
    fens: verbose.map((move) => move.after),
    headers: {
      white: chess.getHeaders().White || 'White',
      black: chess.getHeaders().Black || 'Black',
      result: chess.getHeaders().Result || '*'
    },
    pgn: chess.pgn()
  };
}

export function parseFen(fen) {
  const checked = validateFen(String(fen || '').trim());
  if (!checked.ok) return { ok: false, error: checked.error || 'That FEN is not valid.' };
  return { ok: true, fen: new Chess(checked.fen || fen).fen() };
}

export function createTree(startFen) {
  return { fen: startFen, san: null, uci: null, children: [], parent: null, evalCp: null, mark: '' };
}

export function addChild(node, move) {
  const uci = move.uci;
  let child = node.children.find((item) => item.uci === uci);
  if (!child) {
    child = { fen: move.fen, san: move.san, uci, children: [], parent: node, evalCp: null, mark: '' };
    node.children.push(child);
  }
  return child;
}

export function mainlineNodes(root) {
  const nodes = [];
  let cursor = root;
  while (cursor.children[0]) {
    cursor = cursor.children[0];
    nodes.push(cursor);
  }
  return nodes;
}

export function onMainline(node) {
  let cursor = node;
  while (cursor && cursor.parent) {
    if (cursor.parent.children[0] !== cursor) return false;
    cursor = cursor.parent;
  }
  return true;
}

export function mainlineAt(node) {
  const stack = [];
  let cursor = node;
  while (cursor && cursor.parent) {
    stack.push(cursor);
    cursor = cursor.parent;
  }
  let main = cursor;
  while (stack.length && main && main.children[0]) {
    const step = stack.pop();
    if (main.children[0] !== step) return main.children[0];
    main = step;
  }
  return main;
}

export function treeFromLine(startFen, sans, ucis, fens) {
  const root = createTree(startFen);
  let cursor = root;
  sans.forEach((san, index) => {
    cursor = addChild(cursor, { san, uci: ucis[index], fen: fens[index] });
  });
  return root;
}

export function whiteCp(info, turn) {
  if (!info) return null;
  let cp = null;
  if (info.mate != null && Number.isFinite(info.mate)) cp = info.mate > 0 ? 10000 - info.mate * 10 : -10000 - info.mate * 10;
  else if (info.cp != null && Number.isFinite(info.cp)) cp = info.cp;
  if (cp == null) return null;
  if (turn === 'b') cp = -cp;
  return cp;
}

export function moverLoss(beforeWhiteCp, afterWhiteCp, color) {
  if (beforeWhiteCp == null || afterWhiteCp == null) return null;
  return color === 'w' ? beforeWhiteCp - afterWhiteCp : afterWhiteCp - beforeWhiteCp;
}

export function classifyLoss(lossCp, matchedBest) {
  if (lossCp == null) return '';
  if (matchedBest || lossCp <= CLASS_LIMITS.best) return 'Best';
  if (lossCp <= CLASS_LIMITS.excellent) return 'Excellent';
  if (lossCp <= CLASS_LIMITS.good) return 'Good';
  if (lossCp <= CLASS_LIMITS.inaccuracy) return 'Inaccuracy';
  if (lossCp <= CLASS_LIMITS.mistake) return 'Mistake';
  return 'Blunder';
}

export function moveAccuracy(lossCp) {
  const loss = Math.max(0, Number(lossCp) || 0);
  const value = 103.1668 * Math.exp(-0.04354 * loss) - 3.1669;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function sideAccuracy(marks) {
  if (!marks.length) return null;
  const total = marks.reduce((sum, loss) => sum + moveAccuracy(loss), 0);
  return Math.round(total / marks.length);
}

export function parseInfo(line) {
  const text = String(line || '');
  if (!text.startsWith('info ') || text.indexOf(' pv ') === -1) return null;
  if (text.includes('lowerbound') || text.includes('upperbound')) return null;
  const depth = Number((text.match(/\bdepth (\d+)/) || [])[1]);
  const multipv = Number((text.match(/\bmultipv (\d+)/) || [, '1'])[1]);
  const mate = text.match(/\bscore mate (-?\d+)/);
  const cp = text.match(/\bscore cp (-?\d+)/);
  const pv = text.slice(text.indexOf(' pv ') + 4).trim().split(/\s+/).filter(Boolean);
  if (!Number.isFinite(depth) || !pv.length) return null;
  return {
    depth,
    multipv: Number.isFinite(multipv) ? multipv : 1,
    mate: mate ? Number(mate[1]) : null,
    cp: cp ? Number(cp[1]) : null,
    pv
  };
}

export function rememberAnalysis(game) {
  const payload = {
    pgn: game && game.pgn ? String(game.pgn) : '',
    fen: game && game.fen ? String(game.fen) : '',
    white: game && game.white ? String(game.white) : 'White',
    black: game && game.black ? String(game.black) : 'Black',
    result: game && game.result ? String(game.result) : '*'
  };
  sessionStorage.setItem(ANALYSIS_KEY, JSON.stringify(payload));
  return payload;
}

export function readAnalysis() {
  try {
    const raw = sessionStorage.getItem(ANALYSIS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

import { Chess } from '../assets/vendor/chess.js/chess.js';
import { mountBoard } from '../assets/chess/board.js';
import { loadPrefs, pieceColors } from '../assets/chess/bot-prefs.js';
import { piecesOf, kingSquare } from '../assets/chess/human-rules.js';
import { formatDelta } from '../assets/chess/rating.js';
import { closeGameStage, syncGameStage } from '../assets/chess/game-stage.js';
import { createChessGateway } from '../assets/chess/community-gateway.js';

const root = document.getElementById('puzzle-app');
const gateway = createChessGateway();
const prefs = loadPrefs(localStorage);
let account = null;
let summary = { streak: 0, best: 0, userRating: 0 };
let phase = 'home';
let puzzle = null;
let game = null;
let selected = null;
let notice = '';
let reviewAt = 0;
let practice = [];
let practiceCursor = 0;
let busy = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function csrf() {
  const match = document.cookie.match(/(?:^|; )chess_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}
async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() },
    body: JSON.stringify(body || {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'The request could not be completed.');
  return payload;
}
function parseUci(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined };
}
function replay(fen, ucis) {
  const board = new Chess(fen);
  (ucis || []).forEach((uci) => {
    if (!board.move(parseUci(uci))) throw new Error('That move is not legal.');
  });
  return board;
}
function orientationOf(attempt) {
  if (attempt.orientation) return attempt.orientation;
  const board = new Chess(attempt.setupFen);
  if (attempt.applied && attempt.applied[0]) board.move(parseUci(attempt.applied[0]));
  return board.turn();
}
function loadPosition(attempt) {
  puzzle = attempt;
  game = replay(attempt.setupFen, attempt.applied || []);
  selected = null;
}
function seconds(millis) {
  const value = Number(millis) || 0;
  return (value / 1000).toFixed(1) + 's';
}
function resultLine(attempt) {
  if (!attempt || attempt.status === 'active') return '';
  if (attempt.status === 'abandoned') return 'Abandoned. Unrated. Your rating and streak stay the same.';
  if (attempt.status === 'solved') {
    const gain = Number(attempt.gain) || 0;
    const bonus = Number(attempt.bonus) || 0;
    return bonus ? 'Solved. +' + gain + ' +' + bonus + ' streak' : 'Solved. +' + gain;
  }
  return 'Missed. ' + formatDelta(attempt.delta || 0) + '. Streak reset.';
}
function stageOptions() {
  if (puzzle && puzzle.status === 'active' && account) {
    return {
      label: 'Leave puzzle',
      confirm: 'Leave this puzzle? Leaving before a wrong move is abandoned. It does not change your rating or streak.',
      yesLabel: 'Leave puzzle',
      onConfirm: () => { void leave(); }
    };
  }
  return {
    label: 'Exit',
    confirm: 'Leave this board?',
    yesLabel: 'Exit',
    onConfirm: () => { phase = 'home'; puzzle = null; game = null; paint(); }
  };
}
function syncStage() {
  if (phase === 'play' || phase === 'review') syncGameStage(stageOptions());
  else closeGameStage();
}
function boardState(interactive) {
  const legal = selected ? game.moves({ square: selected, verbose: true }).map((move) => move.to) : [];
  return {
    orientation: orientationOf(puzzle),
    pieces: piecesOf(game),
    selected,
    legal: interactive ? legal : [],
    lastMove: null,
    checkSquare: kingSquare(game),
    interactive,
    palette: prefs.palette,
    pieceStyle: prefs.pieceStyle,
    pieceColor: prefs.pieceColor,
    pieceColors: pieceColors(prefs.pieceColor)
  };
}
function tracker() {
  const box = el('p', 'puzzle-streak');
  const streak = puzzle && puzzle.streak != null ? puzzle.streak : summary.streak;
  const best = puzzle && puzzle.best != null ? puzzle.best : summary.best;
  const rating = puzzle && puzzle.userRating != null ? puzzle.userRating : summary.userRating;
  box.textContent = account
    ? 'Puzzle rating ' + rating + '. Streak ' + streak + '. Best ' + best + '.'
    : 'Practice. Unrated. Sign in to keep a puzzle rating and streak.';
  return box;
}
function paint() {
  root.replaceChildren();
  if (notice) {
    const alert = el('p', 'community-error', notice);
    alert.setAttribute('role', 'alert');
    root.append(alert);
  }
  root.append(tracker());
  if (phase === 'home') {
    const start = el('button', 'tool', account ? 'Start puzzle' : 'Practice a puzzle');
    start.type = 'button';
    start.id = 'puzzle-start';
    start.addEventListener('click', () => { void begin(); });
    root.append(start);
    if (account) {
      const reset = el('button', 'tool', 'Reset attempted puzzles');
      reset.type = 'button';
      reset.id = 'puzzle-reset';
      reset.addEventListener('click', () => { void resetPool(); });
      root.append(reset);
    }
    syncStage();
    return;
  }
  const spec = el('p', 'puzzle-spec');
  spec.textContent = 'Puzzle ' + puzzle.puzzleId + ' · rating ' + puzzle.puzzleRating + (account ? '' : ' · practice');
  root.append(spec);
  const outcome = el('p', 'puzzle-outcome', resultLine(puzzle));
  outcome.id = 'puzzle-outcome';
  if (outcome.textContent) root.append(outcome);
  const board = el('div', 'board');
  board.id = 'puzzle-board';
  root.append(board);
  const interactive = phase === 'play' && puzzle.status === 'active' && !busy;
  mountBoard(board, onSquare).render(boardState(interactive));
  if (phase === 'play' && puzzle.status === 'active') {
    const hint = el('p', null, 'Find the move. A wrong move misses the puzzle. Leaving before that is abandoned.');
    root.append(hint);
  }
  if (puzzle.status === 'solved' || puzzle.status === 'failed') {
    const review = el('button', 'tool', 'Review');
    review.type = 'button';
    review.id = 'puzzle-review';
    review.addEventListener('click', () => { phase = 'review'; reviewAt = 0; paint(); });
    root.append(review);
  }
  if (puzzle.status !== 'active') {
    const again = el('button', 'tool', account ? 'Next puzzle' : 'Next practice puzzle');
    again.type = 'button';
    again.id = 'puzzle-next';
    again.addEventListener('click', () => { void begin(); });
    root.append(again);
  }
  if (phase === 'review') paintReview();
  syncStage();
}
function paintReview() {
  const solution = puzzle.solution || [];
  const sans = puzzle.solutionSans || [];
  const wrap = el('div', 'puzzle-review');
  const solved = el('div');
  solved.append(el('h2', null, 'Solution'));
  const line = el('ol', 'puzzle-line');
  sans.forEach((san, index) => {
    const item = el('li', index === reviewAt - 1 ? 'is-current' : '', san);
    line.append(item);
  });
  if (!sans.length) line.append(el('li', null, 'The solution is not available.'));
  solved.append(line);
  const yours = el('div');
  yours.append(el('h2', null, 'Your moves'));
  const played = el('ol', 'puzzle-line');
  (puzzle.played || []).forEach((move) => {
    played.append(el('li', null, move.uci + (move.correct ? '' : ' incorrect') + ' · ' + seconds(move.millis)));
  });
  if (!(puzzle.played || []).length) played.append(el('li', null, 'No move was played.'));
  yours.append(played);
  wrap.append(solved, yours);
  const controls = el('p', 'puzzle-review-controls');
  const back = el('button', 'tool', 'Previous');
  back.type = 'button';
  back.id = 'review-prev';
  const next = el('button', 'tool', 'Next');
  next.type = 'button';
  next.id = 'review-next';
  back.addEventListener('click', () => { reviewAt = Math.max(0, reviewAt - 1); showReviewStep(); });
  next.addEventListener('click', () => { reviewAt = Math.min(solution.length, reviewAt + 1); showReviewStep(); });
  controls.append(back, next);
  root.append(wrap, controls);
  showReviewStep();
}
function showReviewStep() {
  if (!puzzle || !puzzle.solution) return;
  game = replay(puzzle.setupFen, puzzle.solution.slice(0, reviewAt));
  const board = document.getElementById('puzzle-board');
  if (board) mountBoard(board, () => {}).render(boardState(false));
  root.querySelectorAll('.puzzle-line li').forEach((item, index) => {
    const solutionCount = (puzzle.solutionSans || []).length;
    if (index < solutionCount) item.classList.toggle('is-current', index === reviewAt - 1);
  });
}
function onSquare(square) {
  if (busy || !game || puzzle.status !== 'active') return;
  const moves = game.moves({ verbose: true });
  if (selected) {
    const choices = moves.filter((move) => move.from === selected && move.to === square);
    if (choices.length) {
      const promos = choices.filter((move) => move.promotion);
      if (promos.length) {
        askPromotion(promos);
        return;
      }
      void playUci(choices[0].from + choices[0].to);
      return;
    }
  }
  selected = moves.some((move) => move.from === square) ? square : null;
  const board = document.getElementById('puzzle-board');
  if (board) mountBoard(board, onSquare).render(boardState(true));
}
function askPromotion(choices) {
  const row = el('p', 'puzzle-promote');
  row.id = 'puzzle-promote';
  choices.forEach((move) => {
    const name = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[move.promotion] || move.promotion;
    const button = el('button', 'tool', name);
    button.type = 'button';
    button.addEventListener('click', () => { void playUci(move.from + move.to + move.promotion); });
    row.append(button);
  });
  const old = document.getElementById('puzzle-promote');
  if (old) old.remove();
  root.append(row);
}
async function playUci(uci) {
  if (account) {
    busy = true;
    paint();
    try {
      const body = await post('/api/puzzles/move', { attemptId: puzzle.attemptId, uci });
      applyServer(body);
      notice = '';
    } catch (err) {
      notice = err.message || 'The request could not be completed.';
    }
    busy = false;
    paint();
    return;
  }
  const expected = puzzle.line[puzzle.cursor];
  const millis = Date.now() - puzzle.movedAt;
  puzzle.played.push({ uci, correct: uci === expected, millis });
  if (uci !== expected) {
    puzzle.status = 'failed';
    puzzle.solution = puzzle.line;
    puzzle.solutionSans = replay(puzzle.setupFen, puzzle.line).history();
    puzzle.delta = 0;
    puzzle.gain = 0;
    puzzle.bonus = 0;
    notice = '';
    paint();
    return;
  }
  puzzle.applied = puzzle.line.slice(0, puzzle.cursor + 1);
  puzzle.cursor += 1;
  if (puzzle.cursor < puzzle.line.length) {
    puzzle.applied = puzzle.line.slice(0, puzzle.cursor + 1);
    puzzle.cursor += 1;
  }
  puzzle.movedAt = Date.now();
  if (puzzle.cursor >= puzzle.line.length) {
    puzzle.status = 'solved';
    puzzle.solution = puzzle.line;
    puzzle.solutionSans = replay(puzzle.setupFen, puzzle.line).history();
    puzzle.gain = 0;
    puzzle.bonus = 0;
    puzzle.delta = 0;
  }
  loadPosition(puzzle);
  notice = '';
  paint();
}
function applyServer(body) {
  const attempt = body.attempt || body;
  if (body.exhausted) {
    phase = 'home';
    puzzle = null;
    notice = 'Every puzzle in this range has been attempted. Reset the pool to play them again.';
    summary.streak = body.streak || 0;
    summary.best = body.best || 0;
    summary.userRating = body.userRating || 0;
    return;
  }
  if (!attempt || !attempt.setupFen) return;
  summary.streak = attempt.streak != null ? attempt.streak : summary.streak;
  summary.best = attempt.best != null ? attempt.best : summary.best;
  summary.userRating = attempt.userRating != null ? attempt.userRating : summary.userRating;
  loadPosition(attempt);
  phase = attempt.status === 'active' ? 'play' : 'play';
}
async function begin() {
  notice = '';
  if (!account) return beginPractice();
  busy = true;
  paint();
  try {
    const body = await post('/api/puzzles/next', {});
    applyServer(body);
  } catch (err) {
    notice = err.message || 'The request could not be completed.';
    phase = 'home';
  }
  busy = false;
  paint();
}
function beginPractice() {
  if (!practice.length) {
    notice = 'Practice puzzles could not be loaded.';
    paint();
    return;
  }
  const row = practice[practiceCursor % practice.length];
  practiceCursor += 1;
  const attempt = {
    attemptId: null,
    puzzleId: row.id,
    puzzleRating: row.rating,
    themes: row.themes || [],
    setupFen: row.fen,
    applied: [row.moves[0]],
    status: 'active',
    played: [],
    line: row.moves,
    cursor: 1,
    movedAt: Date.now(),
    solution: null,
    userRating: 0,
    streak: 0,
    best: 0
  };
  loadPosition(attempt);
  phase = 'play';
  paint();
}
async function leave() {
  if (account && puzzle && puzzle.attemptId && puzzle.status === 'active') {
    try {
      const body = await post('/api/puzzles/abandon', { attemptId: puzzle.attemptId });
      applyServer(body);
      notice = resultLine(puzzle);
    } catch (err) {
      notice = err.message || 'The request could not be completed.';
    }
  }
  phase = 'home';
  puzzle = null;
  game = null;
  paint();
}
async function resetPool() {
  try {
    const body = await post('/api/puzzles/reset', {});
    summary.streak = body.streak || summary.streak;
    summary.best = body.best || summary.best;
    summary.userRating = body.userRating || summary.userRating;
    notice = 'Attempted puzzles in this range can be played again. Your history stays.';
  } catch (err) {
    notice = err.message || 'The request could not be completed.';
  }
  paint();
}
function readOrder() {
  const order = document.getElementById('puzzle-order');
  const min = document.getElementById('puzzle-min');
  const max = document.getElementById('puzzle-max');
  const tier = document.getElementById('puzzle-tier');
  return {
    puzzleOrder: order ? order.value : 'weakest',
    puzzleMin: min && min.value !== '' ? Number(min.value) : null,
    puzzleMax: max && max.value !== '' ? Number(max.value) : null,
    puzzleTier: tier && tier.value !== '' ? Number(tier.value) : null
  };
}
function fillOrder(settings) {
  const order = document.getElementById('puzzle-order');
  const min = document.getElementById('puzzle-min');
  const max = document.getElementById('puzzle-max');
  const tier = document.getElementById('puzzle-tier');
  if (order && settings.puzzleOrder) order.value = settings.puzzleOrder;
  if (min) min.value = settings.puzzleMin == null ? '' : String(settings.puzzleMin);
  if (max) max.value = settings.puzzleMax == null ? '' : String(settings.puzzleMax);
  if (tier) tier.value = settings.puzzleTier == null ? '' : String(settings.puzzleTier);
}
async function saveOrder() {
  try {
    const saved = await post('/api/settings', readOrder());
    fillOrder(saved);
    summary.streak = saved.puzzleStreak || 0;
    summary.best = saved.puzzleBest || 0;
    summary.userRating = saved.puzzleRating || 0;
    notice = 'Puzzle order saved.';
  } catch (err) {
    notice = err.message || 'The request could not be completed.';
  }
  paint();
}
async function boot() {
  const save = document.getElementById('puzzle-save-order');
  if (save) save.addEventListener('click', () => { void saveOrder(); });
  try {
    const session = await gateway.profile();
    account = session ? { profile: session } : null;
  } catch (err) {
    account = null;
  }
  try {
    const pack = await fetch('/puzzles/practice.json', { cache: 'no-store' });
    practice = pack.ok ? await pack.json() : [];
  } catch (err) {
    practice = [];
  }
  if (account) {
    try {
      const settings = await post('/api/settings', {});
      fillOrder(settings);
      summary.streak = settings.puzzleStreak || 0;
      summary.best = settings.puzzleBest || 0;
      summary.userRating = settings.puzzleRating || 0;
      const current = await fetch('/api/puzzles/current', { credentials: 'same-origin', cache: 'no-store' });
      const body = await current.json();
      if (current.ok && body.attempt) {
        applyServer(body);
      } else if (current.ok) {
        summary.streak = body.streak || summary.streak;
        summary.best = body.best || summary.best;
        summary.userRating = body.userRating || summary.userRating;
      }
    } catch (err) {
      notice = err.message || '';
    }
  }
  paint();
  window.addEventListener('pagehide', () => {
    if (!account || !puzzle || puzzle.status !== 'active' || !puzzle.attemptId) return;
    fetch('/api/puzzles/abandon', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() },
      body: JSON.stringify({ attemptId: puzzle.attemptId })
    });
  });
}
boot();

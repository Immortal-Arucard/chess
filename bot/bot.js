import { Chess } from '/assets/vendor/chess.js/chess.js';
import { mountBoard } from '/assets/chess/board.js';
import { createEngine } from '/assets/chess/engine.js';
import { applyUci, kingSquare, legalTargets, outcome, pieceMap, pgnFor, promotionMoves } from '/assets/chess/rules.js';

const ENGINE_URL = '/assets/vendor/stockfish/stockfish-19-lite-single.js';
const SITE = 'https://chess.theworldgovernmentincorporated.com/bot/';

const statusEl = document.getElementById('status');
const engineEl = document.getElementById('engine-status');
const movesEl = document.getElementById('moves');
const pgnEl = document.getElementById('pgn');
const promotionEl = document.getElementById('promotion');
const boardApi = mountBoard(document.getElementById('board'), onSquare);

const engine = createEngine(ENGINE_URL);
let chess = new Chess();
let player = 'w';
let movetime = 500;
let selected = null;
let pendingPromotion = null;
let manualResult = null;
let lastMove = null;
let engineReady = false;
let notice = '';

const params = new URLSearchParams(location.search);
const reviewFen = params.get('review') === '1' ? params.get('fen') : '';
if (params.get('play') === 'b' || params.get('play') === 'w') player = params.get('play');

function today() {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return now.getUTCFullYear() + '.' + month + '.' + day;
}

function names() {
  const bot = 'Stockfish 19 lite';
  return player === 'w'
    ? { white: 'Player', black: bot }
    : { white: bot, black: 'Player' };
}

function resultCode(state) {
  if (manualResult) return manualResult;
  if (!state.over) return '*';
  if (state.kind === 'checkmate') return state.winner === 'white' ? '1-0' : '0-1';
  return '1/2-1/2';
}

function render() {
  const state = outcome(chess);
  const interactive = engineReady && !state.over && !manualResult && chess.turn() === player && !engineEl.dataset.thinking;
  const legal = selected ? legalTargets(chess, selected) : [];
  boardApi.render({
    orientation: player,
    pieces: pieceMap(chess),
    selected,
    legal: interactive ? legal : [],
    checkSquare: state.check ? kingSquare(chess, chess.turn()) : null,
    lastMove,
    interactive
  });
  let text = manualResult
    ? (manualResult === '1-0' ? 'White wins by resignation.' : 'Black wins by resignation.')
    : state.text;
  if (!manualResult && !state.over && chess.turn() !== player && engineReady) text = 'Bot is thinking.';
  if (!engineReady && !engineEl.dataset.failed) text = 'Waiting for the engine.';
  statusEl.textContent = notice || text;
  const history = chess.history();
  movesEl.replaceChildren();
  for (let i = 0; i < history.length; i += 2) {
    const item = document.createElement('li');
    item.textContent = history[i] + (history[i + 1] ? ' ' + history[i + 1] : '');
    movesEl.append(item);
  }
  const who = names();
  pgnEl.value = pgnFor(chess, {
    event: 'Bot chess',
    site: SITE,
    date: today(),
    white: who.white,
    black: who.black,
    result: resultCode(state)
  });
  document.getElementById('play-white').setAttribute('aria-pressed', player === 'w' ? 'true' : 'false');
  document.getElementById('play-black').setAttribute('aria-pressed', player === 'b' ? 'true' : 'false');
  document.getElementById('resign').disabled = state.over || !!manualResult || chess.history().length === 0;
}

function showPromotion(from, to) {
  pendingPromotion = { from, to };
  promotionEl.hidden = false;
  const first = promotionEl.querySelector('button');
  if (first) first.focus();
}

function hidePromotion() {
  pendingPromotion = null;
  promotionEl.hidden = true;
}

function finishHumanMove(played) {
  selected = null;
  lastMove = { from: played.from, to: played.to };
  hidePromotion();
  const state = outcome(chess);
  render();
  if (!state.over) requestBot();
}

function tryMove(from, to, promotion) {
  const choices = promotionMoves(chess, from, to);
  if (choices.length && !promotion) {
    showPromotion(from, to);
    return;
  }
  let played = null;
  try {
    played = chess.move({ from, to, promotion });
  } catch (err) {
    played = null;
  }
  if (!played) {
    notice = 'That move is not legal.';
    render();
    return;
  }
  notice = '';
  finishHumanMove(played);
}

function onSquare(square) {
  const state = outcome(chess);
  if (!engineReady || state.over || manualResult || chess.turn() !== player || engineEl.dataset.thinking) return;
  const piece = chess.get(square);
  if (selected && legalTargets(chess, selected).includes(square)) {
    tryMove(selected, square);
    return;
  }
  if (piece && piece.color === player) {
    selected = square;
    hidePromotion();
    render();
    return;
  }
  selected = null;
  hidePromotion();
  render();
}

function requestBot() {
  const state = outcome(chess);
  if (manualResult || state.over || chess.turn() === player) return;
  if (!engine.ready) return;
  engineEl.dataset.thinking = 'true';
  render();
  const started = engine.search(chess.fen(), movetime);
  if (!started) {
    delete engineEl.dataset.thinking;
    render();
  }
}

function newGame() {
  engine.cancel();
  delete engineEl.dataset.thinking;
  hidePromotion();
  selected = null;
  lastMove = null;
  manualResult = null;
  notice = '';
  chess = new Chess();
  if (reviewFen) {
    try {
      chess.load(reviewFen);
    } catch (err) {
      chess = new Chess();
      notice = 'That position could not be loaded. A new game was started.';
    }
  }
  render();
  if (engineReady) requestBot();
}

engine.on((type, detail) => {
  if (type === 'progress') {
    engineEl.textContent = 'Loading the engine… ' + Math.round(detail.percent * 100) + '%';
    return;
  }
  if (type === 'ready') {
    engineReady = true;
    engineEl.textContent = 'Engine ready. Stockfish 19 lite, searching for up to ' + (movetime / 1000) + ' seconds. This is not a rated game.';
    render();
    requestBot();
    return;
  }
  if (type === 'error') {
    engineReady = false;
    engineEl.dataset.failed = 'true';
    delete engineEl.dataset.thinking;
    engineEl.textContent = detail.message;
    render();
    return;
  }
  if (type === 'thinking') return;
  if (type !== 'move') return;
  delete engineEl.dataset.thinking;
  if (detail.fen !== chess.fen() || manualResult || outcome(chess).over) {
    render();
    return;
  }
  const played = applyUci(chess, detail.uci);
  if (!played) {
    notice = 'The engine returned a move that is not legal here. No bot move was played. Use New game to continue.';
    render();
    return;
  }
  notice = '';
  lastMove = { from: played.from, to: played.to };
  selected = null;
  render();
});

document.getElementById('play-white').addEventListener('click', () => {
  if (player === 'w' && !reviewFen) return;
  player = 'w';
  newGame();
});
document.getElementById('play-black').addEventListener('click', () => {
  if (player === 'b' && !reviewFen) return;
  player = 'b';
  newGame();
});
document.querySelectorAll('[data-ms]').forEach((button) => {
  button.addEventListener('click', () => {
    movetime = Number(button.getAttribute('data-ms'));
    document.querySelectorAll('[data-ms]').forEach((item) => {
      item.setAttribute('aria-pressed', item === button ? 'true' : 'false');
    });
    if (engineReady && !engineEl.dataset.failed) {
      engineEl.textContent = 'Engine ready. Stockfish 19 lite, searching for up to ' + (movetime / 1000) + ' seconds. This is not a rated game.';
    }
  });
});
document.getElementById('new-game').addEventListener('click', () => newGame());
document.getElementById('resign').addEventListener('click', () => {
  if (outcome(chess).over || manualResult) return;
  engine.cancel();
  delete engineEl.dataset.thinking;
  manualResult = player === 'w' ? '0-1' : '1-0';
  selected = null;
  hidePromotion();
  render();
});
document.getElementById('download-pgn').addEventListener('click', () => {
  const blob = new Blob([pgnEl.value], { type: 'application/x-chess-pgn' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'bot-chess.pgn';
  link.click();
  URL.revokeObjectURL(url);
});
promotionEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-piece]');
  if (!button || !pendingPromotion) return;
  const choice = pendingPromotion;
  tryMove(choice.from, choice.to, button.getAttribute('data-piece'));
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && pendingPromotion) {
    hidePromotion();
    render();
  }
});

if (reviewFen) {
  try {
    chess.load(reviewFen);
  } catch (err) {
    chess = new Chess();
    notice = 'That position could not be loaded. A new game was started.';
  }
}
render();
engine.start();

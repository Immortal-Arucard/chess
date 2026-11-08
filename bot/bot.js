import { Chess } from '/assets/vendor/chess.js/chess.js';
import { mountBoard } from '/assets/chess/board.js';
import { ELO_CHOICES, PALETTES, PIECE_COLORS, PIECE_STYLES, SEARCH_MS, loadPrefs, pieceColors, savePrefs, strengthNote } from '/assets/chess/bot-prefs.js';
import {
  applySave,
  buildGameRecord,
  createResultBook,
  loadAutoSavePreference,
  readDeviceRecovery,
  rememberDeviceRecovery
} from '/assets/chess/bot-results.js';
import { createEngine } from '/assets/chess/engine.js';
import { applyUci, kingSquare, legalTargets, outcome, pieceMap, pgnFor, promotionMoves } from '/assets/chess/rules.js';

const ENGINE_URL = '/assets/vendor/stockfish/stockfish-19-lite-single.js';
const SITE = 'https://chess.theworldgovernmentincorporated.com/bot/';

const statusEl = document.getElementById('status');
const engineEl = document.getElementById('engine-status');
const movesEl = document.getElementById('moves');
const pgnEl = document.getElementById('pgn');
const promotionEl = document.getElementById('promotion');
const windowEl = document.getElementById('game-window');
const endPanel = document.getElementById('end-panel');
const saveStatus = document.getElementById('save-status');
const saveDetail = document.getElementById('save-detail');
const setupStatus = document.getElementById('setup-status');
const leavePrompt = document.getElementById('leave-prompt');
const autoBox = document.getElementById('autosave-bot');
const autoNote = document.getElementById('autosave-note');
const boardEl = document.getElementById('board');
const boardApi = mountBoard(boardEl, onSquare);

const engine = createEngine(ENGINE_URL);
const book = createResultBook();
let chess = new Chess();
let player = 'w';
let prefs = loadPrefs(localStorage);
let selected = null;
let pendingPromotion = null;
let manualResult = null;
let lastMove = null;
let engineReady = false;
let notice = '';
let phase = 'setup';
let clientGameId = crypto.randomUUID();
let discardedIds = [];
let startFen = chess.fen();
let pending = null;
let leaveAction = '';

const params = new URLSearchParams(location.search);
const reviewFen = params.get('review') === '1' ? params.get('fen') : '';
if (params.get('play') === 'b' || params.get('play') === 'w') player = params.get('play');

let accountState = { available: false, reachable: false, id: null, autoSave: false };
function currentAccount() {
  return accountState;
}

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

function freshChess() {
  const game = new Chess();
  if (reviewFen) {
    try {
      game.load(reviewFen);
    } catch (err) {
      notice = 'That position could not be loaded.';
    }
  }
  return game;
}

function placeBoard(inGame) {
  document.getElementById(inGame ? 'board-mount' : 'board-preview').append(boardEl);
}

function unsavedFinished() {
  return phase === 'ended' && pending && pending.status !== 'saved';
}

function syncAccountSettings() {
  if (!accountState.reachable || !accountState.id) {
    autoBox.checked = false;
    autoBox.disabled = true;
    autoNote.textContent = accountState.reachable
      ? 'Sign in and join Chess to store automatic saving on the account. It stays off until then.'
      : 'Chess accounts are not reachable from this page, so automatic saving stays off.';
    return;
  }
  autoBox.disabled = false;
  autoBox.checked = accountState.autoSave === true;
  autoNote.textContent = accountState.autoSave
    ? 'Finished bot games are saved to this Chess account, including every move.'
    : 'Automatic saving is off for this Chess account. Use Save to account after a game.';
}

async function refreshAccount() {
  try {
    const response = await fetch('/api/session', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('unavailable');
    const body = await response.json();
    accountState = {
      available: !!(body.profile && body.profile.id),
      reachable: true,
      id: body.profile ? body.profile.id : null,
      autoSave: false
    };
    if (accountState.id) {
      const settings = await fetch('/api/settings', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() },
        body: '{}'
      });
      if (settings.ok) {
        const prefs = await settings.json();
        accountState.autoSave = prefs.autoSaveBotResults === true;
      }
    }
  } catch (err) {
    accountState = { available: false, reachable: false, id: null, autoSave: false };
  }
  syncAccountSettings();
  void loadSavedGames();
}

function render() {
  const state = outcome(chess);
  if (phase === 'playing' && (state.over || manualResult)) {
    enterEnded();
    return;
  }
  const interactive = phase === 'playing' && engineReady && !state.over && !manualResult && chess.turn() === player && !engineEl.dataset.thinking;
  const legal = selected ? legalTargets(chess, selected) : [];
  boardApi.render({
    orientation: player,
    pieces: pieceMap(chess),
    selected,
    legal: interactive ? legal : [],
    palette: prefs.palette,
    pieceStyle: prefs.pieceStyle,
    pieceColor: prefs.pieceColor,
    pieceColors: pieceColors(prefs.pieceColor),
    checkSquare: state.check ? kingSquare(chess, chess.turn()) : null,
    lastMove,
    interactive
  });
  let text = manualResult
    ? (manualResult === '1-0' ? 'White wins by resignation.' : 'Black wins by resignation.')
    : state.text;
  if (phase === 'setup') text = 'Press Start game to play. No moves are made until then.';
  else if (!manualResult && !state.over && chess.turn() !== player && engineReady && phase === 'playing') text = 'Bot is thinking.';
  else if (!engineReady && !engineEl.dataset.failed && phase !== 'setup') text = 'Waiting for the engine.';
  statusEl.textContent = notice || text;
  const history = chess.history();
  movesEl.replaceChildren();
  for (let i = 0; i < history.length; i += 2) {
    const item = document.createElement('li');
    item.textContent = history[i] + (history[i + 1] ? ' ' + history[i + 1] : '');
    movesEl.append(item);
  }
  const who = names();
  const livePgn = pgnFor(chess, {
    event: 'Bot chess',
    site: SITE,
    date: today(),
    white: who.white,
    black: who.black,
    result: resultCode(state)
  });
  pgnEl.value = pending && pending.record ? pending.record.pgn : livePgn;
  document.getElementById('play-white').setAttribute('aria-pressed', player === 'w' ? 'true' : 'false');
  document.getElementById('play-black').setAttribute('aria-pressed', player === 'b' ? 'true' : 'false');
  document.getElementById('resign').disabled = phase !== 'playing';
  document.body.dataset.phase = phase;
  windowEl.hidden = phase === 'setup';
  document.body.classList.toggle('game-open', phase !== 'setup');
  endPanel.hidden = phase !== 'ended';
  if (phase === 'ended' && pending) {
    const count = pending.record ? pending.record.moves.length : history.length;
    const saved = pending.status === 'saved';
    saveStatus.dataset.state = saved ? 'saved' : 'unsaved';
    saveStatus.textContent = saved
      ? 'Saved to your Chess account.'
      : 'Not saved to an account. ' + count + (count === 1 ? ' move is' : ' moves are') + ' still in this record.';
    saveDetail.textContent = pending.error || notice || '';
  } else {
    saveStatus.dataset.state = '';
    saveStatus.textContent = '';
    saveDetail.textContent = '';
  }
  const summary = names();
  document.getElementById('game-summary').textContent = summary.white + ' vs ' + summary.black + '. Bot limit ' + prefs.elo + ', an uncalibrated engine target.';
  setupStatus.textContent = notice && phase === 'setup'
    ? notice
    : 'Choose a color, bot limit, and appearance, then start the game. Pieces stay where they are until you start.';
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

function rememberDevice() {
  if (phase === 'setup') return;
  try {
    rememberDeviceRecovery(localStorage, {
      phase,
      startFen,
      sans: chess.history(),
      player,
      manualResult,
      clientGameId,
      record: pending && pending.record,
      discardedIds,
      savedStatus: pending && pending.status,
      accountId: accountState.id
    });
  } catch (err) { /* the browser blocked storage */ }
}

function csrfToken() {
  const match = document.cookie.match(/(?:^|; )chess_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function gamePayload(record) {
  return {
    clientGameId: record.id,
    pgn: record.pgn,
    startFen: record.startFen,
    moves: record.moves,
    result: record.result,
    termination: record.termination,
    playerColor: record.playerColor,
    opponentName: record.opponentName,
    opponentUciElo: record.opponentUciElo,
    rated: false,
    pieceStyle: prefs.pieceStyle,
    pieceColor: prefs.pieceColor,
    palette: prefs.palette
  };
}

let saveChain = Promise.resolve();
async function tryAccountSave(kind) {
  if (!pending || !pending.record) return;
  const operation = {
    kind,
    clientGameId: pending.record.id,
    record: pending.record,
    accountId: accountState.id
  };
  const run = saveChain.then(() => performAccountSave(operation));
  saveChain = run.catch(() => {});
  return run;
}

async function performAccountSave(operation) {
  if (!operation.record || discardedIds.includes(operation.clientGameId)) return;
  if (operation.accountId && accountState.id && operation.accountId !== accountState.id) {
    if (pending && pending.record && pending.record.id === operation.clientGameId) {
      pending.status = 'unsaved';
      pending.error = 'This game was started for a different Chess account, so it was not saved there.';
      rememberDevice();
      render();
    }
    return;
  }
  const before = operation.record.pgn;
  try {
    const sessionResponse = await fetch('/api/session', { credentials: 'same-origin' });
    if (!sessionResponse.ok) throw new Error('unavailable');
    const session = await sessionResponse.json();
    if (!session.profile) {
      pending.status = 'unsaved';
      pending.error = 'Join Chess before saving a game to an account. The copy on this device is not an account save.';
      rememberDevice();
      render();
      return;
    }
    const headers = { 'content-type': 'application/json', 'x-csrf-token': csrfToken() };
    if (operation.kind === 'auto') {
      const settingsResponse = await fetch('/api/settings', { method: 'POST', credentials: 'same-origin', headers, body: '{}' });
      if (!settingsResponse.ok) throw new Error('settings');
      const settings = await settingsResponse.json();
      if (settings.autoSaveBotResults !== true) {
        pending.status = 'unsaved';
        pending.error = 'Automatic saving is off for this Chess account. This game is not saved.';
        rememberDevice();
        render();
        return;
      }
    }
    const response = await fetch('/api/games', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify(gamePayload(operation.record))
    });
    const body = await response.json();
    if (!pending || !pending.record || pending.record.id !== operation.clientGameId || pending.record.pgn !== before) return;
    if (discardedIds.includes(operation.clientGameId)) return;
    if (response.ok && body.status === 'saved') {
      pending.status = 'saved';
      pending.accountId = operation.accountId;
      pending.error = '';
    } else {
      pending.status = 'unsaved';
      pending.error = body.error || 'The account did not save this game. It is still unsaved.';
    }
  } catch (err) {
    const decision = applySave(operation.kind, currentAccount(), loadAutoSavePreference(currentAccount()), operation.record, book);
    if (pending && pending.record && pending.record.id === operation.clientGameId) {
      pending.status = 'unsaved';
      pending.error = decision.error;
    }
  }
  rememberDevice();
  render();
}

function enterEnded() {
  if (phase === 'ended') return;
  phase = 'ended';
  hidePromotion();
  selected = null;
  const state = outcome(chess);
  const who = names();
  let record = null;
  let error = '';
  try {
    record = buildGameRecord({
      id: clientGameId,
      startFen,
      sans: chess.history(),
      result: resultCode(state),
      termination: manualResult ? 'resign' : state.kind,
      playerColor: player === 'w' ? 'white' : 'black',
      opponentName: 'Stockfish 19 Lite',
      opponentUciElo: prefs.elo,
      white: who.white,
      black: who.black,
      event: 'Bot chess',
      site: SITE,
      date: today(),
      boundAccountId: currentAccount().id
    });
  } catch (err) {
    error = 'The full game record could not be built, so it was not saved.';
  }
  pending = { record, status: 'unsaved', error, accountId: null };
  notice = '';
  rememberDevice();
  render();
  if (record) void tryAccountSave('auto');
}

function finishHumanMove(played) {
  selected = null;
  lastMove = { from: played.from, to: played.to };
  hidePromotion();
  notice = '';
  render();
  rememberDevice();
  if (phase === 'playing') requestBot();
}

function tryMove(from, to, promotion) {
  if (phase !== 'playing') return;
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
  finishHumanMove(played);
}

function onSquare(square) {
  if (phase !== 'playing') return;
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
  if (phase !== 'playing') return;
  const state = outcome(chess);
  if (manualResult || state.over || chess.turn() === player) return;
  if (!engine.ready) return;
  engineEl.dataset.thinking = 'true';
  render();
  const started = engine.search(chess.fen(), SEARCH_MS, prefs.elo);
  if (!started) {
    delete engineEl.dataset.thinking;
    render();
  }
}

function returnToSetup() {
  engine.cancel();
  delete engineEl.dataset.thinking;
  hidePromotion();
  leavePrompt.hidden = true;
  leaveAction = '';
  selected = null;
  lastMove = null;
  manualResult = null;
  pending = null;
  phase = 'setup';
  chess = freshChess();
  startFen = chess.fen();
  placeBoard(false);
  render();
  const start = document.getElementById('start-game');
  if (start) start.focus();
}

function startGame() {
  if (unsavedFinished()) {
    notice = 'This finished game is still unsaved. Discard it, or keep it open, before starting another. Account saving is not available.';
    render();
    return;
  }
  if (phase === 'playing') return;
  engine.cancel();
  delete engineEl.dataset.thinking;
  hidePromotion();
  selected = null;
  lastMove = null;
  manualResult = null;
  pending = null;
  notice = '';
  chess = freshChess();
  startFen = chess.fen();
  clientGameId = crypto.randomUUID();
  phase = 'playing';
  placeBoard(true);
  if (engineReady) engine.setElo(prefs.elo);
  windowEl.hidden = false;
  windowEl.focus();
  render();
  requestBot();
}

function askLeave(action) {
  if (unsavedFinished()) {
    notice = 'This finished game is still unsaved. Save is not available yet. Discard it or download the PGN before leaving. Leaving is blocked so the moves are not dropped.';
    render();
    return;
  }
  if (phase !== 'playing') return;
  leaveAction = action;
  leavePrompt.hidden = false;
  document.getElementById('leave-cancel').focus();
}

engine.on((type, detail) => {
  if (type === 'progress') {
    engineEl.textContent = 'Loading the engine… ' + Math.round(detail.percent * 100) + '%';
    return;
  }
  if (type === 'ready') {
    engineReady = true;
    engine.setElo(prefs.elo);
    engineEl.textContent = 'Engine ready. ' + strengthNote(prefs.elo);
    render();
    if (phase === 'playing') requestBot();
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
  if (phase !== 'playing' || detail.fen !== chess.fen() || manualResult || outcome(chess).over) {
    render();
    return;
  }
  const played = applyUci(chess, detail.uci);
  if (!played) {
    notice = 'The engine returned a move that is not legal here. No bot move was played.';
    render();
    return;
  }
  notice = '';
  lastMove = { from: played.from, to: played.to };
  selected = null;
  render();
  rememberDevice();
});

document.getElementById('play-white').addEventListener('click', () => {
  if (phase !== 'setup') return;
  player = 'w';
  render();
});
document.getElementById('play-black').addEventListener('click', () => {
  if (phase !== 'setup') return;
  player = 'b';
  render();
});

function choiceButtons(container, items, selectedId, onPick) {
  items.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tool';
    button.textContent = item.label;
    button.setAttribute('aria-pressed', item.id === selectedId ? 'true' : 'false');
    button.addEventListener('click', () => {
      if (phase !== 'setup') return;
      onPick(item.id);
      [...container.querySelectorAll('button')].forEach((other) => {
        other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
      });
    });
    container.append(button);
  });
}

choiceButtons(document.getElementById('elo-choices'), ELO_CHOICES.map((elo) => ({ id: String(elo), label: String(elo) })), String(prefs.elo), (id) => {
  prefs = savePrefs(localStorage, Object.assign({}, prefs, { elo: Number(id) }));
  engine.setElo(prefs.elo);
  if (engineReady && !engineEl.dataset.failed) engineEl.textContent = 'Engine ready. ' + strengthNote(prefs.elo);
  render();
});
choiceButtons(document.getElementById('palette-choices'), PALETTES, prefs.palette, (id) => {
  prefs = savePrefs(localStorage, Object.assign({}, prefs, { palette: id }));
  render();
});
choiceButtons(document.getElementById('piece-style-choices'), PIECE_STYLES, prefs.pieceStyle, (id) => {
  prefs = savePrefs(localStorage, Object.assign({}, prefs, { pieceStyle: id }));
  render();
});
choiceButtons(document.getElementById('piece-color-choices'), PIECE_COLORS, prefs.pieceColor, (id) => {
  prefs = savePrefs(localStorage, Object.assign({}, prefs, { pieceColor: id }));
  render();
});

document.getElementById('start-game').addEventListener('click', startGame);
document.getElementById('new-game').addEventListener('click', () => askLeave('new'));
document.getElementById('exit-game').addEventListener('click', () => askLeave('exit'));
document.getElementById('leave-cancel').addEventListener('click', () => {
  leavePrompt.hidden = true;
  leaveAction = '';
});
document.getElementById('leave-confirm').addEventListener('click', () => {
  returnToSetup();
});
document.getElementById('resign').addEventListener('click', () => {
  if (phase !== 'playing' || outcome(chess).over || manualResult) return;
  engine.cancel();
  delete engineEl.dataset.thinking;
  manualResult = player === 'w' ? '0-1' : '1-0';
  selected = null;
  hidePromotion();
  render();
});
document.getElementById('save-account').addEventListener('click', () => {
  if (!pending || !pending.record) return;
  void tryAccountSave('manual');
});
document.getElementById('discard-result').addEventListener('click', () => {
  if (pending && pending.record) {
    book.noteDiscard(pending.record.id);
    discardedIds.push(pending.record.id);
    try {
      rememberDeviceRecovery(localStorage, {
        phase: 'setup',
        startFen,
        sans: [],
        player,
        clientGameId: pending.record.id,
        record: null,
        discardedIds
      });
    } catch (err) { /* the browser blocked storage */ }
  }
  notice = 'The unsaved game was discarded. Games already stored in an account are not deleted.';
  returnToSetup();
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
autoBox.addEventListener('change', syncAccountSettings);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && pendingPromotion) {
    hidePromotion();
    render();
    return;
  }
  if (event.key === 'Escape' && phase !== 'setup') {
    askLeave('exit');
    return;
  }
  if (event.key !== 'Tab' || windowEl.hidden) return;
  const nodes = [...windowEl.querySelectorAll('button, textarea, a, input')].filter((el) => !el.disabled && !el.closest('[hidden]'));
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

chess = freshChess();
startFen = chess.fen();
placeBoard(false);
const recovered = readDeviceRecovery(localStorage);
if (recovered && recovered.sans && recovered.sans.length) {
  try {
    discardedIds = recovered.discardedIds || [];
    clientGameId = recovered.clientGameId || clientGameId;
    player = recovered.player || player;
    chess = new Chess();
    if (recovered.startFen) chess.load(recovered.startFen);
    recovered.sans.forEach((san) => chess.move(san));
    startFen = recovered.startFen || startFen;
    manualResult = recovered.manualResult;
    if (recovered.phase === 'playing' && !outcome(chess).over && !manualResult) {
      phase = 'playing';
      placeBoard(true);
    } else if (recovered.record) {
      phase = 'ended';
      pending = {
        record: recovered.record,
        status: recovered.savedStatus === 'saved' && recovered.accountId ? 'saved' : 'unsaved',
        error: recovered.savedStatus === 'saved' ? '' : recovered.note,
        accountId: recovered.accountId || null
      };
      placeBoard(true);
    }
  } catch (err) {
    chess = freshChess();
    phase = 'setup';
    placeBoard(false);
  }
}
syncAccountSettings();
render();
async function loadSavedGames() {
  const list = document.getElementById('saved-games-list');
  const note = document.getElementById('saved-games-note');
  if (!list || !note) return;
  list.replaceChildren();
  if (!accountState.id) {
    note.textContent = 'Saved games appear here after you join Chess and save a finished game.';
    return;
  }
  const response = await fetch('/api/games/list', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() },
    body: '{}'
  });
  if (!response.ok) return;
  const body = await response.json();
  const games = body.games || [];
  note.textContent = games.length ? 'These games are stored on your Chess account.' : 'No games are saved on this Chess account yet.';
  games.forEach((game) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tool';
    button.textContent = 'Replay ' + game.result;
    button.addEventListener('click', () => {
      const replay = new Chess();
      replay.loadPgn(game.pgn);
      chess = replay;
      phase = 'ended';
      pending = {
        record: {
          id: game.clientGameId,
          pgn: game.pgn,
          startFen: game.startFen,
          moves: game.moves,
          result: game.result,
          termination: game.termination,
          playerColor: game.playerColor
        },
        status: 'saved',
        accountId: accountState.id,
        error: ''
      };
      placeBoard(true);
      render();
    });
    item.append(button);
    list.append(item);
  });
}

void refreshAccount();
engine.start();
autoBox.addEventListener('change', () => {
  if (!accountState.id) {
    syncAccountSettings();
    return;
  }
  const enabled = autoBox.checked === true;
  void fetch('/api/settings', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() },
    body: JSON.stringify({ autoSaveBotResults: enabled })
  }).then((response) => response.json()).then((body) => {
    if (body && body.autoSaveBotResults === enabled) accountState.autoSave = enabled;
    syncAccountSettings();
  }).catch(() => syncAccountSettings());
});

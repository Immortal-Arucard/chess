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
import { closeGameStage, requestGameExit, syncGameStage } from '/assets/chess/game-stage.js';
import { rememberAnalysis } from '/assets/chess/analysis-model.js';

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
const playWhite = document.getElementById('play-white');
const playBlack = document.getElementById('play-black');
const replayRoot = document.getElementById('replay-board');
const replayPanel = document.getElementById('replay-panel');
const replayStatus = document.getElementById('replay-status');
const savedList = document.getElementById('saved-games-list');
const savedNote = document.getElementById('saved-games-note');
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
let ownerAtStart = null;
let gameSettings = null;
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
  if (playWhite) playWhite.setAttribute('aria-pressed', player === 'w' ? 'true' : 'false');
  if (playBlack) playBlack.setAttribute('aria-pressed', player === 'b' ? 'true' : 'false');
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
  if (phase === 'setup') closeGameStage();
  else syncGameStage({
    label: phase === 'playing' ? 'Leave game' : 'Exit',
    confirm: phase === 'playing' ? 'Leave this unfinished game? There is no finished result to save.' : '',
    yesLabel: 'Leave game',
    onConfirm: () => {
      if (unsavedFinished()) {
        notice = 'This finished game is still unsaved. Save it to the Chess account or discard it before leaving. Leaving is blocked so the moves are not dropped.';
        render();
        return;
      }
      returnToSetup();
    }
  });
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
      accountId: accountState.id,
      ownerAtStart,
      prefs: { elo: prefs.elo, palette: prefs.palette, pieceStyle: prefs.pieceStyle, pieceColor: prefs.pieceColor }
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
    expectedProfileId: record.boundAccountId,
    pgn: record.pgn,
    startFen: record.startFen,
    moves: record.moves,
    result: record.result,
    termination: record.termination,
    playerColor: record.playerColor,
    opponentName: record.opponentName,
    opponentUciElo: record.opponentUciElo,
    rated: false,
    pieceStyle: record.pieceStyle,
    pieceColor: record.pieceColor,
    palette: record.palette
  };
}

function samePending(operation) {
  return !!(pending && pending.record && pending.record.id === operation.clientGameId && pending.record.boundAccountId === operation.record.boundAccountId);
}

let saveChain = Promise.resolve();
async function tryAccountSave(kind) {
  if (!pending || !pending.record) return;
  const operation = {
    kind,
    clientGameId: pending.record.id,
    record: pending.record,
    accountId: accountState.id,
    ownerAtStart: pending.record.boundAccountId || ownerAtStart
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
      if (samePending(operation)) {
        pending.status = 'unsaved';
        pending.error = 'Join Chess before saving a game to an account. The copy on this device is not an account save.';
        rememberDevice();
        render();
      }
      return;
    }
    const headers = { 'content-type': 'application/json', 'x-csrf-token': csrfToken() };
    if (discardedIds.includes(operation.clientGameId)) return;
    if (operation.kind === 'auto') {
      const settingsResponse = await fetch('/api/settings', { method: 'POST', credentials: 'same-origin', headers, body: '{}' });
      if (!settingsResponse.ok) throw new Error('settings');
      const settings = await settingsResponse.json();
      if (settings.autoSaveBotResults !== true) {
        if (samePending(operation)) {
          pending.status = 'unsaved';
          pending.error = 'Automatic saving is off for this Chess account. This game is not saved.';
          rememberDevice();
          render();
        }
        return;
      }
    }
    if (discardedIds.includes(operation.clientGameId)) return;
    if (session.profile.id !== operation.record.boundAccountId) {
      if (samePending(operation)) {
        pending.status = 'unsaved';
        pending.error = 'This game belongs to a different Chess account.';
        rememberDevice();
        render();
      }
      return;
    }
    const response = await fetch('/api/games', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify(gamePayload(operation.record))
    });
    const body = await response.json();
    if (!samePending(operation) || pending.record.pgn !== before) return;
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
    const settings = gameSettings || { elo: prefs.elo, palette: prefs.palette, pieceStyle: prefs.pieceStyle, pieceColor: prefs.pieceColor };
    record = buildGameRecord({
      id: clientGameId,
      boundAccountId: ownerAtStart,
      startFen,
      sans: chess.history(),
      result: resultCode(state),
      termination: manualResult ? 'resign' : (state.over ? state.kind : 'resign'),
      playerColor: player === 'w' ? 'white' : 'black',
      opponentName: 'Stockfish 19 Lite',
      opponentUciElo: settings.elo,
      pieceStyle: settings.pieceStyle,
      pieceColor: settings.pieceColor,
      palette: settings.palette,
      white: who.white,
      black: who.black,
      event: 'Bot chess',
      site: SITE,
      date: today()
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
  closeGameStage();
  chess = freshChess();
  startFen = chess.fen();
  placeBoard(false);
  try {
    rememberDeviceRecovery(localStorage, {
      phase: 'setup',
      startFen,
      sans: [],
      player,
      clientGameId: null,
      discardedIds,
      savedStatus: 'unsaved',
      accountId: null,
      ownerAtStart: null,
      prefs
    });
  } catch (err) { /* the browser blocked storage */ }
  render();
  const start = document.getElementById('start-game');
  if (start) start.focus();
}

function startGame() {
  if (unsavedFinished()) {
    notice = 'This finished game is still unsaved. Save it or discard it before starting another.';
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
  ownerAtStart = accountState.id;
  gameSettings = { elo: prefs.elo, palette: prefs.palette, pieceStyle: prefs.pieceStyle, pieceColor: prefs.pieceColor };
  phase = 'playing';
  rememberDevice();
  placeBoard(true);
  if (engineReady) engine.setElo(prefs.elo);
  windowEl.hidden = false;
  windowEl.focus();
  render();
  requestBot();
}

function askLeave(action) {
  if (unsavedFinished()) {
    notice = 'This finished game is still unsaved. Save it to the Chess account or discard it before leaving. Leaving is blocked so the moves are not dropped.';
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

playWhite.addEventListener('click', () => {
  if (phase !== 'setup') return;
  player = 'w';
  render();
});
playBlack.addEventListener('click', () => {
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
document.getElementById('new-game').addEventListener('click', () => requestGameExit());
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
document.getElementById('analyze-game').addEventListener('click', () => {
  rememberAnalysis({ pgn: pgnEl.value, result: manualResult || resultCode(chess) });
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
    return;
  }
  if (event.key !== 'Tab' || windowEl.hidden) return;
  const nodes = [...document.querySelectorAll('#game-window button, #game-window textarea, #game-window a, #game-window input, .game-exitbar button')].filter((el) => !el.disabled && !el.closest('[hidden]') && !el.closest('[inert]'));
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
if (recovered && recovered.phase !== 'setup') {
  try {
    discardedIds = recovered.discardedIds || [];
    clientGameId = recovered.clientGameId || clientGameId;
    ownerAtStart = recovered.ownerAtStart || null;
    if (recovered.prefs) {
      prefs = Object.assign({}, prefs, recovered.prefs);
      gameSettings = recovered.prefs;
    }
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
let replayGame = null;
let replayIndex = 0;
let replayStart = '';
const replayBoard = mountBoard(replayRoot, () => {});
function openReplay(game) {
  if (phase === 'playing' || (phase === 'ended' && pending && pending.status !== 'saved')) {
    if (savedNote) savedNote.textContent = 'Finish or discard the game on the board before replaying a saved game.';
    return;
  }
  replayGame = new Chess();
  replayGame.loadPgn(game.pgn);
  replayStart = game.startFen;
  replayIndex = replayGame.history().length;
  replayPanel.hidden = false;
  showReplay();
}
function showReplay() {
  const cursor = new Chess(replayStart || undefined);
  const moves = replayGame.history();
  moves.slice(0, replayIndex).forEach((san) => cursor.move(san));
  replayBoard.render({
    orientation: 'w',
    pieces: pieceMap(cursor),
    selected: null,
    legal: [],
    palette: 'midnight',
    pieceStyle: 'standard',
    pieceColor: 'ink',
    pieceColors: pieceColors('ink'),
    checkSquare: null,
    lastMove: null,
    interactive: false
  });
  replayStatus.textContent = replayIndex === 0
    ? 'Starting position.'
    : 'Move ' + replayIndex + ': ' + moves[replayIndex - 1];
}
document.getElementById('replay-prev').addEventListener('click', () => {
  replayIndex = Math.max(0, replayIndex - 1);
  showReplay();
});
document.getElementById('replay-next').addEventListener('click', () => {
  replayIndex = Math.min(replayGame ? replayGame.history().length : 0, replayIndex + 1);
  showReplay();
});
document.getElementById('replay-close').addEventListener('click', () => {
  replayPanel.hidden = true;
  replayGame = null;
  replayIndex = 0;
});

async function loadSavedGames(cursor) {
  const list = savedList;
  const note = savedNote;
  if (!list || !note) return;
  if (!cursor) list.replaceChildren();
  if (!accountState.id) {
    note.textContent = 'Saved games appear here after you join Chess and save a finished game.';
    return;
  }
  const response = await fetch('/api/games/list', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() },
    body: JSON.stringify({ before: cursor && cursor.createdAt, beforeId: cursor && cursor.id, limit: 20 })
  });
  if (!response.ok) return;
  const body = await response.json();
  const games = body.games || [];
  if (!cursor) note.textContent = games.length ? 'These games are stored on your Chess account.' : 'No games are saved on this Chess account yet.';
  const previous = list.querySelector('[data-more]');
  if (previous) previous.remove();
  games.forEach((game) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tool';
    button.textContent = 'Replay ' + game.result;
    button.addEventListener('click', () => openReplay(game));
    const analyze = document.createElement('a');
    analyze.className = 'tool';
    analyze.href = '/analysis/';
    analyze.textContent = 'Analyze';
    analyze.addEventListener('click', () => rememberAnalysis({ pgn: game.pgn, result: game.result }));
    item.append(button, analyze);
    list.append(item);
  });
  if (games.length === 20) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'tool';
    more.dataset.more = 'true';
    more.textContent = 'More saved games';
    const last = games[games.length - 1];
    more.addEventListener('click', () => loadSavedGames({ createdAt: last.createdAt, id: last.id }));
    list.append(more);
  }
}

syncAccountSettings();
render();
void refreshAccount();
engine.start();
autoBox.addEventListener('change', () => {
  if (!accountState.id) {
    syncAccountSettings();
    return;
  }
  const enabled = autoBox.checked === true;
  autoNote.textContent = enabled ? 'Saving automatic saving on this Chess account…' : 'Turning automatic saving off…';
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

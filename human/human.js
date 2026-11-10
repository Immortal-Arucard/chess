import { Chess } from '../assets/vendor/chess.js/chess.js';
import { mountBoard } from '../assets/chess/board.js';
import { PALETTES, PIECE_COLORS, PIECE_STYLES, loadPrefs, pieceColors, savePrefs } from '../assets/chess/bot-prefs.js';
import { authorChip } from '../assets/chess/author-avatar.js';
import { formatDelta, winGain } from '../assets/chess/rating.js';
import { createChessGateway } from '../assets/chess/community-gateway.js';
import { closeGameStage, requestGameFullscreen, syncGameStage } from '../assets/chess/game-stage.js';
import { rememberAnalysis } from '../assets/chess/analysis-model.js';
import {
  CATEGORIES, STANDARD_FEN, chatControls, cleanChatBody, clockView, formatClock, formatSpan, loadChatSize, outcome,
  piecesOf, playSan, replaySans, kingSquare, resolveTimeControl, saveChatSize, timeSummary, unreadCount
} from '../assets/chess/human-rules.js';

const root = document.getElementById('human-app');
const gateway = createChessGateway();
const params = new URLSearchParams(window.location.search);
let account = null;
let settings = { autoSaveBotResults: false, autoRecordHumanChat: false };
let mode = 'home';
let notice = '';
let prefs = loadPrefs(localStorage);
let category = 'blitz';
let preset = '3+2';
let custom = { minutes: 3, increment: 2, days: 3 };
let color = 'white';
let ratedChoice = false;
let categoryRatings = null;
let seat = 'w';
let manualFlip = false;
let pass = null;
let selected = null;
let promotion = null;
let online = null;
let chatSize = 'normal';
let chatSeen = 0;
let chatDraft = '';
let chatNode = null;
let pollTimer = 0;
let clockTimer = 0;
let reconnecting = false;
let searchRows = [];
let chosen = null;
let lobby = [];
let incoming = [];
let mine = [];
let history = [];
let replay = null;

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
    body: JSON.stringify(Object.assign({ authorId: account && account.profile && account.profile.id }, body || {}))
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'The request could not be completed.');
  return payload;
}
async function get(path) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'The request could not be completed.');
  return payload;
}
function offlineNow() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}
function control() {
  return resolveTimeControl(preset === 'custom'
    ? { category, preset: 'custom', minutes: custom.minutes, increment: custom.increment, days: custom.days }
    : { category, preset });
}
function setChatSize(size) {
  chatSize = saveChatSize(localStorage, account && account.id, size);
  if (chatSize !== 'min') chatSeen = online && online.messages ? online.messages.length : chatSeen;
  paint();
}
function restoreIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<rect x="4" y="1" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5"></rect><rect x="1" y="4" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5"></rect>';
  return svg;
}

function playerChip(name, id) {
  return authorChip(name, id, { linked: false });
}
function inGame() {
  return (mode === 'pass-play' && pass) || (mode === 'online-game' && online);
}
function stageOptions() {
  if (mode === 'online-game' && online && online.status === 'active') {
    const moves = (online.sans || []).length;
    const id = online.id;
    const version = online.version;
    return {
      label: 'Leave game',
      confirm: moves
        ? 'Leave this game? You resign, and the other player wins.'
        : 'Leave this game? It will be aborted, and neither player gets a result.',
      yesLabel: moves ? 'Resign' : 'Abort game',
      onConfirm: () => run(async () => {
        if (moves) await post('/api/human/resign', { id, version });
        else await post('/api/human/abort', { id });
        mode = 'online';
        online = null;
        notice = '';
        paint();
        refreshOnline();
      })
    };
  }
  if (mode === 'pass-play' && pass && !pass.result) {
    return {
      label: 'Leave game',
      confirm: 'Leave this game? The moves on this device will be discarded.',
      yesLabel: 'Leave game',
      onConfirm: () => { pass = null; mode = 'home'; notice = ''; paint(); }
    };
  }
  if (mode === 'pass-play' && pass && pass.result && !pass.saved) {
    return {
      label: 'Exit',
      confirm: '',
      onConfirm: () => { notice = 'Save or discard the finished game first.'; paint(); }
    };
  }
  return {
    label: 'Exit',
    confirm: '',
    onConfirm: () => {
      if (mode === 'online-game') { mode = 'online'; online = null; paint(); refreshOnline(); }
      else { pass = null; mode = 'home'; paint(); }
    }
  };
}
function home() {
  root.append(el('p', null, 'Same-device games work without a connection. Online games need two Chess accounts.'));
  if (notice) root.append(el('p', 'community-error', notice));
  const same = el('button', 'tool', 'Same device');
  same.type = 'button';
  same.id = 'mode-pass';
  same.addEventListener('click', () => { mode = 'pass-setup'; notice = ''; paint(); });
  const net = el('button', 'tool', 'Online');
  net.type = 'button';
  net.id = 'mode-online';
  net.addEventListener('click', () => { mode = 'online'; notice = ''; paint(); refreshOnline(); });
  const row = el('div', 'human-modes');
  row.append(same, net);
  root.append(row);
  accountBox();
  historyList();
}

function accountBox() {
  const box = el('section', 'human-card');
  box.append(el('h2', null, 'Account'));
  if (!account) {
    box.append(el('p', null, 'Sign in, then click Join Chess, before an online game or an account save. Same-device play does not require an account.'));
    const email = document.createElement('input');
    email.type = 'email';
    email.id = 'human-email';
    email.placeholder = 'Email';
    const name = document.createElement('input');
    name.id = 'human-name';
    name.maxLength = 40;
    name.placeholder = 'Display name';
    const mail = el('button', 'tool', 'Email me a sign-in link');
    mail.type = 'button';
    mail.addEventListener('click', () => run(async () => { await gateway.signIn(email.value, name.value); notice = 'Check your email for the sign-in link.'; }));
    const google = el('button', 'tool', 'Continue with Google');
    google.type = 'button';
    google.id = 'human-google';
    google.addEventListener('click', () => run(() => gateway.continueWithGoogle()));
    box.append(email, name, mail, google);
  } else if (!account.profile) {
    const name = document.createElement('input');
    name.id = 'human-join-name';
    name.maxLength = 40;
    name.placeholder = 'Display name';
    const join = el('button', 'tool', 'Join Chess');
    join.type = 'button';
    join.addEventListener('click', () => run(async () => { await gateway.joinChess(name.value); await refreshAccount(); notice = 'Chess profile saved.'; }));
    box.append(el('p', null, 'Signed in. Join Chess to play online. Joining does not open another service.'), name, join);
  } else {
    box.append(el('p', null, 'Signed in as ' + account.profile.displayName + '.'));
    const save = document.createElement('input');
    save.type = 'checkbox';
    save.id = 'human-autosave';
    save.checked = settings.autoSaveBotResults === true;
    save.addEventListener('change', () => run(async () => {
      settings = await post('/api/settings', { autoSaveBotResults: save.checked });
    }));
    const saveLabel = el('label', null, 'Automatically save finished games');
    saveLabel.prepend(save);
    const record = document.createElement('input');
    record.type = 'checkbox';
    record.id = 'human-autorecord';
    record.checked = settings.autoRecordHumanChat === true;
    record.addEventListener('change', () => run(async () => {
      settings = await post('/api/settings', { autoRecordHumanChat: record.checked });
    }));
    const recordLabel = el('label', null, 'Always permanently record in-game dialogues');
    recordLabel.prepend(record);
    box.append(saveLabel, el('p', 'human-chat-note', 'Automatic saving is the same account switch as bot games. Dialogue recording is separate and starts off.'), recordLabel);
  }
  root.append(box);
}

function timePicker() {
  const wrap = el('div', null);
  const cats = el('div', 'play-toolbar');
  CATEGORIES.forEach((item) => {
    const button = el('button', 'tool', item.label);
    button.type = 'button';
    button.setAttribute('aria-pressed', item.id === category ? 'true' : 'false');
    button.addEventListener('click', () => {
      category = item.id;
      preset = item.presets[0].id;
      paint();
    });
    cats.append(button);
  });
  const group = CATEGORIES.find((item) => item.id === category);
  const presets = el('div', 'play-toolbar');
  group.presets.forEach((item) => {
    const button = el('button', 'tool', item.label);
    button.type = 'button';
    button.setAttribute('aria-pressed', item.id === preset ? 'true' : 'false');
    button.addEventListener('click', () => { preset = item.id; paint(); });
    presets.append(button);
  });
  if (category !== 'untimed') {
    const customButton = el('button', 'tool', 'Custom');
    customButton.type = 'button';
    customButton.setAttribute('aria-pressed', preset === 'custom' ? 'true' : 'false');
    customButton.addEventListener('click', () => { preset = 'custom'; paint(); });
    presets.append(customButton);
  }
  wrap.append(el('p', 'human-spec', (mode === 'online' ? (ratedChoice ? 'Rated' : 'Unrated') : 'Unrated') + ' · ' + safeSummary()), cats, presets);
  if (preset === 'custom' && category !== 'untimed') {
    const row = el('div', 'human-custom');
    if (category === 'daily') {
      const days = document.createElement('input');
      days.type = 'number';
      days.min = '1';
      days.max = '14';
      days.value = String(custom.days);
      days.id = 'custom-days';
      days.addEventListener('change', () => { custom.days = Number(days.value); paint(); });
      row.append(el('label', null, 'Days per move'), days);
    } else {
      const minutes = document.createElement('input');
      minutes.type = 'number';
      minutes.id = 'custom-minutes';
      minutes.value = String(custom.minutes);
      minutes.addEventListener('change', () => { custom.minutes = Number(minutes.value); paint(); });
      const increment = document.createElement('input');
      increment.type = 'number';
      increment.id = 'custom-increment';
      increment.value = String(custom.increment);
      increment.addEventListener('change', () => { custom.increment = Number(increment.value); paint(); });
      row.append(el('label', null, 'Minutes'), minutes, el('label', null, 'Increment seconds'), increment);
    }
    wrap.append(row);
  }
  return wrap;
}
function safeSummary() {
  try { return timeSummary(control()); } catch (err) { return err.message; }
}

function passSetup() {
  root.append(el('h2', null, 'Same device'));
  root.append(el('p', null, 'Pass the device after each move. The board turns toward the side to move. Press Start game before any move.'));
  if (notice) root.append(el('p', 'community-error', notice));
  root.append(timePicker());
  const sides = el('div', 'play-toolbar');
  ['white', 'black'].forEach((side) => {
    const button = el('button', 'tool', side === 'white' ? 'I sit as White' : 'I sit as Black');
    button.type = 'button';
    button.setAttribute('aria-pressed', color === side ? 'true' : 'false');
    button.addEventListener('click', () => { color = side; paint(); });
    sides.append(button);
  });
  root.append(sides, appearancePicker());
  const start = el('button', 'tool', 'Start game');
  start.type = 'button';
  start.id = 'start-game';
  start.addEventListener('click', startPass);
  const back = el('button', 'tool', 'Back');
  back.type = 'button';
  back.addEventListener('click', () => { mode = 'home'; paint(); });
  root.append(start, back);
  const preview = el('div', null);
  preview.id = 'board';
  root.append(preview);
  mountBoard(preview, () => {}).render(boardState(new Chess(), false, color === 'white' ? 'w' : 'b'));
}

function appearancePicker() {
  const wrap = el('div', 'play-toolbar');
  function group(title, items, current, key) {
    const field = document.createElement('fieldset');
    field.append(el('legend', null, title));
    items.forEach((item) => {
      const button = el('button', 'tool', item.label);
      button.type = 'button';
      button.setAttribute('aria-pressed', item.id === current ? 'true' : 'false');
      button.addEventListener('click', () => {
        prefs = savePrefs(localStorage, Object.assign({}, prefs, { [key]: item.id }));
        paint();
      });
      field.append(button);
    });
    wrap.append(field);
  }
  group('Board', PALETTES, prefs.palette, 'palette');
  group('Pieces', PIECE_STYLES, prefs.pieceStyle, 'pieceStyle');
  group('Colors', PIECE_COLORS, prefs.pieceColor, 'pieceColor');
  return wrap;
}

function boardState(game, interactive, orientation) {
  const legal = selected ? game.moves({ square: selected, verbose: true }).map((move) => move.to) : [];
  return {
    orientation,
    pieces: piecesOf(game),
    selected,
    legal,
    lastMove: pass && pass.last,
    checkSquare: kingSquare(game),
    interactive,
    palette: prefs.palette,
    pieceStyle: prefs.pieceStyle,
    pieceColor: prefs.pieceColor,
    pieceColors: pieceColors(prefs.pieceColor)
  };
}

function startPass() {
  let spec;
  try { spec = control(); } catch (err) { notice = err.message; paint(); return; }
  const game = new Chess();
  pass = {
    game, spec, sans: [], last: null, started: Date.now(), deadline: spec.dailyDays ? Date.now() + spec.dailyDays * 86400000 : null,
    whiteMs: spec.baseMs, blackMs: spec.baseMs, clockAt: Date.now(), offer: null, result: null, termination: '', saved: false
  };
  selected = null;
  mode = 'pass-play';
  notice = '';
  paint();
}

function passOrientation() {
  const turn = pass.game.turn();
  const base = manualFlip ? (turn === 'w' ? 'b' : 'w') : turn;
  return base;
}

function passPlay() {
  const over = pass.result || outcome(pass.game).over;
  const live = clockView({
    category: pass.spec.category,
    dailyDays: pass.spec.dailyDays,
    deadlineAt: pass.deadline,
    baseMs: pass.spec.baseMs,
    whiteMs: pass.whiteMs,
    blackMs: pass.blackMs,
    clockAt: pass.clockAt,
    turn: pass.game.turn() === 'w' ? 'white' : 'black'
  }, Date.now());
  if (!pass.result && live.flagged) finishPass(live.flagged === 'white' ? '0-1' : '1-0', 'timeout');
  root.append(el('p', 'human-spec', timeSummary(pass.spec) + ' · Unrated'));
  root.append(el('p', null, (pass.game.turn() === 'w' ? 'White' : 'Black') + ' to move. ' + (account && account.profile ? 'Your seat is ' + color + '.' : '')));
  if (pass.spec.baseMs != null) {
    const clocks = el('p', null, 'White ' + formatClock(live.whiteMs) + ' · Black ' + formatClock(live.blackMs));
    clocks.id = 'pass-clocks';
    root.append(clocks);
  }
  if (pass.spec.dailyDays) {
    const daily = el('p', null, formatSpan(live.dailyLeftMs) + ' for this move');
    daily.id = 'pass-daily';
    root.append(daily);
  }
  if (notice) root.append(el('p', 'community-error', notice));
  const board = el('div', null);
  board.id = 'board';
  root.append(board);
  mountBoard(board, onPassSquare).render(boardState(pass.game, !over, passOrientation()));
  const flip = el('button', 'tool', 'Flip board');
  flip.type = 'button';
  flip.addEventListener('click', () => { manualFlip = !manualFlip; paint(); });
  const resign = el('button', 'tool', 'Resign');
  resign.type = 'button';
  resign.id = 'resign';
  resign.addEventListener('click', () => finishPass(pass.game.turn() === 'w' ? '0-1' : '1-0', 'resign'));
  if (!over) {
    root.append(flip, resign);
    if (pass.offer) {
      const accept = el('button', 'tool', 'Accept draw');
      accept.type = 'button';
      accept.id = 'draw';
      accept.addEventListener('click', () => finishPass('1/2-1/2', 'agreement'));
      const decline = el('button', 'tool', 'Decline draw');
      decline.type = 'button';
      decline.id = 'decline-draw';
      decline.addEventListener('click', () => { pass.offer = null; paint(); });
      root.append(accept, decline);
    } else {
      const draw = el('button', 'tool', 'Offer draw');
      draw.type = 'button';
      draw.id = 'draw';
      draw.addEventListener('click', () => { pass.offer = pass.game.turn() === 'w' ? 'white' : 'black'; paint(); });
      root.append(draw);
    }
  }
  root.append(el('ol', 'moves', pass.sans.join(' ')));
  if (over) endPanel();
  promotionBox(onPassSquare);
}

function onPassSquare(square) {
  if (!pass || pass.result || outcome(pass.game).over) return;
  const game = pass.game;
  const turn = game.turn();
  if (selected) {
    const choices = game.moves({ square: selected, verbose: true }).filter((move) => move.to === square);
    if (choices.length > 1) { promotion = { from: selected, to: square, apply: applyPass }; paint(); return; }
    if (choices.length === 1) { applyPass(choices[0].san); return; }
  }
  const piece = piecesOf(game)[square];
  selected = piece && piece.color === turn ? square : null;
  paint();
}
function applyPass(san) {
  const played = playSan(pass.sans, san);
  const elapsed = Date.now() - pass.clockAt;
  if (pass.spec.baseMs != null) {
    if (pass.game.turn() === 'w') pass.whiteMs = Math.max(0, pass.whiteMs - elapsed) + pass.spec.incrementMs;
    else pass.blackMs = Math.max(0, pass.blackMs - elapsed) + pass.spec.incrementMs;
  }
  pass.sans.push(played.san);
  pass.game = played.game;
  pass.last = { from: played.from, to: played.to };
  pass.clockAt = Date.now();
  if (pass.spec.dailyDays) pass.deadline = Date.now() + pass.spec.dailyDays * 86400000;
  pass.offer = null;
  selected = null;
  promotion = null;
  const end = played.outcome;
  if (end.over) finishPass(end.result, end.termination);
  else paint();
}
function finishPass(result, termination) {
  pass.result = result;
  pass.termination = termination;
  selected = null;
  promotion = null;
  if (settings.autoSaveBotResults && account && account.profile) run(() => savePass('auto'));
  else paint();
}
function endPanel() {
  const panel = el('div', 'human-card');
  panel.append(el('h2', null, 'Game over'), el('p', null, pass.result + ' · ' + pass.termination));
  const save = el('button', 'tool', 'Save to account');
  save.type = 'button';
  save.id = 'save-account';
  save.addEventListener('click', () => run(() => savePass('manual')));
  const discard = el('button', 'tool', 'Discard');
  discard.type = 'button';
  discard.id = 'discard-result';
  discard.addEventListener('click', () => { pass.saved = true; pass = null; mode = 'home'; notice = 'The game was discarded.'; paint(); });
  const analyze = document.createElement('a');
  analyze.className = 'tool';
  analyze.href = '/analysis/';
  analyze.textContent = 'Analyze';
  analyze.addEventListener('click', () => {
    pass.game.header('White', 'White', 'Black', 'Black', 'Result', pass.result || '*');
    rememberAnalysis({ pgn: pass.game.pgn(), result: pass.result });
  });
  panel.append(save, discard, analyze);
  root.append(panel);
}
async function savePass() {
  if (!account || !account.profile) throw new Error('Join Chess before saving a game to an account.');
  const game = replaySans(pass.sans);
  const moves = game.history({ verbose: true }).map((move, index) => ({
    ply: index + 1, san: move.san, uci: move.from + move.to + (move.promotion || ''), fen: move.after
  }));
  const white = color === 'white' && account.profile ? account.profile.displayName : 'Guest';
  const black = color === 'black' && account.profile ? account.profile.displayName : 'Guest';
  game.header('Event', 'Human chess', 'White', white, 'Black', black, 'Result', pass.result, 'TimeControl', timeSummary(pass.spec));
  const id = crypto.randomUUID();
  await post('/api/human/save', {
    clientGameId: id,
    expectedProfileId: account.profile.id,
    rated: false,
    pgn: game.pgn(),
    startFen: STANDARD_FEN,
    moves,
    sans: pass.sans,
    result: pass.result,
    termination: pass.termination,
    playerColor: color,
    opponentName: 'Guest',
    category: pass.spec.category,
    timeLabel: pass.spec.label,
    pieceStyle: prefs.pieceStyle,
    pieceColor: prefs.pieceColor,
    palette: prefs.palette
  });
  pass.saved = true;
  notice = 'Saved to your Chess account.';
  await refreshHistory();
  paint();
}

function promotionBox(apply) {
  if (!promotion) return;
  const box = el('div', 'promotion');
  box.hidden = false;
  ['q', 'r', 'b', 'n'].forEach((piece) => {
    const button = el('button', 'tool', piece);
    button.type = 'button';
    button.addEventListener('click', () => {
      const move = pass.game.moves({ verbose: true }).find((item) => item.from === promotion.from && item.to === promotion.to && item.promotion === piece);
      if (move) apply(move.san);
    });
    box.append(button);
  });
  root.append(box);
}

function onlineHome() {
  root.append(el('h2', null, 'Online'));
  if (offlineNow()) root.append(el('p', 'community-error', 'You appear to be offline. Online games need a connection. Same-device play still works.'));
  if (reconnecting) root.append(el('p', null, 'Reconnecting…'));
  if (notice) root.append(el('p', 'community-error', notice));
  accountBox();
  if (!account || !account.profile) {
    const back = el('button', 'tool', 'Back');
    back.type = 'button';
    back.addEventListener('click', () => { mode = 'home'; paint(); });
    root.append(back);
    return;
  }
  root.append(el('h3', null, 'Named challenge'));
  const query = document.createElement('input');
  query.id = 'name-search';
  query.placeholder = 'Display name';
  const find = el('button', 'tool', 'Search');
  find.type = 'button';
  find.addEventListener('click', () => run(async () => {
    const result = await get('/api/human/search?q=' + encodeURIComponent(query.value));
    searchRows = result.profiles || [];
    paint();
  }));
  const search = el('div', 'human-search');
  search.append(query, find);
  root.append(search);
  searchRows.forEach((person) => {
    const button = el('button', 'tool', person.displayName);
    button.type = 'button';
    button.addEventListener('click', () => { chosen = person; paint(); });
    root.append(button);
  });
  if (chosen) root.append(el('p', null, 'Challenging ' + chosen.displayName + '.'));
  root.append(timePicker());
  colorPicker();
  const named = el('button', 'tool', 'Send named challenge');
  named.type = 'button';
  named.id = 'send-named';
  named.addEventListener('click', () => run(() => createChallenge('named')));
  const pub = el('button', 'tool', 'Post public challenge');
  pub.type = 'button';
  pub.id = 'send-public';
  pub.addEventListener('click', () => run(() => createChallenge('public')));
  root.append(named, pub);
  listBlock('Incoming challenges', incoming, true);
  listBlock('Public lobby', lobby, false);
  listBlock('Your games', mine, false);
  const back = el('button', 'tool', 'Back');
  back.type = 'button';
  back.addEventListener('click', () => { mode = 'home'; paint(); });
  root.append(back);
  historyList();
}
function colorPicker() {
  const ratedBox = document.createElement('fieldset');
  ratedBox.className = 'human-rated';
  ratedBox.append(el('legend', null, 'Rated or unrated'));
  const unrated = el('button', 'tool', 'Unrated');
  unrated.type = 'button';
  unrated.id = 'rated-off';
  unrated.setAttribute('aria-pressed', ratedChoice ? 'false' : 'true');
  unrated.addEventListener('click', () => { ratedChoice = false; paint(); });
  const rated = el('button', 'tool', 'Rated');
  rated.type = 'button';
  rated.id = 'rated-on';
  rated.setAttribute('aria-pressed', ratedChoice ? 'true' : 'false');
  rated.addEventListener('click', () => { ratedChoice = true; paint(); });
  ratedBox.append(unrated, rated, el('p', 'human-chat-note', 'Rated changes the ' + category + ' rating for both players. The other player sees this choice and cannot change it. Same-device games and aborted games stay unrated.'));
  const mine = categoryRatings && categoryRatings[category];
  const theirs = chosen && chosen.ratings ? chosen.ratings[category] : null;
  ratedBox.append(el('p', null, 'Your ' + category + ' rating is ' + (mine == null ? '0' : String(mine)) + (chosen ? '. ' + chosen.displayName + ' is ' + (theirs == null ? '0' : String(theirs)) + '.' : '.')));
  const row = el('div', 'play-toolbar');
  ['white', 'black', 'random'].forEach((side) => {
    const button = el('button', 'tool', side[0].toUpperCase() + side.slice(1));
    button.type = 'button';
    button.setAttribute('aria-pressed', color === side ? 'true' : 'false');
    button.addEventListener('click', () => { color = side; paint(); });
    row.append(button);
  });
  root.append(ratedBox, row);
}
async function createChallenge(kind) {
  const spec = control();
  const game = await post('/api/human/challenges', {
    kind, opponentId: kind === 'named' ? chosen && chosen.id : null, color, category: spec.category,
    preset: preset === 'custom' ? 'custom' : preset, minutes: custom.minutes, increment: custom.increment, days: custom.days, rated: ratedChoice
  });
  notice = game.invite ? 'Invite link: ' + location.origin + '/human/?invite=' + game.invite : 'Challenge sent.';
  online = game;
  await refreshOnline();
  paint();
}
function listBlock(title, rows, incomingList) {
  root.append(el('h3', null, title));
  if (!rows.length) root.append(el('p', null, 'None.'));
  rows.forEach((game) => root.append(challengeCard(game, incomingList)));
}
function challengeCard(game, incomingList) {
  const card = el('article', 'human-card');
  card.append(el('p', 'human-spec', timeSummary({ category: game.category, label: game.timeLabel }) + ' · ' + (game.rated ? 'Rated' : 'Unrated') + ' · ' + game.creatorColor));
  if (game.creatorRating != null) {
    card.append(el('p', null, (game.creatorName || 'Creator') + ' ' + game.category + ' ' + game.creatorRating + (game.opponentRating != null ? ' · ' + (game.challengedName || 'Opponent') + ' ' + game.opponentRating : '')));
  }
  const players = el('div', 'human-players');
  if (game.creatorId) players.append(authorChip(game.creatorName || 'Member', game.creatorId));
  card.append(players, el('p', null, (game.turn ? game.turn + ' to move' : game.status) + (game.dailyDays ? ' · ' + formatSpan(Date.parse(game.deadlineAt) - Date.parse(game.serverNow)) : '')));
  if (incomingList) {
    const accept = el('button', 'tool', 'Accept');
    accept.type = 'button';
    accept.addEventListener('click', () => { requestGameFullscreen(); run(async () => openGame(await post('/api/human/accept', { id: game.id }))); });
    const decline = el('button', 'tool', 'Decline');
    decline.type = 'button';
    decline.addEventListener('click', () => run(async () => { await post('/api/human/decline', { id: game.id }); await refreshOnline(); }));
    card.append(accept, decline);
  } else if (game.status === 'open' && game.creatorId === (account.profile && account.profile.id)) {
    const cancel = el('button', 'tool', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => run(async () => { await post('/api/human/cancel', { id: game.id }); await refreshOnline(); }));
    card.append(cancel);
  } else if (game.status === 'open' && game.kind === 'public') {
    const claim = el('button', 'tool', 'Claim');
    claim.type = 'button';
    claim.addEventListener('click', () => { requestGameFullscreen(); run(async () => openGame(await post('/api/human/accept', { id: game.id }))); });
    card.append(claim);
  } else if (game.status === 'active') {
    const open = el('button', 'tool', 'Open');
    open.type = 'button';
    open.addEventListener('click', () => { requestGameFullscreen(); run(async () => openGame(await get('/api/human/games/' + game.id))); });
    card.append(open);
  }
  return card;
}

function openGame(game) {
  online = game;
  chatSeen = chatSize === 'min' ? chatSeen : (game.messages || []).length;
  mode = 'online-game';
  notice = '';
  paint();
}

function onlineGame() {
  const game = online;
  const mineId = account.profile.id;
  const turnName = game.turn === 'white' ? (game.whiteName || 'White') : (game.blackName || 'Black');
  const received = Date.parse(game.serverNow);
  const offset = Date.now() - received;
  const view = clockView({
    category: game.category,
    dailyDays: game.dailyDays,
    deadlineAt: Date.parse(game.deadlineAt),
    baseMs: game.baseMs,
    whiteMs: game.whiteMs,
    blackMs: game.blackMs,
    clockAt: Date.parse(game.clockAt),
    turn: game.turn
  }, Date.now() - offset);
  root.append(el('p', 'human-spec', timeSummary({ category: game.category, label: game.timeLabel }) + ' · ' + (game.rated ? 'Rated' : 'Unrated')));
  if (reconnecting) root.append(el('p', null, 'Reconnecting…'));
  if (offlineNow()) root.append(el('p', 'community-error', 'You appear to be offline. Moves and dialogue will resume when the connection returns.'));
  if (notice) root.append(el('p', 'community-error', notice));
  const layout = el('div', 'human-layout');
  layout.dataset.chat = chatSize;
  const boardColumn = el('div', 'human-board-column');
  const players = el('div', 'human-players');
  if (game.whiteId) {
    players.append(playerChip(game.whiteName || 'White', game.whiteId));
    if (game.whiteRating != null) players.append(el('span', 'human-rating', String(game.whiteRating)));
  }
  if (game.baseMs != null) {
    const whiteClock = el('span', 'human-clock' + (game.turn === 'white' ? ' is-turn' : ''), formatClock(view.whiteMs));
    whiteClock.id = 'clock-white';
    players.append(whiteClock);
  }
  if (game.blackId) {
    players.append(playerChip(game.blackName || 'Black', game.blackId));
    if (game.blackRating != null) players.append(el('span', 'human-rating', String(game.blackRating)));
  }
  if (game.baseMs != null) {
    const blackClock = el('span', 'human-clock' + (game.turn === 'black' ? ' is-turn' : ''), formatClock(view.blackMs));
    blackClock.id = 'clock-black';
    players.append(blackClock);
  }
  boardColumn.append(players);
  boardColumn.append(el('p', null, game.status === 'active' ? turnName + ' to move' + (game.dailyDays ? ' · ' + formatSpan(view.dailyLeftMs) : '') : (game.result || game.status) + ' ' + (game.termination || '')));
  if (game.status === 'finished') {
    const analyze = document.createElement('a');
    analyze.className = 'tool';
    analyze.href = '/analysis/';
    analyze.textContent = 'Analyze';
    analyze.addEventListener('click', () => {
      const replayGame = new Chess(game.startFen || undefined);
      (game.sans || []).forEach((san) => { try { replayGame.move(san); } catch (err) { /* skip a move the record cannot replay */ } });
      replayGame.header('White', game.whiteName || 'White', 'Black', game.blackName || 'Black', 'Result', game.result || '*');
      rememberAnalysis({ pgn: replayGame.pgn(), result: game.result });
    });
    boardColumn.append(analyze);
  }
  if (game.rated && game.status === 'active' && game.whiteRatingBefore != null && game.blackRatingBefore != null && game.myColor) {
    const mine = game.myColor === 'white' ? game.whiteRatingBefore : game.blackRatingBefore;
    const theirs = game.myColor === 'white' ? game.blackRatingBefore : game.whiteRatingBefore;
    boardColumn.append(el('p', 'human-chat-note', 'A win from these ratings changes your ' + game.category + ' rating by +' + winGain(theirs - mine) + '. The server records the change when the game ends.'));
  }
  if (game.whiteDelta != null || game.blackDelta != null) {
    const change = el('p', 'human-spec', 'White ' + formatDelta(game.whiteDelta || 0) + ' · Black ' + formatDelta(game.blackDelta || 0));
    change.id = 'rating-result';
    boardColumn.append(change);
  }
  const board = el('div', null);
  board.id = 'board';
  boardColumn.append(board);
  const local = replaySans(game.sans || [], game.startFen);
  const interactive = game.status === 'active' && game.myColor === game.turn && !offlineNow();
  mountBoard(board, onOnlineSquare).render({
    orientation: game.myColor === 'black' ? 'b' : 'w',
    pieces: piecesOf(local),
    selected,
    legal: selected ? local.moves({ square: selected, verbose: true }).map((move) => move.to) : [],
    lastMove: null,
    checkSquare: kingSquare(local),
    interactive,
    palette: prefs.palette,
    pieceStyle: prefs.pieceStyle,
    pieceColor: prefs.pieceColor,
    pieceColors: pieceColors(prefs.pieceColor)
  });
  if (game.status === 'active' && game.myColor) {
    const resign = el('button', 'tool', 'Resign');
    resign.type = 'button';
    resign.id = 'resign';
    resign.addEventListener('click', () => run(async () => openGame(await post('/api/human/resign', { id: game.id, version: game.version }))));
    boardColumn.append(resign);
    if (game.drawOffer && game.drawOffer !== game.myColor) {
      const accept = el('button', 'tool', 'Accept draw');
      accept.type = 'button';
      accept.id = 'draw';
      accept.addEventListener('click', () => run(async () => openGame(await post('/api/human/draw', { id: game.id, version: game.version, action: 'accept' }))));
      const decline = el('button', 'tool', 'Decline draw');
      decline.type = 'button';
      decline.id = 'decline-draw';
      decline.addEventListener('click', () => run(async () => openGame(await post('/api/human/draw', { id: game.id, version: game.version, action: 'decline' }))));
      boardColumn.append(accept, decline);
    } else if (!game.drawOffer) {
      const draw = el('button', 'tool', 'Offer draw');
      draw.type = 'button';
      draw.id = 'draw';
      draw.addEventListener('click', () => run(async () => openGame(await post('/api/human/draw', { id: game.id, version: game.version, action: 'offer' }))));
      boardColumn.append(draw);
    } else boardColumn.append(el('p', null, 'Draw offered.'));
    if (!(game.sans || []).length) {
      const abort = el('button', 'tool', 'Abort');
      abort.type = 'button';
      abort.addEventListener('click', () => run(async () => { await post('/api/human/abort', { id: game.id }); mode = 'online'; online = null; await refreshOnline(); }));
      boardColumn.append(abort);
    }
  }
  boardColumn.append(el('ol', 'moves', (game.sans || []).join(' ')));
  layout.append(boardColumn, chatPanel(game, mineId));
  root.append(layout);
}
function onOnlineSquare(square) {
  if (!online || online.myColor !== online.turn) return;
  const game = replaySans(online.sans || [], online.startFen);
  if (selected) {
    const choices = game.moves({ square: selected, verbose: true }).filter((move) => move.to === square);
    if (choices.length === 1) {
      run(async () => openGame(await post('/api/human/move', { id: online.id, version: online.version, san: choices[0].san })));
      selected = null;
      return;
    }
  }
  const piece = piecesOf(game)[square];
  const mine = online.myColor === 'white' ? 'w' : 'b';
  selected = piece && piece.color === mine ? square : null;
  paint();
}
function chatPanel(game, mineId) {
  const panel = el('section', 'human-chat');
  panel.id = 'game-chat';
  const unread = unreadCount(chatSize, chatSeen, (game.messages || []).length);
  if (chatSize === 'min') {
    const bar = el('button', 'human-chat-restorebar');
    bar.type = 'button';
    bar.title = 'Restore';
    bar.setAttribute('aria-label', 'Restore');
    bar.append(el('span', null, 'Chat'));
    if (unread) bar.append(el('span', 'human-chat-badge', unread + ' unread'));
    bar.append(el('span', null, 'Restore'));
    bar.addEventListener('click', () => setChatSize('normal'));
    panel.append(bar);
    return panel;
  }
  const bar = el('div', 'human-chat-bar');
  bar.append(el('span', 'human-chat-title', 'Dialogue'));
  chatControls(chatSize).forEach((controlButton) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'human-chat-icon';
    button.title = controlButton.tip;
    button.setAttribute('aria-label', controlButton.action === 'restore' ? 'Restore' : controlButton.label + ' chat');
    if (controlButton.glyph === 'restore') button.append(restoreIcon());
    else button.textContent = controlButton.glyph;
    button.addEventListener('click', () => setChatSize(controlButton.action === 'min' ? 'min' : controlButton.action === 'max' ? 'max' : 'normal'));
    bar.append(button);
  });
  if (chatSize === 'max') {
    const back = el('button', 'tool', 'Back to the board');
    back.type = 'button';
    back.title = 'Restore';
    back.setAttribute('aria-label', 'Restore');
    back.addEventListener('click', () => setChatSize('normal'));
    bar.append(back);
  }
  panel.append(bar);
  const body = el('div', 'human-chat-body');
  const recording = game.iAmRecording || (settings.autoRecordHumanChat && game.status === 'active');
  body.append(el('p', 'human-chat-note', recording
    ? 'You are recording this dialogue. A saved transcript cannot be edited.'
    : 'This dialogue is temporary. It is deleted 24 hours after the game unless you record it. The other player can keep a separate copy.'));
  const log = el('div', 'human-chat-log');
  log.id = 'chat-log';
  (game.messages || []).forEach((message) => {
    const line = el('p', 'human-chat-line');
    if (message.authorId) line.append(playerChip(message.authorName || 'Member', message.authorId));
    line.append(el('span', null, ' ' + message.body));
    log.append(line);
  });
  body.append(log);
  if (!game.dialogueRecorded && (game.status === 'active' || game.status === 'finished')) {
    const record = el('button', 'tool', 'Record dialogue with this game');
    record.type = 'button';
    record.id = 'record-chat';
    record.addEventListener('click', () => run(async () => openGame(await post('/api/human/record', { id: game.id }))));
    body.append(record);
  }
  if (game.status === 'active' && game.myColor) {
    const input = document.createElement('textarea');
    input.id = 'chat-body';
    input.maxLength = 500;
    input.rows = 2;
    input.value = chatDraft;
    input.addEventListener('input', () => { chatDraft = input.value; });
    const send = el('button', 'tool', 'Send');
    send.type = 'button';
    send.id = 'chat-send';
    send.addEventListener('click', () => run(async () => {
      const text = cleanChatBody(chatDraft);
      chatDraft = '';
      const field = document.getElementById('chat-body');
      if (field) field.value = '';
      openGame(await post('/api/human/chat', { id: game.id, body: text }));
    }));
    body.append(input, send);
  }
  panel.append(body);
  chatNode = panel;
  void mineId;
  return panel;
}

function historyList() {
  if (!history.length) return;
  root.append(el('h2', null, 'Saved games'));
  history.forEach((game) => {
    const card = el('article', 'human-card');
    card.append(el('p', 'human-spec', timeSummary({ category: game.category, label: game.timeLabel }) + (game.kind === 'online' ? (game.rated ? ' · Rated' : ' · Unrated') : ' · Unrated')));
    const who = el('div', 'human-players');
    if (game.opponentId) who.append(authorChip(game.opponentName, game.opponentId));
    else who.append(el('span', null, game.opponentName));
    card.append(who, el('p', null, game.result + ' · ' + game.termination + (game.dialogueRecorded ? ' · dialogue recorded' : '')));
    const open = el('button', 'tool', 'Replay');
    open.type = 'button';
    open.addEventListener('click', () => { replay = { game, ply: 0 }; paint(); });
    const analyze = document.createElement('a');
    analyze.className = 'tool';
    analyze.href = '/analysis/';
    analyze.textContent = 'Analyze';
    analyze.addEventListener('click', () => rememberAnalysis({ pgn: game.pgn, result: game.result }));
    card.append(open, analyze);
    if (replay && replay.game.id === game.id) card.append(replayBox());
    root.append(card);
  });
}
function replayBox() {
  const box = el('div', null);
  const board = el('div', null);
  const sans = replay.game.sans || (replay.game.moves || []).map((move) => move.san || move);
  const game = replaySans(sans.slice(0, replay.ply), replay.game.startFen);
  mountBoard(board, () => {}).render({
    orientation: 'w', pieces: piecesOf(game), selected: null, legal: [], lastMove: null, checkSquare: '',
    interactive: false, palette: replay.game.palette || 'midnight', pieceStyle: replay.game.pieceStyle || 'standard',
    pieceColor: replay.game.pieceColor || 'ink', pieceColors: pieceColors(replay.game.pieceColor || 'ink')
  });
  const prev = el('button', 'tool', 'Previous move');
  prev.type = 'button';
  prev.addEventListener('click', () => { replay.ply = Math.max(0, replay.ply - 1); paint(); });
  const next = el('button', 'tool', 'Next move');
  next.type = 'button';
  next.addEventListener('click', () => { replay.ply = Math.min(sans.length, replay.ply + 1); paint(); });
  box.append(board, prev, next, el('p', null, 'Move ' + replay.ply + ' of ' + sans.length));
  (replay.game.dialogue || []).forEach((message) => box.append(el('p', null, message.authorName + ': ' + message.body)));
  return box;
}

function paint() {
  if (chatNode) {
    const field = chatNode.querySelector('#chat-body');
    if (field) chatDraft = field.value;
  }
  root.replaceChildren();
  if (mode === 'pass-setup') passSetup();
  else if (mode === 'pass-play' && pass) passPlay();
  else if (mode === 'online') onlineHome();
  else if (mode === 'online-game' && online) onlineGame();
  else home();
  if (inGame()) syncGameStage(stageOptions());
  else closeGameStage();
}
async function run(action) {
  try { notice = ''; await action(); }
  catch (err) { notice = err.message || 'The request could not be completed.'; paint(); }
}
async function refreshAccount() {
  try {
    const session = await gateway.profile();
    account = session ? { profile: session } : { profile: null };
    if (!session) {
      const raw = await get('/api/session');
      account = raw.authenticated ? { profile: raw.profile } : null;
    }
    if (account && account.profile) {
      settings = await post('/api/settings', {});
      try {
        const card = await get('/api/profiles/' + account.profile.id);
        categoryRatings = card.ratings || null;
      } catch (err) {
        categoryRatings = null;
      }
    }
    chatSize = loadChatSize(localStorage, account && account.profile && account.profile.id);
  } catch (err) {
    account = null;
  }
}
async function refreshHistory() {
  if (!account || !account.profile || offlineNow()) return;
  const result = await get('/api/human/results');
  history = result.games || [];
}
async function refreshOnline() {
  if (!account || !account.profile || offlineNow()) return;
  try {
    const [inRows, lobbyRows, mineRows] = await Promise.all([
      get('/api/human/incoming'), get('/api/human/lobby'), get('/api/human/mine')
    ]);
    const nextIncoming = inRows.games || [];
    const nextLobby = lobbyRows.games || [];
    const nextMine = mineRows.games || [];
    const changed = JSON.stringify([nextIncoming, nextLobby, nextMine]) !== JSON.stringify([incoming, lobby, mine]);
    incoming = nextIncoming;
    lobby = nextLobby;
    mine = nextMine;
    reconnecting = false;
    if (changed && mode === 'online' && !(document.activeElement && document.activeElement.tagName === 'INPUT')) paint();
  } catch (err) {
    reconnecting = !offlineNow();
    if (mode === 'online') paint();
  }
}
async function pollGame() {
  if (mode !== 'online-game' || !online || offlineNow()) { reconnecting = offlineNow(); return; }
  try {
    const game = await get('/api/human/games/' + online.id);
    const changed = game.version !== online.version || game.status !== online.status || (game.messages || []).length !== (online.messages || []).length || game.iAmRecording !== online.iAmRecording;
    online = game;
    reconnecting = false;
    if (changed) paint();
  } catch (err) {
    if (!reconnecting) { reconnecting = true; paint(); }
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || chatSize !== 'max') return;
  event.preventDefault();
  setChatSize('normal');
});
window.addEventListener('online', () => { reconnecting = false; refreshOnline(); pollGame(); });
window.addEventListener('offline', () => { reconnecting = false; paint(); });

async function boot() {
  await refreshAccount();
  await refreshHistory();
  if (params.get('opponent') && account && account.profile) {
    mode = 'online';
    try {
      const profile = await gateway.getPublicProfile(params.get('opponent'));
      if (profile) chosen = { id: profile.id, displayName: profile.displayName };
    } catch (err) { notice = err.message; }
  }
  if (params.get('match') && account && account.profile) {
    try { openGame(await get('/api/human/games/' + params.get('match'))); } catch (err) { notice = err.message; mode = 'online'; }
  }
  if (params.get('invite') && account && account.profile) {
    try { openGame(await get('/api/human/invite/' + params.get('invite'))); } catch (err) { notice = err.message; mode = 'online'; }
  }
  paint();
  pollTimer = window.setInterval(() => {
    if (mode === 'online' || mode === 'online-game') {
      refreshOnline();
      pollGame();
    }
  }, 2500);
  clockTimer = window.setInterval(tickClocks, 500);
}
function tickClocks() {
  if (mode === 'pass-play' && pass && !pass.result) {
    const live = clockView({
      category: pass.spec.category, dailyDays: pass.spec.dailyDays, deadlineAt: pass.deadline, baseMs: pass.spec.baseMs,
      whiteMs: pass.whiteMs, blackMs: pass.blackMs, clockAt: pass.clockAt, turn: pass.game.turn() === 'w' ? 'white' : 'black'
    }, Date.now());
    if (live.flagged) { finishPass(live.flagged === 'white' ? '0-1' : '1-0', 'timeout'); return; }
    const clocks = document.getElementById('pass-clocks');
    if (clocks) clocks.textContent = 'White ' + formatClock(live.whiteMs) + ' · Black ' + formatClock(live.blackMs);
    const daily = document.getElementById('pass-daily');
    if (daily) daily.textContent = formatSpan(live.dailyLeftMs) + ' for this move';
  }
  if (mode === 'online-game' && online && online.serverNow) {
    const offset = Date.now() - Date.parse(online.serverNow);
    const view = clockView({
      category: online.category, dailyDays: online.dailyDays, deadlineAt: Date.parse(online.deadlineAt), baseMs: online.baseMs,
      whiteMs: online.whiteMs, blackMs: online.blackMs, clockAt: Date.parse(online.clockAt), turn: online.turn
    }, Date.now() - offset);
    const white = document.getElementById('clock-white');
    const black = document.getElementById('clock-black');
    if (white && view.whiteMs != null) white.textContent = formatClock(view.whiteMs);
    if (black && view.blackMs != null) black.textContent = formatClock(view.blackMs);
  }
}
boot().catch((err) => {
  const note = document.createElement('p');
  note.id = 'boot-error';
  note.textContent = String(err && err.stack || err);
  document.body.append(note);
});

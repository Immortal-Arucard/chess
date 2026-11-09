const HIDE_MS = 3200;
const TOP_PX = 12;
const CHROME = [
  'a.skip',
  'header.site-header',
  'nav.crumbs',
  'footer.site-footer',
  'nav.page-nav',
  'p.eyebrow',
  'main > h1',
  'main > p.lead',
  'main > .prose',
  '.account-settings',
  '.credits',
  '#setup',
  '#saved-games'
];

let active = false;
let parked = [];
let bar = null;
let edge = null;
let hideTimer = 0;
let options = { label: 'Exit', confirm: '', yesLabel: 'Leave game', onConfirm: () => {} };
let confirming = false;
let suppressPop = false;
let observer = null;
let touchStart = null;
let bound = false;

export function requestGameFullscreen() {
  const root = document.documentElement;
  const request = root.requestFullscreen || root.webkitRequestFullscreen || root.webkitRequestFullScreen;
  if (!request) return;
  try {
    const result = request.call(root);
    if (result && typeof result.then === 'function') result.then(() => {}, () => {});
  } catch (err) { /* immersive view remains when fullscreen is declined */ }
}

export function syncGameStage(next) {
  options = next || options;
  if (!active) openStage();
  else refreshBar();
}

export function closeGameStage() {
  if (!active) return;
  active = false;
  confirming = false;
  touchStart = null;
  window.clearTimeout(hideTimer);
  document.body.classList.remove('game-stage', 'exit-revealed');
  const dialog = document.getElementById('game-window');
  if (dialog) dialog.setAttribute('aria-modal', 'true');
  restoreChrome();
  if (observer) observer.disconnect();
  observer = null;
  if (edge) edge.remove();
  if (bar) bar.remove();
  edge = null;
  bar = null;
  exitFullscreen();
  if (history.state && history.state.chessGame) {
    suppressPop = true;
    history.back();
  }
}

export function requestGameExit() {
  if (!active) return;
  beginExit();
}

function openStage() {
  active = true;
  document.body.classList.add('game-stage');
  const dialog = document.getElementById('game-window');
  if (dialog) dialog.setAttribute('aria-modal', 'false');
  parkChrome();
  ensureBar();
  refreshBar();
  watchBody();
  if (!history.state || !history.state.chessGame) history.pushState({ chessGame: true }, '');
  bind();
  requestGameFullscreen();
}

function parkChrome() {
  parked = [];
  CHROME.forEach((selector) => {
    document.querySelectorAll(selector).forEach((node) => {
      if (!node.parentNode) return;
      parked.push({ node, parent: node.parentNode, next: node.nextSibling });
      node.remove();
    });
  });
}

function restoreChrome() {
  for (let i = parked.length - 1; i >= 0; i -= 1) {
    const item = parked[i];
    if (item.parent.isConnected || item.parent === document.body || item.parent === document.head) {
      item.parent.insertBefore(item.node, item.next);
    }
  }
  parked = [];
}

function ensureBar() {
  if (bar) return;
  edge = document.createElement('div');
  edge.className = 'game-edge';
  edge.setAttribute('aria-hidden', 'true');
  bar = document.createElement('div');
  bar.className = 'game-exitbar';
  bar.setAttribute('inert', '');
  bar.setAttribute('aria-hidden', 'true');
  const note = document.createElement('p');
  note.className = 'game-exit-note';
  note.hidden = true;
  const actions = document.createElement('div');
  actions.className = 'game-exit-actions';
  const leave = document.createElement('button');
  leave.type = 'button';
  leave.className = 'tool';
  leave.id = 'leave-game';
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'tool';
  yes.id = 'leave-yes';
  yes.hidden = true;
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'tool';
  no.id = 'leave-no';
  no.textContent = 'Keep playing';
  no.title = 'Keep playing';
  no.setAttribute('aria-label', 'Keep playing');
  no.hidden = true;
  actions.append(leave, yes, no);
  bar.append(note, actions);
  document.body.append(edge, bar);
  leave.addEventListener('click', beginExit);
  yes.addEventListener('click', () => {
    confirming = false;
    const done = options.onConfirm;
    if (done) done();
  });
  no.addEventListener('click', () => {
    confirming = false;
    refreshBar();
    conceal();
  });
  edge.addEventListener('pointerenter', reveal);
}

function refreshBar() {
  if (!bar) return;
  const leave = bar.querySelector('#leave-game');
  const yes = bar.querySelector('#leave-yes');
  const no = bar.querySelector('#leave-no');
  const note = bar.querySelector('.game-exit-note');
  const label = options.label || 'Exit';
  leave.textContent = label;
  leave.title = label;
  leave.setAttribute('aria-label', label);
  const yesLabel = options.yesLabel || 'Leave game';
  yes.textContent = yesLabel;
  yes.title = yesLabel;
  yes.setAttribute('aria-label', yesLabel);
  note.hidden = !confirming;
  yes.hidden = !confirming;
  no.hidden = !confirming;
  leave.hidden = confirming;
  if (confirming) {
    note.textContent = options.confirm || '';
    reveal();
  }
}

function beginExit() {
  if (!active) return;
  reveal();
  if (options.confirm) {
    confirming = true;
    refreshBar();
    const no = bar.querySelector('#leave-no');
    if (no) no.focus();
    return;
  }
  if (options.onConfirm) options.onConfirm();
}

function reveal() {
  if (!active || !bar) return;
  document.body.classList.add('exit-revealed');
  bar.removeAttribute('inert');
  bar.setAttribute('aria-hidden', 'false');
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(maybeHide, HIDE_MS);
}

function maybeHide() {
  if (!active || !bar || confirming) return;
  if (bar.matches(':hover') || (edge && edge.matches(':hover')) || bar.contains(document.activeElement)) {
    hideTimer = window.setTimeout(maybeHide, HIDE_MS);
    return;
  }
  conceal();
}

function conceal() {
  if (!bar || confirming) return;
  document.body.classList.remove('exit-revealed');
  bar.setAttribute('inert', '');
  bar.setAttribute('aria-hidden', 'true');
}

function exitFullscreen() {
  const activeElement = document.fullscreenElement || document.webkitFullscreenElement;
  if (!activeElement) return;
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.webkitCancelFullScreen;
  if (!exit) return;
  try {
    const result = exit.call(document);
    if (result && typeof result.then === 'function') result.then(() => {}, () => {});
  } catch (err) { /* the browser already left fullscreen */ }
}

function fullscreenNow() {
  return document.fullscreenElement || document.webkitFullscreenElement;
}

function onKey(event) {
  if (!active) return;
  if (event.key === 'Tab') {
    if (bar && bar.hasAttribute('inert')) {
      reveal();
      const leave = bar.querySelector('#leave-game');
      if (leave && !leave.hidden) {
        event.preventDefault();
        event.stopPropagation();
        leave.focus();
      }
    }
    return;
  }
  if (event.key !== 'Escape') return;
  if (document.querySelector('.human-layout[data-chat="max"]')) return;
  const promotion = document.getElementById('promotion');
  if (promotion && !promotion.hidden) return;
  if (fullscreenNow()) return;
  reveal();
  const target = confirming ? bar.querySelector('#leave-no') : bar.querySelector('#leave-game');
  if (target && !target.hidden) target.focus();
  event.preventDefault();
  event.stopPropagation();
}

function onFullscreen() {
  if (!active) return;
  if (!fullscreenNow()) reveal();
}

function onPointer(event) {
  if (!active) return;
  if (event.pointerType === 'touch') {
    if (event.type === 'pointerdown' && event.clientY <= 24) touchStart = event.clientY;
    if (event.type === 'pointermove' && touchStart != null && event.clientY - touchStart > 28) reveal();
    return;
  }
  if (event.type === 'pointermove' && event.clientY <= TOP_PX) reveal();
}

function onTouchStart(event) {
  if (!active) return;
  const touch = event.touches && event.touches[0];
  touchStart = touch && touch.clientY <= 24 ? touch.clientY : null;
}

function onTouchMove(event) {
  if (!active || touchStart == null) return;
  const touch = event.touches && event.touches[0];
  if (touch && touch.clientY - touchStart > 28) reveal();
}

function onPop() {
  if (suppressPop) {
    suppressPop = false;
    return;
  }
  if (!active) return;
  history.pushState({ chessGame: true }, '');
  beginExit();
}

function onVisible() {
  if (document.visibilityState === 'visible' && active) requestGameFullscreen();
}

function bind() {
  if (bound) return;
  bound = true;
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('fullscreenchange', onFullscreen);
  document.addEventListener('webkitfullscreenchange', onFullscreen);
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('pointermove', onPointer, true);
  document.addEventListener('touchstart', onTouchStart, true);
  document.addEventListener('touchmove', onTouchMove, true);
  window.addEventListener('popstate', onPop);
  document.addEventListener('visibilitychange', onVisible);
}

function allowedBodyNode(node) {
  if (!node || node.nodeType !== 1) return true;
  if (node === bar || node === edge) return true;
  if (node.tagName === 'MAIN' || node.tagName === 'SCRIPT' || node.tagName === 'NOSCRIPT') return true;
  return false;
}

function watchBody() {
  if (observer) return;
  observer = new MutationObserver((records) => {
    if (!active) return;
    records.forEach((record) => {
      record.addedNodes.forEach((node) => {
        if (node.parentNode === document.body && !allowedBodyNode(node)) node.remove();
      });
    });
  });
  observer.observe(document.body, { childList: true });
}

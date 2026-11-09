import { createChessGateway } from './community-gateway.js';
import { portraitFor } from './author-avatar.js';
import { cleanEmail, cleanName, profilePath, LIMITS } from './community-model.js';

export function sessionView(body) {
  if (!body || body.authenticated !== true) return { state: 'signed-out' };
  const profile = body.profile;
  if (!profile || typeof profile.id !== 'string' || !profile.id) return { state: 'needs-profile' };
  const name = typeof profile.displayName === 'string' && profile.displayName.trim() ? profile.displayName.trim() : 'Member';
  return { state: 'signed-in', id: profile.id, name, hasPortrait: !!profile.hasPortrait };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function paintPortrait(avatar, id) {
  avatar.className = 'account-avatar is-pending';
  avatar.replaceChildren();
  portraitFor(id).then((result) => {
    if (!avatar.isConnected) return;
    const picture = result && result.status === 'image' && typeof result.url === 'string' && result.url.startsWith('blob:');
    avatar.className = 'account-avatar is-' + (picture ? 'picture' : (result && result.status) || 'absent');
    avatar.replaceChildren();
    if (!picture) return;
    const img = document.createElement('img');
    img.alt = '';
    img.width = 28;
    img.height = 28;
    img.draggable = false;
    img.src = result.url;
    avatar.append(img);
  });
}

export function mountAccountMenu(slot, gateway) {
  const auth = gateway || createChessGateway();
  let view = null;
  let mode = 'sign-in';
  let notice = '';
  let menuOpen = false;
  let dialogOpen = false;

  function placeholder() {
    const pending = el('span', 'account-pending');
    pending.setAttribute('aria-busy', 'true');
    pending.setAttribute('aria-label', 'Checking account');
    return pending;
  }

  function closeMenu() { menuOpen = false; }
  function closeDialog() { dialogOpen = false; notice = ''; }

  function render() {
    slot.replaceChildren();
    if (view === null) {
      slot.append(placeholder());
      return;
    }
    if (view.state === 'signed-out') slot.append(signedOutControl());
    else slot.append(signedInControl());
    if (dialogOpen) slot.append(dialog());
  }

  function signedOutControl() {
    const button = el('button', 'account-signin', 'Sign in');
    button.type = 'button';
    button.id = 'account-sign-in';
    button.addEventListener('click', () => {
      dialogOpen = true;
      mode = 'sign-in';
      notice = '';
      render();
      const panel = document.getElementById('account-email');
      if (panel) panel.focus();
    });
    return button;
  }

  function signedInControl() {
    const wrap = el('div', 'account-signed');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'account-button';
    button.id = 'account-menu-button';
    button.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
    button.setAttribute('aria-controls', 'account-menu');
    const name = view.state === 'signed-in' ? view.name : 'Join Chess';
    button.setAttribute('aria-label', name);
    const avatar = el('span', 'account-avatar is-absent');
    avatar.setAttribute('aria-hidden', 'true');
    if (view.state === 'signed-in') paintPortrait(avatar, view.id);
    const label = el('span', 'account-name', name);
    button.append(avatar, label);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      menuOpen = !menuOpen;
      render();
    });
    wrap.append(button);
    if (menuOpen) wrap.append(menu());
    return wrap;
  }

  function menu() {
    const panel = el('div', 'account-menu');
    panel.id = 'account-menu';
    panel.setAttribute('role', 'menu');
    if (view.state === 'signed-in') {
      const profile = document.createElement('a');
      profile.className = 'account-menu-item';
      profile.href = profilePath(view.id);
      profile.id = 'account-profile';
      profile.setAttribute('role', 'menuitem');
      profile.textContent = 'Profile';
      panel.append(profile);
    } else {
      const join = document.createElement('a');
      join.className = 'account-menu-item';
      join.href = '/community/';
      join.id = 'account-join';
      join.setAttribute('role', 'menuitem');
      join.textContent = 'Join Chess';
      panel.append(join);
    }
    const out = el('button', 'account-menu-item', 'Sign out');
    out.type = 'button';
    out.id = 'account-sign-out';
    out.setAttribute('role', 'menuitem');
    out.addEventListener('click', () => { void signOut(); });
    panel.append(out);
    return panel;
  }

  function dialog() {
    const overlay = el('div', 'account-dialog');
    overlay.id = 'account-dialog';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'account-dialog-title');
    const panel = el('div', 'account-panel');
    const title = el('h2', null, mode === 'create' ? 'Create an account' : 'Sign in');
    title.id = 'account-dialog-title';
    const create = el('button', 'tool', 'Create an account');
    create.type = 'button';
    create.id = 'account-create';
    create.setAttribute('aria-pressed', mode === 'create' ? 'true' : 'false');
    create.addEventListener('click', () => { mode = 'create'; notice = ''; render(); });
    const existing = el('button', 'tool', 'Sign in');
    existing.type = 'button';
    existing.id = 'account-existing';
    existing.setAttribute('aria-pressed', mode === 'sign-in' ? 'true' : 'false');
    existing.addEventListener('click', () => { mode = 'sign-in'; notice = ''; render(); });
    const google = el('button', 'tool', 'Continue with Google');
    google.type = 'button';
    google.id = 'account-google';
    google.addEventListener('click', () => { void googleSignIn(); });
    const email = document.createElement('input');
    email.type = 'email';
    email.id = 'account-email';
    email.autocomplete = 'email';
    email.maxLength = 320;
    email.required = true;
    const display = document.createElement('input');
    display.type = 'text';
    display.id = 'account-display-name';
    display.autocomplete = 'nickname';
    display.maxLength = LIMITS.name;
    display.required = true;
    const submit = el('button', 'tool', mode === 'create' ? 'Create an account' : 'Email me a sign-in link');
    submit.type = 'submit';
    submit.id = 'account-submit';
    const form = document.createElement('form');
    form.append(labeled('Email', email), labeled('Display name', display), submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const emailResult = cleanEmail(email.value);
      const nameResult = cleanName(display.value);
      if (!emailResult.ok) { notice = emailResult.error; render(); return; }
      if (!nameResult.ok) { notice = nameResult.error; render(); return; }
      void emailSignIn(emailResult.value, nameResult.value);
    });
    const close = el('button', 'tool', 'Close');
    close.type = 'button';
    close.id = 'account-close';
    close.addEventListener('click', () => { closeDialog(); render(); });
    panel.append(
      title,
      el('p', null, 'New here? Create an account. Already joined? Sign in. Both use the same Chess sign-in.'),
      create,
      existing,
      google,
      form,
      close
    );
    if (notice) {
      const alert = el('p', 'account-notice', notice);
      alert.setAttribute('role', 'status');
      panel.append(alert);
    }
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) { closeDialog(); render(); }
    });
    overlay.append(panel);
    return overlay;
  }

  function labeled(text, control) {
    const label = el('label', 'account-field');
    label.append(el('span', null, text), control);
    return label;
  }

  async function emailSignIn(email, name) {
    try {
      await auth.signIn(email, name);
      notice = mode === 'create'
        ? 'Check ' + email + ' for the link to create your account.'
        : 'Check ' + email + ' for the sign-in link.';
    } catch (err) {
      notice = err && err.message ? err.message : 'Sign-in could not start.';
    }
    render();
  }

  async function googleSignIn() {
    try { await auth.continueWithGoogle(); }
    catch (err) {
      notice = err && err.message ? err.message : 'Google sign-in could not start.';
      render();
    }
  }

  async function signOut() {
    menuOpen = false;
    try { await auth.signOut(); } catch (err) { notice = err && err.message ? err.message : 'Sign-out could not finish.'; }
    await refresh();
  }

  async function refresh() {
    try {
      const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
      const body = response.ok ? await response.json() : null;
      view = sessionView(body);
    } catch (err) {
      view = { state: 'signed-out' };
    }
    render();
  }

  document.addEventListener('click', (event) => {
    if (!menuOpen) return;
    if (slot.contains(event.target)) return;
    closeMenu();
    render();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (dialogOpen) { closeDialog(); render(); return; }
    if (menuOpen) { closeMenu(); render(); }
  });
  window.addEventListener('chess-session', () => { void refresh(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });
  render();
  void refresh();
}

if (typeof document !== 'undefined') {
  const slotParent = document.querySelector('header.site-header');
  if (slotParent && !document.getElementById('account-slot')) {
    const slot = document.createElement('div');
    slot.id = 'account-slot';
    slot.className = 'account-slot';
    slotParent.append(slot);
    mountAccountMenu(slot);
  }
}

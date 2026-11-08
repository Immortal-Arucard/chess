const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function csrfToken() {
  const match = document.cookie.match(/(?:^|; )chess_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function sessionView(body) {
  const profile = body && body.profile;
  return {
    authenticated: !!(body && body.authenticated === true),
    displayName: profile && typeof profile.displayName === 'string' ? profile.displayName : ''
  };
}

async function readSession() {
  const response = await fetch('/api/session', { credentials: 'same-origin' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('Chess accounts are not reachable.');
  return sessionView(body);
}

function renderSession(view) {
  const status = document.getElementById('signin-status');
  const signOut = document.getElementById('signout');
  signOut.hidden = !view.authenticated;
  if (!view.authenticated) {
    status.textContent = 'Not signed in.';
    return;
  }
  status.textContent = view.displayName
    ? 'Signed in. Chess profile: ' + view.displayName + '.'
    : 'Signed in. No Chess profile yet.';
}

async function refresh() {
  renderSession(await readSession());
}

document.getElementById('signin-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const status = document.getElementById('signin-status');
  const email = document.getElementById('signin-email').value.trim();
  if (!EMAIL.test(email)) {
    status.textContent = 'Enter a valid email.';
    return;
  }
  status.textContent = 'Sending the sign-in link.';
  fetch('/api/auth/start', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', origin: location.origin },
    body: JSON.stringify({ email })
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.sent !== true) throw new Error(typeof body.error === 'string' ? body.error : 'Sign-in could not start.');
    status.textContent = 'Check your email for the sign-in link. Opening it returns to this page. No Chess profile was created.';
  }).catch((err) => {
    status.textContent = err instanceof Error ? err.message : 'Sign-in could not start.';
  });
});

document.getElementById('signout').addEventListener('click', () => {
  const status = document.getElementById('signin-status');
  fetch('/api/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() },
    body: '{}'
  }).then(async (response) => {
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(typeof body.error === 'string' ? body.error : 'Sign-out could not finish.');
    }
    await refresh();
  }).catch((err) => {
    status.textContent = err instanceof Error ? err.message : 'Sign-out could not finish.';
  });
});

refresh().catch(() => {
  document.getElementById('signin-status').textContent = 'Chess accounts are not reachable.';
});

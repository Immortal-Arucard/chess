const PENDING_NAME = 'chess.pendingDisplayName';

function failed(response, body) {
  const message = body && body.error ? body.error : 'The community request failed.';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return new Error('You appear to be offline. Community posts are not stored on this device.');
  }
  return new Error(message);
}

function csrfToken() {
  const match = document.cookie.match(/(?:^|; )chess_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

async function send(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() },
    body: JSON.stringify(body || {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw failed(response, payload);
  return payload;
}

export function createChessGateway() {
  let listener = () => {};
  return {
    suggestedName() {
      try { return sessionStorage.getItem(PENDING_NAME) || ''; } catch (err) { return ''; }
    },
    onAuth(fn) { listener = fn; },
    async session() {
      const response = await fetch('/api/session', { credentials: 'same-origin' });
      if (!response.ok) throw new Error('Chess accounts are not available.');
      const body = await response.json();
      if (!body.authenticated) return null;
      return { user: { authenticated: true } };
    },
    async profile() {
      const response = await fetch('/api/session', { credentials: 'same-origin' });
      if (!response.ok) return null;
      const body = await response.json();
      return body.profile || null;
    },
    async signIn(email, displayName) {
      try { sessionStorage.setItem(PENDING_NAME, displayName); } catch (err) { /* the name form asks again */ }
      const response = await fetch('/api/auth/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', origin: location.origin },
        body: JSON.stringify({ loginHint: email })
      });
      const body = await response.json();
      if (!response.ok || !body.redirect) throw new Error(body.error || 'Sign-in could not start.');
      location.assign(body.redirect);
    },
    async signOut() {
      await send('/api/logout');
      try { sessionStorage.removeItem(PENDING_NAME); } catch (err) { /* ignore */ }
      listener();
    },
    async saveProfile(displayName) {
      const existing = await this.profile();
      const body = existing
        ? await send('/api/profile/rename', { displayName })
        : await send('/api/join', { displayName });
      try { sessionStorage.removeItem(PENDING_NAME); } catch (err) { /* ignore */ }
      return { id: body.id, displayName: body.displayName, createdAt: body.createdAt };
    },
    async getPublicProfile(id) {
      const response = await fetch('/api/profiles/' + encodeURIComponent(id), { credentials: 'same-origin' });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error('That profile could not be loaded.');
      const body = await response.json();
      return { id: body.id, displayName: body.displayName, createdAt: body.createdAt };
    },
    async listAuthorPosts(authorId, options) {
      const cursor = options && options.cursor;
      const limit = options && options.limit ? options.limit : 20;
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor) {
        query.set('before', cursor.createdAt);
        query.set('beforeId', cursor.id);
      }
      const response = await fetch('/api/profiles/' + encodeURIComponent(authorId) + '/posts?' + query.toString(), { credentials: 'same-origin' });
      const body = await response.json();
      const posts = body.posts || [];
      return { posts, nextCursor: posts.length < limit ? null : { createdAt: posts[posts.length - 1].createdAt, id: posts[posts.length - 1].id } };
    },
    async listPosts() {
      const response = await fetch('/api/posts', { credentials: 'same-origin' });
      const body = await response.json();
      return { posts: body.posts || [], nextCursor: null };
    },
    async createPost(body) { await send('/api/posts', { body }); },
    async listReplies(postId) {
      const body = await send('/api/replies/list', { postId });
      return { replies: body.replies || [], nextCursor: null };
    },
    async createReply(postId, body) { await send('/api/replies', { postId, body }); },
    async deletePost(id) { await send('/api/posts/delete', { id }); },
    async deleteReply(id) { await send('/api/replies/delete', { id }); },
    async report(input) { await send('/api/reports', input); },
    listen() {}
  };
}

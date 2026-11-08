export const LIMITS = {
  name: 40,
  body: 2000,
  reason: 500,
  pageSize: 20
};

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function cleanName(value) {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, error: 'Enter a display name.' };
  if (name.length > LIMITS.name) return { ok: false, error: 'Display names can be at most 40 characters.' };
  if (/[\u0000-\u001F\u007F]/.test(name)) return { ok: false, error: 'Display names cannot include control characters.' };
  return { ok: true, value: name };
}

export function cleanDiscussion(value) {
  const body = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!body) return { ok: false, error: 'Enter a message.' };
  if (body.length > 1000) return { ok: false, error: 'A discussion message must be 1 to 1000 characters.' };
  if (CONTROL.test(body)) return { ok: false, error: 'That text includes a character this community does not accept.' };
  return { ok: true, value: body };
}

export function cleanBody(value) {
  const body = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!body) return { ok: false, error: 'Enter some text.' };
  if (body.length > LIMITS.body) return { ok: false, error: 'Posts and replies can be at most 2000 characters.' };
  if (CONTROL.test(body)) return { ok: false, error: 'That text includes a character this community does not accept.' };
  return { ok: true, value: body };
}

export function cleanReason(value) {
  const reason = String(value || '').replace(/\s+/g, ' ').trim();
  if (!reason) return { ok: false, error: 'Enter a short reason.' };
  if (reason.length > LIMITS.reason) return { ok: false, error: 'A report reason can be at most 500 characters.' };
  if (/[\u0000-\u001F\u007F]/.test(reason)) return { ok: false, error: 'The reason cannot include control characters.' };
  return { ok: true, value: reason };
}

export function cleanEmail(value) {
  const email = String(value || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Enter a valid email.' };
  return { ok: true, value: email };
}

export function nextCursor(rows, limit) {
  if (!rows || rows.length < limit) return null;
  const last = rows[rows.length - 1];
  return { createdAt: last.createdAt, id: last.id };
}

export function olderThan(row, cursor) {
  if (!cursor) return true;
  if (row.createdAt < cursor.createdAt) return true;
  return row.createdAt === cursor.createdAt && row.id < cursor.id;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function profilePath(id) {
  return '/community/profile/?id=' + encodeURIComponent(id);
}

export function profileExitHref(candidate) {
  void candidate;
  return '/community/';
}

export function communityRoute(location) {
  const path = String(location.pathname || '').replace(/\/index\.html$/, '');
  const normalized = path.endsWith('/') ? path : path + '/';
  if (normalized === '/community/discussion/') return { page: 'discussion' };
  return profileRoute(location);
}

export function profileRoute(location) {
  const path = String(location.pathname || '').replace(/\/index\.html$/, '');
  const normalized = path.endsWith('/') ? path : path + '/';
  if (normalized !== '/community/profile/') return { page: 'feed' };
  const id = new URLSearchParams(location.search || '').get('id') || '';
  if (!id) return { page: 'profile', valid: false, reason: 'missing', id: '' };
  if (!UUID.test(id)) return { page: 'profile', valid: false, reason: 'invalid', id };
  return { page: 'profile', valid: true, reason: '', id };
}

export function chessAccess({ authenticated, chessProfile }) {
  return {
    authenticated: !!authenticated,
    chessMember: !!chessProfile,
    otherServices: []
  };
}

export function publicProfile(row) {
  if (!row || !row.id) return null;
  return {
    id: row.id,
    displayName: row.display_name || row.displayName || 'Member',
    createdAt: row.created_at || row.createdAt || ''
  };
}

export function feedFilter(cursor) {
  if (!cursor) return null;
  const time = JSON.stringify(cursor.createdAt);
  return `and(created_at.eq.${time},id.lt.${cursor.id}),created_at.lt.${time}`;
}

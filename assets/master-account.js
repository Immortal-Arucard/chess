// Owner-only master account links and avatar helpers. This file does not
// know about Chess. On the master host, /login/ and /account/ stay
// same-origin. Every other host prefixes them with the master origin.

export const MASTER_ORIGIN = 'https://theworldgovernmentincorporated.com';
export const MASTER_ACCOUNT_HREF = MASTER_ORIGIN + '/account/';
export const MASTER_LOGIN_HREF = MASTER_ORIGIN + '/login/';

export function masterHref(path, hostname) {
  if (hostname === 'theworldgovernmentincorporated.com') return path;
  return MASTER_ORIGIN + path;
}

export function httpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.href;
  } catch (err) {
    return '';
  }
}

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

export function masterLook(master) {
  const name = master && String(master.displayName || '').trim() ? String(master.displayName).trim() : 'Account';
  return {
    name,
    avatarUrl: httpsUrl(master && master.avatarUrl),
    initials: initials(name)
  };
}

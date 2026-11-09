// Owner-only master account look. This file does not know about Chess.
// Copy it into another sub-site and pass that site's section descriptor
// to resolveAccountLook in section-account.js.

export const MASTER_ACCOUNT_HREF = 'https://theworldgovernmentincorporated.com/account/';

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

export function masterMenu(joinItem) {
  const items = [];
  if (joinItem && joinItem.label && joinItem.href) items.push({ id: 'join', label: String(joinItem.label), href: String(joinItem.href) });
  items.push({ id: 'master-account', label: 'Master account', href: MASTER_ACCOUNT_HREF });
  items.push({ id: 'log-out', label: 'Log out', action: 'sign-out' });
  return items;
}

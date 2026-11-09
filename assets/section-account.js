import { httpsUrl, initials, masterHref } from './master-account.js';

// Chess header shell. The section object uses the main-site contract in
// assets/account-sections.js. This origin always evaluates that section:
// the visitor is already on Chess, including a local preview host.
//
// sectionId, label, host, pathPrefixes, signInUrl
// hasLocalAccount(session) -> boolean or Promise. Called only when signed in.
// localProfile(session) -> { name, avatarUrl, url }
// menuItems: [{ label, href } | { label, action: 'sign-out' }]
// session is { user: { id, email, user_metadata, created_at } } and has no access token.
// A throw, a rejection, or a missing name or url shows the master control.

export function callbackSession(user) {
  const source = user && typeof user === 'object' ? user : {};
  const metadata = source.user_metadata && typeof source.user_metadata === 'object' ? source.user_metadata : {};
  return {
    user: {
      id: source.id == null ? '' : String(source.id),
      email: source.email == null ? '' : String(source.email),
      user_metadata: { ...metadata },
      created_at: source.created_at == null ? '' : String(source.created_at)
    }
  };
}

export function safeHref(value) {
  const raw = String(value || '').trim();
  if (raw.charAt(0) === '/' && raw.charAt(1) !== '/' && !raw.includes('\\')) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return url.href;
  } catch (err) {
    return '';
  }
  return '';
}

function localMenu(section, url) {
  const custom = section && Array.isArray(section.menuItems) ? section.menuItems : null;
  const items = custom && custom.length ? custom : [
    { label: 'Account', href: url },
    { label: 'Log out', action: 'sign-out' }
  ];
  return items.map((item) => {
    if (!item || !item.label) return null;
    if (item.action === 'sign-out') return { label: String(item.label), action: 'sign-out' };
    const href = safeHref(item.href);
    if (!href) return null;
    return { label: String(item.label), href };
  }).filter(Boolean);
}

function masterMenu(section, hostname) {
  const items = [];
  if (section && section.sectionId === 'chess') items.push({ label: 'Join Chess', href: '/community/' });
  items.push({ label: 'Master account', href: masterHref('/account/', hostname) });
  items.push({ label: 'Log out', action: 'sign-out' });
  return items;
}

function masterView(master, section, hostname) {
  const name = master && String(master.displayName || '').trim() ? String(master.displayName).trim() : 'Account';
  return {
    kind: 'master',
    sectionId: section ? String(section.sectionId || '') : '',
    name,
    avatarUrl: httpsUrl(master && master.avatarUrl),
    initials: initials(name),
    url: masterHref('/account/', hostname),
    menu: masterMenu(section, hostname)
  };
}

export async function resolveAccountLook(section, auth, hostname) {
  const host = hostname == null ? '' : String(hostname);
  if (!auth || auth.signedIn !== true) return { kind: 'signed-out' };
  if (!section || typeof section.hasLocalAccount !== 'function') return masterView(auth.master, section, host);
  const session = callbackSession(auth.user);
  try {
    const has = await section.hasLocalAccount(session);
    if (!has || typeof section.localProfile !== 'function') return masterView(auth.master, section, host);
    const profile = await section.localProfile(session);
    const name = profile && String(profile.name || '').trim();
    const url = safeHref(profile && profile.url);
    if (!name || !url) return masterView(auth.master, section, host);
    return {
      kind: 'local',
      sectionId: String(section.sectionId || ''),
      name,
      avatarUrl: httpsUrl(profile.avatarUrl),
      initials: initials(name),
      url,
      menu: localMenu(section, url)
    };
  } catch (err) {
    return masterView(auth.master, section, host);
  }
}

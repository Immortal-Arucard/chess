import { profilePath } from './community-model.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PORTRAIT_CACHE_LIMIT = 32;
export const PORTRAIT_RETRY_DELAYS = [2000, 8000, 30000];

const portraits = new Map();
const recent = [];
const generations = new Map();
const displays = new Map();

function generationOf(key) {
  return generations.get(key) || 0;
}

export function elementShown(node) {
  if (!node) return false;
  if (typeof node.isConnected === 'boolean') return node.isConnected;
  let current = node;
  while (current) {
    if (typeof document !== 'undefined' && (current === document || current === document.body || current === document.documentElement)) return true;
    current = current.parentNode;
  }
  return false;
}

function revoke(url) {
  if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}

function liveDisplays(key) {
  const set = displays.get(key);
  if (!set) return 0;
  for (const img of set) if (!elementShown(img)) set.delete(img);
  if (!set.size) displays.delete(key);
  return set ? set.size : 0;
}

function rememberDisplay(key, img) {
  let set = displays.get(key);
  if (!set) {
    set = new Set();
    displays.set(key, set);
  }
  set.add(img);
}

function touch(key) {
  const index = recent.indexOf(key);
  if (index !== -1) recent.splice(index, 1);
  recent.push(key);
}

function cachedImages() {
  return recent.filter((key) => {
    const entry = portraits.get(key);
    return entry && entry.status === 'image' && entry.url;
  });
}

function evict(keep) {
  let images = cachedImages();
  while (images.length > PORTRAIT_CACHE_LIMIT) {
    const victim = images.find((key) => key !== keep && liveDisplays(key) === 0);
    if (!victim) break;
    const entry = portraits.get(victim);
    revoke(entry && entry.url);
    portraits.delete(victim);
    displays.delete(victim);
    const index = recent.indexOf(victim);
    if (index !== -1) recent.splice(index, 1);
    images = images.filter((key) => key !== victim);
  }
}

function failureEntry(previous) {
  const attempts = ((previous && previous.attempts) || 0) + 1;
  const delay = PORTRAIT_RETRY_DELAYS[Math.min(attempts - 1, PORTRAIT_RETRY_DELAYS.length - 1)];
  return { status: 'unavailable', attempts, retryAt: Date.now() + delay };
}

export function markPortraitUnavailable(id, url) {
  const key = String(id || '');
  const existing = portraits.get(key);
  if (url && existing && existing.url && existing.url !== url) return existing;
  if (existing && existing.url) revoke(existing.url);
  const stored = failureEntry(existing && existing.status !== 'pending' ? existing : null);
  portraits.set(key, stored);
  displays.delete(key);
  const index = recent.indexOf(key);
  if (index !== -1) recent.splice(index, 1);
  return stored;
}

export function forgetAuthorPortrait(id) {
  const key = String(id || '');
  generations.set(key, generationOf(key) + 1);
  const existing = portraits.get(key);
  if (existing && existing.url) revoke(existing.url);
  portraits.delete(key);
  displays.delete(key);
  const index = recent.indexOf(key);
  if (index !== -1) recent.splice(index, 1);
}

export function authorChip(name, id) {
  const link = document.createElement('a');
  link.className = 'author-chip';
  link.href = profilePath(id);
  const avatar = document.createElement('span');
  avatar.className = 'author-avatar is-pending';
  avatar.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'author-name';
  label.textContent = name || 'Member';
  link.append(avatar, label);
  const key = String(id || '');
  const known = portraits.get(key);
  if (known && known.status === 'image' && known.url && !known.promise) {
    touch(key);
    paintAvatar(avatar, known, key);
    return link;
  }
  if (known && known.status === 'absent' && !known.promise) {
    paintAvatar(avatar, known, key);
    return link;
  }
  if (known && known.status === 'unavailable' && !known.promise && known.retryAt > Date.now()) {
    paintAvatar(avatar, known, key);
    return link;
  }
  const started = generationOf(key);
  portraitFor(key).then((result) => {
    if (!elementShown(avatar) || generationOf(key) !== started || !result || result.status === 'stale') return;
    paintAvatar(avatar, result, key);
  });
  return link;
}

export function portraitFor(id) {
  const key = String(id || '');
  const existing = portraits.get(key);
  if (existing && existing.promise) return existing.promise;
  if (existing && (existing.status === 'image' || existing.status === 'absent')) {
    if (existing.status === 'image') touch(key);
    return Promise.resolve(existing);
  }
  if (existing && existing.status === 'unavailable' && existing.retryAt > Date.now()) return Promise.resolve(existing);
  const generation = generationOf(key);
  let promise;
  promise = readPortrait(key).then((result) => {
    if (generationOf(key) !== generation) {
      if (result && result.url) revoke(result.url);
      if (portraits.get(key) && portraits.get(key).promise === promise) portraits.delete(key);
      return { status: 'stale' };
    }
    if (result && result.ephemeral) {
      if (portraits.get(key) && portraits.get(key).promise === promise) portraits.delete(key);
      return { status: result.status };
    }
    if (!result || result.status === 'unavailable') {
      const stored = failureEntry(existing);
      portraits.set(key, stored);
      return stored;
    }
    const stored = { status: result.status, url: result.url };
    portraits.set(key, stored);
    if (stored.status === 'image' && stored.url) {
      touch(key);
      evict(key);
    }
    return portraits.get(key) || stored;
  });
  portraits.set(key, { status: 'pending', promise, attempts: existing && existing.attempts || 0 });
  return promise;
}

function paintAvatar(avatar, result, id) {
  const status = result && result.status === 'image' && result.url ? 'picture' : (result && result.status) || 'unavailable';
  avatar.className = 'author-avatar is-' + (status === 'pending' ? 'pending' : status);
  avatar.replaceChildren();
  if (status === 'picture') {
    avatar.removeAttribute('title');
    const img = document.createElement('img');
    img.alt = '';
    img.width = 32;
    img.height = 32;
    img.draggable = false;
    rememberDisplay(id, img);
    img.addEventListener('error', () => {
      markPortraitUnavailable(id, result.url);
      if (!elementShown(avatar)) return;
      paintAvatar(avatar, portraits.get(id) || { status: 'unavailable' }, id);
    });
    img.src = result.url;
    avatar.append(img);
    return;
  }
  if (status === 'absent') avatar.setAttribute('title', 'No profile picture');
  else if (status === 'unavailable') avatar.setAttribute('title', 'Profile picture unavailable');
  else avatar.removeAttribute('title');
}

async function readPortrait(id) {
  if (!UUID.test(id)) return { status: 'absent' };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { status: 'unavailable', ephemeral: true };
  try {
    const response = await fetch('/api/profiles/' + encodeURIComponent(id) + '/portrait', {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (response.status === 404) return { status: 'absent' };
    if (!response.ok) return { status: 'unavailable' };
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    const mime = type.split(';', 1)[0].trim();
    if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp') return { status: 'unavailable' };
    const blob = await response.blob();
    if (!blob || blob.size < 16 || typeof URL.createObjectURL !== 'function') return { status: 'unavailable' };
    return { status: 'image', url: URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: mime })) };
  } catch (err) {
    return { status: 'unavailable' };
  }
}

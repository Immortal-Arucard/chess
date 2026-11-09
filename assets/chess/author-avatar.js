import { profilePath } from './community-model.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const portraits = new Map();

export function forgetAuthorPortrait(id) {
  const key = String(id || '');
  const existing = portraits.get(key);
  if (existing && existing.url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(existing.url);
  portraits.delete(key);
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
  if (known && known.status && !known.promise) {
    paintAvatar(avatar, known, key);
    return link;
  }
  portraitFor(key).then((result) => {
    if (!avatar.parentNode) return;
    paintAvatar(avatar, result, key);
  });
  return link;
}

export function portraitFor(id) {
  const key = String(id || '');
  const existing = portraits.get(key);
  if (existing && existing.promise) return existing.promise;
  if (existing && existing.status) return Promise.resolve(existing);
  let promise;
  promise = readPortrait(key).then((result) => {
    if (result.ephemeral) {
      if (portraits.get(key) && portraits.get(key).promise === promise) portraits.delete(key);
      return { status: result.status };
    }
    const stored = { status: result.status, url: result.url };
    portraits.set(key, stored);
    return stored;
  });
  portraits.set(key, { status: 'pending', promise });
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
    img.src = result.url;
    img.addEventListener('error', () => {
      const failed = portraits.get(id);
      if (failed && failed.url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(failed.url);
      portraits.set(id, { status: 'unavailable' });
      if (!avatar.parentNode) return;
      paintAvatar(avatar, { status: 'unavailable' }, id);
    });
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

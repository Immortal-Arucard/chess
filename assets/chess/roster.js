import { authorChip } from './author-avatar.js';

const root = document.getElementById('roster-app');
const CATEGORIES = [
  ['bullet', 'Bullet'],
  ['blitz', 'Blitz'],
  ['rapid', 'Rapid'],
  ['daily', 'Daily'],
  ['untimed', 'Untimed'],
  ['puzzles', 'Puzzles']
];
const SORTS = [
  ['name', 'Name'],
  ['newest', 'Newest'],
  ['bullet', 'Bullet rating'],
  ['blitz', 'Blitz rating'],
  ['rapid', 'Rapid rating'],
  ['daily', 'Daily rating'],
  ['untimed', 'Untimed rating']
];

let query = '';
let sort = 'name';
let members = [];
let next = null;
let total = null;
let notice = '';
let loading = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function offlineNow() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function ratingMark(value) {
  const node = el('span', 'roster-score', value == null ? '\u2014' : String(value));
  node.setAttribute('aria-label', value == null ? 'Unrated' : String(value));
  return node;
}

async function load(cursor, append) {
  if (offlineNow()) {
    notice = 'The roster needs a connection. Account names are not stored on this device.';
    paint();
    return;
  }
  loading = true;
  notice = '';
  paint();
  const params = new URLSearchParams();
  params.set('sort', sort);
  params.set('limit', '24');
  if (query) params.set('q', query);
  if (cursor && cursor.id) {
    params.set('beforeId', cursor.id);
    if (cursor.rating != null) params.set('beforeName', String(cursor.rating));
    else if (cursor.name) params.set('beforeName', cursor.name);
    if (cursor.createdAt) params.set('before', cursor.createdAt);
  }
  try {
    const response = await fetch('/api/community/roster?' + params.toString(), { cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'The roster needs a connection. Account names are not stored on this device.');
    const page = Array.isArray(body.members) ? body.members : [];
    members = append ? members.concat(page) : page;
    next = body.next || null;
    total = Number.isFinite(body.total) ? body.total : page.length;
    notice = '';
  } catch (err) {
    if (!append) members = [];
    next = null;
    notice = offlineNow() || !navigator.onLine
      ? 'The roster needs a connection. Account names are not stored on this device.'
      : (err.message || 'The roster needs a connection. Account names are not stored on this device.');
  }
  loading = false;
  paint();
}

function paint() {
  const field = document.getElementById('roster-search');
  const draft = field ? field.value : query;
  root.replaceChildren();
  const tools = el('div', 'roster-tools');
  const input = document.createElement('input');
  input.id = 'roster-search';
  input.type = 'search';
  input.maxLength = 40;
  input.value = draft;
  input.placeholder = 'Display name';
  input.setAttribute('aria-label', 'Search display names');
  const search = el('button', 'tool', 'Search');
  search.type = 'button';
  search.id = 'roster-find';
  search.addEventListener('click', () => {
    query = input.value.trim();
    load(null, false);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      query = input.value.trim();
      load(null, false);
    }
  });
  tools.append(input, search);
  const sorts = el('label', 'roster-sorts', 'Sort');
  const select = document.createElement('select');
  select.id = 'roster-sort';
  SORTS.forEach(([id, label]) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = label;
    option.selected = sort === id;
    select.append(option);
  });
  select.addEventListener('change', () => {
    sort = select.value;
    load(null, false);
  });
  sorts.append(select);
  tools.append(sorts);
  root.append(tools);
  if (notice) root.append(el('p', 'community-error', notice));
  if (total != null && !notice) {
    root.append(el('p', 'roster-count', total === 1 ? '1 account' : total + ' accounts'));
  }
  const list = el('div', 'roster-list');
  list.id = 'roster-list';
  members.forEach((member) => {
    if (!member || !member.id) return;
    const row = document.createElement('a');
    row.className = 'roster-row';
    row.href = '/community/profile/?id=' + encodeURIComponent(member.id);
    const person = authorChip(member.displayName || 'Member', member.id, { linked: false });
    person.classList.add('roster-person');
    const ratings = el('span', 'roster-ratings');
    CATEGORIES.forEach(([key, label]) => {
      const slot = el('span', 'roster-rating');
      slot.append(el('b', null, label), ratingMark(member.ratings ? member.ratings[key] : null));
      ratings.append(slot);
    });
    row.append(person, ratings);
    list.append(row);
  });
  if (!loading && !notice && members.length === 0) {
    list.append(el('p', 'roster-empty', 'No Chess accounts match that name.'));
  }
  root.append(list);
  if (next && next.id) {
    const more = el('button', 'tool', loading ? 'Loading…' : 'More accounts');
    more.type = 'button';
    more.id = 'roster-more';
    more.disabled = loading;
    more.addEventListener('click', () => load(next, true));
    root.append(more);
  }
}

window.addEventListener('online', () => load(null, false));
window.addEventListener('offline', () => {
  notice = 'The roster needs a connection. Account names are not stored on this device.';
  paint();
});
load(null, false);

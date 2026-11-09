import assert from 'node:assert/strict';

class Node {
  constructor(tag) {
    this.tagName = tag;
    this.className = '';
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.listeners = {};
    this._text = '';
    this.src = '';
  }
  set textContent(value) {
    this._text = value == null ? '' : String(value);
    this.children = [];
  }
  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join('');
    return this._text;
  }
  get isConnected() {
    let current = this;
    while (current) {
      if (current === document.body || current === document.documentElement) return true;
      current = current.parentNode;
    }
    return false;
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  append(...nodes) {
    nodes.forEach((node) => {
      node.parentNode = this;
      this.children.push(node);
    });
  }
  replaceChildren(...nodes) {
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = [];
    if (nodes.length) this.append(...nodes);
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
}

const body = new Node('body');
globalThis.document = {
  body,
  documentElement: body,
  createElement(tag) { return new Node(tag); }
};
let seq = 0;
const created = [];
const revoked = [];
URL.createObjectURL = () => {
  const url = 'blob:portrait-' + (++seq);
  created.push(url);
  return url;
};
URL.revokeObjectURL = (url) => revoked.push(url);
let clock = 100000;
Date.now = () => clock;

const { PORTRAIT_CACHE_LIMIT, PORTRAIT_RETRY_DELAYS, authorChip, forgetAuthorPortrait, portraitFor } = await import('./author-avatar.js');
const mina = '11111111-1111-4111-8111-111111111111';
const julian = '22222222-2222-4222-8222-222222222222';
const nora = '33333333-3333-4333-8333-333333333333';
const bytes = new Uint8Array(32).fill(7);
let calls = [];
let mode = 'image';
let release;
let gate = new Promise((resolve) => { release = resolve; });
let online = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, get() { return { onLine: online }; } });

function imageResponse() {
  return { status: 200, ok: true, headers: { get: () => 'image/png' }, blob: async () => new Blob([bytes], { type: 'image/png' }) };
}
globalThis.fetch = (url) => {
  calls.push(String(url));
  return gate.then(() => {
    if (mode === 'missing') return { status: 404, ok: false, headers: { get: () => 'application/json' }, blob: async () => new Blob() };
    if (mode === 'text') return { status: 200, ok: true, headers: { get: () => 'text/plain' }, blob: async () => new Blob(['nope']) };
    if (mode === 'down') return { status: 503, ok: false, headers: { get: () => 'text/plain' }, blob: async () => new Blob(['busy']) };
    if (mode === 'throw') return Promise.reject(new Error('network'));
    return imageResponse();
  });
};

function mount(node) {
  document.body.append(node);
  return node;
}

const first = mount(authorChip('Mina Chen', mina));
const second = authorChip('Mina Chen', mina);
assert.equal(calls.length, 1);
assert.equal(first.children[0].className, 'author-avatar is-pending');
assert.equal(first.children[1].textContent, 'Mina Chen');
assert.equal(first.href, '/community/profile/?id=' + mina);
assert.equal(second.isConnected, false);
release();
await portraitFor(mina);
assert.equal(first.children[0].className, 'author-avatar is-picture');
assert.equal(first.children[0].children[0].tagName, 'img');
assert.equal(first.children[0].children[0].alt, '');
assert.equal(second.children[0].className, 'author-avatar is-pending');
assert.equal(second.children[0].parentNode, second);
mount(second);
const third = mount(authorChip('Mina Chen', mina));
assert.equal(calls.length, 1);
assert.equal(third.children[0].className, 'author-avatar is-picture');
assert.equal(second.children[0].className, 'author-avatar is-pending');

mode = 'missing';
gate = Promise.resolve();
const missing = mount(authorChip('Julian Park', julian));
await portraitFor(julian);
assert.equal(missing.children[0].className, 'author-avatar is-absent');
assert.equal(missing.children[0].children.length, 0);
assert.equal(missing.children[0].attrs.title, 'No profile picture');
assert.equal(missing.textContent, 'Julian Park');
const missingCalls = calls.length;
clock += 60000;
await portraitFor(julian);
assert.equal(calls.length, missingCalls);

mode = 'text';
const broken = mount(authorChip('Nora Ellison', nora));
await portraitFor(nora);
assert.equal(broken.children[0].className, 'author-avatar is-unavailable');
assert.equal(broken.children[0].attrs.title, 'Profile picture unavailable');
assert.equal(broken.children[0].children.length, 0);

const beforeOdd = calls.length;
mode = 'image';
const odd = authorChip('Member', 'not-an-id');
await portraitFor('not-an-id');
assert.equal(calls.length, beforeOdd);
assert.equal(odd.children[0].parentNode, odd);
assert.equal(odd.isConnected, false);
assert.equal(odd.children[0].className, 'author-avatar is-pending');
const oddShown = mount(authorChip('Member', 'not-an-id'));
assert.equal(oddShown.children[0].className, 'author-avatar is-absent');

const fresh = '55555555-5555-4555-8555-555555555555';
mode = 'image';
const queued = [];
globalThis.fetch = (url) => {
  calls.push(String(url));
  return new Promise((resolve) => queued.push(resolve));
};
const staleRequest = portraitFor(fresh);
forgetAuthorPortrait(fresh);
const freshRequest = portraitFor(fresh);
assert.equal(queued.length, 2);
queued[0](imageResponse());
const stale = await staleRequest;
queued[1](imageResponse());
const saved = await freshRequest;
assert.equal(stale.status, 'stale');
assert.equal(saved.status, 'image');
assert.equal(revoked.includes(created[created.length - 2]), true);
assert.equal(revoked.includes(saved.url), false);
assert.notEqual(saved.url, created[created.length - 2]);
const shown = mount(authorChip('Mina Chen', fresh));
assert.equal(shown.children[0].children[0].src, saved.url);

const flaky = '66666666-6666-4666-8666-666666666666';
mode = 'down';
let flakyCalls = 0;
globalThis.fetch = (url) => {
  calls.push(String(url));
  flakyCalls += 1;
  if (mode === 'throw') return Promise.reject(new Error('network'));
  if (mode === 'down') return Promise.resolve({ status: 503, ok: false, headers: { get: () => 'text/plain' }, blob: async () => new Blob(['busy']) });
  return Promise.resolve(imageResponse());
};
const failed = await portraitFor(flaky);
assert.equal(failed.status, 'unavailable');
assert.equal(flakyCalls, 1);
await Promise.all([portraitFor(flaky), portraitFor(flaky), portraitFor(flaky)]);
assert.equal(flakyCalls, 1);
clock += PORTRAIT_RETRY_DELAYS[0] - 1;
await portraitFor(flaky);
assert.equal(flakyCalls, 1);
clock += 1;
await Promise.all([portraitFor(flaky), portraitFor(flaky)]);
assert.equal(flakyCalls, 2);
mode = 'throw';
clock += PORTRAIT_RETRY_DELAYS[1];
await portraitFor(flaky);
assert.equal(flakyCalls, 3);
mode = 'image';
clock += PORTRAIT_RETRY_DELAYS[2];
const recovered = await portraitFor(flaky);
assert.equal(recovered.status, 'image');
const afterRecovery = flakyCalls;
await Promise.all([portraitFor(flaky), portraitFor(flaky)]);
assert.equal(flakyCalls, afterRecovery);

forgetAuthorPortrait(mina);
const keptUrl = saved.url;
const keptId = fresh;
for (let index = 0; index < PORTRAIT_CACHE_LIMIT; index += 1) {
  const id = '77777777-7777-4777-8777-' + String(index).padStart(12, '0');
  await portraitFor(id);
}
assert.equal(revoked.includes(keptUrl), false);
document.body.replaceChildren();
await portraitFor('88888888-8888-4888-8888-888888888888');
assert.equal(revoked.includes(keptUrl), true);
const again = await portraitFor(keptId);
assert.notEqual(again.url, keptUrl);
assert.equal(again.status, 'image');

online = false;
const helen = '44444444-4444-4444-8444-444444444444';
const beforeHelen = calls.length;
const offline = mount(authorChip('Helen Ward', helen));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(calls.length, beforeHelen);
assert.equal(offline.children[0].className, 'author-avatar is-unavailable');
online = true;
await portraitFor(helen);
assert.ok(calls.some((url) => url.includes(helen)));
console.log('author avatar tests passed');

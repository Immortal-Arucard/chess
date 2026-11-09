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
  }
  set textContent(value) {
    this._text = value == null ? '' : String(value);
    this.children = [];
  }
  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join('');
    return this._text;
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
  addEventListener(type, fn) { this.listeners[type] = fn; }
}

globalThis.document = { createElement(tag) { return new Node(tag); } };
if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = (blob) => 'blob:avatar-' + blob.size;
if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = () => {};

const { authorChip, forgetAuthorPortrait, portraitFor } = await import('./author-avatar.js');
const mina = '11111111-1111-4111-8111-111111111111';
const julian = '22222222-2222-4222-8222-222222222222';
const nora = '33333333-3333-4333-8333-333333333333';
const bytes = new Uint8Array(32).fill(7);
let calls = [];
let release;
let gate = new Promise((resolve) => { release = resolve; });

globalThis.fetch = (url) => {
  calls.push(String(url));
  return gate.then(() => respond(String(url)));
};
let online = true;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  get() { return { onLine: online }; }
});

function respond(url) {
  if (url.includes(julian)) return { status: 404, ok: false, headers: { get: () => 'application/json' }, blob: async () => new Blob() };
  if (url.includes(nora)) return { status: 200, ok: true, headers: { get: () => 'text/plain' }, blob: async () => new Blob(['nope']) };
  return { status: 200, ok: true, headers: { get: () => 'image/png' }, blob: async () => new Blob([bytes], { type: 'image/png' }) };
}

const first = authorChip('Mina Chen', mina);
const second = authorChip('Mina Chen', mina);
assert.equal(calls.length, 1);
assert.equal(first.children[0].className, 'author-avatar is-pending');
assert.equal(first.children[1].textContent, 'Mina Chen');
assert.equal(first.attrs.href || first.href, '/community/profile/?id=' + mina);
release();
await portraitFor(mina);
assert.equal(first.children[0].className, 'author-avatar is-picture');
assert.equal(first.children[0].children[0].tagName, 'img');
assert.equal(first.children[0].children[0].attrs.alt || '', '');
assert.equal(second.children[0].className, 'author-avatar is-picture');
const third = authorChip('Mina Chen', mina);
assert.equal(calls.length, 1);
assert.equal(third.children[0].className, 'author-avatar is-picture');

const missing = authorChip('Julian Park', julian);
await portraitFor(julian);
assert.equal(missing.children[0].className, 'author-avatar is-absent');
assert.equal(missing.children[0].children.length, 0);
assert.equal(missing.children[0].attrs.title, 'No profile picture');
assert.equal(missing.textContent, 'Julian Park');

const broken = authorChip('Nora Ellison', nora);
await portraitFor(nora);
assert.equal(broken.children[0].className, 'author-avatar is-unavailable');
assert.equal(broken.children[0].attrs.title, 'Profile picture unavailable');
assert.equal(broken.children[0].children.length, 0);

const before = calls.length;
const odd = authorChip('Member', 'not-an-id');
await portraitFor('not-an-id');
assert.equal(calls.length, before);
assert.equal(odd.children[0].className, 'author-avatar is-absent');

forgetAuthorPortrait(mina);
gate = new Promise((resolve) => { release = resolve; });
globalThis.fetch = (url) => {
  calls.push(String(url));
  return gate.then(() => respond(String(url)));
};
const again = authorChip('Mina Chen', mina);
assert.equal(again.children[0].className, 'author-avatar is-pending');
assert.equal(calls.filter((url) => url.includes(mina)).length, 2);
release();
await portraitFor(mina);
assert.equal(again.children[0].className, 'author-avatar is-picture');

online = false;
const helen = '44444444-4444-4444-8444-444444444444';
const offline = authorChip('Helen Ward', helen);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(calls.some((url) => url.includes(helen)), false);
assert.equal(offline.children[0].className, 'author-avatar is-unavailable');
console.log('author avatar tests passed');

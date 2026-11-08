import assert from 'node:assert/strict';

function installDom() {
  const active = { current: null };
  class Node {
    constructor(tag) {
      this.tagName = tag;
      this.className = '';
      this.id = '';
      this.children = [];
      this.parentNode = null;
      this.listeners = {};
      this.hidden = false;
      this.value = '';
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.attrs = {};
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
    focus() { active.current = this; }
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    }
    querySelector(selector) {
      const id = selector.startsWith('#') ? selector.slice(1) : '';
      const walk = (node) => {
        if (!node || node.id !== id) {
          for (const child of (node && node.children) || []) {
            const found = walk(child);
            if (found) return found;
          }
          return node && node.id === id ? node : null;
        }
        return node;
      };
      return walk(this);
    }
  }
  globalThis.document = {
    hidden: false,
    createElement(tag) { return new Node(tag); },
    createTextNode(text) {
      const node = new Node('#text');
      node._text = String(text);
      return node;
    },
    get activeElement() { return active.current; }
  };
  globalThis.window = {
    setInterval(fn) { globalThis.window.tick = fn; return 1; },
    clearInterval() {},
    addEventListener() {}
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

installDom();
const { mountDiscussion } = await import('./community-view.js');

const ada = 'aaaaaaaa-aaaa-4aaa-8aaa-00000000000a';
const bob = 'bbbbbbbb-bbbb-4bbb-8bbb-00000000000b';

function message(id, body, createdAt, authorId) {
  return { id, authorId: authorId || ada, authorName: authorId === bob ? 'Bob' : 'Ada', body, createdAt };
}

function mount(gateway) {
  const root = document.createElement('div');
  mountDiscussion(root, { configured: true, gateway });
  return root;
}

const kept = mount({
  async profile() { return { id: ada, displayName: 'Ada' }; },
  async listDiscussion(options) {
    if (options && options.after) return { messages: [message('m2', 'later', '2026-11-08T00:00:02.000Z')] };
    return { messages: [message('m1', 'first', '2026-11-08T00:00:01.000Z')] };
  },
  async sendDiscussion() { throw new Error('the draft was sent'); }
});
await flush();
const box = kept.querySelector('#discussion-body');
box.focus();
box.value = 'keep this draft';
box.selectionStart = 5;
box.selectionEnd = 9;
box.listeners.input();
await window.tick();
assert.equal(kept.querySelector('#discussion-body'), box);
assert.equal(box.value, 'keep this draft');
assert.equal(box.selectionStart, 5);
assert.equal(box.selectionEnd, 9);
assert.equal(document.activeElement, box);
assert.match(kept.querySelector('#discussion-log').textContent, /later/);

let speaker = { id: ada, displayName: 'Ada' };
const sent = [];
const switched = mount({
  async profile() { return speaker; },
  async listDiscussion() { return { messages: [] }; },
  async sendDiscussion(body, authorId) {
    sent.push({ body, authorId });
    return message('sent', body, '2026-11-08T00:00:03.000Z', authorId);
  }
});
await flush();
const draft = switched.querySelector('#discussion-body');
draft.value = 'from ada';
draft.listeners.input();
speaker = { id: bob, displayName: 'Bob' };
switched.querySelector('#discussion-send').listeners.click();
await flush();
assert.equal(sent.length, 0);
assert.equal(switched.querySelector('#discussion-body').value, '');
assert.match(switched.textContent, /different Chess profile/);

speaker = { id: ada, displayName: 'Ada' };
const own = mount({
  async profile() { return speaker; },
  async listDiscussion() { return { messages: [] }; },
  async sendDiscussion(body, authorId) {
    sent.push({ body, authorId });
    return message('own', body, '2026-11-08T00:00:04.000Z', authorId);
  }
});
await flush();
const ownBox = own.querySelector('#discussion-body');
ownBox.value = 'from ada';
ownBox.listeners.input();
own.querySelector('#discussion-send').listeners.click();
await flush();
assert.equal(sent.length, 1);
assert.equal(sent[0].body, 'from ada');
assert.equal(sent[0].authorId, ada);
assert.equal(own.querySelector('#discussion-body').value, '');

const cursors = [];
const burst = mount({
  async profile() { return { id: ada, displayName: 'Ada' }; },
  async listDiscussion(options) {
    if (!options || !options.after) return { messages: [message('m00', 'seed', '2026-11-08T00:00:00.000Z')] };
    cursors.push(options.after.id);
    const page = cursors.length;
    return {
      messages: Array.from({ length: 20 }, (_, index) => message(
        'p' + page + '-' + String(index).padStart(2, '0'),
        'burst ' + page,
        '2026-11-08T00:01:' + String(page).padStart(2, '0') + '.' + String(index).padStart(3, '0') + 'Z'
      ))
    };
  },
  async sendDiscussion() { throw new Error('not used'); }
});
await flush();
await window.tick();
assert.equal(cursors.length, 5);
assert.equal(cursors[1], 'p1-19');
assert.equal(cursors[4], 'p4-19');
assert.match(burst.querySelector('#discussion-log').textContent, /burst 5/);

console.log('discussion room tests passed');

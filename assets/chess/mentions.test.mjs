import assert from 'node:assert/strict';
import { mentionParts } from './mentions.js';

const julian = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const body = 'Hello @"Julian Park" and @Mina';
const parts = mentionParts(body, [
  { id: julian, start: 6, end: 20, text: '@"Julian Park"' },
  { id: 'not-a-uuid', start: 25, end: 30, text: '@Mina' },
  { id: julian, start: 0, end: 5, text: 'nope' }
]);
assert.deepEqual(parts, [
  { type: 'text', text: 'Hello ' },
  { type: 'link', text: '@"Julian Park"', href: '/community/profile/?id=' + julian },
  { type: 'text', text: ' and @Mina' }
]);
assert.deepEqual(mentionParts('plain', [{ id: julian, start: 0, end: 5, text: 'nope' }]), [{ type: 'text', text: 'plain' }]);
console.log('mention render tests passed');

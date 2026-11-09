import assert from 'node:assert/strict';
import { sessionView } from './account-menu.js';

assert.deepEqual(sessionView(null), { state: 'signed-out' });
assert.deepEqual(sessionView({ authenticated: false }), { state: 'signed-out' });
assert.deepEqual(sessionView({ authenticated: true }), { state: 'needs-profile' });
assert.deepEqual(sessionView({ authenticated: true, profile: null }), { state: 'needs-profile' });
assert.deepEqual(sessionView({
  authenticated: true,
  profile: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', displayName: '  Mina Chen  ', hasPortrait: true }
}), {
  state: 'signed-in',
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  name: 'Mina Chen',
  hasPortrait: true
});
assert.equal(sessionView({ authenticated: true, profile: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', displayName: '   ' } }).name, 'Member');
console.log('account menu session tests passed');

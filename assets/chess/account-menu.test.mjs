import assert from 'node:assert/strict';
import { httpsUrl, initials, masterLook } from '../master-account.js';
import { resolveAccountLook } from '../section-account.js';
import { chessSection } from './chess-section.js';

const chessId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const master = { displayName: 'Ada Lovelace', avatarUrl: 'https://cdn.example/ada.png', avatarType: 'image/png' };
const chess = { authenticated: true, profile: { id: chessId, displayName: '  Mina Chen  ' }, master: { displayName: 'Hidden Master', avatarUrl: 'http://evil.example/a.png' } };

assert.equal(httpsUrl('http://evil.example/a.png'), '');
assert.equal(httpsUrl('https://user:pass@cdn.example/a.png'), '');
assert.equal(httpsUrl('https://cdn.example/ada.png'), 'https://cdn.example/ada.png');
assert.equal(initials('Ada Lovelace'), 'AL');
assert.equal(initials('Mina'), 'MI');

assert.deepEqual(resolveAccountLook(chessSection, null), { kind: 'signed-out' });
assert.deepEqual(resolveAccountLook(chessSection, { authenticated: false, master }), { kind: 'signed-out' });

const local = resolveAccountLook(chessSection, chess);
assert.equal(local.kind, 'local');
assert.equal(local.sectionId, 'chess');
assert.equal(local.name, 'Mina Chen');
assert.equal(local.portraitId, chessId);
assert.equal(local.profileUrl, '/community/profile/?id=' + chessId);
assert.equal(local.menu.some((item) => item.label === 'Profile'), true);
assert.equal(local.menu.some((item) => item.label === 'Sign out'), true);
assert.equal(local.menu.some((item) => item.label === 'Master account'), false);
assert.equal(JSON.stringify(local).includes('Hidden Master'), false);

const masterOnly = resolveAccountLook(chessSection, { authenticated: true, profile: null, master });
assert.equal(masterOnly.kind, 'master');
assert.equal(masterOnly.name, 'Ada Lovelace');
assert.equal(masterOnly.avatarUrl, 'https://cdn.example/ada.png');
assert.equal(masterOnly.initials, 'AL');
assert.deepEqual(masterOnly.menu.map((item) => item.label), ['Join Chess', 'Master account', 'Log out']);
assert.equal(masterOnly.menu[1].href, 'https://theworldgovernmentincorporated.com/account/');

const unregistered = resolveAccountLook(null, { authenticated: true, profile: chess.profile, master });
assert.equal(unregistered.kind, 'master');
assert.equal(unregistered.name, 'Ada Lovelace');
assert.equal(unregistered.menu.some((item) => item.label === 'Join Chess'), false);

assert.equal(masterLook({ displayName: '  ', avatarUrl: 'notaurl' }).name, 'Account');
assert.equal(masterLook({ displayName: '  ', avatarUrl: 'notaurl' }).avatarUrl, '');
console.log('account look tests passed');

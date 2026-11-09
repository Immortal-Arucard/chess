import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { httpsUrl, initials, masterHref, masterLook } from '../master-account.js';
import { callbackSession, resolveAccountLook, safeHref } from '../section-account.js';
import { chessSection } from './chess-section.js';

const chessId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const master = { displayName: 'Ada Lovelace', avatarUrl: 'https://cdn.example/ada.png', avatarType: 'image/png' };
const profile = { id: chessId, displayName: '  Mina Chen  ' };

assert.equal(httpsUrl('http://evil.example/a.png'), '');
assert.equal(httpsUrl('https://user:pass@cdn.example/a.png'), '');
assert.equal(httpsUrl('https://cdn.example/ada.png'), 'https://cdn.example/ada.png');
assert.equal(initials('Ada Lovelace'), 'AL');
assert.equal(initials('Mina'), 'MI');
assert.equal(safeHref('javascript:alert(1)'), '');
assert.equal(safeHref('//evil.example'), '');
assert.equal(safeHref('/community/profile/?id=' + chessId), '/community/profile/?id=' + chessId);
assert.equal(masterHref('/account/', 'theworldgovernmentincorporated.com'), '/account/');
assert.equal(masterHref('/login/', 'chess.theworldgovernmentincorporated.com'), 'https://theworldgovernmentincorporated.com/login/');
assert.equal(masterHref('/account/', '127.0.0.1'), 'https://theworldgovernmentincorporated.com/account/');

const passed = callbackSession({ id: 'user-1', email: 'ada@example.com', user_metadata: { name: 'Ada' }, created_at: '2020-01-01', access_token: 'secret' });
assert.equal(passed.user.id, 'user-1');
assert.equal(passed.user.email, 'ada@example.com');
assert.equal(passed.user.user_metadata.name, 'Ada');
assert.equal(passed.user.created_at, '2020-01-01');
assert.equal(Object.prototype.hasOwnProperty.call(passed.user, 'access_token'), false);
assert.equal(Object.prototype.hasOwnProperty.call(passed, 'access_token'), false);

assert.equal(chessSection.sectionId, 'chess');
assert.equal(chessSection.label, 'Chess');
assert.equal(chessSection.host, 'chess.theworldgovernmentincorporated.com');
assert.equal(chessSection.pathPrefixes, undefined);
assert.equal(chessSection.signInUrl, '/community/');
assert.equal(chessSection.menuItems, undefined);

let calls = 0;
const counting = {
  sectionId: 'chess',
  async hasLocalAccount() { calls += 1; return true; },
  async localProfile() { return { name: 'Mina', avatarUrl: '', url: '/community/profile/?id=' + chessId }; }
};
assert.deepEqual(await resolveAccountLook(counting, { signedIn: false, master }, 'chess.theworldgovernmentincorporated.com'), { kind: 'signed-out' });
assert.equal(calls, 0);

function sessionBody(next) {
  globalThis.fetch = async (url) => {
    assert.equal(String(url), '/api/session');
    return { ok: true, json: async () => next };
  };
}

sessionBody({ profile });
const local = await resolveAccountLook(chessSection, { signedIn: true, user: { access_token: 'secret' }, master }, '127.0.0.1');
assert.equal(local.kind, 'local');
assert.equal(local.sectionId, 'chess');
assert.equal(local.name, 'Mina Chen');
assert.equal(local.avatarUrl, '');
assert.equal(local.url, '/community/profile/?id=' + chessId);
assert.deepEqual(local.menu.map((item) => item.label), ['Account', 'Log out']);
assert.equal(local.menu[0].href, '/community/profile/?id=' + chessId);
assert.equal(local.menu[1].action, 'sign-out');
assert.equal(JSON.stringify(local).includes('Hidden Master'), false);
assert.equal(JSON.stringify(local).includes('secret'), false);

sessionBody({ profile: null });
const masterOnly = await resolveAccountLook(chessSection, { signedIn: true, user: {}, master }, 'chess.theworldgovernmentincorporated.com');
assert.equal(masterOnly.kind, 'master');
assert.equal(masterOnly.name, 'Ada Lovelace');
assert.equal(masterOnly.avatarUrl, 'https://cdn.example/ada.png');
assert.equal(masterOnly.initials, 'AL');
assert.deepEqual(masterOnly.menu.map((item) => item.label), ['Join Chess', 'Master account', 'Log out']);
assert.equal(masterOnly.menu[1].href, 'https://theworldgovernmentincorporated.com/account/');
assert.equal(masterOnly.url, 'https://theworldgovernmentincorporated.com/account/');

const broken = {
  sectionId: 'chess',
  async hasLocalAccount() { throw new Error('down'); },
  async localProfile() { throw new Error('down'); }
};
const fellBack = await resolveAccountLook(broken, { signedIn: true, master }, 'chess.theworldgovernmentincorporated.com');
assert.equal(fellBack.kind, 'master');
assert.equal(fellBack.name, 'Ada Lovelace');

const unnamed = {
  sectionId: 'chess',
  async hasLocalAccount() { return true; },
  async localProfile() { return { name: ' ', avatarUrl: 'https://cdn.example/a.png', url: '/community/' }; }
};
assert.equal((await resolveAccountLook(unnamed, { signedIn: true, master }, '')).kind, 'master');

const badUrl = {
  sectionId: 'chess',
  async hasLocalAccount() { return true; },
  async localProfile() { return { name: 'Mina', avatarUrl: '', url: 'javascript:alert(1)' }; }
};
assert.equal((await resolveAccountLook(badUrl, { signedIn: true, master }, '')).kind, 'master');

const custom = {
  sectionId: 'other',
  menuItems: [{ label: 'Desk', href: '/desk/' }, { label: 'Leave', action: 'sign-out' }],
  async hasLocalAccount() { return true; },
  async localProfile() { return { name: 'Mina', avatarUrl: 'http://evil.example/a.png', url: 'https://cdn.example/profile' }; }
};
const customLook = await resolveAccountLook(custom, { signedIn: true, master: { displayName: 'Hidden Master' } }, '');
assert.equal(customLook.kind, 'local');
assert.equal(customLook.avatarUrl, '');
assert.equal(customLook.url, 'https://cdn.example/profile');
assert.deepEqual(customLook.menu.map((item) => item.label), ['Desk', 'Leave']);

const unregistered = await resolveAccountLook(null, { signedIn: true, master }, 'chess.theworldgovernmentincorporated.com');
assert.equal(unregistered.kind, 'master');
assert.equal(unregistered.name, 'Ada Lovelace');
assert.equal(unregistered.menu.some((item) => item.label === 'Join Chess'), false);

assert.equal(masterLook({ displayName: '  ', avatarUrl: 'notaurl' }).name, 'Account');
assert.equal(masterLook({ displayName: '  ', avatarUrl: 'notaurl' }).avatarUrl, '');

function registry(hostname) {
  const sandbox = {
    location: { hostname, pathname: '/' },
    document: null
  };
  sandbox.window = sandbox;
  vm.runInNewContext(readFileSync(new URL('../account-sections.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.TWGIAccountSections;
}

const chessHost = registry('chess.theworldgovernmentincorporated.com');
let seen = null;
let reads = 0;
chessHost.register({
  sectionId: 'chess',
  label: 'Chess',
  host: 'chess.theworldgovernmentincorporated.com',
  signInUrl: '/community/',
  hasLocalAccount(session) {
    reads += 1;
    seen = session;
    return true;
  },
  localProfile() {
    return { name: 'Mina', avatarUrl: '', url: '/community/profile/?id=' + chessId };
  }
});
assert.equal(chessHost.masterUrls().signInUrl, 'https://theworldgovernmentincorporated.com/login/');
assert.equal(chessHost.masterUrls().accountUrl, 'https://theworldgovernmentincorporated.com/account/');
const matched = await chessHost.appearance({ user: { id: 'user-1', email: 'ada@example.com', user_metadata: {}, created_at: '2020-01-01' } });
assert.equal(matched.kind, 'local');
assert.equal(matched.local.name, 'Mina');
assert.equal(matched.local.url, '/community/profile/?id=' + chessId);
assert.equal(seen.user.id, 'user-1');
assert.equal(Object.prototype.hasOwnProperty.call(seen.user, 'access_token'), false);
assert.equal(reads, 1);
const signedOut = await chessHost.appearance(null);
assert.equal(signedOut.kind, 'master');
assert.equal(reads, 1);

const otherHost = registry('example.com');
otherHost.register(chessSection);
let foreign = 0;
const skipped = {
  sectionId: 'chess',
  host: 'chess.theworldgovernmentincorporated.com',
  hasLocalAccount() { foreign += 1; return true; },
  localProfile() { return { name: 'Mina', url: '/community/' }; }
};
otherHost.register(skipped);
assert.equal((await otherHost.appearance({ user: { id: 'user-1' } })).kind, 'master');
assert.equal(foreign, 0);

const home = registry('theworldgovernmentincorporated.com');
assert.equal(home.masterUrls().signInUrl, '/login/');
assert.equal(home.masterUrls().accountUrl, '/account/');
console.log('account look tests passed');

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chessAccess, cleanBody, cleanDiscussion, cleanName, cleanReason, communityRoute, feedFilter, nextCursor, olderThan, profileExitHref, profilePath, profileRoute, publicProfile } from './community-model.js';
import { assertPublishable, communityConfig } from './community-config.js';

const name = cleanName('  Ada  Lovelace ');
assert.equal(name.ok && name.value, 'Ada Lovelace');
assert.equal(cleanName('').ok, false);
assert.equal(cleanName('a'.repeat(41)).ok, false);
assert.equal(cleanName('Ada\nLovelace').value, 'Ada Lovelace');
assert.equal(cleanName('Ada\u0007Lovelace').ok, false);

const body = cleanBody('  Hello\nboard  ');
assert.equal(body.ok && body.value, 'Hello\nboard');
assert.equal(cleanBody('   ').ok, false);
assert.equal(cleanBody('x'.repeat(2001)).ok, false);
assert.equal(cleanBody('ok\u0000no').ok, false);
assert.equal(cleanReason('spam').ok && cleanReason('spam').value, 'spam');
assert.equal(cleanReason('').ok, false);

const rows = [
  { id: 'b', createdAt: '2026-11-08T00:00:02Z' },
  { id: 'a', createdAt: '2026-11-08T00:00:01Z' }
];
const cursor = nextCursor(rows, 2);
assert.deepEqual(cursor, { createdAt: '2026-11-08T00:00:01Z', id: 'a' });
assert.equal(nextCursor(rows, 3), null);
assert.equal(olderThan({ id: '9', createdAt: '2026-11-07T00:00:00Z' }, cursor), true);
assert.equal(olderThan({ id: 'b', createdAt: '2026-11-08T00:00:02Z' }, cursor), false);
assert.match(feedFilter(cursor), /created_at\.lt\./);
assert.equal(communityRoute({ pathname: '/community/discussion/', search: '' }).page, 'discussion');
assert.equal(communityRoute({ pathname: '/community/profile/', search: '?id=11111111-1111-4111-8111-111111111111' }).page, 'profile');
assert.equal(profileExitHref('/community/'), '/community/');
assert.equal(profileExitHref('https://evil.example'), '/community/');
assert.equal(profileExitHref('//evil.example'), '/community/');
assert.equal(profileExitHref('/\\evil'), '/community/');
assert.equal(profilePath('11111111-1111-4111-8111-111111111111'), '/community/profile/?id=11111111-1111-4111-8111-111111111111');
assert.equal(cleanDiscussion('<b>safe</b>').value, '<b>safe</b>');
assert.equal(cleanDiscussion('x'.repeat(1001)).ok, false);

const configText = readFileSync(new URL('./community-config.js', import.meta.url), 'utf8');
assert.match(configText, /CHESS_SUPABASE_URL = ''/);
assert.match(configText, /CHESS_SUPABASE_PUBLISHABLE_KEY = ''/);
assert.equal(configText.includes('service_role'), true);
assert.equal(communityConfig().configured, false);
assert.throws(() => assertPublishable('header.payload.service_role'), /Refusing/);
const serviceJwt = 'aaa.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.bbb';
assert.throws(() => assertPublishable(serviceJwt), /Refusing/);
assert.doesNotThrow(() => assertPublishable('sb_publishable_example'));

const ada = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
assert.equal(profilePath(ada), '/community/profile/?id=' + ada);
assert.deepEqual(profileRoute({ pathname: '/community/', search: '' }).page, 'feed');
assert.equal(profileRoute({ pathname: '/community/profile/', search: '' }).reason, 'missing');
assert.equal(profileRoute({ pathname: '/community/profile/', search: '?id=ada' }).reason, 'invalid');
assert.equal(profileRoute({ pathname: '/community/profile/index.html', search: '?id=' + ada }).id, ada);
const shown = publicProfile({ id: ada, display_name: 'Ada', created_at: '2026-11-08T00:00:00Z', email: 'ada@example.com' });
assert.deepEqual(shown, { id: ada, displayName: 'Ada', createdAt: '2026-11-08T00:00:00Z' });
assert.equal(Object.hasOwn(shown, 'email'), false);
const signedInOnly = chessAccess({ authenticated: true, chessProfile: null });
assert.deepEqual(signedInOnly, { authenticated: true, chessMember: false, otherServices: [] });
const chessOnly = chessAccess({ authenticated: true, chessProfile: { id: ada } });
assert.equal(chessOnly.chessMember, true);
assert.deepEqual(chessOnly.otherServices, []);
const shownOwner = publicProfile({ id: ada, display_name: 'Ada', created_at: '2026-11-08T00:00:00Z', owner_id: 'master-id', email: 'ada@example.com' });
assert.equal(Object.hasOwn(shownOwner, 'owner_id'), false);
assert.equal(Object.hasOwn(shownOwner, 'email'), false);

const sql = readFileSync(new URL('../../supabase/chess_community.sql', import.meta.url), 'utf8');
assert.match(sql, /extensions\.digest/);
assert.doesNotMatch(sql, /public\.digest/);
for (const table of ['chess_profiles', 'chess_posts', 'chess_replies', 'chess_reports']) {
  assert.match(sql, new RegExp('alter table public\\.' + table + ' enable row level security'));
  assert.match(sql, new RegExp('alter table public\\.' + table + ' force row level security'));
}
assert.match(sql, /chess_posts_by_author/);
assert.match(sql, /chess_private\.profile_owners/);
assert.match(sql, /revoke all on chess_private\.profile_owners from public, anon, authenticated/);
assert.doesNotMatch(sql, /grant select on chess_private\.profile_owners to anon/);
assert.doesNotMatch(sql, /grant select on chess_private\.profile_owners to authenticated/);
assert.doesNotMatch(sql, /chess_twgi_links/);
assert.doesNotMatch(sql, /owner_id uuid[\s\S]{0,80}chess_profiles \(/);
assert.doesNotMatch(sql, /email text/i);
assert.match(sql, /no trigger on auth\.users/i);
assert.doesNotMatch(sql, /create trigger[\s\S]{0,120}auth\.users/i);
assert.doesNotMatch(sql, /join[\s\S]{0,40}email/i);
assert.equal(sql.includes('public.profiles'), false);
assert.equal(sql.includes('public.results'), false);
assert.doesNotMatch(sql, /table public\.test_events|from public\.test_events/);
assert.equal(sql.includes('service_role'), true);
assert.match(sql, /chess_api/);
assert.match(sql, /chess_private\.sessions/);
assert.match(sql, /chess_private\.rate_buckets/);
assert.match(sql, /revoke all on table public\.chess_posts from public, anon, authenticated/);
assert.doesNotMatch(sql, /grant execute on function chess_private\.provision_profile\(uuid, text\) to anon/);
assert.doesNotMatch(sql, /grant execute on function chess_private\.provision_profile\(uuid, text\) to authenticated/);
const appText = readFileSync(new URL('./community-app.js', import.meta.url), 'utf8');
assert.equal(appText.includes('createClient'), false);
assert.equal(appText.includes('supabase.js'), false);
assert.equal(appText.includes('/api/session'), true);
assert.doesNotMatch(sql, /eyJ[A-Za-z0-9_-]{20,}/);

const users = {
  ada: { id: 'ada', name: 'Ada' },
  bob: { id: 'bob', name: 'Bob' }
};
let current = users.ada;
const posts = [];
function createPost(author, text) {
  const cleaned = cleanBody(text);
  if (!cleaned.ok) throw new Error(cleaned.error);
  const row = { id: String(posts.length + 1), authorId: author.id, authorName: author.name, body: cleaned.value, createdAt: new Date(Date.UTC(2026, 10, 8, 0, 0, posts.length)).toISOString() };
  posts.unshift(row);
  return row;
}
function deletePost(actor, id) {
  const row = posts.find((item) => item.id === id);
  if (!row || row.authorId !== actor.id) throw new Error('You can delete only your own post.');
  posts.splice(posts.indexOf(row), 1);
}
createPost(users.ada, 'Hello <script>alert(1)</script>');
assert.throws(() => deletePost(users.bob, posts[0].id), /only your own post/);
deletePost(users.ada, posts[0].id);
assert.equal(posts.length, 0);

console.log('community model tests passed');

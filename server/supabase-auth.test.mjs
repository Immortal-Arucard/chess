import assert from 'node:assert/strict';
import { createSupabaseAuth } from './supabase-auth.mjs';

const redirectTo = 'https://chess.theworldgovernmentincorporated.com/api/auth/callback';
const google = 'https://accounts.google.com/o/oauth2/v2/auth?state=test';

function authWith(fetchImpl) {
  return createSupabaseAuth({ url: 'https://example.supabase.co', apiKey: 'publishable-test-key', fetchImpl });
}

const seen = [];
const started = await authWith(async (url, options) => {
  seen.push({ url: String(url), redirect: options.redirect });
  return new Response('', { status: 302, headers: { location: google } });
}).startGoogle({ challenge: 'challenge', redirectTo });
assert.equal(started, google);
assert.equal(seen.length, 1);
assert.equal(seen[0].redirect, 'manual');
assert.equal(seen[0].url.includes('skip_http_redirect'), false);
assert.equal(seen[0].url.includes('/auth/v1/authorize'), true);

const shapes = [
  ['evil host', 302, 'https://evil.example/phish'],
  ['lookalike host', 302, 'https://accounts.google.com.evil.example/o/oauth2/v2/auth'],
  ['insecure scheme', 302, 'http://accounts.google.com/o/oauth2/v2/auth'],
  ['json body', 200, '']
];
for (const [name, status, location] of shapes) {
  const headers = location ? { location } : undefined;
  const body = status === 200 ? JSON.stringify({ url: google }) : '';
  await assert.rejects(
    () => authWith(async () => new Response(body, { status, headers })).startGoogle({ challenge: 'challenge', redirectTo }),
    /Google sign-in could not start/,
    name
  );
}
console.log('google authorize uses the provider 302 and does not follow it');

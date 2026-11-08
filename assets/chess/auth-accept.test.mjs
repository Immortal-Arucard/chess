import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('./auth-accept.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../../community/index.html', import.meta.url), 'utf8');

assert.match(script, /method:\s*'POST'/);
assert.match(script, /\/api\/auth\/start/);
assert.match(script, /\/api\/session/);
assert.match(script, /\/api\/logout/);
assert.match(script, /body\.sent !== true/);
assert.equal(script.includes('/api/join'), false);
assert.equal(script.includes('/api/posts'), false);
assert.equal(script.includes('/api/games'), false);
assert.equal(script.includes('/api/replies'), false);
assert.equal(script.includes('supabase'), false);
assert.equal(script.includes('profile.id'), false);
assert.match(page, /auth-accept\.js/);
assert.equal(page.includes('community-app.js'), false);
assert.match(page, /Email me a sign-in link/);

console.log('sign-in acceptance page stays on session start and logout');

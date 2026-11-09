import assert from 'node:assert/strict';
import worker, { routeApi, trustedClientIp, workerBody } from './worker.mjs';

const missing = await worker.fetch(new Request('https://chess.example/api/session'), {});
assert.equal(missing.status, 503);
const page = await worker.fetch(new Request('https://chess.example/bot/'), { HYPERDRIVE: { connectionString: 'postgres://unused' } });
assert.equal(page.status, 404);
const bad = await worker.fetch(new Request('https://chess.example/api/session', { headers: { 'CF-Connecting-IP': '198.51.100.8' } }), {
  HYPERDRIVE: { connectionString: 'postgres://chess_server:wrong@127.0.0.1:1/none' },
  CHESS_ORIGIN: 'https://chess.example',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'publishable'
});
assert.equal(bad.status, 503);
const again = await worker.fetch(new Request('https://chess.example/api/session'), {});
assert.equal(again.status, 503);
assert.equal(routeApi('/api/session'), true);
assert.equal(trustedClientIp(new Request('https://chess.example/api/session', { headers: { 'CF-Connecting-IP': '198.51.100.8' } })), '198.51.100.8');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xd9]);
assert.equal(Buffer.compare(Buffer.from(workerBody(jpeg)), jpeg), 0);
assert.notEqual(Buffer.compare(Buffer.from(String(jpeg)), jpeg), 0);
console.log('worker entry tests passed');

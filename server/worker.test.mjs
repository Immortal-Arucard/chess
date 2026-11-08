import assert from 'node:assert/strict';
import { handleWorkerRequest, trustedClientIp } from './worker.mjs';

const seen = [];
function fakeClient(id) {
  return {
    async connect() {},
    async query(text) {
      seen.push(id + ':' + text);
      if (text.includes('current_user')) return { rows: [{ role: 'chess_server' }] };
      if (text === 'begin' || text === 'commit' || text.startsWith('set local') || text.startsWith('select set_config')) return { rows: [] };
      if (text.includes('chess_session')) return { rows: [{ session: { authenticated: false, profile: null } }] };
      return { rows: [{}] };
    },
    async end() { seen.push(id + ':end'); }
  };
}

let next = 0;
const clients = [fakeClient('a'), fakeClient('b')];
const env = { HYPERDRIVE: { connectionString: 'postgres://chess_server@db/chess' }, CHESS_ORIGIN: 'https://chess.example', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'publishable' };

async function invoke(app, request, ip) {
  const url = new URL(request.url);
  const req = {
    method: request.method,
    url: url.pathname + url.search,
    headers: { 'cf-connecting-ip': ip },
    socket: { remoteAddress: '203.0.113.9' },
    async *[Symbol.asyncIterator]() {}
  };
  return new Promise((resolve) => {
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { resolve({ status: this.status, body }); }
    };
    app.handle(req, res);
  });
}

const first = await handleWorkerRequest(new Request('https://chess.example/api/session'), env, {
  Client: class { constructor() { return clients[next++]; } },
  createApp: (options) => ({ handle: async (req, res) => { seen.push('ip:' + (req.headers['cf-connecting-ip'] || '')); res.writeHead(200, {}); res.end('{}'); } }),
  invoke
});
const second = await handleWorkerRequest(new Request('https://chess.example/api/session', { headers: { 'CF-Connecting-IP': '198.51.100.8' } }), env, {
  Client: class { constructor() { return clients[next++]; } },
  createApp: (options) => ({ handle: async (req, res) => { seen.push('ip:' + (req.headers['cf-connecting-ip'] || '')); res.writeHead(200, {}); res.end('{}'); } }),
  invoke
});
assert.equal(first.status, 200);
assert.equal(second.status, 200);
assert.equal(seen.filter((item) => item.endsWith(':end')).length, 2);
assert.equal(trustedClientIp(new Request('https://chess.example/api/session', { headers: { 'CF-Connecting-IP': '198.51.100.8' } })), '198.51.100.8');
assert.equal(trustedClientIp(new Request('https://chess.example/api/session')), 'untrusted');
const outside = await handleWorkerRequest(new Request('https://chess.example/bot/'), env, { Client: class {}, createApp() {}, invoke });
assert.equal(outside.status, 404);
console.log('worker request isolation tests passed');

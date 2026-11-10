import pg from 'pg';
import { createChessApp } from './chess-api.mjs';
import { deliverDue } from './push-send.mjs';

// Production Worker entry. Each request and each scheduled run opens its own
// pg client from the cache-disabled Hyperdrive binding and closes it, including
// when connect or the handler fails. There is no module-level client.
// https://developers.cloudflare.com/hyperdrive/platform/pricing/
// https://developers.cloudflare.com/workers/tutorials/postgres/

export function routeApi(pathname) {
  return String(pathname || '').startsWith('/api/');
}

export function workerBody(payload) {
  if (payload == null) return null;
  if (payload instanceof Uint8Array) return payload;
  return String(payload);
}

export function trustedClientIp(request) {
  const value = request.headers.get('CF-Connecting-IP');
  if (!value || value.includes(',')) return 'untrusted';
  return value.trim();
}

function oneClientPool(client) {
  return {
    async connect() {
      return {
        query: (text, params) => client.query(text, params),
        release() {}
      };
    }
  };
}

function bridge(app, request) {
  const url = new URL(request.url);
  const headers = {};
  request.headers.forEach((value, key) => { headers[key] = value; });
  const req = {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    socket: { remoteAddress: '' },
    async *[Symbol.asyncIterator]() {
      if (request.body) {
        const buf = Buffer.from(await request.arrayBuffer());
        if (buf.length) yield buf;
      }
    }
  };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(status, hdrs) {
        this.statusCode = status;
        this.headers = hdrs || {};
      },
      end(payload) {
        const out = new Headers();
        for (const [key, value] of Object.entries(this.headers)) {
          if (String(key).toLowerCase() === 'set-cookie' && Array.isArray(value)) value.forEach((cookie) => out.append('set-cookie', cookie));
          else if (value != null) out.set(key, Array.isArray(value) ? value.join(', ') : String(value));
        }
        resolve(new Response(workerBody(payload), { status: this.statusCode, headers: out }));
      }
    };
    Promise.resolve(app.handle(req, res)).catch(reject);
  });
}

async function withClient(connectionString, run) {
  const client = new pg.Client({ connectionString });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    return await run(client);
  } finally {
    if (connected) {
      try { await client.end(); } catch (err) { /* the connection is already closed */ }
    }
  }
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!routeApi(url.pathname)) return new Response(null, { status: 404 });
    const connectionString = env && env.HYPERDRIVE && env.HYPERDRIVE.connectionString;
    if (!connectionString) {
      return new Response(JSON.stringify({ error: 'Chess accounts are not configured.' }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
      });
    }
    try {
      return await withClient(connectionString, (client) => {
        const vapid = env && env.VAPID_PRIVATE_KEY ? {
          publicKey: env.VAPID_PUBLIC_KEY,
          privateKey: env.VAPID_PRIVATE_KEY,
          subject: env.VAPID_SUBJECT || 'mailto:cubzub@gmail.com'
        } : null;
        const app = createChessApp({
          pool: oneClientPool(client),
          origin: env.CHESS_ORIGIN,
          supabaseUrl: env.SUPABASE_URL,
          supabaseKey: env.SUPABASE_ANON_KEY,
          vapidPublicKey: env && env.VAPID_PUBLIC_KEY,
          deliver: vapid ? (query) => deliverDue(query, vapid) : null
        });
        return bridge(app, request);
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Chess accounts are not reachable.' }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
      });
    }
  },
  async scheduled(_event, env) {
    const connectionString = env && env.HYPERDRIVE && env.HYPERDRIVE.connectionString;
    if (!connectionString) return;
    await withClient(connectionString, async (client) => {
      await client.query('begin');
      try {
        await client.query('select chess_service.chess_cleanup()');
        await client.query('select chess_service.human_expire()');
        await client.query('commit');
      } catch (err) {
        try { await client.query('rollback'); } catch (ignore) { /* rollback failed */ }
        throw err;
      }
    });
  }
};

export default worker;

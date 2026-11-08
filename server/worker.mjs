import pg from 'pg';
import { createChessApp } from './chess-api.mjs';

// Each request opens and closes its own database client. There is no process-wide
// pool, because a Worker isolate must not keep the first Hyperdrive client alive.
// Hyperdrive caching must be disabled. The free plan includes 100,000 queries a day:
// https://developers.cloudflare.com/hyperdrive/platform/pricing/

export function routeApi(pathname) {
  return String(pathname || '').startsWith('/api/');
}

export function trustedClientIp(request) {
  const value = request.headers.get('CF-Connecting-IP');
  if (!value || value.includes(',')) return 'untrusted';
  return value.trim();
}

function oneClientPool(client) {
  let closed = false;
  return {
    async connect() {
      if (closed) throw new Error('The database client is closed.');
      return {
        query: (text, params) => client.query(text, params),
        release() {}
      };
    },
    async end() {
      closed = true;
      await client.end();
    }
  };
}

export async function handleWorkerRequest(request, env, deps) {
  const url = new URL(request.url);
  if (!routeApi(url.pathname)) return new Response(null, { status: 404 });
  const connectionString = env && env.HYPERDRIVE && env.HYPERDRIVE.connectionString;
  if (!connectionString) {
    return new Response(JSON.stringify({ error: 'Chess accounts are not configured.' }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }
  const Client = deps.Client;
  const client = new Client({ connectionString });
  await client.connect();
  const pool = oneClientPool(client);
  try {
    const app = deps.createApp({
      pool,
      origin: env.CHESS_ORIGIN,
      supabaseUrl: env.SUPABASE_URL,
      supabaseKey: env.SUPABASE_ANON_KEY,
      fetchImpl: deps.fetchImpl
    });
    return await deps.invoke(app, request, trustedClientIp(request));
  } finally {
    await pool.end();
  }
}

export async function runCleanup(env, deps) {
  const connectionString = env && env.HYPERDRIVE && env.HYPERDRIVE.connectionString;
  if (!connectionString) return;
  const client = new deps.Client({ connectionString });
  await client.connect();
  try {
    await client.query('begin');
    await client.query('select chess_service.chess_cleanup()');
    await client.query('commit');
  } finally {
    await client.end();
  }
}

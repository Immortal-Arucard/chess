import { createServer } from 'node:http';
import pg from 'pg';
import { createChessApp } from './chess-api.mjs';

// Official Workers adapter: httpServerHandler from cloudflare:node runs this
// Node server. Hyperdrive with caching disabled is the free-plan Postgres pool.
// https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/
// https://developers.cloudflare.com/hyperdrive/platform/pricing/
// This file is not executed in the Node test suite. Local tests call createChessApp.

const port = 8787;
let server;

function appFromEnv(env) {
  if (!env.HYPERDRIVE || !env.HYPERDRIVE.connectionString) {
    return null;
  }
  const pool = new pg.Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
  return createChessApp({
    pool,
    origin: env.CHESS_ORIGIN,
    supabaseUrl: env.SUPABASE_URL,
    supabaseKey: env.SUPABASE_ANON_KEY
  });
}

export function routeApi(pathname) {
  return String(pathname || '').startsWith('/api/');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!routeApi(url.pathname)) return new Response(null, { status: 404 });
    const app = appFromEnv(env);
    if (!app) return new Response(JSON.stringify({ error: 'Chess accounts are not configured.' }), { status: 503 });
    if (!server) {
      server = createServer((req, res) => app.handle(req, res));
      server.listen(port);
    }
    const { httpServerHandler } = await import('cloudflare:node');
    return httpServerHandler({ port }).fetch(request, env);
  },
  async scheduled(_event, env) {
    const app = appFromEnv(env);
    if (!app) return;
    await app.query('select chess_service.cleanup()');
  }
};

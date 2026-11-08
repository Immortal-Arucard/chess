import pg from 'pg';
import { createChessApp } from './chess-api.mjs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const app = createChessApp({
  pool,
  origin: process.env.CHESS_ORIGIN,
  audience: 'chess',
  masterAuthorize: process.env.MASTER_AUTHORIZE_URL,
  exchangeCode: async function exchangeCode(input) {
    const response = await fetch(process.env.MASTER_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'pkce',
        code: input.code,
        code_verifier: input.verifier,
        audience: input.audience,
        redirect_uri: input.redirectUri
      })
    });
    const body = await response.json();
    const masterId = body.user && body.user.id;
    if (!response.ok || !masterId) return null;
    return { masterId, audience: input.audience };
  }
});

const port = Number(process.env.PORT || 8787);
app.server.listen(port, '127.0.0.1');

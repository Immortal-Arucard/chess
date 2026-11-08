import pg from 'pg';
import { createChessApp } from './chess-api.mjs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const app = createChessApp({
  pool,
  origin: process.env.CHESS_ORIGIN,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_ANON_KEY
});
const port = Number(process.env.PORT || 8787);
app.server.listen(port, '127.0.0.1');

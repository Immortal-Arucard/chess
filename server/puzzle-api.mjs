import { Chess } from '../assets/vendor/chess.js/chess.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUci(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined };
}

export function replayLine(fen, ucis) {
  const game = new Chess(fen);
  const sans = [];
  let orientation = game.turn();
  (ucis || []).forEach((uci, index) => {
    const played = game.move(parseUci(uci));
    if (!played) throw new Error('That move is not legal.');
    if (index === 0) orientation = game.turn();
    sans.push(played.san);
  });
  return { fen: game.fen(), sans, orientation, turn: game.turn() };
}

export function moveIsLegal(fen, ucis, uci) {
  try {
    const game = new Chess(replayLine(fen, ucis).fen);
    return !!game.move(parseUci(uci));
  } catch (err) {
    return false;
  }
}

function decorate(body) {
  if (!body || typeof body !== 'object') return body;
  const attempt = body.attempt && body.attempt.setupFen ? body.attempt : (body.setupFen ? body : null);
  if (!attempt) return body;
  const replay = replayLine(attempt.setupFen, attempt.applied || []);
  attempt.fen = replay.fen;
  attempt.orientation = replay.orientation;
  attempt.sans = replay.sans;
  if (Array.isArray(attempt.solution)) {
    attempt.solutionSans = replayLine(attempt.setupFen, attempt.solution).sans;
  }
  return body;
}

export async function handlePuzzleGet({ url, token, query, send }) {
  if (!url.pathname.startsWith('/api/puzzles')) return false;
  if (!token) throw new Error('Sign in before doing that.');
  if (url.pathname === '/api/puzzles/current') {
    const result = await query('select chess_service.puzzle_current($1) as puzzle', [token]);
    return send(200, decorate(result.rows[0].puzzle));
  }
  if (url.pathname === '/api/puzzles/attempts') {
    const result = await query('select chess_service.puzzle_attempts($1, $2, $3, $4) as puzzle', [
      token,
      url.searchParams.get('before') || null,
      url.searchParams.get('beforeId') || null,
      Number(url.searchParams.get('limit') || 10)
    ]);
    return send(200, result.rows[0].puzzle);
  }
  const detail = url.pathname.match(/^\/api\/puzzles\/attempts\/([0-9a-f-]{36})$/i);
  if (detail && UUID.test(detail[1])) {
    const result = await query('select chess_service.puzzle_attempt($1, $2) as puzzle', [token, detail[1]]);
    return send(200, decorate(result.rows[0].puzzle));
  }
  return false;
}

export async function handlePuzzlePost({ url, token, body, query, send }) {
  if (!url.pathname.startsWith('/api/puzzles')) return false;
  if (url.pathname === '/api/puzzles/next') {
    const result = await query('select chess_service.puzzle_next($1) as puzzle', [token]);
    return send(200, decorate(result.rows[0].puzzle));
  }
  if (url.pathname === '/api/puzzles/reset') {
    const result = await query('select chess_service.puzzle_reset($1) as puzzle', [token]);
    return send(200, decorate(result.rows[0].puzzle));
  }
  if (url.pathname === '/api/puzzles/move') {
    if (!UUID.test(String(body.attemptId || ''))) throw new Error('That puzzle attempt was not found.');
    const current = await query('select chess_service.puzzle_current($1) as puzzle', [token]);
    const open = current.rows[0].puzzle && current.rows[0].puzzle.attempt;
    if (open && open.attemptId === body.attemptId && open.status === 'active' && !moveIsLegal(open.setupFen, open.applied || [], String(body.uci || ''))) {
      throw new Error('That move is not legal.');
    }
    const result = await query('select chess_service.puzzle_move($1, $2, $3) as puzzle', [token, body.attemptId, String(body.uci || '')]);
    return send(200, decorate(result.rows[0].puzzle));
  }
  if (url.pathname === '/api/puzzles/abandon') {
    if (!UUID.test(String(body.attemptId || ''))) throw new Error('That puzzle attempt was not found.');
    const result = await query('select chess_service.puzzle_abandon($1, $2) as puzzle', [token, body.attemptId]);
    return send(200, decorate(result.rows[0].puzzle));
  }
  return false;
}

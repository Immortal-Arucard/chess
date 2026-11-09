import { createHash } from 'node:crypto';
import { playSan, resolveTimeControl } from '../assets/chess/human-rules.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STYLES = new Set(['standard', 'bold', 'contour']);
const COLORS = new Set(['ink', 'ivory', 'sky']);
const PALETTES = new Set(['midnight', 'classic', 'sea', 'paper', 'indigo']);

function uuid(value) {
  return UUID.test(String(value || '')) ? String(value) : null;
}

function hashRecord(record) {
  return createHash('sha256').update(JSON.stringify({
    startFen: record.startFen,
    moves: record.moves,
    result: record.result,
    termination: record.termination,
    playerColor: record.playerColor,
    category: record.category,
    timeLabel: record.timeLabel
  })).digest('hex');
}

export function validatePassRecord(record) {
  if (!record || record.rated === true) throw new Error('Chess does not store a rated result.');
  if (!STYLES.has(record.pieceStyle) || !COLORS.has(record.pieceColor) || !PALETTES.has(record.palette)) {
    throw new Error('That appearance is not one of the saved choices.');
  }
  if (!['white', 'black'].includes(record.playerColor)) throw new Error('The player side is missing.');
  if (!['bullet', 'blitz', 'rapid', 'daily', 'untimed'].includes(record.category)) throw new Error('That time control is not available.');
  if (typeof record.timeLabel !== 'string' || record.timeLabel.length < 1 || record.timeLabel.length > 40) {
    throw new Error('That time control is not available.');
  }
  if (!Array.isArray(record.moves) || record.moves.length > 400) throw new Error('A saved game must include every move.');
  if (!record.moves.length && !['resign', 'agreement', 'timeout'].includes(record.termination)) {
    throw new Error('A saved game must include every move.');
  }
  const sans = [];
  record.moves.forEach((move, index) => {
    const played = playSan(sans, move.san, record.startFen);
    if (move.ply !== index + 1 || move.uci !== played.uci || move.fen !== played.fen) {
      throw new Error('The move list does not replay.');
    }
    sans.push(played.san);
  });
  const end = sans.length ? playSan(sans.slice(0, -1), sans[sans.length - 1], record.startFen).outcome : { over: false, result: '*', termination: '' };
  if (record.termination === 'resign' || record.termination === 'timeout') {
    if (end.over) throw new Error('A finished position is not a resignation.');
    if (!['1-0', '0-1'].includes(record.result)) throw new Error('A resignation needs a winner.');
  } else if (record.termination === 'agreement') {
    if (record.result !== '1/2-1/2') throw new Error('The result does not match the position.');
  } else if (end.over) {
    if (record.result !== end.result || record.termination !== end.termination) throw new Error('The result does not match the position.');
  } else {
    throw new Error('The ending is not one this service stores.');
  }
  return hashRecord(record);
}

export async function handleHumanGet({ url, token, query, send }) {
  if (!url.pathname.startsWith('/api/human')) return false;
  if (!token) return send(401, { error: 'Sign in before doing that.' });
  if (url.pathname === '/api/human/search') {
    const result = await query('select chess_service.human_search($1, $2) as rows', [token, url.searchParams.get('q') || '']);
    return send(200, { profiles: result.rows[0].rows });
  }
  if (url.pathname === '/api/human/lobby' || url.pathname === '/api/human/incoming' || url.pathname === '/api/human/mine') {
    const which = url.pathname.endsWith('lobby') ? 'lobby' : url.pathname.endsWith('incoming') ? 'incoming' : 'mine';
    const result = await query('select chess_service.human_lists($1, $2) as rows', [token, which]);
    return send(200, { games: result.rows[0].rows });
  }
  if (url.pathname === '/api/human/results') {
    const result = await query('select chess_service.human_results($1) as rows', [token]);
    return send(200, { games: result.rows[0].rows });
  }
  const game = url.pathname.match(/^\/api\/human\/games\/([0-9a-f-]{36})$/i);
  if (game) {
    const result = await query('select chess_service.human_get($1, $2, $3) as game', [token, game[1], null]);
    return send(200, result.rows[0].game);
  }
  const invite = url.pathname.match(/^\/api\/human\/invite\/([0-9a-f]{32})$/i);
  if (invite) {
    const result = await query('select chess_service.human_get($1, $2, $3) as game', [token, null, invite[1]]);
    return send(200, result.rows[0].game);
  }
  return false;
}

export async function handleHumanPost({ url, token, body, query, send }) {
  if (!url.pathname.startsWith('/api/human')) return false;
  const authorId = uuid(body.authorId);
  if (url.pathname === '/api/human/challenges') {
    if (body.rated === true) throw new Error('Chess does not store a rated result.');
    const time = resolveTimeControl(body);
    const color = String(body.color || '');
    if (!['white', 'black', 'random'].includes(color)) throw new Error('Choose white, black, or random.');
    const kind = body.kind === 'public' ? 'public' : 'named';
    const opponent = kind === 'named' ? uuid(body.opponentId) : null;
    if (kind === 'named' && !opponent) throw new Error('Choose a Chess member to challenge.');
    const result = await query(
      'select chess_service.human_create($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as game',
      [token, authorId, kind, color, time.category, time.label, time.baseMs, time.incrementMs, time.dailyDays, opponent]
    );
    return send(200, result.rows[0].game);
  }
  const id = uuid(body.id);
  if (url.pathname === '/api/human/cancel') {
    const result = await query('select chess_service.human_cancel($1, $2, $3) as game', [token, authorId, id]);
    return send(200, result.rows[0].game);
  }
  if (url.pathname === '/api/human/decline') {
    const result = await query('select chess_service.human_decline($1, $2, $3) as game', [token, authorId, id]);
    return send(200, result.rows[0].game);
  }
  if (url.pathname === '/api/human/accept') {
    const result = await query('select chess_service.human_accept($1, $2, $3, $4) as game', [token, authorId, id, body.invite || null]);
    return send(200, result.rows[0].game);
  }
  if (url.pathname === '/api/human/move') {
    const current = await query('select chess_service.human_get($1, $2, $3) as game', [token, id, null]);
    const game = current.rows[0].game;
    if (game && game.status === 'finished') return send(200, game);
    if (!game || game.status !== 'active') throw new Error('That game was not found.');
    if (Number(body.version) !== Number(game.version)) throw new Error('The board changed. Reload this game.');
    if (game.myColor !== game.turn) throw new Error('It is not your turn.');
    const played = playSan(game.sans || [], body.san, game.startFen);
    const end = played.outcome.over ? played.outcome : { result: null, termination: null };
    const result = await query('select chess_service.human_move($1, $2, $3, $4, $5, $6, $7) as game', [
      token, authorId, id, Number(body.version), played.san, end.result, end.termination || null
    ]);
    return send(200, result.rows[0].game);
  }
  if (url.pathname === '/api/human/resign') {
    const result = await query('select chess_service.human_resign($1, $2, $3, $4) as game', [token, authorId, id, Number(body.version)]);
    return send(200, result.rows[0].game);
  }
  if (url.pathname === '/api/human/draw') {
    const result = await query('select chess_service.human_draw($1, $2, $3, $4, $5) as game', [token, authorId, id, Number(body.version), String(body.action || '')]);
    return send(200, result.rows[0].game);
  }
  if (url.pathname === '/api/human/abort') {
    const result = await query('select chess_service.human_abort($1, $2, $3) as game', [token, authorId, id]);
    return send(200, result.rows[0].game);
  }
  if (url.pathname === '/api/human/chat') {
    const result = await query('select chess_service.human_chat($1, $2, $3, $4) as game', [token, authorId, id, body.body]);
    return send(200, result.rows[0].game);
  }
  if (url.pathname === '/api/human/record') {
    const result = await query('select chess_service.human_record($1, $2, $3) as game', [token, authorId, id]);
    return send(200, result.rows[0].game);
  }
  if (url.pathname === '/api/human/save') {
    const digest = validatePassRecord(body);
    const result = await query('select chess_service.human_save($1, $2, $3::jsonb, $4) as saved', [token, authorId, JSON.stringify(body), digest]);
    return send(200, result.rows[0].saved);
  }
  return false;
}

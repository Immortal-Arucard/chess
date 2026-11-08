import { createHash } from 'node:crypto';
import { Chess } from '../assets/vendor/chess.js/chess.js';
import { STANDARD_FEN } from '../assets/chess/bot-results.js';

const STYLES = new Set(['standard', 'bold', 'contour']);
const COLORS = new Set(['ink', 'ivory', 'sky']);
const PALETTES = new Set(['midnight', 'classic', 'sea', 'paper', 'indigo']);
const ELOS = new Set([1320, 1600, 2000, 2500, 3190]);

export function canonicalGame(record) {
  return {
    startFen: record.startFen,
    moves: (record.moves || []).map((move) => ({
      ply: move.ply,
      san: move.san,
      uci: move.uci,
      fen: move.fen
    })),
    result: record.result,
    termination: record.termination,
    playerColor: record.playerColor,
    opponentName: record.opponentName,
    opponentUciElo: Number(record.opponentUciElo),
    pieceStyle: record.pieceStyle,
    pieceColor: record.pieceColor,
    palette: record.palette,
    rated: false
  };
}

export function payloadHash(record) {
  return createHash('sha256').update(JSON.stringify(canonicalGame(record))).digest('hex');
}

export function validateGame(record) {
  if (!record || typeof record !== 'object') throw new Error('The game record is incomplete.');
  if (record.rated !== false) throw new Error('Chess does not store a rated result.');
  if (!STYLES.has(record.pieceStyle) || !COLORS.has(record.pieceColor) || !PALETTES.has(record.palette)) {
    throw new Error('That appearance is not one of the saved choices.');
  }
  if (!ELOS.has(Number(record.opponentUciElo))) throw new Error('That engine target is not one of the saved choices.');
  if (!['white', 'black'].includes(record.playerColor)) throw new Error('The player side is missing.');
  if (!Array.isArray(record.moves) || record.moves.length > 400) {
    throw new Error('A saved game must include every move.');
  }
  if (record.moves.length === 0 && record.termination !== 'resign') {
    throw new Error('A saved game must include every move.');
  }
  if (typeof record.pgn !== 'string' || record.pgn.length < 1 || record.pgn.length > 20000) {
    throw new Error('The game record is too long.');
  }
  const game = new Chess();
  if (record.startFen && record.startFen !== STANDARD_FEN) game.load(record.startFen);
  else if (record.startFen !== STANDARD_FEN) throw new Error('The starting position is missing.');
  record.moves.forEach((move, index) => {
    const played = game.move(move.san);
    if (!played) throw new Error('The move list does not replay.');
    const uci = played.from + played.to + (played.promotion || '');
    if (move.ply !== index + 1 || move.uci !== uci || move.fen !== played.after) {
      throw new Error('The move list does not replay.');
    }
  });
  const fenHeader = /\[FEN "([^"]+)"\]/.exec(record.pgn);
  const declaredStart = fenHeader ? fenHeader[1] : STANDARD_FEN;
  if (declaredStart !== (record.startFen || STANDARD_FEN)) {
    throw new Error('The PGN does not match the starting position.');
  }
  const loaded = new Chess();
  loaded.loadPgn(record.pgn);
  const replay = loaded.history({ verbose: true });
  if (replay.length !== record.moves.length || loaded.getHeaders().Result !== record.result) {
    throw new Error('The PGN does not match the move list.');
  }
  replay.forEach((move, index) => {
    if (move.san !== record.moves[index].san) throw new Error('The PGN does not match the move list.');
  });
  const headerFen = loaded.getHeaders().FEN || STANDARD_FEN;
  if (headerFen !== (record.startFen || STANDARD_FEN)) {
    throw new Error('The PGN does not match the starting position.');
  }
  const finalFen = game.fen();
  const listedFinal = record.moves.length ? record.moves[record.moves.length - 1].fen : (record.startFen || STANDARD_FEN);
  if (loaded.fen() !== finalFen || listedFinal !== finalFen) {
    throw new Error('The PGN does not match the move list.');
  }
  const mateResult = game.isCheckmate() ? (game.turn() === 'w' ? '0-1' : '1-0') : null;
  const drawResult = !mateResult && game.isDraw() ? '1/2-1/2' : null;
  if (record.termination === 'resign') {
    if (mateResult || drawResult) throw new Error('A finished position is not a resignation.');
    if (!['1-0', '0-1'].includes(record.result)) throw new Error('A resignation needs a winner.');
  } else if (record.termination === 'checkmate') {
    if (record.result !== mateResult) throw new Error('The result does not match the position.');
  } else if (record.termination === 'draw') {
    if (record.result !== drawResult) throw new Error('The result does not match the position.');
  } else {
    throw new Error('The ending is not one this service stores.');
  }
  return payloadHash(record);
}

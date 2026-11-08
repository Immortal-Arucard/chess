const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

export function pieceName(type) {
  return PIECE_NAMES[type] || 'piece';
}

export function pieceMap(chess) {
  const map = {};
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell) map[cell.square] = { type: cell.type, color: cell.color };
    }
  }
  return map;
}

export function legalTargets(chess, square) {
  return chess.moves({ square, verbose: true }).map((move) => move.to);
}

export function promotionMoves(chess, from, to) {
  return chess.moves({ square: from, verbose: true }).filter((move) => move.to === to && move.promotion);
}

export function applyUci(chess, uci) {
  if (!uci || uci === '(none)' || uci === '0000') return null;
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  const move = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
  if (uci.length === 5) move.promotion = uci[4];
  try {
    return chess.move(move) || null;
  } catch (err) {
    return null;
  }
}

export function outcome(chess) {
  if (chess.isCheckmate()) {
    const winner = chess.turn() === 'w' ? 'Black' : 'White';
    return {
      over: true,
      check: true,
      kind: 'checkmate',
      winner: winner.toLowerCase(),
      text: `Checkmate. ${winner} wins.`
    };
  }
  const reasons = [];
  if (chess.isStalemate()) reasons.push('stalemate');
  if (chess.isInsufficientMaterial()) reasons.push('insufficient material');
  if (chess.isThreefoldRepetition()) reasons.push('threefold repetition');
  if (chess.isDrawByFiftyMoves()) reasons.push('the fifty-move rule');
  if (reasons.length) {
    return {
      over: true,
      check: false,
      kind: 'draw',
      reasons,
      text: `Draw by ${reasons.join(' and ')}.`
    };
  }
  if (chess.isDraw()) {
    return { over: true, check: false, kind: 'draw', reasons: [], text: 'Draw.' };
  }
  const turn = chess.turn() === 'w' ? 'White' : 'Black';
  if (chess.isCheck()) {
    return { over: false, check: true, kind: 'check', text: `Check. ${turn} to move.` };
  }
  return { over: false, check: false, kind: 'play', text: `${turn} to move.` };
}

export function kingSquare(chess, color) {
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.type === 'k' && cell.color === color) return cell.square;
    }
  }
  return null;
}

export function pgnFor(chess, meta) {
  const pairs = [
    'Event', meta.event,
    'Site', meta.site,
    'Date', meta.date,
    'Round', '1',
    'White', meta.white,
    'Black', meta.black
  ];
  if (meta.result) pairs.push('Result', meta.result);
  chess.header(...pairs);
  let text = chess.pgn();
  if (meta.result) {
    text = text.replace(/\[Result "[^"]*"\]/, `[Result "${meta.result}"]`);
    text = text.replace(/\s(?:1-0|0-1|1\/2-1\/2|\*)\s*$/, ` ${meta.result}`);
  }
  return text.trim() + '\n';
}

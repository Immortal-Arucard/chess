const LICHESS = ['bullet', 'blitz', 'rapid', 'classical'];
const CHESSCOM = [
  ['bullet', 'live_bullet'],
  ['blitz', 'live_blitz'],
  ['rapid', 'live_rapid']
];

export function quotesFromLichess(category, body, fetchedAt) {
  const users = Array.isArray(body && body.users) ? body.users : [];
  const quotes = [];
  for (const user of users.slice(0, 20)) {
    const rating = user && user.perfs && user.perfs[category] && user.perfs[category].rating;
    const ref = user && (user.id || user.username);
    if (!ref || !Number.isInteger(rating) || rating < 1 || rating > 4000) continue;
    quotes.push({
      marketId: 'lichess:' + category,
      externalRef: String(ref).toLowerCase(),
      rating,
      asOf: fetchedAt,
      source: 'Lichess public API /api/player/top/20/' + category,
      kind: 'cached_public_api'
    });
  }
  return quotes;
}

export function quotesFromChesscom(body, fetchedAt) {
  const quotes = [];
  for (const [category, key] of CHESSCOM) {
    const rows = Array.isArray(body && body[key]) ? body[key] : [];
    for (const row of rows.slice(0, 20)) {
      if (!row || typeof row.username !== 'string' || !Number.isInteger(row.score)) continue;
      if (row.score < 1 || row.score > 4000) continue;
      quotes.push({
        marketId: 'chesscom:' + category,
        externalRef: row.username.toLowerCase(),
        rating: row.score,
        asOf: fetchedAt,
        source: 'Chess.com public API /pub/leaderboards (' + key + ')',
        kind: 'cached_public_api'
      });
    }
  }
  return quotes;
}

export async function refreshExternalQuotes(fetchImpl, now) {
  const fetchedAt = (now instanceof Date ? now : new Date()).toISOString();
  const headers = { accept: 'application/json', 'user-agent': 'ChessExchange/1.0 (simulated ratings cache)' };
  const quotes = [];
  for (const category of LICHESS) {
    const response = await fetchImpl('https://lichess.org/api/player/top/20/' + category, { headers });
    if (!response.ok) throw new Error('Lichess list was not available.');
    quotes.push(...quotesFromLichess(category, await response.json(), fetchedAt));
  }
  const chesscom = await fetchImpl('https://api.chess.com/pub/leaderboards', { headers });
  if (!chesscom.ok) throw new Error('Chess.com list was not available.');
  quotes.push(...quotesFromChesscom(await chesscom.json(), fetchedAt));
  return quotes;
}

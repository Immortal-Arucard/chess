const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARKET = /^[a-z]+:[a-z0-9]+$/;

function whole(value, min, max) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : String(value ?? '').trim();
  if (!/^[0-9]+$/.test(text)) return null;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return null;
  return String(parsed);
}

function decodedPath(url) {
  try { return decodeURIComponent(url.pathname); } catch (err) { return url.pathname; }
}

export async function handleExchangeGet({ url, token, query, send }) {
  const pathname = decodedPath(url);
  if (!pathname.startsWith('/api/exchange')) return false;
  const session = token || null;
  if (pathname === '/api/exchange/markets') {
    const result = await query('select chess_service.exchange_markets($1) as exchange', [session]);
    return send(200, result.rows[0].exchange);
  }
  if (pathname === '/api/exchange/leaderboard') {
    const requested = Number(url.searchParams.get('limit') || 20);
    const limit = Number.isInteger(requested) ? requested : 20;
    const result = await query('select chess_service.exchange_leaderboard($1) as exchange', [limit]);
    return send(200, result.rows[0].exchange);
  }
  if (pathname === '/api/exchange/portfolio') {
    if (!token) return send(401, { error: 'Sign in before doing that.' });
    const result = await query('select chess_service.exchange_portfolio($1) as exchange', [token]);
    return send(200, result.rows[0].exchange);
  }
  const market = pathname.match(/^\/api\/exchange\/markets\/([a-z]+:[a-z0-9]+)$/);
  if (market && MARKET.test(market[1])) {
    const result = await query('select chess_service.exchange_market($1, $2) as exchange', [session, market[1]]);
    return send(200, result.rows[0].exchange);
  }
  const instrument = pathname.match(/^\/api\/exchange\/instruments\/([0-9a-f-]{36})$/i);
  if (instrument && UUID.test(instrument[1])) {
    const result = await query('select chess_service.exchange_instrument($1) as exchange', [instrument[1]]);
    return send(200, result.rows[0].exchange);
  }
  return false;
}

export async function handleExchangePost({ url, token, body, query, send }) {
  if (!url.pathname.startsWith('/api/exchange')) return false;
  if (url.pathname === '/api/exchange/orders') {
    if (!UUID.test(String(body.instrumentId || ''))) throw new Error('That instrument was not found.');
    const side = body.side === 'buy' || body.side === 'sell' ? body.side : null;
    const orderType = body.orderType === 'limit' || body.orderType === 'market' ? body.orderType : null;
    if (!side) throw new Error('Choose buy or sell.');
    if (!orderType) throw new Error('Choose a limit or market order.');
    const quantity = whole(body.quantity, 1, 100000);
    if (!quantity) throw new Error('Enter a whole number of shares from 1 to 100000.');
    const price = orderType === 'limit' ? whole(body.price, 1, 1000000000000) : null;
    if (orderType === 'limit' && !price) throw new Error('Enter a limit price in whole AMU.');
    const result = await query(
      'select chess_service.exchange_place($1, $2, $3, $4, $5::bigint, $6::integer) as exchange',
      [token, body.instrumentId, side, orderType, price, quantity]
    );
    return send(200, result.rows[0].exchange);
  }
  if (url.pathname === '/api/exchange/orders/cancel') {
    if (!UUID.test(String(body.orderId || ''))) throw new Error('That order was not found.');
    const result = await query('select chess_service.exchange_cancel($1, $2) as exchange', [token, body.orderId]);
    return send(200, result.rows[0].exchange);
  }
  return false;
}

import { sanitizeProfileImage } from './profile-image.mjs';
import { checkoutBody, checkoutEnabled, createRecipientAccount, feeCents, platformFeeBps, reverseTransfer, stripeEventPayload, stripeForm, stripeSignatureValid } from './market-stripe.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function imageBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string' && value.startsWith('\\x') && /^\\x[0-9a-fA-F]*$/.test(value) && value.length % 2 === 0) {
    return Buffer.from(value.slice(2), 'hex');
  }
  return null;
}

function idOf(value) {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function feeBps(stripe) {
  return platformFeeBps(stripe && stripe.feeBps);
}

async function readBounded(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function handleMarketGet({ url, token, query, send, res, stripe }) {
  if (!url.pathname.startsWith('/api/market')) return false;
  if (url.pathname === '/api/market/config') {
    const result = await query('select chess_service.market_config($1) as market', [token || null]);
    const config = result.rows[0].market || {};
    return send(200, {
      checkoutEnabled: checkoutEnabled(stripe),
      admin: config.admin === true,
      profileId: config.profileId || null,
      feeBps: feeBps(stripe)
    });
  }
  if (url.pathname === '/api/market/listings') {
    const result = await query('select chess_service.market_search($1, $2, $3) as listings', [
      url.searchParams.get('q') || '',
      url.searchParams.get('category') || '',
      Number(url.searchParams.get('limit') || 20)
    ]);
    return send(200, { listings: result.rows[0].listings, checkoutEnabled: checkoutEnabled(stripe) });
  }
  const photo = url.pathname.match(/^\/api\/market\/photos\/([0-9a-f-]{36})$/i);
  if (photo) {
    const result = await query('select mime, bytes from chess_service.market_photo($1)', [photo[1]]);
    const image = result.rows[0];
    const bytes = imageBytes(image && image.bytes);
    if (!bytes || !bytes.length) return send(404, { error: 'That listing was not found.' });
    res.writeHead(200, {
      'content-type': image.mime,
      'content-length': bytes.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    });
    res.end(bytes);
    return true;
  }
  const listing = url.pathname.match(/^\/api\/market\/listings\/([0-9a-f-]{36})$/i);
  if (listing) {
    const result = await query('select chess_service.market_listing($1, $2) as listing', [token || null, listing[1]]);
    if (!result.rows[0].listing) return send(404, { error: 'That listing was not found.' });
    return send(200, Object.assign({ checkoutEnabled: checkoutEnabled(stripe) }, result.rows[0].listing));
  }
  if (!token) return send(401, { error: 'Sign in before doing that.' });
  if (url.pathname === '/api/market/orders' || url.pathname === '/api/market/sales') {
    const result = await query('select chess_service.market_orders($1, $2) as orders', [token, url.pathname.endsWith('/sales') ? 'sales' : 'orders']);
    return send(200, { orders: result.rows[0].orders });
  }
  if (url.pathname === '/api/market/seller') {
    const result = await query('select chess_service.market_seller($1) as seller', [token]);
    return send(200, Object.assign({ checkoutEnabled: checkoutEnabled(stripe) }, result.rows[0].seller));
  }
  if (url.pathname === '/api/market/moderation') {
    const result = await query('select chess_service.market_queue($1) as queue', [token]);
    return send(200, { listings: result.rows[0].queue });
  }
  if (url.pathname === '/api/market/disputes') {
    const result = await query('select chess_service.market_disputes($1) as disputes', [token]);
    return send(200, { disputes: result.rows[0].disputes });
  }
  if (url.pathname === '/api/market/trades') {
    const result = await query('select chess_service.market_trades($1) as trades', [token]);
    return send(200, { trades: result.rows[0].trades });
  }
  return false;
}

export async function handleMarketWebhook({ req, query, send, stripe }) {
  const raw = await readBounded(req, 200000);
  const text = raw.toString('utf8');
  if (!stripe || !stripe.webhookSecret || !stripeSignatureValid(text, req.headers['stripe-signature'], stripe.webhookSecret)) {
    return send(400, { error: 'The Stripe event could not be verified.' });
  }
  let event;
  try { event = JSON.parse(text); } catch (err) { return send(400, { error: 'The Stripe event could not be verified.' }); }
  const payload = stripeEventPayload(event);
  const applied = await query('select chess_service.market_stripe_apply($1, $2, $3::jsonb) as action', [String(event.id || ''), String(event.type || ''), JSON.stringify(payload)]);
  const rawAction = applied.rows[0] && applied.rows[0].action;
  const action = typeof rawAction === 'string' ? JSON.parse(rawAction) : rawAction;
  if (action && action.reverseTransfer && checkoutEnabled(stripe)) {
    const reversed = await reverseTransfer(stripe.fetchImpl || fetch, stripe.secretKey, action.reverseTransfer);
    if (action.orderId) await query('select chess_service.market_reversal_note($1, $2)', [action.orderId, reversed]);
  }
  return send(200, { received: true });
}

export async function handleMarketPhoto({ url, token, req, query, send }) {
  const photo = url.pathname.match(/^\/api\/market\/listings\/([0-9a-f-]{36})\/photo$/i);
  if (!photo) return false;
  const raw = await readBounded(req, 524288);
  const image = sanitizeProfileImage(raw, String(req.headers['content-type'] || ''));
  const result = await query('select chess_service.market_photo_add($1, $2, $3, $4) as id', [token, photo[1], image.type, image.bytes]);
  return send(200, { id: result.rows[0].id });
}

export async function handleMarketPost({ url, token, body, query, send, stripe, origin }) {
  if (!url.pathname.startsWith('/api/market')) return false;
  if (url.pathname === '/api/market/listings') {
    const dollars = Number(body.price);
    const price = Number.isInteger(body.priceCents) ? body.priceCents : Math.round(dollars * 100);
    const result = await query(
      'select chess_service.market_save($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as listing',
      [token, idOf(body.id), body.title, body.description, body.category, body.condition, price, Number(body.quantity), body.fulfillment, body.location || '', body.openToTrades === true]
    );
    return send(200, result.rows[0].listing);
  }
  const report = url.pathname.match(/^\/api\/market\/listings\/([0-9a-f-]{36})\/report$/i);
  if (report) {
    const result = await query('select chess_service.market_report($1, $2, $3, $4) as id', [token, report[1], body.reason, body.note || '']);
    return send(200, { id: result.rows[0].id });
  }
  if (url.pathname === '/api/market/connect') {
    if (!checkoutEnabled(stripe)) return send(200, { checkoutEnabled: false, error: 'Checkout not yet enabled' });
    const existing = await query('select chess_service.market_seller($1) as seller', [token]);
    const who = await query('select chess_service.market_config($1) as market', [token]);
    let accountId = existing.rows[0].seller && existing.rows[0].seller.accountId;
    const profileId = who.rows[0].market && who.rows[0].market.profileId;
    if (!accountId) {
      const account = await createRecipientAccount(stripe.fetchImpl || fetch, stripe.secretKey, profileId || 'seller');
      accountId = account.id;
      await query('select chess_service.market_seller_set($1, $2)', [token, accountId]);
    }
    const link = new URLSearchParams();
    link.set('account', accountId);
    link.set('refresh_url', origin + '/marketplace/?connect=refresh');
    link.set('return_url', origin + '/marketplace/?connect=return');
    link.set('type', 'account_onboarding');
    const created = await stripeForm(stripe.fetchImpl || fetch, stripe.secretKey, 'account_links', link);
    return send(200, { url: created.url, checkoutEnabled: true });
  }
  const buy = url.pathname.match(/^\/api\/market\/listings\/([0-9a-f-]{36})\/checkout$/i);
  if (buy) {
    if (!checkoutEnabled(stripe)) return send(200, { checkoutEnabled: false, error: 'Checkout not yet enabled' });
    const opened = await query('select chess_service.market_order_open($1, $2, $3, $4) as order', [token, buy[1], Number(body.quantity || 1), feeBps(stripe)]);
    const order = opened.rows[0].order;
    if (order.checkoutUrl) return send(200, { url: order.checkoutUrl, checkoutEnabled: true });
    const session = await stripeForm(stripe.fetchImpl || fetch, stripe.secretKey, 'checkout/sessions', checkoutBody({
      orderId: order.orderId,
      title: order.title,
      quantity: order.quantity,
      unitCents: order.unitCents,
      feeBps: feeBps(stripe),
      destination: order.destination,
      fulfillment: order.fulfillment,
      successUrl: origin + '/marketplace/?orders=1',
      cancelUrl: origin + '/marketplace/?listing=' + buy[1]
    }), 'chess-checkout-' + order.orderId);
    await query('select chess_service.market_checkout_bind($1, $2, $3)', [order.orderId, session.id, session.url]);
    return send(200, { url: session.url, checkoutEnabled: true });
  }
  if (url.pathname === '/api/market/connect/login') {
    if (!checkoutEnabled(stripe)) return send(200, { checkoutEnabled: false, error: 'Checkout not yet enabled' });
    const seller = await query('select chess_service.market_seller($1) as seller', [token]);
    const accountId = seller.rows[0].seller && seller.rows[0].seller.accountId;
    if (!accountId) return send(200, { checkoutEnabled: true, error: 'Checkout not yet enabled' });
    const link = await stripeForm(stripe.fetchImpl || fetch, stripe.secretKey, 'accounts/' + encodeURIComponent(accountId) + '/login_links', new URLSearchParams());
    return send(200, { url: link.url, checkoutEnabled: true });
  }
  const ship = url.pathname.match(/^\/api\/market\/orders\/([0-9a-f-]{36})\/ship$/i);
  if (ship) {
    const result = await query('select chess_service.market_ship($1, $2, $3) as order', [token, ship[1], body.tracking || '']);
    return send(200, result.rows[0].order);
  }
  if (url.pathname === '/api/market/trades') {
    const result = await query('select chess_service.market_trade_offer($1, $2, $3, $4, $5) as trade', [
      token, idOf(body.offeredId), idOf(body.requestedId), Number(body.cashCents || 0), body.cashPayer || 'none'
    ]);
    return send(200, result.rows[0].trade);
  }
  const tradePay = url.pathname.match(/^\/api\/market\/trades\/([0-9a-f-]{36})\/checkout$/i);
  if (tradePay) {
    if (!checkoutEnabled(stripe)) return send(200, { checkoutEnabled: false, error: 'Checkout not yet enabled' });
    const opened = await query('select chess_service.market_trade_checkout($1, $2) as order', [token, tradePay[1]]);
    const order = opened.rows[0].order;
    if (order.checkoutUrl) return send(200, { url: order.checkoutUrl, checkoutEnabled: true });
    const session = await stripeForm(stripe.fetchImpl || fetch, stripe.secretKey, 'checkout/sessions', checkoutBody({
      orderId: order.orderId,
      title: order.title,
      quantity: order.quantity,
      unitCents: order.unitCents,
      feeBps: feeBps(stripe),
      destination: order.destination,
      fulfillment: order.fulfillment,
      successUrl: origin + '/marketplace/?trades=1',
      cancelUrl: origin + '/marketplace/?trades=1'
    }), 'chess-trade-' + order.orderId);
    await query('select chess_service.market_checkout_bind($1, $2, $3)', [order.orderId, session.id, session.url]);
    return send(200, { url: session.url, checkoutEnabled: true });
  }
  const answer = url.pathname.match(/^\/api\/market\/trades\/([0-9a-f-]{36})\/(accept|decline)$/i);
  if (answer) {
    const result = await query('select chess_service.market_trade_answer($1, $2, $3, $4) as trade', [token, answer[1], answer[2] === 'accept', feeBps(stripe)]);
    return send(200, result.rows[0].trade);
  }
  const moderate = url.pathname.match(/^\/api\/market\/moderation\/([0-9a-f-]{36})$/i);
  if (moderate) {
    const result = await query('select chess_service.market_moderate($1, $2, $3) as listing', [token, moderate[1], body.action]);
    return send(200, result.rows[0].listing);
  }
  return false;
}

export { feeCents };

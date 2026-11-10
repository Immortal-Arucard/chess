import { createHmac, timingSafeEqual } from 'node:crypto';

export const STRIPE_VERSION = '2026-09-30.endive';
const SHIP_COUNTRIES = ['US', 'CA', 'GB', 'AU', 'IE', 'NZ', 'DE', 'FR', 'IT', 'ES', 'NL', 'SE', 'NO', 'DK', 'FI', 'JP', 'MX'];

const ORDER_MOVES = {
  pending: ['paid', 'canceled'],
  paid: ['shipped', 'refunded', 'partially_refunded', 'disputed'],
  shipped: ['refunded', 'partially_refunded', 'disputed'],
  partially_refunded: ['shipped', 'refunded', 'disputed'],
  disputed: ['paid', 'shipped', 'refunded'],
  refunded: [],
  canceled: []
};

export function nextOrderStatus(current, next) {
  const allowed = ORDER_MOVES[current];
  if (!allowed || !allowed.includes(next)) return null;
  return next;
}

export const DEFAULT_FEE_BPS = 500;

export function platformFeeBps(value) {
  if (value == null || String(value).trim() === '') return DEFAULT_FEE_BPS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return DEFAULT_FEE_BPS;
  return Math.min(10000, Math.max(0, parsed));
}

export function feeCents(totalCents, bps) {
  const total = Number(totalCents);
  const rate = platformFeeBps(bps);
  if (!Number.isInteger(total) || total < 0) return 0;
  return Math.floor(total * rate / 10000);
}

export function checkoutEnabled(stripe) {
  const key = String(stripe && stripe.secretKey || '');
  return key.startsWith('sk_') || key.startsWith('rk_');
}

export function checkoutBody(fields) {
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', fields.successUrl);
  params.set('cancel_url', fields.cancelUrl);
  params.set('client_reference_id', fields.orderId);
  params.set('integration_identifier', 'chess.marketplace');
  params.set('line_items[0][quantity]', String(fields.quantity));
  params.set('line_items[0][price_data][currency]', 'usd');
  params.set('line_items[0][price_data][unit_amount]', String(fields.unitCents));
  params.set('line_items[0][price_data][product_data][name]', String(fields.title || 'Chess item').slice(0, 80));
  params.set('metadata[order_id]', fields.orderId);
  params.set('payment_intent_data[metadata][order_id]', fields.orderId);
  params.set('payment_intent_data[transfer_data][destination]', fields.destination);
  const fee = feeCents(fields.unitCents * fields.quantity, platformFeeBps(fields.feeBps));
  if (fee > 0) params.set('payment_intent_data[application_fee_amount]', String(fee));
  if (fields.fulfillment === 'shipping') {
    SHIP_COUNTRIES.forEach((country) => params.append('shipping_address_collection[allowed_countries][]', country));
  }
  return params;
}

export function recipientAccountBody(profileId) {
  return {
    dashboard: 'express',
    defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
    identity: { country: 'us' },
    metadata: { chess_profile: profileId },
    configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
    include: ['configuration.recipient']
  };
}

export function recipientAccountFallback(profileId) {
  const params = new URLSearchParams();
  params.set('country', 'US');
  params.set('controller[fees][payer]', 'application');
  params.set('controller[losses][payments]', 'application');
  params.set('controller[stripe_dashboard][type]', 'express');
  params.set('controller[requirement_collection]', 'stripe');
  params.set('capabilities[transfers][requested]', 'true');
  params.set('metadata[chess_profile]', profileId);
  return params;
}

export function stripeEventPayload(event) {
  const object = event && event.data && event.data.object ? event.data.object : {};
  const metadata = object.metadata || {};
  const shipping = object.shipping_details || object.shipping || {};
  const address = shipping.address || {};
  const capabilities = object.capabilities || {};
  const recipient = object.configuration && object.configuration.recipient;
  const v2Transfers = recipient && recipient.capabilities && recipient.capabilities.stripe_balance && recipient.capabilities.stripe_balance.stripe_transfers;
  const transfersActive = capabilities.transfers === 'active' || (v2Transfers && v2Transfers.status === 'active');
  return {
    orderId: metadata.order_id || metadata.orderId || '',
    paymentStatus: object.payment_status || '',
    paymentIntent: typeof object.payment_intent === 'string' ? object.payment_intent : '',
    sessionId: object.object === 'checkout.session' ? object.id || '' : '',
    transferId: typeof object.transfer === 'string' ? object.transfer : '',
    amount: Number.isInteger(object.amount) ? object.amount : '',
    amountRefunded: Number.isInteger(object.amount_refunded) ? object.amount_refunded : '',
    disputeId: object.object === 'dispute' ? object.id || '' : '',
    disputeStatus: object.object === 'dispute' ? object.status || '' : '',
    accountId: object.object === 'account' ? object.id || '' : (object.account || ''),
    chargesEnabled: object.charges_enabled === true,
    transfersActive: transfersActive === true,
    payoutsEnabled: object.payouts_enabled === true,
    detailsSubmitted: object.details_submitted === true,
    shipName: shipping.name || '',
    shipLine1: address.line1 || '',
    shipLine2: address.line2 || '',
    shipCity: address.city || '',
    shipState: address.state || '',
    shipPostal: address.postal_code || '',
    shipCountry: address.country || ''
  };
}

export function stripeSignatureValid(rawBody, header, secret, nowSeconds) {
  const text = String(header || '');
  const parts = {};
  text.split(',').forEach((piece) => {
    const index = piece.indexOf('=');
    if (index > 0) parts[piece.slice(0, index)] = piece.slice(index + 1);
  });
  const timestamp = Number(parts.t);
  const expected = parts.v1;
  if (!Number.isFinite(timestamp) || !expected || !secret) return false;
  const now = Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) return false;
  const digest = createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex');
  const left = Buffer.from(digest);
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function stripeHeaders(secret, idempotencyKey, json) {
  const headers = {
    authorization: 'Bearer ' + secret,
    'Stripe-Version': STRIPE_VERSION,
    'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded'
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return headers;
}

export async function stripeForm(fetchImpl, secret, path, params, idempotencyKey) {
  const response = await fetchImpl('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: stripeHeaders(secret, idempotencyKey, false),
    body: params.toString()
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('Checkout could not start.');
  return payload;
}

export async function createRecipientAccount(fetchImpl, secret, profileId) {
  const v2 = await fetchImpl('https://api.stripe.com/v2/core/accounts', {
    method: 'POST',
    headers: stripeHeaders(secret, 'chess-account-' + profileId, true),
    body: JSON.stringify(recipientAccountBody(profileId))
  });
  if (v2.ok) {
    const payload = await v2.json().catch(() => ({}));
    if (payload && payload.id) return payload;
  } else {
    await v2.text().catch(() => '');
  }
  return stripeForm(fetchImpl, secret, 'accounts', recipientAccountFallback(profileId), 'chess-account-' + profileId);
}

export async function reverseTransfer(fetchImpl, secret, transferId) {
  if (!transferId || !String(transferId).startsWith('tr_')) return false;
  const response = await fetchImpl('https://api.stripe.com/v1/transfers/' + encodeURIComponent(transferId) + '/reversals', {
    method: 'POST',
    headers: stripeHeaders(secret, 'chess-reverse-' + transferId, false),
    body: ''
  });
  if (!response.ok) {
    await response.text().catch(() => '');
    return false;
  }
  return true;
}

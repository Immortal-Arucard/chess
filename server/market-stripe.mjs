import { createHmac, timingSafeEqual } from 'node:crypto';

const ORDER_MOVES = {
  pending: ['paid', 'canceled'],
  paid: ['shipped', 'refunded'],
  shipped: ['refunded'],
  refunded: [],
  canceled: []
};

export function nextOrderStatus(current, next) {
  const allowed = ORDER_MOVES[current];
  if (!allowed || !allowed.includes(next)) return null;
  return next;
}

export function feeCents(totalCents, bps) {
  const total = Number(totalCents);
  const rate = Number(bps);
  if (!Number.isInteger(total) || total < 0) return 0;
  const applied = Number.isInteger(rate) ? Math.min(10000, Math.max(0, rate)) : 0;
  return Math.floor(total * applied / 10000);
}

export function checkoutBody(fields) {
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', fields.successUrl);
  params.set('cancel_url', fields.cancelUrl);
  params.set('client_reference_id', fields.orderId);
  params.set('line_items[0][quantity]', String(fields.quantity));
  params.set('line_items[0][price_data][currency]', 'usd');
  params.set('line_items[0][price_data][unit_amount]', String(fields.unitCents));
  params.set('line_items[0][price_data][product_data][name]', String(fields.title || 'Chess item').slice(0, 80));
  params.set('metadata[order_id]', fields.orderId);
  params.set('payment_intent_data[metadata][order_id]', fields.orderId);
  params.set('payment_intent_data[transfer_data][destination]', fields.destination);
  const fee = feeCents(fields.unitCents * fields.quantity, fields.feeBps);
  if (fee > 0) params.set('payment_intent_data[application_fee_amount]', String(fee));
  return params;
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

export async function stripeForm(fetchImpl, secret, path, params) {
  const response = await fetchImpl('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + secret,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('Checkout could not start.');
  return payload;
}

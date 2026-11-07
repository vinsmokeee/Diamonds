// Mock payment gateway. A real adapter (Stripe, PayPal, Xendit, PayMongo, Razorpay, ...)
// must expose the same two functions:
//
//   createCheckout(order) -> { checkoutUrl, reference }
//       Create a payment session and return where to send the buyer.
//   parseWebhook(req)     -> { orderId, reference, status: 'paid' | 'failed' } | null
//       Verify the gateway's signature on an incoming webhook and normalise it.
//       Return null if the signature is invalid.
const crypto = require('crypto');
const config = require('../config');

function sign(body) {
  return crypto.createHmac('sha256', config.webhookSecret).update(body).digest('hex');
}

function createCheckout(order) {
  return {
    checkoutUrl: `${config.baseUrl}/checkout/mock/${order.id}`,
    reference: `mock_${crypto.randomBytes(6).toString('hex')}`,
  };
}

function parseWebhook(req) {
  const given = req.get('x-signature') || '';
  const expected = sign(req.rawBody || '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const { orderId, reference, status } = req.body || {};
  if (!orderId || !['paid', 'failed'].includes(status)) return null;
  return { orderId, reference, status };
}

module.exports = { name: 'mock', createCheckout, parseWebhook, sign };

// FazerCards reseller API (https://reseller.fazercards.com) — direct MLBB top-ups.
//
// API facts (from their official SDK, fazercards@0.2.0):
//   base   https://api.fzr.cards/api/v2, header X-API-Key, every 2xx body is { ok: true, ... }
//   POST   /topups/order        { category_id, offer_id, fields: { player_id, zone_id } } -> { order }
//   GET    /orders/{id}         -> { order: { id, status, fail_reason } }
//          status: created | processing | completed | failed | refund (refund = balance returned)
//   POST   /topups/validate-id  { category_id, fields } -> { valid, player_name }  (free nickname check)
//   GET    /balance             -> { balance, currency }
//   Webhooks: X-Webhook-Signature: sha256=<hmac of raw body>, events order.status_changed
//   Idempotency-Key on orders: the same key returns the original order for 7 days, never a 2nd charge.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE = 'https://api.fzr.cards/api/v2';

function loadSettings(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    categoryId: raw.categoryId || 'mobile_legends',
    validateCategoryId: raw.validateCategoryId || '',
    // FazerCards names the zone differently per endpoint: orders use server_id, validate-id uses zone_id.
    fields: raw.fields || { player_id: 'userId', server_id: 'zoneId' },
    validateFields: raw.validateFields || raw.fields || { player_id: 'userId', zone_id: 'zoneId' },
    offers: raw.offers || {},
  };
}

class SupplierError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

function createFazerCards({
  apiKey,
  baseUrl = DEFAULT_BASE,
  webhookSecret = '',
  settings,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  if (!apiKey) throw new Error('FAZER_API_KEY is required for the fazercards supplier');
  const base = baseUrl.replace(/\/+$/, '');

  async function request(method, urlPath, { body, idempotencyKey } = {}) {
    const headers = { 'X-API-Key': apiKey, Accept: 'application/json', 'User-Agent': 'soma-diamonds/1.0' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    // Retrying is only safe for reads, or for writes that carry an idempotency key.
    const replaySafe = method === 'GET' || Boolean(idempotencyKey);

    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchImpl(base + urlPath, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) return data;
        const msg = data.error?.message || data.message || data.error || `HTTP ${res.status}`;
        if (res.status === 429) {
          lastErr = new SupplierError('Supplier is rate limiting us', { status: 429, retryable: true });
          await sleep((Number(res.headers.get?.('retry-after')) || 2) * 1000);
          continue;
        }
        throw new SupplierError(typeof msg === 'string' ? msg : JSON.stringify(msg), {
          status: res.status,
          retryable: res.status >= 500,
        });
      } catch (e) {
        lastErr = e instanceof SupplierError ? e : new SupplierError(e.message || 'Network error', { retryable: true });
        if (!lastErr.retryable || !replaySafe || attempt === 2) throw lastErr;
        await sleep(500 * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  function buildFields(o, map = settings.fields) {
    const fields = {};
    for (const [key, prop] of Object.entries(map)) fields[key] = String(o[prop] ?? '');
    return fields;
  }

  // Map FazerCards status to ours.
  function normalise(fzOrder) {
    const status = fzOrder?.status;
    if (status === 'completed') return { status: 'completed', reference: fzOrder.id };
    if (status === 'failed' || status === 'refund') {
      const reason = fzOrder.fail_reason || fzOrder.failReason;
      return {
        status: 'failed',
        reference: fzOrder.id,
        error: `Supplier ${status === 'refund' ? 'refunded' : 'failed'} the top-up${reason ? `: ${reason}` : ''}`,
      };
    }
    return { status: 'pending', reference: fzOrder?.id };
  }

  return {
    name: 'fazercards',
    manual: false,
    verifiesPlayer: Boolean(settings.validateCategoryId),

    async lookupPlayer(userId, zoneId) {
      if (!settings.validateCategoryId) return { ok: true, nickname: null };
      try {
        const r = await request('POST', '/topups/validate-id', {
          body: { category_id: settings.validateCategoryId, fields: buildFields({ userId, zoneId }, settings.validateFields || settings.fields) },
        });
        if (r.valid === false) return { ok: false, error: 'Player not found. Check your User ID and Zone ID.' };
        const nickname = r.username || r.nickname || r.player_name || r.name || r.data?.username || r.data?.nickname || null;
        return { ok: true, nickname };
      } catch (e) {
        if (e.status === 400 || e.status === 404) return { ok: false, error: 'Player not found. Check your User ID and Zone ID.' };
        throw e;
      }
    },

    /**
     * Start the top-up. Uses a stable idempotency key per delivery attempt, so a
     * timeout + retry can never pay the supplier twice for the same order.
     */
    async fulfill(order) {
      const offerId = settings.offers[order.packageId];
      if (!offerId) return { ok: false, error: `No FazerCards offer set for "${order.packageId}" — deliver by hand or add it to config/fazercards.json.` };
      try {
        const r = await request('POST', '/topups/order', {
          body: { category_id: settings.categoryId, offer_id: offerId, fields: buildFields(order) },
          idempotencyKey: `soma-${order.id}-${order.deliveryAttempts || 1}`,
        });
        const n = normalise(r.order || r);
        if (n.status === 'completed') return { ok: true, reference: n.reference };
        if (n.status === 'failed') return { ok: false, error: n.error, reference: n.reference };
        return { ok: true, pending: true, reference: n.reference };
      } catch (e) {
        // Outcome unknown (e.g. timeout): keep it "processing" without a reference so the admin checks it.
        if (e.retryable) return { ok: true, pending: true, reference: null, warning: `Supplier did not answer: ${e.message}` };
        return { ok: false, error: `Supplier refused the top-up: ${e.message}` };
      }
    },

    /** Poll one supplier order. -> { status: 'completed' | 'failed' | 'pending', error? } */
    async checkOrder(reference) {
      const r = await request('GET', `/orders/${encodeURIComponent(reference)}`);
      return normalise(r.order || r);
    },

    /** Current supplier cost (USD) of each SOMA package that has an offer id. */
    async getPackageCosts() {
      const r = await request('GET', `/topups/offers?category_id=${encodeURIComponent(settings.categoryId)}`);
      const byOffer = Object.fromEntries((r.offers || []).map((o) => [o.offer_id, Number(o.price_usd)]));
      const costs = {};
      for (const [packageId, offerId] of Object.entries(settings.offers)) {
        if (offerId) costs[packageId] = Number.isFinite(byOffer[offerId]) ? byOffer[offerId] : null; // null = offer gone
      }
      return costs;
    },

    async getBalance() {
      const r = await request('GET', '/balance');
      return { balance: r.balance, currency: r.currency || 'USD' };
    },

    /** Verify a FazerCards webhook. Returns { eventId, reference, status, error } or null. */
    parseWebhook(req) {
      if (!webhookSecret) return null;
      let given = String(req.get('x-webhook-signature') || '');
      if (given.toLowerCase().startsWith('sha256=')) given = given.slice(7);
      const expected = crypto.createHmac('sha256', webhookSecret).update(req.rawBody || '').digest('hex');
      const a = Buffer.from(expected);
      const b = Buffer.from(given.toLowerCase());
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      const { event, event_id: eventId, data } = req.body || {};
      if (event === 'webhook.test') return { eventId, test: true };
      const fzOrder = data?.order || data;
      if (!fzOrder?.id) return { eventId, ignore: true };
      return { eventId, ...normalise(fzOrder) };
    },

    _request: request, // for scripts
  };
}

function fromEnv() {
  const file = process.env.FAZER_CONFIG || path.join(__dirname, '..', '..', 'config', 'fazercards.json');
  return createFazerCards({
    apiKey: process.env.FAZER_API_KEY,
    baseUrl: process.env.FAZER_BASE_URL || DEFAULT_BASE,
    webhookSecret: process.env.FAZER_WEBHOOK_SECRET || '',
    settings: loadSettings(file),
  });
}

module.exports = { createFazerCards, loadSettings, fromEnv, SupplierError };

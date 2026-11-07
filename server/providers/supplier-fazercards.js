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

  // A package maps to one offer id, or a list of offer ids (several top-ups to the same player).
  function offersFor(packageId) {
    const spec = settings.offers[packageId];
    return (Array.isArray(spec) ? spec : [spec]).filter(Boolean);
  }

  function summarise(parts) {
    const reference = parts.map((p) => p.reference).filter(Boolean).join('+') || null;
    const done = parts.filter((p) => p.status === 'completed').length;
    const failed = parts.find((p) => p.status === 'failed');
    if (failed) {
      const progress = parts.length > 1 ? ` (${done} of ${parts.length} top-ups delivered)` : '';
      return { ok: false, error: `${failed.error || 'Supplier failed the top-up'}${progress}`, reference, parts };
    }
    if (done === parts.length) return { ok: true, reference, parts };
    const warning = parts.find((p) => p.warning)?.warning;
    return { ok: true, pending: true, reference, parts, ...(warning ? { warning } : {}) };
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
     * Start the top-up. A package may need several supplier top-ups (e.g. 1412 = 2 x 706):
     * each part gets its own idempotency key, completed parts are never re-sent, and a
     * timeout + retry can never pay the supplier twice for the same part.
     * -> { ok, pending?, reference, parts, error?, warning? }
     */
    async fulfill(order) {
      const offers = offersFor(order.packageId);
      if (!offers.length) return { ok: false, error: `No FazerCards offer set for "${order.packageId}" — deliver by hand or add it to config/fazercards.json.` };
      const attempt = order.deliveryAttempts || 1;
      const multi = offers.length > 1;
      const prev = order.supplierParts || [];
      const parts = [];
      for (let i = 0; i < offers.length; i++) {
        const old = prev[i];
        // Keep parts that are done or already with the supplier.
        if (old && (old.status === 'completed' || (old.status === 'pending' && old.reference))) {
          parts.push(old);
          continue;
        }
        const key = multi ? `soma-${order.id}-${attempt}-p${i + 1}` : `soma-${order.id}-${attempt}`;
        try {
          const r = await request('POST', '/topups/order', {
            body: { category_id: settings.categoryId, offer_id: offers[i], fields: buildFields(order) },
            idempotencyKey: key,
          });
          const n = normalise(r.order || r);
          parts.push({ offerId: offers[i], reference: n.reference || null, status: n.status, ...(n.error ? { error: n.error } : {}) });
        } catch (e) {
          // Outcome unknown (e.g. timeout): resend later with the SAME key, which is safe.
          if (e.retryable) parts.push({ offerId: offers[i], reference: null, status: 'pending', warning: `Supplier did not answer: ${e.message}` });
          else parts.push({ offerId: offers[i], reference: null, status: 'failed', error: `Supplier refused the top-up: ${e.message}` });
        }
        if (parts[i].status === 'failed') {
          // Don't start the remaining parts on this attempt.
          for (let j = i + 1; j < offers.length; j++) parts.push(prev[j] && prev[j].status === 'completed' ? prev[j] : { offerId: offers[j], reference: null, status: 'not_started' });
          break;
        }
      }
      return summarise(parts);
    },

    /**
     * Poll the supplier. With parts (multi top-up), checks each unfinished part.
     * -> { status: 'completed' | 'failed' | 'pending', error?, parts?, reference? }
     */
    async checkOrder(reference, parts) {
      if (!parts || !parts.length) {
        const r = await request('GET', `/orders/${encodeURIComponent(reference)}`);
        return normalise(r.order || r);
      }
      const next = [];
      for (const p of parts) {
        if (p.status === 'pending' && p.reference) {
          const r = await request('GET', `/orders/${encodeURIComponent(p.reference)}`);
          const n = normalise(r.order || r);
          next.push({ ...p, status: n.status, ...(n.error ? { error: n.error } : {}) });
        } else {
          next.push(p);
        }
      }
      const s = summarise(next);
      return { status: s.ok ? (s.pending ? 'pending' : 'completed') : 'failed', error: s.error, parts: next, reference: s.reference };
    },

    /** Current supplier cost (USD) of each SOMA package that has an offer id. */
    async getPackageCosts() {
      const r = await request('GET', `/topups/offers?category_id=${encodeURIComponent(settings.categoryId)}`);
      const byOffer = Object.fromEntries((r.offers || []).map((o) => [o.offer_id, Number(o.price_usd)]));
      const costs = {};
      for (const packageId of Object.keys(settings.offers)) {
        const offers = offersFor(packageId);
        if (!offers.length) continue;
        const prices = offers.map((id) => byOffer[id]);
        // null = an offer is gone; bundles cost the sum of their parts
        costs[packageId] = prices.every(Number.isFinite) ? Math.round(prices.reduce((a, b) => a + b, 0) * 10000) / 10000 : null;
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

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const catalog = require('./catalog');

const USER_ID = /^\d{5,12}$/;
const ZONE_ID = /^\d{1,6}$/;
const PHONE = /^[+\d][\d\s-]{6,18}$/;
const TXN_REF = /^[A-Za-z0-9-]{4,40}$/;
const IMAGE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;

// Order lifecycle:
//   pending_payment -> awaiting_verification -> processing -> completed
//                                            \-> payment_failed   \-> failed
const OPEN = ['pending_payment', 'awaiting_verification', 'processing'];

// Tiny fixed-window rate limiter (per IP). Replace with a shared store when running >1 instance.
function rateLimit({ windowMs, max, enabled = true }) {
  const hits = new Map();
  return (req, res, next) => {
    if (!enabled) return next();
    const now = Date.now();
    const entry = hits.get(req.ip);
    if (!entry || now - entry.start > windowMs) {
      hits.set(req.ip, { start: now, count: 1 });
      return next();
    }
    if (++entry.count > max) return res.status(429).json({ error: 'Too many requests, slow down.' });
    next();
  };
}

function publicOrder(o) {
  return {
    id: o.id,
    status: o.status,
    item: o.item,
    amount: o.amount,
    currency: o.currency,
    userId: o.userId,
    zoneId: o.zoneId,
    nickname: o.nickname,
    txnRef: o.txnRef ? `••••${o.txnRef.slice(-4)}` : null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    note: ['failed', 'payment_failed'].includes(o.status) ? o.note : undefined,
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createApp({ store, payment, supplier, receiptsDir, rateLimits = true }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Keep the raw body so webhook signatures can be verified.
  app.use(express.json({ limit: '3mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  app.use(express.urlencoded({ extended: false, limit: '5kb' }));

  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    next();
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/catalog', (_req, res) => {
    res.json({
      currency: config.currency,
      currencySymbol: config.currencySymbol,
      packages: catalog.packages.map((p) => ({ ...p, label: catalog.label(p) })),
      verifiesPlayer: !supplier.manual,
      support: config.support,
    });
  });

  app.get('/api/payment-info', (_req, res) => {
    res.json({ ...config.bank, currencySymbol: config.currencySymbol, support: config.support });
  });

  const lookupLimiter = rateLimit({ windowMs: 60_000, max: 20, enabled: rateLimits });
  app.post('/api/players/lookup', lookupLimiter, async (req, res) => {
    const userId = String(req.body.userId || '').trim();
    const zoneId = String(req.body.zoneId || '').trim();
    if (!USER_ID.test(userId) || !ZONE_ID.test(zoneId)) {
      return res.status(400).json({ error: 'Enter a valid User ID and Zone ID (numbers only).' });
    }
    try {
      const r = await supplier.lookupPlayer(userId, zoneId);
      if (!r.ok) return res.status(404).json({ error: r.error || 'Player not found' });
      res.json({ nickname: r.nickname });
    } catch (e) {
      console.error('lookup failed', e);
      res.status(502).json({ error: 'Could not verify player right now. Try again shortly.' });
    }
  });

  const orderLimiter = rateLimit({ windowMs: 60_000, max: 10, enabled: rateLimits });
  app.post('/api/orders', orderLimiter, async (req, res) => {
    const userId = String(req.body.userId || '').trim();
    const zoneId = String(req.body.zoneId || '').trim();
    const phone = String(req.body.phone || '').trim();
    const pkg = catalog.getPackage(String(req.body.packageId || ''));

    if (!USER_ID.test(userId) || !ZONE_ID.test(zoneId)) return res.status(400).json({ error: 'Invalid User ID or Zone ID.' });
    if (!pkg) return res.status(400).json({ error: 'Choose a package.' });
    if (phone && !PHONE.test(phone)) return res.status(400).json({ error: 'Invalid phone number.' });

    try {
      const player = await supplier.lookupPlayer(userId, zoneId);
      if (!player.ok) return res.status(404).json({ error: player.error || 'Player not found' });

      const now = new Date().toISOString();
      const order = store.create({
        id: crypto.randomBytes(12).toString('base64url'),
        status: 'pending_payment',
        packageId: pkg.id,
        item: catalog.label(pkg),
        amount: pkg.price,
        currency: config.currency,
        userId,
        zoneId,
        nickname: player.nickname || null,
        phone: phone || null,
        paymentProvider: payment.name,
        createdAt: now,
        updatedAt: now,
      });

      const checkout = await payment.createCheckout(order);
      if (checkout.reference) store.update(order.id, { paymentRef: checkout.reference });
      res.status(201).json({ orderId: order.id, checkoutUrl: checkout.checkoutUrl });
    } catch (e) {
      console.error('order create failed', e);
      res.status(502).json({ error: 'Could not start payment. Please try again.' });
    }
  });

  app.get('/api/orders/:id', (req, res) => {
    const o = store.get(req.params.id);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    res.json(publicOrder(o));
  });

  // ---- Manual payment proof (bank QR) --------------------------------------------
  const proofLimiter = rateLimit({ windowMs: 60_000, max: 6, enabled: rateLimits });
  app.post('/api/orders/:id/payment-proof', proofLimiter, (req, res) => {
    if (!payment.manual) return res.status(404).json({ error: 'Not found' });
    const o = store.get(req.params.id);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    if (o.status !== 'pending_payment') return res.status(409).json({ error: 'Payment was already submitted for this order.' });

    const txnRef = String(req.body.txnRef || '').trim().toUpperCase();
    if (!TXN_REF.test(txnRef)) return res.status(400).json({ error: 'Enter the journal / reference number from your bank receipt.' });
    const dupe = store.list().find((x) => x.txnRef === txnRef && x.id !== o.id && x.status !== 'payment_failed');
    if (dupe) return res.status(409).json({ error: 'This reference number was already used for another order.' });

    let receiptFile = null;
    if (req.body.screenshot) {
      const m = IMAGE.exec(String(req.body.screenshot));
      if (!m) return res.status(400).json({ error: 'Screenshot must be a JPG, PNG or WebP image.' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_RECEIPT_BYTES) return res.status(400).json({ error: 'Screenshot is too large (max 2 MB).' });
      if (receiptsDir) {
        fs.mkdirSync(receiptsDir, { recursive: true });
        receiptFile = `${o.id}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
        fs.writeFileSync(path.join(receiptsDir, receiptFile), buf);
      }
    }

    const updated = store.transition(o.id, 'pending_payment', 'awaiting_verification', {
      txnRef,
      receiptFile,
      paymentSubmittedAt: new Date().toISOString(),
    });
    if (!updated) return res.status(409).json({ error: 'Payment was already submitted for this order.' });
    res.json(publicOrder(updated));
  });

  // ---- Payment confirmed -> deliver -----------------------------------------------
  async function deliver(orderId, from, patch) {
    // Only one caller can win this transition, so retries can't double-deliver.
    const order = store.transition(orderId, from, 'processing', { paidAt: new Date().toISOString(), ...patch });
    if (!order) return null;
    try {
      const r = await supplier.fulfill(order);
      if (!r.ok) return store.transition(orderId, 'processing', 'failed', { note: r.error || 'Delivery failed — we will retry or refund.' });
      if (r.pending) return order; // manual supplier: admin marks delivered later
      return store.transition(orderId, 'processing', 'completed', { supplierRef: r.reference, completedAt: new Date().toISOString() });
    } catch (e) {
      console.error('fulfil failed', e);
      return store.transition(orderId, 'processing', 'failed', { note: 'Delivery failed — we will retry or refund.' });
    }
  }

  // For automated gateways that send webhooks.
  app.post('/api/webhooks/payment', async (req, res) => {
    const event = payment.parseWebhook(req);
    if (!event) return res.status(400).json({ error: 'Invalid webhook' });
    if (!store.get(event.orderId)) return res.status(404).json({ error: 'Unknown order' });
    if (event.status === 'failed') store.transition(event.orderId, 'pending_payment', 'payment_failed');
    else await deliver(event.orderId, 'pending_payment', { paymentRef: event.reference });
    res.json({ received: true });
  });

  // ---- Mock checkout (dev only) ---------------------------------------------------
  if (payment.name === 'mock') {
    app.get('/checkout/mock/:id', (req, res) => {
      if (!store.get(req.params.id)) return res.status(404).send('Order not found');
      res.sendFile(path.join(__dirname, '..', 'public', 'mock-checkout.html'));
    });
    app.post('/checkout/mock/:id', async (req, res) => {
      const o = store.get(req.params.id);
      if (!o) return res.status(404).send('Order not found');
      if (req.body.action === 'pay') await deliver(o.id, 'pending_payment', { paymentRef: o.paymentRef });
      else store.transition(o.id, 'pending_payment', 'payment_failed');
      res.redirect(303, `/order.html?id=${encodeURIComponent(o.id)}`);
    });
  }

  // ---- Admin ----------------------------------------------------------------------
  const adminLimiter = rateLimit({ windowMs: 60_000, max: 120, enabled: rateLimits });
  function requireAdmin(req, res, next) {
    const token = (req.get('authorization') || '').replace(/^Bearer /, '');
    if (!config.adminToken || !safeEqual(token, config.adminToken)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  }
  app.use('/api/admin', adminLimiter, requireAdmin);

  app.get('/api/admin/orders', (req, res) => {
    const status = req.query.status;
    let list = store.list();
    if (status === 'open') list = list.filter((o) => OPEN.includes(o.status));
    else if (status) list = list.filter((o) => o.status === status);
    res.json(list);
  });

  app.get('/api/admin/orders/:id/receipt', (req, res) => {
    const o = store.get(req.params.id);
    if (!o || !o.receiptFile || !receiptsDir) return res.status(404).json({ error: 'No screenshot' });
    res.sendFile(path.join(receiptsDir, path.basename(o.receiptFile)));
  });

  const ACTIONS = {
    // Payment seen in the bank app -> start delivery.
    approve: (id) => deliver(id, 'awaiting_verification', {}),
    reject: (id, note) => store.transition(id, 'awaiting_verification', 'payment_failed', { note: note || 'Payment could not be verified.' }),
    delivered: (id) => store.transition(id, 'processing', 'completed', { completedAt: new Date().toISOString() })
      || store.transition(id, 'failed', 'completed', { completedAt: new Date().toISOString() }),
    fail: (id, note) => store.transition(id, 'processing', 'failed', { note: note || 'Delivery failed — we will refund you.' }),
  };

  app.post('/api/admin/orders/:id/:action', async (req, res) => {
    const fn = ACTIONS[req.params.action];
    if (!fn) return res.status(404).json({ error: 'Unknown action' });
    if (!store.get(req.params.id)) return res.status(404).json({ error: 'Order not found' });
    const note = String(req.body.note || '').slice(0, 300);
    const o = await fn(req.params.id, note);
    if (!o) return res.status(409).json({ error: `Can't ${req.params.action} an order in status "${store.get(req.params.id).status}".` });
    res.json(o);
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  return app;
}

module.exports = { createApp };

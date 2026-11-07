const express = require('express');
const crypto = require('crypto');
const path = require('path');
const config = require('./config');
const catalog = require('./catalog');

const USER_ID = /^\d{5,12}$/;
const ZONE_ID = /^\d{1,6}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAYMENT_METHODS = ['card', 'ewallet', 'bank'];

// Tiny fixed-window rate limiter (per IP). Replace with a shared store when running >1 instance.
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
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
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    error: o.status === 'failed' ? o.error : undefined,
  };
}

function createApp({ store, payment, supplier }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Keep the raw body so webhook signatures can be verified.
  app.use(express.json({ limit: '20kb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  app.use(express.urlencoded({ extended: false, limit: '5kb' }));

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
    });
    next();
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/catalog', (_req, res) => {
    res.json({
      currency: config.currency,
      packages: catalog.packages.map((p) => ({ ...p, label: catalog.label(p) })),
      paymentMethods: PAYMENT_METHODS,
    });
  });

  const lookupLimiter = rateLimit({ windowMs: 60_000, max: 20 });
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

  const orderLimiter = rateLimit({ windowMs: 60_000, max: 10 });
  app.post('/api/orders', orderLimiter, async (req, res) => {
    const userId = String(req.body.userId || '').trim();
    const zoneId = String(req.body.zoneId || '').trim();
    const email = String(req.body.email || '').trim();
    const pkg = catalog.getPackage(String(req.body.packageId || ''));
    const method = String(req.body.paymentMethod || '');

    if (!USER_ID.test(userId) || !ZONE_ID.test(zoneId)) return res.status(400).json({ error: 'Invalid User ID or Zone ID.' });
    if (!pkg) return res.status(400).json({ error: 'Choose a package.' });
    if (!PAYMENT_METHODS.includes(method)) return res.status(400).json({ error: 'Choose a payment method.' });
    if (email && (!EMAIL.test(email) || email.length > 200)) return res.status(400).json({ error: 'Invalid email address.' });

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
        nickname: player.nickname,
        email: email || null,
        paymentMethod: method,
        createdAt: now,
        updatedAt: now,
      });

      const checkout = await payment.createCheckout(order);
      store.update(order.id, { paymentRef: checkout.reference });
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

  async function handlePaymentResult({ orderId, reference, status }) {
    if (status === 'failed') {
      store.transition(orderId, 'pending_payment', 'payment_failed');
      return;
    }
    // Only the first "paid" event for an order moves it forward, so webhook retries can't double-deliver.
    const order = store.transition(orderId, 'pending_payment', 'processing', { paidAt: new Date().toISOString(), paymentRef: reference });
    if (!order) return;
    try {
      const r = await supplier.fulfill(order);
      if (r.ok) store.transition(orderId, 'processing', 'completed', { supplierRef: r.reference, completedAt: new Date().toISOString() });
      else store.transition(orderId, 'processing', 'failed', { error: r.error || 'Delivery failed — our team will refund or retry.' });
    } catch (e) {
      console.error('fulfil failed', e);
      store.transition(orderId, 'processing', 'failed', { error: 'Delivery failed — our team will refund or retry.' });
    }
  }

  app.post('/api/webhooks/payment', async (req, res) => {
    const event = payment.parseWebhook(req);
    if (!event) return res.status(400).json({ error: 'Invalid webhook' });
    if (!store.get(event.orderId)) return res.status(404).json({ error: 'Unknown order' });
    await handlePaymentResult(event);
    res.json({ received: true });
  });

  // ---- Mock checkout (dev only) -------------------------------------------------
  if (payment.name === 'mock') {
    app.get('/checkout/mock/:id', (req, res) => {
      const o = store.get(req.params.id);
      if (!o) return res.status(404).send('Order not found');
      res.sendFile(path.join(__dirname, '..', 'public', 'mock-checkout.html'));
    });

    app.post('/checkout/mock/:id', async (req, res) => {
      const o = store.get(req.params.id);
      if (!o) return res.status(404).send('Order not found');
      const status = req.body.action === 'pay' ? 'paid' : 'failed';
      await handlePaymentResult({ orderId: o.id, reference: o.paymentRef, status });
      res.redirect(303, `/order.html?id=${encodeURIComponent(o.id)}`);
    });
  }

  // ---- Admin ----------------------------------------------------------------------
  app.get('/api/admin/orders', (req, res) => {
    const token = (req.get('authorization') || '').replace(/^Bearer /, '');
    const a = Buffer.from(token);
    const b = Buffer.from(config.adminToken);
    if (!config.adminToken || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json(store.list());
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  return app;
}

module.exports = { createApp };

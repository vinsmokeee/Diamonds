const express = require('express');
const crypto = require('crypto');
const path = require('path');
const config = require('./config');
const catalog = require('./catalog');
const { saveDataUrlImage } = require('./images');
const { createChatService, mountChatRoutes, cleanName } = require('./chat');
const { createNotifier } = require('./notify');

const USER_ID = /^\d{5,12}$/;
const ZONE_ID = /^\d{1,6}$/;
const TXN_REF = /^[A-Za-z0-9-]{4,40}$/;

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
    gameName: o.gameName,
    chatId: o.chatId,
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

function createApp({ store, chats, payment, supplier, dataDir = null, rateLimits = true, notifier = null }) {
  const receiptsDir = dataDir ? path.join(dataDir, 'receipts') : null;
  const chat = createChatService({ chats, dataDir });
  const limiter = (opts) => rateLimit({ ...opts, enabled: rateLimits });
  const money = (n) => `${config.currencySymbol} ${n.toLocaleString('en-IN')}`;
  const alerts = notifier || createNotifier({ ...config.telegram, baseUrl: config.baseUrl, money });
  const alertOn = (event) => (config.telegram.events || []).includes(event);
  const notify = (order, text, audience) => order && order.chatId && chat.post(order.chatId, { from: 'system', text, audience });
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

  const lookupLimiter = limiter({ windowMs: 60_000, max: 20 });
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

  const orderLimiter = limiter({ windowMs: 60_000, max: 10 });
  app.post('/api/orders', orderLimiter, async (req, res) => {
    const userId = String(req.body.userId || '').trim();
    const zoneId = String(req.body.zoneId || '').trim();
    const gameName = cleanName(req.body.gameName);
    const pkg = catalog.getPackage(String(req.body.packageId || ''));

    if (!USER_ID.test(userId) || !ZONE_ID.test(zoneId)) return res.status(400).json({ error: 'Invalid User ID or Zone ID.' });
    if (!pkg) return res.status(400).json({ error: 'Choose a package.' });
    if (!gameName) return res.status(400).json({ error: 'Enter your game name.' });

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
        gameName,
        paymentProvider: payment.name,
        createdAt: now,
        updatedAt: now,
      });

      // Reuse the buyer's open chat if it is for the same account, otherwise start one.
      let c = req.body.chatId ? chats.get(String(req.body.chatId)) : null;
      if (c && c.userId === userId && c.zoneId === zoneId) chats.update(c.id, { orderIds: [...c.orderIds, order.id], gameName });
      else c = chat.create({ gameName, userId, zoneId, orderId: order.id });
      store.update(order.id, { chatId: c.id });
      notify(order, `🛒 New order: ${order.item} · ${money(order.amount)}`, 'admin');
      if (alertOn('orders')) alerts.newOrder(order);

      const checkout = await payment.createCheckout(order);
      if (checkout.reference) store.update(order.id, { paymentRef: checkout.reference });
      res.status(201).json({ orderId: order.id, chatId: c.id, checkoutUrl: checkout.checkoutUrl });
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
  const proofLimiter = limiter({ windowMs: 60_000, max: 6 });
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
    if (req.body.screenshot && receiptsDir) {
      const r = saveDataUrlImage(req.body.screenshot, receiptsDir);
      if (r.error) return res.status(400).json({ error: r.error.replace('Photo', 'Screenshot') });
      receiptFile = r.file;
    }

    const updated = store.transition(o.id, 'pending_payment', 'awaiting_verification', {
      txnRef,
      receiptFile,
      paymentSubmittedAt: new Date().toISOString(),
    });
    if (!updated) return res.status(409).json({ error: 'Payment was already submitted for this order.' });
    if (updated.chatId) {
      chat.post(updated.chatId, {
        from: 'buyer',
        text: `💳 Payment submitted for ${updated.item}\nAmount: ${money(updated.amount)}\nJournal no.: ${txnRef}`,
        image: receiptFile ? `receipts/${receiptFile}` : null,
      });
    }
    if (alertOn('payments')) alerts.paymentSubmitted(updated, receiptFile ? path.join(receiptsDir, receiptFile) : null);
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
  const adminLimiter = limiter({ windowMs: 60_000, max: 120 });
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
    const NOTES = {
      approve: '✅ Payment confirmed. We are sending your diamonds now.',
      reject: `❌ Payment could not be verified${note ? `: ${note}` : '.'}`,
      delivered: `💎 ${o.item} delivered to ${o.userId} (${o.zoneId}). Thank you!`,
      fail: `⚠️ Delivery problem${note ? `: ${note}` : '.'}`,
    };
    notify(o, NOTES[req.params.action], 'buyer');
    res.json(o);
  });

  mountChatRoutes(app, {
    chats,
    orders: store,
    service: chat,
    rateLimit: limiter,
    adminSummary: (o) => o,
    onBuyerMessage: (c, msg) => alertOn('messages') && alerts.buyerMessage(c, msg, chat.imagePath(msg)),
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  return app;
}

module.exports = { createApp };

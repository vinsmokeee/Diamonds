const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const catalog = require('./catalog');
const { saveDataUrlImage } = require('./images');
const { createChatService, mountChatRoutes, cleanName } = require('./chat');
const { createNotifier } = require('./notify');
const { createPriceGuard } = require('./pricing');
const { createReceiptReader, fileHash } = require('./receipts');

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
    amountReceived: o.amountReceived || 0,
    amountDue: amountDue(o),
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

// What the buyer still has to pay (after any partial payments).
function amountDue(o) {
  return Math.max(0, o.amount - (o.amountReceived || 0));
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createApp({ store, chats, payment, supplier, playerLookup = null, dataDir = null, rateLimits = true, notifier = null, priceGuard = null, receiptReader = null }) {
  const receiptsDir = dataDir ? path.join(dataDir, 'receipts') : null;
  const chat = createChatService({ chats, dataDir });
  const limiter = (opts) => rateLimit({ ...opts, enabled: rateLimits });
  const money = (n) => `${config.currencySymbol} ${n.toLocaleString('en-IN')}`;
  const alerts = notifier || createNotifier({ ...config.telegram, baseUrl: config.baseUrl, money });
  const alertOn = (event) => (config.telegram.events || []).includes(event);
  const prices = priceGuard || createPriceGuard({ supplier, ...config.pricing });
  const receipts = receiptReader || createReceiptReader({ enabled: config.receiptOcr });

  // In-game name lookup (shown to the buyer as soon as they confirm their ID).
  const lookup = playerLookup || (supplier.verifiesPlayer ? supplier : null);
  const nameCache = new Map(); // "user|zone" -> { result, at }
  async function lookupPlayer(userId, zoneId) {
    if (!lookup) return supplier.lookupPlayer(userId, zoneId);
    const key = `${userId}|${zoneId}`;
    const hit = nameCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.result;
    const result = await lookup.lookupPlayer(userId, zoneId);
    nameCache.set(key, { result, at: Date.now() });
    if (nameCache.size > 5000) nameCache.delete(nameCache.keys().next().value);
    return result;
  }

  // ---- Receipts: a journal number / screenshot can only ever pay for one order ----
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  function journalUsedBy(ref, exceptId) {
    if (!ref) return null;
    return store.list().find((x) => x.id !== exceptId && (x.txnRef === ref || (x.journalHistory || []).includes(ref))) || null;
  }
  function screenshotUsedBy(hash, exceptId) {
    if (!hash) return null;
    return store.list().find((x) => x.id !== exceptId && (x.receiptHashes || []).includes(hash)) || null;
  }

  /**
   * Check a receipt before accepting it. Reads the journal number and amount from the
   * screenshot. -> { error } or { patch, adminNotes }
   */
  async function checkReceipt(order, { typedRef = null, imageFile = null }) {
    const hash = imageFile ? fileHash(imageFile) : null;
    const resent = order.amountReceived > 0; // after "Paid less", the old receipt is not proof of the rest
    if (screenshotUsedBy(hash, order.id) || (resent && hash && (order.receiptHashes || []).includes(hash))) {
      return { error: 'This screenshot was already used. Please send the receipt for this payment.' };
    }
    if (typedRef && (journalUsedBy(typedRef, order.id) || (resent && (order.journalHistory || []).includes(typedRef)))) {
      return { error: `Journal no. ${typedRef} was already used. Please send the receipt for this payment.` };
    }
    const ocr = imageFile ? await receipts.read(imageFile) : null;
    const readRef = ocr && ocr.journalNo;
    if (readRef && (journalUsedBy(readRef, order.id) || (resent && (order.journalHistory || []).includes(readRef)))) {
      return { error: `This receipt (journal no. ${readRef}) was already used. Please send the receipt for this payment.` };
    }

    const due = amountDue(order);
    const adminNotes = [];
    if (imageFile && receipts.enabled && !ocr) adminNotes.push('🔍 Could not read the screenshot automatically. Check the journal number by eye.');
    else if (imageFile && ocr && !readRef) adminNotes.push('🔍 No journal number found on the screenshot. Check it by eye, then use "Set journal no.".');
    if (typedRef && readRef && typedRef !== readRef) adminNotes.push(`⚠️ Buyer typed journal no. ${typedRef} but the screenshot says ${readRef}.`);
    if (ocr && ocr.amount !== null && ocr.amount < due) adminNotes.push(`⚠️ Screenshot shows ${money(ocr.amount)} but ${money(due)} is due. Check your bank before approving.`);

    const txnRef = typedRef || readRef || null;
    return {
      adminNotes,
      patch: {
        txnRef,
        ocrJournalNo: readRef || null,
        receiptAmount: ocr ? ocr.amount : null,
        receiptHashes: uniq([...(order.receiptHashes || []), hash]),
        journalHistory: uniq([...(order.journalHistory || []), txnRef, readRef]),
      },
    };
  }

  function postAdminNotes(chatId, notes) {
    for (const text of notes) chat.post(chatId, { from: 'system', audience: 'admin', adminOnly: true, text });
  }
  const notify = (order, text, audience) => order && order.chatId && chat.post(order.chatId, { from: 'system', text, audience });
  const app = express();
  app.locals.priceGuard = prices;
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
      // Packages paused by the price guard (cost went up) are hidden from buyers.
      packages: catalog.packages.filter((p) => !prices.isPaused(p.id)).map(({ deliveryHint, ...p }) => ({ ...p, label: catalog.label(p) })),
      verifiesPlayer: Boolean(lookup),
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
      const r = await lookupPlayer(userId, zoneId);
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
    if (prices.isPaused(pkg.id)) return res.status(409).json({ error: 'This package is temporarily unavailable. Please choose another one.' });

    try {
      let player;
      try {
        player = await lookupPlayer(userId, zoneId);
      } catch (e) {
        console.error('player lookup unavailable, continuing without nickname', e.message);
        player = { ok: true, nickname: null };
      }
      if (!player.ok) return res.status(404).json({ error: player.error || 'Player not found' });
      // Players only enter their IDs; show their in-game name when the supplier can look it up.
      const displayName = gameName || cleanName(player.nickname) || `Player ${userId}`;

      const now = new Date().toISOString();
      const order = store.create({
        id: crypto.randomBytes(12).toString('base64url'),
        status: 'pending_payment',
        packageId: pkg.id,
        item: catalog.label(pkg),
        ...(pkg.deliveryHint ? { deliveryHint: pkg.deliveryHint } : {}),
        amount: pkg.price,
        currency: config.currency,
        userId,
        zoneId,
        nickname: player.nickname || null,
        gameName: displayName,
        paymentProvider: payment.name,
        createdAt: now,
        updatedAt: now,
      });

      // Reuse the buyer's open chat if it is for the same account, otherwise start one.
      let c = req.body.chatId ? chats.get(String(req.body.chatId)) : null;
      if (c && c.userId === userId && c.zoneId === zoneId) chats.update(c.id, { orderIds: [...c.orderIds, order.id], gameName: displayName });
      else c = chat.create({ gameName: displayName, userId, zoneId, orderId: order.id });
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
  app.post('/api/orders/:id/payment-proof', proofLimiter, async (req, res) => {
    if (!payment.manual) return res.status(404).json({ error: 'Not found' });
    const o = store.get(req.params.id);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    if (o.status !== 'pending_payment') return res.status(409).json({ error: 'Payment was already submitted for this order.' });

    // Proof = the receipt screenshot, the journal number, or both (at least one).
    const txnRef = String(req.body.txnRef || '').trim().toUpperCase() || null;
    if (!txnRef && !req.body.screenshot) {
      return res.status(400).json({ error: 'Attach a screenshot of your payment receipt (or enter the journal number).' });
    }
    if (txnRef && !TXN_REF.test(txnRef)) return res.status(400).json({ error: 'That journal / reference number does not look right.' });

    let receiptFile = null;
    if (req.body.screenshot && receiptsDir) {
      const r = saveDataUrlImage(req.body.screenshot, receiptsDir);
      if (r.error) return res.status(400).json({ error: r.error.replace('Photo', 'Screenshot') });
      receiptFile = r.file;
    }
    const receiptPath = receiptFile ? path.join(receiptsDir, receiptFile) : null;

    const check = await checkReceipt(o, { typedRef: txnRef, imageFile: receiptPath });
    if (check.error) {
      if (receiptPath) fs.rm(receiptPath, { force: true }, () => {});
      return res.status(409).json({ error: check.error });
    }

    const updated = store.transition(o.id, 'pending_payment', 'awaiting_verification', {
      ...check.patch,
      receiptFile,
      paymentSubmittedAt: new Date().toISOString(),
    });
    if (!updated) return res.status(409).json({ error: 'Payment was already submitted for this order.' });
    const shownRef = updated.txnRef;
    if (updated.chatId) {
      chat.post(updated.chatId, {
        from: 'buyer',
        text: `💳 I have paid for ${updated.item}\nAmount: ${money(amountDue(updated))}` + (updated.amountReceived ? ` (remaining of ${money(updated.amount)})` : '') + (shownRef ? `\nJournal no.: ${shownRef}` : ''),
        image: receiptFile ? `receipts/${receiptFile}` : null,
      });
      chat.post(updated.chatId, {
        from: 'system',
        text: '⏳ Thanks! We are checking your payment. Your diamonds will be sent to your game account automatically once it is confirmed.',
      });
      postAdminNotes(updated.chatId, check.adminNotes);
    }
    if (alertOn('payments')) alerts.paymentSubmitted(updated, receiptPath);
    res.json(publicOrder(updated));
  });

  // ---- Payment confirmed -> deliver -----------------------------------------------
  const BUYER_FAIL_NOTE = 'Delivery is delayed — we are fixing it, or we will refund you.';

  function markDelivered(orderId, from, patch = {}) {
    const o = store.transition(orderId, from, 'completed', { completedAt: new Date().toISOString(), ...patch });
    if (o) notify(o, `💎 ${o.item} delivered to ${o.userId} (${o.zoneId}). Thank you!`, 'buyer');
    return o;
  }

  function markDeliveryFailed(orderId, reason, patch = {}) {
    const o = store.transition(orderId, 'processing', 'failed', { note: BUYER_FAIL_NOTE, deliveryError: reason, ...patch });
    if (!o) return null;
    notify(o, `⚠️ ${BUYER_FAIL_NOTE}`, 'buyer');
    if (o.chatId) {
      chat.post(o.chatId, {
        from: 'system',
        audience: 'admin',
        adminOnly: true,
        text: `🔧 Automatic delivery failed: ${reason}\nPress "Retry delivery", or top up by hand and press "Delivered by hand".`,
      });
    }
    return o;
  }

  // Ask the supplier to deliver, and record what happened.
  async function runFulfil(orderId) {
    const order = store.get(orderId);
    try {
      const r = await supplier.fulfill(order);
      // Multi top-up packages report each part, so a retry only resends what's missing.
      const parts = r.parts ? { supplierParts: r.parts } : {};
      if (!r.ok) return markDeliveryFailed(orderId, r.error || 'Supplier error', { supplierRef: r.reference || order.supplierRef || null, ...parts });
      if (r.pending) {
        // Manual supplier (admin marks delivered) or an async top-up the sync loop/webhook will finish.
        return store.update(orderId, { supplierRef: r.reference || null, ...parts, ...(r.warning ? { deliveryWarning: r.warning } : {}) });
      }
      return markDelivered(orderId, 'processing', { supplierRef: r.reference, ...parts });
    } catch (e) {
      console.error('fulfil failed', e);
      return markDeliveryFailed(orderId, e.message || 'Supplier error');
    }
  }

  async function deliver(orderId, from, patch) {
    // Only one caller can win this transition, so retries can't double-deliver.
    const current = store.get(orderId);
    const attempts = (current?.deliveryAttempts || 0) + 1;
    const order = store.transition(orderId, from, 'processing', {
      ...(from === 'failed' ? {} : { paidAt: new Date().toISOString() }),
      deliveryAttempts: attempts,
      deliveryError: null,
      deliveryWarning: null,
      note: null,
      ...patch,
    });
    if (!order) return null;
    notify(order, from === 'failed' ? '🔁 Sending your diamonds again…' : '✅ Payment confirmed. We are sending your diamonds now.', 'buyer');
    return runFulfil(orderId);
  }

  // Apply a supplier status update (from polling or a webhook) to our order.
  function applySupplierStatus(order, update) {
    if (!order || order.status !== 'processing') return;
    // A single-order update (e.g. a webhook) also updates the matching part, so Retry knows what to resend.
    let partsList = update.parts;
    if (!partsList && order.supplierParts && update.status !== 'pending') {
      partsList = order.supplierParts.map((p) =>
        p.status === 'pending' && (!update.reference || p.reference === update.reference)
          ? { ...p, status: update.status, ...(update.error ? { error: update.error } : {}) }
          : p);
    }
    const parts = partsList ? { supplierParts: partsList } : {};
    if (update.status === 'completed') markDelivered(order.id, 'processing', { supplierRef: update.reference || order.supplierRef, ...parts });
    else if (update.status === 'failed') markDeliveryFailed(order.id, update.error || 'Supplier failed the top-up', parts);
    else if (update.parts) store.update(order.id, parts); // some parts done, others still running
  }

  // Bring one order up to date with the supplier.
  async function syncOrder(o) {
    const parts = o.supplierParts || [];
    const unsent = !o.supplierRef || parts.some((p) => p.status === 'pending' && !p.reference);
    if (unsent) return runFulfil(o.id); // same attempt = same idempotency keys, so this is safe
    return applySupplierStatus(o, await supplier.checkOrder(o.supplierRef, parts.length ? parts : undefined));
  }

  // Safety net for automatic suppliers: finish orders whose webhook never came,
  // and resend ones whose first request timed out (same idempotency key = no double charge).
  let syncing = false;
  async function syncSupplierOrders() {
    if (supplier.manual || !supplier.checkOrder || syncing) return;
    syncing = true;
    try {
      for (const o of store.list().filter((x) => x.status === 'processing')) {
        try {
          await syncOrder(o);
        } catch (e) {
          console.error('supplier sync failed for', o.id, e.message);
        }
      }
    } finally {
      syncing = false;
    }
  }
  app.locals.syncSupplierOrders = syncSupplierOrders;

  // Supplier delivery webhooks (e.g. FazerCards order.status_changed).
  const seenSupplierEvents = new Set();
  app.post('/api/webhooks/supplier', (req, res) => {
    if (!supplier.parseWebhook) return res.status(404).json({ error: 'Not found' });
    const event = supplier.parseWebhook(req);
    if (!event) return res.status(401).json({ error: 'Bad signature' });
    if (event.eventId && seenSupplierEvents.has(event.eventId)) return res.json({ received: true, duplicate: true });
    if (event.eventId) {
      seenSupplierEvents.add(event.eventId);
      if (seenSupplierEvents.size > 5000) seenSupplierEvents.delete(seenSupplierEvents.values().next().value);
    }
    if (!event.test && !event.ignore && event.reference) {
      const o = store.list().find((x) => x.supplierRef === event.reference || (x.supplierParts || []).some((p) => p.reference === event.reference));
      if (o && (o.supplierParts || []).length > 1) {
        // One part of a multi top-up changed: re-check all parts.
        syncOrder(o).catch((e) => console.error('webhook sync', e.message));
      } else {
        applySupplierStatus(o, event);
      }
    }
    res.json({ received: true });
  });

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

  app.get('/api/admin/pricing', (_req, res) => res.json(prices.report()));

  app.get('/api/admin/supplier', async (_req, res) => {
    const info = { name: supplier.name, automatic: !supplier.manual };
    if (supplier.getBalance) {
      try { Object.assign(info, await supplier.getBalance()); } catch (e) { info.error = e.message; }
    }
    res.json(info);
  });

  // Each action returns the updated order and posts its own chat notes.
  const ACTIONS = {
    // Payment seen in the bank app -> start delivery.
    // Also allowed straight from "unpaid": e.g. the money is in the bank but the buyer sent nothing.
    approve: (id) => {
      const cur = store.get(id);
      const clash = journalUsedBy(cur.txnRef, id);
      if (clash) {
        const e = new Error(`Journal no. ${cur.txnRef} is already used by order ${clash.id} (${clash.item}, ${clash.userId}). Check the receipt.`);
        e.status = 400;
        throw e;
      }
      return cur.status === 'pending_payment' ? deliver(id, 'pending_payment', {}) : deliver(id, 'awaiting_verification', {});
    },
    // Admin enters / corrects the journal number (e.g. when it could not be read from the screenshot).
    journal: (id, note, body) => {
      const ref = String(body.txnRef || '').trim().toUpperCase();
      if (!TXN_REF.test(ref)) {
        const e = new Error('Enter a valid journal / reference number.');
        e.status = 400;
        throw e;
      }
      const clash = journalUsedBy(ref, id);
      if (clash) {
        const e = new Error(`Journal no. ${ref} is already used by order ${clash.id} (${clash.item}, ${clash.userId}).`);
        e.status = 400;
        throw e;
      }
      const cur = store.get(id);
      return store.update(id, { txnRef: ref, journalHistory: uniq([...(cur.journalHistory || []), ref]) });
    },
    reject: (id, note) => {
      const o = store.transition(id, 'awaiting_verification', 'payment_failed', { note: note || 'Payment could not be verified.' });
      if (o) notify(o, `❌ Payment could not be verified${note ? `: ${note}` : '.'}`, 'buyer');
      return o;
    },
    // Buyer paid less than the price: record what arrived and ask for the rest.
    partial: (id, note, body) => {
      const cur = store.get(id);
      const received = Math.round(Number(body.received));
      const due = amountDue(cur);
      if (!Number.isFinite(received) || received <= 0 || received >= due) {
        const e = new Error(`Enter the amount that arrived: more than 0 and less than ${money(due)}.`);
        e.status = 400;
        throw e;
      }
      const o = store.transition(id, 'awaiting_verification', 'pending_payment', {
        amountReceived: (cur.amountReceived || 0) + received,
        partialPayments: [...(cur.partialPayments || []), { received, txnRef: cur.txnRef || null, at: new Date().toISOString() }],
        txnRef: null,
      });
      if (o) {
        notify(o, `💰 We received ${money(received)} but the price is ${money(due)}. Please pay the remaining ${money(amountDue(o))} to the same QR and send the receipt here.`, 'buyer');
      }
      return o;
    },
    delivered: (id) => markDelivered(id, 'processing') || markDelivered(id, 'failed'),
    fail: (id, note) => {
      const o = store.transition(id, 'processing', 'failed', { note: note || 'Delivery failed — we will refund you.' });
      if (o) notify(o, `⚠️ Delivery problem${note ? `: ${note}` : '.'}`, 'buyer');
      return o;
    },
    // Automatic suppliers only: try the top-up again (new attempt = new idempotency key).
    retry: (id) => (supplier.manual ? null : deliver(id, 'failed', {})),
  };

  app.post('/api/admin/orders/:id/:action', async (req, res) => {
    const fn = ACTIONS[req.params.action];
    if (!fn) return res.status(404).json({ error: 'Unknown action' });
    if (!store.get(req.params.id)) return res.status(404).json({ error: 'Order not found' });
    const note = String(req.body.note || '').slice(0, 300);
    let o;
    try {
      o = await fn(req.params.id, note, req.body);
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      throw e;
    }
    if (!o) return res.status(409).json({ error: `Can't ${req.params.action} an order in status "${store.get(req.params.id).status}".` });
    res.json(store.get(req.params.id));
  });

  // A photo sent in the chat while the buyer has an unpaid order counts as their payment receipt.
  async function acceptChatReceipt(c, msg) {
    const orderId = [...(c.orderIds || [])].reverse().find((id) => store.get(id)?.status === 'pending_payment');
    if (!orderId) return;
    const imageFile = chat.imagePath(msg);
    const check = await checkReceipt(store.get(orderId), { imageFile });
    if (check.error) {
      chat.post(c.id, { from: 'system', audience: 'buyer', text: `⚠️ ${check.error}` });
      return;
    }
    const o = store.transition(orderId, 'pending_payment', 'awaiting_verification', {
      ...check.patch,
      paymentSubmittedAt: new Date().toISOString(),
      receiptChatMessageId: msg.id,
    });
    if (!o) return;
    chat.post(c.id, {
      from: 'system',
      audience: 'admin',
      text: `⏳ Got your receipt for ${o.item} (${money(amountDue(o))})${o.txnRef ? `, journal no. ${o.txnRef}` : ''}. We are checking your payment, and your diamonds will be sent automatically once it is confirmed.`,
    });
    postAdminNotes(c.id, check.adminNotes);
    if (alertOn('payments')) alerts.paymentSubmitted(o, imageFile);
  }

  mountChatRoutes(app, {
    chats,
    orders: store,
    service: chat,
    rateLimit: limiter,
    adminSummary: (o) => o,
    onBuyerMessage: (c, msg) => {
      if (msg.image) acceptChatReceipt(c, msg).catch((e) => console.error('chat receipt', e));
      if (alertOn('messages')) alerts.buyerMessage(c, msg, chat.imagePath(msg));
    },
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  return app;
}

module.exports = { createApp };

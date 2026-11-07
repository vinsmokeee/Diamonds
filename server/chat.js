// Buyer <-> shop chat. Every order gets its own chat; buyers can also start one
// before ordering by giving their game name and ID. Messages can carry a photo.
const crypto = require('crypto');
const path = require('path');
const { saveDataUrlImage } = require('./images');

const USER_ID = /^\d{5,12}$/;
const ZONE_ID = /^\d{1,6}$/;
const MAX_TEXT = 1000;
const MAX_MESSAGES = 500;

function cleanName(v) {
  return String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 30);
}

function createChatService({ chats, dataDir }) {
  const imageDirs = {
    chat: dataDir ? path.join(dataDir, 'chat') : null,
    receipts: dataDir ? path.join(dataDir, 'receipts') : null,
  };

  function create({ gameName, userId, zoneId, orderId = null }) {
    const now = new Date().toISOString();
    return chats.create({
      id: crypto.randomBytes(16).toString('base64url'),
      gameName,
      userId,
      zoneId,
      orderIds: orderId ? [orderId] : [],
      messages: [],
      seq: 0,
      adminUnread: 0,
      buyerUnread: 0,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
    });
  }

  /**
   * Append a message. from: 'buyer' | 'admin' | 'system'. image: 'chat/<file>' | 'receipts/<file>'.
   * System notes count as unread only for `audience` ('buyer' | 'admin'), not for whoever caused them.
   * `adminOnly` notes are never shown to the buyer.
   */
  function post(chatId, { from, text = '', image = null, audience = null, adminOnly = false }) {
    const c = chats.get(chatId);
    if (!c) return null;
    const msg = { id: c.seq + 1, from, text, image, at: new Date().toISOString(), ...(adminOnly ? { adminOnly: true } : {}) };
    const messages = [...c.messages, msg].slice(-MAX_MESSAGES);
    return chats.update(chatId, {
      seq: msg.id,
      messages,
      lastMessageAt: msg.at,
      adminUnread: from === 'admin' ? 0 : c.adminUnread + (from === 'buyer' || audience === 'admin' ? 1 : 0),
      buyerUnread: from === 'buyer' ? 0 : c.buyerUnread + (!adminOnly && (from === 'admin' || audience === 'buyer') ? 1 : 0),
    }) && msg;
  }

  function imagePath(msg) {
    if (!msg || !msg.image) return null;
    const [kind, file] = msg.image.split('/');
    const dir = imageDirs[kind];
    return dir ? path.join(dir, path.basename(file)) : null;
  }

  function publicMessage(m, urlBase) {
    return {
      id: m.id,
      from: m.from,
      text: m.text,
      at: m.at,
      image: m.image ? `${urlBase}/images/${m.id}` : null,
      ...(m.adminOnly ? { adminOnly: true } : {}),
    };
  }

  /** Validate text/photo from a request body, save the photo. Returns { text, image } or { error }. */
  function readMessage(body) {
    const text = String(body.text || '').replace(/\r\n/g, '\n').trim();
    if (text.length > MAX_TEXT) return { error: `Message is too long (max ${MAX_TEXT} characters).` };
    let image = null;
    if (body.image) {
      if (!imageDirs.chat) return { error: 'Photos are not enabled.' };
      const r = saveDataUrlImage(body.image, imageDirs.chat);
      if (r.error) return r;
      image = `chat/${r.file}`;
    }
    if (!text && !image) return { error: 'Write a message or attach a photo.' };
    return { text, image };
  }

  return { create, post, imagePath, publicMessage, readMessage, imageDirs };
}

function mountChatRoutes(app, { chats, orders, service, rateLimit, adminSummary, onBuyerMessage = () => {} }) {
  const startLimiter = rateLimit({ windowMs: 60_000, max: 5 });
  const msgLimiter = rateLimit({ windowMs: 60_000, max: 20 });

  const buyerView = (c, after) => ({
    id: c.id,
    gameName: c.gameName,
    userId: c.userId,
    zoneId: c.zoneId,
    orderIds: c.orderIds,
    messages: c.messages.filter((m) => m.id > after && !m.adminOnly).map((m) => service.publicMessage(m, `/api/chats/${c.id}`)),
    unread: c.buyerUnread,
  });

  // ---- Buyer --------------------------------------------------------------------
  app.post('/api/chats', startLimiter, (req, res) => {
    const gameName = cleanName(req.body.gameName);
    const userId = String(req.body.userId || '').trim();
    const zoneId = String(req.body.zoneId || '').trim();
    if (!USER_ID.test(userId) || !ZONE_ID.test(zoneId)) return res.status(400).json({ error: 'Enter a valid User ID and Zone ID.' });
    const c = service.create({ gameName: gameName || `Player ${userId}`, userId, zoneId });
    res.status(201).json(buyerView(c, 0));
  });

  app.get('/api/chats/:id', (req, res) => {
    const c = chats.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Chat not found' });
    const after = Number(req.query.after) || 0;
    const view = buyerView(c, after);
    if (req.query.read === '1' && c.buyerUnread) chats.update(c.id, { buyerUnread: 0 });
    res.json(view);
  });

  app.post('/api/chats/:id/messages', msgLimiter, (req, res) => {
    if (!chats.get(req.params.id)) return res.status(404).json({ error: 'Chat not found' });
    const m = service.readMessage(req.body);
    if (m.error) return res.status(400).json({ error: m.error });
    const msg = service.post(req.params.id, { from: 'buyer', ...m });
    onBuyerMessage(chats.get(req.params.id), msg);
    res.status(201).json(service.publicMessage(msg, `/api/chats/${req.params.id}`));
  });

  app.get('/api/chats/:id/images/:msgId', (req, res) => {
    const c = chats.get(req.params.id);
    const file = c && service.imagePath(c.messages.find((m) => m.id === Number(req.params.msgId) && !m.adminOnly));
    if (!file) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'private, max-age=86400').sendFile(file, (err) => err && !res.headersSent && res.status(404).end());
  });

  // ---- Admin (mounted after the /api/admin auth middleware) -----------------------
  app.get('/api/admin/chats', (_req, res) => {
    const list = chats.list()
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
      .filter((c) => c.messages.length)
      .map((c) => {
        const last = c.messages[c.messages.length - 1];
        const order = c.orderIds.length ? orders.get(c.orderIds[c.orderIds.length - 1]) : null;
        return {
          id: c.id,
          gameName: c.gameName,
          userId: c.userId,
          zoneId: c.zoneId,
          unread: c.adminUnread,
          lastMessageAt: c.lastMessageAt,
          preview: last ? `${last.from === 'admin' ? 'You: ' : last.adminOnly ? '🔒 ' : ''}${last.text || '📷 Photo'}`.slice(0, 80) : '',
          orderStatus: order ? order.status : null,
        };
      });
    res.json({ unreadTotal: list.reduce((n, c) => n + c.unread, 0), chats: list });
  });

  app.get('/api/admin/chats/:id', (req, res) => {
    const c = chats.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Chat not found' });
    const after = Number(req.query.after) || 0;
    if (c.adminUnread) chats.update(c.id, { adminUnread: 0 });
    res.json({
      id: c.id,
      gameName: c.gameName,
      userId: c.userId,
      zoneId: c.zoneId,
      messages: c.messages.filter((m) => m.id > after).map((m) => service.publicMessage(m, `/api/admin/chats/${c.id}`)),
      orders: c.orderIds.map((id) => orders.get(id)).filter(Boolean).map(adminSummary),
    });
  });

  app.post('/api/admin/chats/:id/messages', (req, res) => {
    if (!chats.get(req.params.id)) return res.status(404).json({ error: 'Chat not found' });
    const m = service.readMessage(req.body);
    if (m.error) return res.status(400).json({ error: m.error });
    const msg = service.post(req.params.id, { from: 'admin', ...m });
    res.status(201).json(service.publicMessage(msg, `/api/admin/chats/${req.params.id}`));
  });

  app.get('/api/admin/chats/:id/images/:msgId', (req, res) => {
    const c = chats.get(req.params.id);
    const file = c && service.imagePath(c.messages.find((m) => m.id === Number(req.params.msgId)));
    if (!file) return res.status(404).json({ error: 'Not found' });
    res.sendFile(file, (err) => err && !res.headersSent && res.status(404).end());
  });
}

module.exports = { createChatService, mountChatRoutes, cleanName };

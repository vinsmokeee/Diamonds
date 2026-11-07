process.env.ADMIN_TOKEN = 'test-admin-token';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server/app');
const { JsonStore } = require('../server/store');
const { createReceiptReader } = require('../server/receipts');

async function start({ payment, supplier, notifier, priceGuard, receiptReader }) {
  const store = new JsonStore(null);
  const chats = new JsonStore(null);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diamonds-'));
  const receiptsDir = path.join(dataDir, 'receipts');
  const app = createApp({
    store, chats, payment, supplier, dataDir, notifier, priceGuard, rateLimits: false,
    // OCR is slow-ish; only the receipts test turns it on.
    receiptReader: receiptReader || createReceiptReader({ enabled: false }),
  });
  const server = app.listen(0);
  server.app = app;
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) =>
    fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const admin = { Authorization: 'Bearer test-admin-token' };
  return { store, chats, server, base, post, admin, receiptsDir, dataDir };
}

// A valid image data URL whose bytes differ every call (each receipt must be unique).
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
function freshPng() {
  return 'data:image/png;base64,' + Buffer.concat([PNG_BYTES, require('crypto').randomBytes(8)]).toString('base64');
}

module.exports = { start, freshPng };

process.env.ADMIN_TOKEN = 'test-admin-token';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server/app');
const { OrderStore } = require('../server/store');

async function start({ payment, supplier }) {
  const store = new OrderStore(null);
  const receiptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-'));
  const server = createApp({ store, payment, supplier, receiptsDir, rateLimits: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) =>
    fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const admin = { Authorization: 'Bearer test-admin-token' };
  return { store, server, base, post, admin, receiptsDir };
}

module.exports = { start };

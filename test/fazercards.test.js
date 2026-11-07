// Automatic delivery through FazerCards, against a local fake of their API
// (shapes taken from their official SDK, fazercards@0.2.0).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const { start, freshPng } = require('./helpers');
const payment = require('../server/providers/payment-bank-qr');
const { createFazerCards } = require('../server/providers/supplier-fazercards');

// ---- fake FazerCards ---------------------------------------------------------------
const fake = {
  calls: [],
  orders: new Map(), // fz id -> order
  byKey: new Map(), // idempotency key -> fz id
  seq: 1000,
  mode: 'async', // 'async' | 'instant' | 'reject' | 'flaky'
  flakyLeft: 0,
  balance: '30.9233',
};
function resetFake() {
  Object.assign(fake, { calls: [], orders: new Map(), byKey: new Map(), mode: 'async', flakyLeft: 0 });
}

const fakeServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url, 'http://x');
    fake.calls.push({ method: req.method, path: url.pathname, body, headers: req.headers });
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers['x-api-key'] !== 'fc_test') return send(401, { ok: false, error: 'bad key' });

    if (req.method === 'GET' && url.pathname === '/api/v2/balance') return send(200, { ok: true, balance: fake.balance, currency: 'USD' });

    if (req.method === 'POST' && url.pathname === '/api/v2/topups/order') {
      const key = req.headers['idempotency-key'];
      if (key && fake.byKey.has(key)) return send(200, { ok: true, order: fake.orders.get(fake.byKey.get(key)) });
      if (fake.mode === 'flaky' && fake.flakyLeft-- > 0) {
        // Server processed it but the response "got lost": the retry must not charge twice.
        const id = `ord-${fake.seq++}`;
        fake.orders.set(id, { id, kind: 'topup', status: 'processing', offer_id: body.offer_id });
        if (key) fake.byKey.set(key, id);
        return send(502, { ok: false, error: 'bad gateway' });
      }
      if (fake.mode === 'reject') return send(400, { ok: false, error: { message: 'Invalid player id' } });
      const id = `ord-${fake.seq++}`;
      const order = { id, kind: 'topup', status: fake.mode === 'instant' ? 'completed' : 'created', offer_id: body.offer_id };
      fake.orders.set(id, order);
      if (key) fake.byKey.set(key, id);
      return send(200, { ok: true, order });
    }

    const m = /^\/api\/v2\/orders\/(.+)$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const o = fake.orders.get(decodeURIComponent(m[1]));
      return o ? send(200, { ok: true, order: o }) : send(404, { ok: false, error: 'not found' });
    }
    send(404, { ok: false, error: 'no route' });
  });
});

const settings = {
  categoryId: 'mobile_legends',
  validateCategoryId: '',
  fields: { player_id: 'userId', server_id: 'zoneId' },
  offers: { 'dm-706': 'ml_706', 'dm-86': 'ml_86' },
};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let t, supplier;
before(async () => {
  await new Promise((r) => fakeServer.listen(0, r));
  supplier = createFazerCards({
    apiKey: 'fc_test',
    baseUrl: `http://127.0.0.1:${fakeServer.address().port}/api/v2`,
    webhookSecret: 'whsec_test',
    settings,
    sleep: async () => {},
  });
  t = await start({ payment, supplier });
});
after(() => { t.server.close(); fakeServer.close(); });
beforeEach(resetFake);

async function paidOrder(packageId = 'dm-706') {
  const { orderId, chatId } = await (await t.post('/api/orders', { gameName: 'Karma', userId: '123456789', zoneId: '2001', packageId })).json();
  await t.post(`/api/orders/${orderId}/payment-proof`, { txnRef: `JN-${crypto.randomBytes(5).toString('hex')}`, screenshot: freshPng() });
  return { orderId, chatId };
}
const approve = (id) => t.post(`/api/admin/orders/${id}/approve`, {}, t.admin);
const chatText = (chatId) => t.chats.get(chatId).messages.map((m) => m.text).join('\n');

test('approve sends the right top-up request to FazerCards', async () => {
  const { orderId } = await paidOrder();
  await approve(orderId);
  const call = fake.calls.find((c) => c.path === '/api/v2/topups/order');
  assert.deepEqual(call.body, { category_id: 'mobile_legends', offer_id: 'ml_706', fields: { player_id: '123456789', server_id: '2001' } });
  assert.equal(call.headers['x-api-key'], 'fc_test');
  assert.equal(call.headers['idempotency-key'], `soma-${orderId}-1`);
});

test('async top-up: order waits in "processing", then the sync loop completes it', async () => {
  const { orderId, chatId } = await paidOrder();
  await approve(orderId);
  const o = t.store.get(orderId);
  assert.equal(o.status, 'processing');
  assert.match(o.supplierRef, /^ord-/);

  fake.orders.get(o.supplierRef).status = 'completed';
  await t.server.app.locals.syncSupplierOrders();
  assert.equal(t.store.get(orderId).status, 'completed');
  assert.match(chatText(chatId), /Payment confirmed[\s\S]*delivered to 123456789 \(2001\)/);
});

test('instant top-up completes on approve', async () => {
  fake.mode = 'instant';
  const { orderId } = await paidOrder();
  await approve(orderId);
  assert.equal(t.store.get(orderId).status, 'completed');
});

test('supplier refund -> order failed with a reason; Retry delivery uses a NEW idempotency key', async () => {
  const { orderId, chatId } = await paidOrder();
  await approve(orderId);
  const ref = t.store.get(orderId).supplierRef;
  Object.assign(fake.orders.get(ref), { status: 'refund', fail_reason: 'Region not supported' });
  await t.server.app.locals.syncSupplierOrders();

  const failed = t.store.get(orderId);
  assert.equal(failed.status, 'failed');
  assert.match(failed.deliveryError, /refunded the top-up: Region not supported/);
  const pub = await (await fetch(`${t.base}/api/orders/${orderId}`)).json();
  assert.doesNotMatch(pub.note, /Region/, 'internal supplier details are not shown to the buyer');
  assert.match(chatText(chatId), /Automatic delivery failed/);

  fake.mode = 'instant';
  assert.equal((await t.post(`/api/admin/orders/${orderId}/retry`, {}, t.admin)).status, 200);
  assert.equal(t.store.get(orderId).status, 'completed');
  const keys = fake.calls.filter((c) => c.path === '/api/v2/topups/order').map((c) => c.headers['idempotency-key']);
  assert.deepEqual(keys, [`soma-${orderId}-1`, `soma-${orderId}-2`]);
});

test('supplier rejects the request (e.g. bad ID) -> failed immediately', async () => {
  fake.mode = 'reject';
  const { orderId } = await paidOrder();
  await approve(orderId);
  const o = t.store.get(orderId);
  assert.equal(o.status, 'failed');
  assert.match(o.deliveryError, /Invalid player id/);
});

test('network hiccup on create: retried with the same key, charged only once', async () => {
  fake.mode = 'flaky';
  fake.flakyLeft = 1;
  const { orderId } = await paidOrder();
  await approve(orderId);
  const creates = fake.calls.filter((c) => c.path === '/api/v2/topups/order');
  assert.equal(creates.length, 2);
  assert.equal(creates[0].headers['idempotency-key'], creates[1].headers['idempotency-key']);
  assert.equal(fake.orders.size, 1, 'only one supplier order exists');
  assert.equal(t.store.get(orderId).status, 'processing');
});

test('package without an offer id fails clearly instead of guessing', async () => {
  const { orderId } = await paidOrder('dm-172');
  await approve(orderId);
  assert.match(t.store.get(orderId).deliveryError, /No FazerCards offer set for "dm-172"/);
  assert.equal(fake.calls.filter((c) => c.path === '/api/v2/topups/order').length, 0);
});

test('signed webhook completes the order; bad signature and duplicates are ignored', async () => {
  const { orderId } = await paidOrder();
  await approve(orderId);
  const ref = t.store.get(orderId).supplierRef;
  const body = JSON.stringify({ event: 'order.status_changed', event_id: 'evt-1', timestamp: new Date().toISOString(), data: { id: ref, status: 'completed' } });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'whsec_test').update(body).digest('hex');

  assert.equal((await t.post('/api/webhooks/supplier', body, { 'x-webhook-signature': 'sha256=bad' })).status, 401);
  assert.equal(t.store.get(orderId).status, 'processing');

  assert.equal((await t.post('/api/webhooks/supplier', body, { 'x-webhook-signature': sig })).status, 200);
  assert.equal(t.store.get(orderId).status, 'completed');
  const dup = await (await t.post('/api/webhooks/supplier', body, { 'x-webhook-signature': sig })).json();
  assert.equal(dup.duplicate, true);
});

test('admin sees supplier balance; manual "delivered" still works', async () => {
  const info = await (await fetch(`${t.base}/api/admin/supplier`, { headers: t.admin })).json();
  assert.deepEqual(info, { name: 'fazercards', automatic: true, balance: '30.9233', currency: 'USD' });

  fake.mode = 'reject';
  const { orderId } = await paidOrder();
  await approve(orderId);
  assert.equal((await t.post(`/api/admin/orders/${orderId}/delivered`, {}, t.admin)).status, 200);
  assert.equal(t.store.get(orderId).status, 'completed');
});

test('the supplier error is a private note: the admin sees it, the buyer does not', async () => {
  fake.mode = 'reject';
  const { orderId, chatId } = await paidOrder();
  await approve(orderId);
  const buyerView = await (await fetch(`${t.base}/api/chats/${chatId}`)).json();
  assert.ok(!buyerView.messages.some((m) => /Automatic delivery failed|Invalid player id/.test(m.text)));
  assert.ok(buyerView.messages.some((m) => /Delivery is delayed/.test(m.text)));
  const adminView = await (await fetch(`${t.base}/api/admin/chats/${chatId}`, { headers: t.admin })).json();
  const note = adminView.messages.find((m) => /Automatic delivery failed/.test(m.text));
  assert.ok(note && note.adminOnly);
});

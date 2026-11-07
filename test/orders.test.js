const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');
const { OrderStore } = require('../server/store');
const payment = require('../server/providers/payment-mock');

let server, base, store, fulfillCalls;
const supplier = {
  name: 'test',
  lookupPlayer: async (u) => (u.startsWith('0') ? { ok: false, error: 'Player not found' } : { ok: true, nickname: 'Tester' }),
  fulfill: async (o) => { fulfillCalls++; return { ok: true, reference: `sup_${o.id}` }; },
};

before(async () => {
  store = new OrderStore(null);
  fulfillCalls = 0;
  server = createApp({ store, payment, supplier }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

const validOrder = { userId: '123456789', zoneId: '2001', packageId: 'dm-86', paymentMethod: 'card' };

test('catalog lists packages', async () => {
  const c = await (await fetch(base + '/api/catalog')).json();
  assert.ok(c.packages.length > 5);
  assert.ok(c.packages.every((p) => Number.isInteger(p.price) && p.label));
});

test('player lookup validates input', async () => {
  assert.equal((await post('/api/players/lookup', { userId: 'abc', zoneId: '1' })).status, 400);
  assert.equal((await post('/api/players/lookup', { userId: '012345', zoneId: '1' })).status, 404);
  const r = await post('/api/players/lookup', { userId: '123456', zoneId: '1' });
  assert.deepEqual(await r.json(), { nickname: 'Tester' });
});

test('order uses server-side price, ignores client price', async () => {
  const r = await post('/api/orders', { ...validOrder, price: 1, amount: 1 });
  assert.equal(r.status, 201);
  const { orderId, checkoutUrl } = await r.json();
  assert.match(checkoutUrl, /\/checkout\/mock\//);
  const o = await (await fetch(`${base}/api/orders/${orderId}`)).json();
  assert.equal(o.amount, 149);
  assert.equal(o.status, 'pending_payment');
  assert.equal(o.email, undefined, 'email is not exposed publicly');
});

test('rejects unknown package and bad payment method', async () => {
  assert.equal((await post('/api/orders', { ...validOrder, packageId: 'nope' })).status, 400);
  assert.equal((await post('/api/orders', { ...validOrder, paymentMethod: 'crypto' })).status, 400);
});

test('webhook with bad signature is rejected', async () => {
  const { orderId } = await (await post('/api/orders', validOrder)).json();
  const body = JSON.stringify({ orderId, status: 'paid' });
  const r = await post('/api/webhooks/payment', body, { 'x-signature': 'deadbeef' });
  assert.equal(r.status, 400);
  assert.equal(store.get(orderId).status, 'pending_payment');
});

test('signed paid webhook delivers exactly once even when retried', async () => {
  const { orderId } = await (await post('/api/orders', validOrder)).json();
  const body = JSON.stringify({ orderId, reference: 'x', status: 'paid' });
  const sig = payment.sign(body);
  const before = fulfillCalls;
  await Promise.all([1, 2, 3].map(() => post('/api/webhooks/payment', body, { 'x-signature': sig })));
  assert.equal(fulfillCalls - before, 1);
  assert.equal(store.get(orderId).status, 'completed');
});

test('admin endpoint requires token', async () => {
  assert.equal((await fetch(base + '/api/admin/orders')).status, 401);
});

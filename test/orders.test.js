// Automated flow: gateway webhook + supplier API (mock adapters).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');
const payment = require('../server/providers/payment-mock');

let t, fulfillCalls = 0;
const supplier = {
  name: 'test',
  lookupPlayer: async (u) => (u.startsWith('0') ? { ok: false, error: 'Player not found' } : { ok: true, nickname: 'Tester' }),
  fulfill: async (o) => { fulfillCalls++; return { ok: true, reference: `sup_${o.id}` }; },
};
const validOrder = { userId: '123456789', zoneId: '2001', packageId: 'dm-86' };

before(async () => { t = await start({ payment, supplier }); });
after(() => t.server.close());

test('catalog lists packages in Nu.', async () => {
  const c = await (await fetch(t.base + '/api/catalog')).json();
  assert.equal(c.currency, 'BTN');
  assert.equal(c.currencySymbol, 'Nu.');
  assert.ok(c.packages.length > 5);
  assert.ok(c.packages.every((p) => Number.isInteger(p.price) && p.label));
});

test('player lookup validates input', async () => {
  assert.equal((await t.post('/api/players/lookup', { userId: 'abc', zoneId: '1' })).status, 400);
  assert.equal((await t.post('/api/players/lookup', { userId: '012345', zoneId: '1' })).status, 404);
  assert.deepEqual(await (await t.post('/api/players/lookup', { userId: '123456', zoneId: '1' })).json(), { nickname: 'Tester' });
});

test('order uses server-side price, ignores client price', async () => {
  const r = await t.post('/api/orders', { ...validOrder, price: 1, amount: 1 });
  assert.equal(r.status, 201);
  const { orderId } = await r.json();
  const o = await (await fetch(`${t.base}/api/orders/${orderId}`)).json();
  assert.equal(o.amount, 125);
  assert.equal(o.status, 'pending_payment');
  assert.equal(o.phone, undefined, 'phone is not exposed publicly');
});

test('rejects unknown package and bad phone', async () => {
  assert.equal((await t.post('/api/orders', { ...validOrder, packageId: 'nope' })).status, 400);
  assert.equal((await t.post('/api/orders', { ...validOrder, phone: '<script>' })).status, 400);
});

test('webhook with bad signature is rejected', async () => {
  const { orderId } = await (await t.post('/api/orders', validOrder)).json();
  const r = await t.post('/api/webhooks/payment', JSON.stringify({ orderId, status: 'paid' }), { 'x-signature': 'deadbeef' });
  assert.equal(r.status, 400);
  assert.equal(t.store.get(orderId).status, 'pending_payment');
});

test('signed paid webhook delivers exactly once even when retried', async () => {
  const { orderId } = await (await t.post('/api/orders', validOrder)).json();
  const body = JSON.stringify({ orderId, reference: 'x', status: 'paid' });
  const sig = payment.sign(body);
  const before = fulfillCalls;
  await Promise.all([1, 2, 3].map(() => t.post('/api/webhooks/payment', body, { 'x-signature': sig })));
  assert.equal(fulfillCalls - before, 1);
  assert.equal(t.store.get(orderId).status, 'completed');
});

test('payment proof is not accepted for non-manual gateways', async () => {
  const { orderId } = await (await t.post('/api/orders', validOrder)).json();
  assert.equal((await t.post(`/api/orders/${orderId}/payment-proof`, { txnRef: '12345678' })).status, 404);
});

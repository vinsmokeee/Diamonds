const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');
const { createPriceGuard } = require('../server/pricing');
const payment = require('../server/providers/payment-bank-qr');
const catalog = require('../server/catalog');

// A supplier whose costs we control. Prices are USD; the guard uses Nu. 100/USD here.
const costs = {};
const supplier = {
  name: 'fake', manual: false, verifiesPlayer: false,
  lookupPlayer: async () => ({ ok: true, nickname: null }),
  fulfill: async () => ({ ok: true, pending: true, reference: 'x' }),
  getPackageCosts: async () => {
    if (costs.down) throw new Error('supplier offline');
    return { ...costs.map };
  },
};
const guard = createPriceGuard({ supplier, usdToLocal: 100, minMarginPercent: 10 });
let t;
before(async () => { t = await start({ payment, supplier, priceGuard: guard }); });
after(() => t.server.close());

const visible = async () => (await (await fetch(t.base + '/api/catalog')).json()).packages.map((p) => p.id);
const price = (id) => catalog.getPackage(id).price;

test('every package in the catalog is priced above zero and unique', () => {
  const ids = catalog.packages.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(catalog.packages.every((p) => Number.isInteger(p.price) && p.price > 0));
});

test('profitable packages stay; one whose cost rose is paused, hidden and not orderable', async () => {
  // dm-706 now costs more than 1/1.1 of its price -> under 10% profit
  costs.map = { 'dm-86': price('dm-86') / 100 / 1.3, 'dm-706': price('dm-706') / 100 / 1.05 };
  await guard.check();
  const ids = await visible();
  assert.ok(ids.includes('dm-86'));
  assert.ok(!ids.includes('dm-706'));
  const r = await t.post('/api/orders', { gameName: 'A', userId: '12345678', zoneId: '1', packageId: 'dm-706' });
  assert.equal(r.status, 409);

  const report = await (await fetch(t.base + '/api/admin/pricing', { headers: t.admin })).json();
  const row = report.rows.find((x) => x.id === 'dm-706');
  assert.equal(row.paused, true);
  assert.match(row.reason, /below your minimum 10%/);
});

test('packages come back when the cost drops again', async () => {
  costs.map = { 'dm-706': price('dm-706') / 100 / 1.25 };
  await guard.check();
  assert.ok((await visible()).includes('dm-706'));
});

test('an offer the supplier stopped selling is paused', async () => {
  costs.map = { 'dm-706': null };
  await guard.check();
  assert.ok(!(await visible()).includes('dm-706'));
});

test('if the supplier is unreachable, the last known state is kept (nothing new is paused)', async () => {
  costs.map = { 'dm-706': price('dm-706') / 100 / 1.3 };
  await guard.check();
  costs.down = true;
  await guard.check();
  costs.down = false;
  assert.ok((await visible()).includes('dm-706'));
  const report = await (await fetch(t.base + '/api/admin/pricing', { headers: t.admin })).json();
  assert.match(report.error, /offline/);
});

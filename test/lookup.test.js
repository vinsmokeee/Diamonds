// In-game name popup: works with manual delivery when a nickname lookup is available.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');
const payment = require('../server/providers/payment-bank-qr');
const supplier = require('../server/providers/supplier-manual');

let calls = 0;
const playerLookup = {
  lookupPlayer: async (userId) => {
    calls++;
    if (userId === '99999999') throw new Error('lookup service down');
    if (userId.startsWith('0')) return { ok: false, error: 'Player not found. Check your User ID and Zone ID.' };
    return { ok: true, nickname: 'ᴛᴀsʜɪ✧Lord' };
  },
};
let t;
before(async () => { t = await start({ payment, supplier, playerLookup }); });
after(() => t.server.close());

test('catalog tells the page that names can be looked up', async () => {
  assert.equal((await (await fetch(t.base + '/api/catalog')).json()).verifiesPlayer, true);
});

test('lookup returns the in-game name, and caches it', async () => {
  const before = calls;
  const r1 = await (await t.post('/api/players/lookup', { userId: '12345678', zoneId: '2001' })).json();
  const r2 = await (await t.post('/api/players/lookup', { userId: '12345678', zoneId: '2001' })).json();
  assert.equal(r1.nickname, 'ᴛᴀsʜɪ✧Lord');
  assert.deepEqual(r2, r1);
  assert.equal(calls - before, 1);
});

test('unknown ID: lookup says not found, and the order is refused', async () => {
  const r = await t.post('/api/players/lookup', { userId: '012345', zoneId: '1' });
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /not found/i);
  assert.equal((await t.post('/api/orders', { userId: '012345', zoneId: '1', packageId: 'dm-86' })).status, 404);
});

test('orders use the looked-up name, so the admin sees the real in-game name', async () => {
  const { orderId, chatId } = await (await t.post('/api/orders', { userId: '12345678', zoneId: '2001', packageId: 'dm-86' })).json();
  assert.equal(t.store.get(orderId).gameName, 'ᴛᴀsʜɪ✧Lord');
  assert.equal(t.chats.get(chatId).gameName, 'ᴛᴀsʜɪ✧Lord');
});

test('if the lookup service is down, buyers can still order', async () => {
  assert.equal((await t.post('/api/players/lookup', { userId: '99999999', zoneId: '1' })).status, 502);
  const r = await t.post('/api/orders', { userId: '99999999', zoneId: '1', packageId: 'dm-86' });
  assert.equal(r.status, 201);
  assert.equal(t.store.get((await r.json()).orderId).gameName, 'Player 99999999');
});

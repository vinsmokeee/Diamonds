const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { start, freshPng } = require('./helpers');
const { createNotifier } = require('../server/notify');
const payment = require('../server/providers/payment-bank-qr');
const supplier = require('../server/providers/supplier-manual');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// --- the app calls the notifier at the right moments ---------------------------
const calls = [];
const spy = {
  enabled: true,
  paymentSubmitted: (o, img) => calls.push(['payment', o, img]),
  newOrder: (o) => calls.push(['order', o]),
  buyerMessage: (c, m, img) => calls.push(['message', c, m, img]),
};
let t;
before(async () => { t = await start({ payment, supplier, notifier: spy }); });
after(() => t.server.close());

test('alerts the owner when a buyer submits payment, with the screenshot', async () => {
  const { orderId } = await (await t.post('/api/orders', { gameName: 'Soma', userId: '12345678', zoneId: '2001', packageId: 'dm-706' })).json();
  await t.post(`/api/orders/${orderId}/payment-proof`, { txnRef: 'JN-ALERT-1', screenshot: freshPng() });
  const c = calls.find((x) => x[0] === 'payment');
  assert.ok(c, 'payment alert sent');
  assert.equal(c[1].txnRef, 'JN-ALERT-1');
  assert.equal(c[1].amount, require('../server/catalog').getPackage('dm-706').price);
  assert.match(c[2], /receipts\/.+\.png$/);
  assert.ok(!calls.some((x) => x[0] === 'order'), 'order alerts are off by default');
});

test('alerts the owner on buyer chat messages but not on admin replies', async () => {
  const chat = await (await t.post('/api/chats', { gameName: 'Soma', userId: '12345678', zoneId: '2001' })).json();
  calls.length = 0;
  await t.post(`/api/chats/${chat.id}/messages`, { text: 'hello?' });
  await t.post(`/api/admin/chats/${chat.id}/messages`, { text: 'hi!' }, t.admin);
  assert.deepEqual(calls.map((x) => [x[0], x[2].text]), [['message', 'hello?']]);
});

// --- the Telegram client itself -------------------------------------------------
function fakeFetch() {
  const sent = [];
  const fn = async (url, opts) => { sent.push({ url, opts }); return { ok: true, text: async () => '' }; };
  fn.sent = sent;
  return fn;
}
const money = (n) => `Nu. ${n}`;
const order = { id: 'o1', chatId: 'c1', amount: 980, txnRef: 'JN1', item: '706 Diamonds', gameName: '<b>x</b>', userId: '1', zoneId: '2' };

test('telegram: sends text with escaped user input and an admin link', async () => {
  const f = fakeFetch();
  await createNotifier({ token: 'T', chatId: '42', baseUrl: 'https://soma.bt', money, fetchImpl: f }).paymentSubmitted(order, null);
  assert.equal(f.sent[0].url, 'https://api.telegram.org/botT/sendMessage');
  const body = JSON.parse(f.sent[0].opts.body);
  assert.equal(body.chat_id, '42');
  assert.match(body.text, /Nu\. 980/);
  assert.match(body.text, /&lt;b&gt;x&lt;\/b&gt;/, 'buyer-controlled text is escaped');
  assert.match(body.text, /https:\/\/soma\.bt\/admin\.html#chat=c1/);
});

test('telegram: sends the receipt as a photo', async () => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(t.dataDir, 'x.png');
  fs.writeFileSync(file, Buffer.from(PNG.split(',')[1], 'base64'));
  const f = fakeFetch();
  await createNotifier({ token: 'T', chatId: '42', baseUrl: '', money, fetchImpl: f }).paymentSubmitted(order, file);
  assert.equal(f.sent[0].url, 'https://api.telegram.org/botT/sendPhoto');
  assert.ok(f.sent[0].opts.body instanceof FormData);
  assert.match(f.sent[0].opts.body.get('caption'), /JN1/);
});

test('telegram: disabled without token, and never throws on network errors', async () => {
  const f = fakeFetch();
  const off = createNotifier({ token: '', chatId: '', baseUrl: '', money, fetchImpl: f });
  assert.equal(off.enabled, false);
  await off.paymentSubmitted(order, null);
  assert.equal(f.sent.length, 0);
  const broken = createNotifier({ token: 'T', chatId: '1', baseUrl: '', money, fetchImpl: async () => { throw new Error('offline'); } });
  const err = console.error; console.error = () => {};
  await broken.paymentSubmitted(order, null); // resolves, doesn't throw
  console.error = err;
});

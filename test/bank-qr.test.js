// Bhutan flow: bank QR payment verified by an admin, delivered manually.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { start } = require('./helpers');
const payment = require('../server/providers/payment-bank-qr');
const supplier = require('../server/providers/supplier-manual');

let t;
const validOrder = { userId: '123456789', zoneId: '2001', packageId: 'dm-706', gameName: 'LaneKing' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

before(async () => { t = await start({ payment, supplier }); });
after(() => t.server.close());

async function newOrder() {
  const r = await t.post('/api/orders', validOrder);
  assert.equal(r.status, 201);
  return r.json();
}

test('catalog says the player is not auto-verified', async () => {
  const c = await (await fetch(t.base + '/api/catalog')).json();
  assert.equal(c.verifiesPlayer, false);
});

test('checkout goes to the QR payment page', async () => {
  const { orderId, checkoutUrl } = await newOrder();
  assert.equal(checkoutUrl, `/pay.html?id=${orderId}`);
  const info = await (await fetch(t.base + '/api/payment-info')).json();
  assert.ok(info.qrImage && info.bankName);
});

test('full flow: submit proof -> admin approves -> admin marks delivered', async () => {
  const { orderId } = await newOrder();
  const r = await t.post(`/api/orders/${orderId}/payment-proof`, { txnRef: 'jn123456789', screenshot: PNG });
  assert.equal(r.status, 200);
  const pub = await r.json();
  assert.equal(pub.status, 'awaiting_verification');
  assert.equal(pub.txnRef, '••••6789', 'reference is masked publicly');

  const stored = t.store.get(orderId);
  assert.equal(stored.txnRef, 'JN123456789');
  assert.ok(fs.existsSync(path.join(t.receiptsDir, stored.receiptFile)));

  // the proof also lands in the order's chat, with the screenshot
  const chat = t.chats.get(stored.chatId);
  const proofMsg = chat.messages.find((m) => m.text.includes('JN123456789'));
  assert.ok(proofMsg && proofMsg.image.startsWith('receipts/'));

  // second submission is refused
  assert.equal((await t.post(`/api/orders/${orderId}/payment-proof`, { txnRef: '99999999' })).status, 409);

  const shot = await fetch(`${t.base}/api/admin/orders/${orderId}/receipt`, { headers: t.admin });
  assert.equal(shot.status, 200);
  assert.equal(shot.headers.get('content-type'), 'image/png');

  assert.equal((await t.post(`/api/admin/orders/${orderId}/approve`, {}, t.admin)).status, 200);
  assert.equal(t.store.get(orderId).status, 'processing');
  // approving twice is refused
  assert.equal((await t.post(`/api/admin/orders/${orderId}/approve`, {}, t.admin)).status, 409);

  assert.equal((await t.post(`/api/admin/orders/${orderId}/delivered`, {}, t.admin)).status, 200);
  assert.equal(t.store.get(orderId).status, 'completed');

  // the buyer sees each step in the chat
  const texts = t.chats.get(stored.chatId).messages.map((m) => m.text).join('\n');
  assert.match(texts, /New order/);
  assert.match(texts, /Payment confirmed/);
  assert.match(texts, /delivered/);
});

test('the same journal number cannot be reused on another order', async () => {
  const a = await newOrder();
  const b = await newOrder();
  assert.equal((await t.post(`/api/orders/${a.orderId}/payment-proof`, { txnRef: 'DUP-0001' })).status, 200);
  const r = await t.post(`/api/orders/${b.orderId}/payment-proof`, { txnRef: 'dup-0001' });
  assert.equal(r.status, 409);
});

test('admin can reject with a note shown to the buyer', async () => {
  const { orderId } = await newOrder();
  await t.post(`/api/orders/${orderId}/payment-proof`, { txnRef: 'REJ-1234' });
  await t.post(`/api/admin/orders/${orderId}/reject`, { note: 'Amount was short' }, t.admin);
  const o = await (await fetch(`${t.base}/api/orders/${orderId}`)).json();
  assert.equal(o.status, 'payment_failed');
  assert.equal(o.note, 'Amount was short');
});

test('rejects bad references and non-image screenshots', async () => {
  const { orderId } = await newOrder();
  assert.equal((await t.post(`/api/orders/${orderId}/payment-proof`, { txnRef: '' })).status, 400);
  assert.equal((await t.post(`/api/orders/${orderId}/payment-proof`, { txnRef: 'a b c' })).status, 400);
  assert.equal((await t.post(`/api/orders/${orderId}/payment-proof`, { txnRef: 'OK12345', screenshot: 'data:text/html;base64,PGgxPg==' })).status, 400);
  assert.equal(t.store.get(orderId).status, 'pending_payment');
});

test('admin endpoints require the token', async () => {
  const { orderId } = await newOrder();
  assert.equal((await fetch(t.base + '/api/admin/orders')).status, 401);
  assert.equal((await t.post(`/api/admin/orders/${orderId}/approve`, {}, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await fetch(t.base + '/api/admin/orders?status=open', { headers: t.admin })).status, 200);
});

test('a receipt screenshot alone is enough (journal number optional), and the buyer is told we are checking', async () => {
  const { orderId } = await newOrder();
  const r = await t.post(`/api/orders/${orderId}/payment-proof`, { screenshot: PNG });
  assert.equal(r.status, 200);
  const o = t.store.get(orderId);
  assert.equal(o.status, 'awaiting_verification');
  assert.equal(o.txnRef, null);
  const texts = t.chats.get(o.chatId).messages.map((m) => m.text);
  assert.ok(texts.some((x) => /I have paid for 706 Diamonds/.test(x) && !/Journal/.test(x)));
  assert.ok(texts.some((x) => /checking your payment/.test(x)));
  // nothing at all is still refused
  const other = await newOrder();
  assert.equal((await t.post(`/api/orders/${other.orderId}/payment-proof`, {})).status, 400);
});

// Journal numbers can never be used twice — whether typed, read from a screenshot,
// or sent as a chat photo. Uses real OCR on a sample receipt (test/fixtures).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { start, freshPng } = require('./helpers');
const { createReceiptReader, parseReceiptText } = require('../server/receipts');
const payment = require('../server/providers/payment-bank-qr');
const supplier = require('../server/providers/supplier-manual');

const RECEIPT = fs.readFileSync(path.join(__dirname, 'fixtures', 'receipt-journal.png')); // Journal No: JRN48213977, Nu. 995.00
// Same receipt, different file bytes (as if re-saved or re-screenshotted): only the journal number can catch it.
const receiptCopy = () => 'data:image/png;base64,' + Buffer.concat([RECEIPT, crypto.randomBytes(6)]).toString('base64');

let t;
const reader = createReceiptReader({ enabled: true });
before(async () => { t = await start({ payment, supplier, receiptReader: reader }); });
after(async () => { t.server.close(); await reader.close(); });

const order = async (packageId = 'dm-706', userId = '123456789') =>
  (await t.post('/api/orders', { gameName: 'Pema', userId, zoneId: '2001', packageId })).json();
const proof = (id, body) => t.post(`/api/orders/${id}/payment-proof`, body);
const chatTexts = (orderId) => t.chats.get(t.store.get(orderId).chatId).messages.map((m) => m.text).join('\n');

test('parses journal numbers and amounts from typical receipt wording', () => {
  assert.deepEqual(parseReceiptText('Transaction Successful\nNu. 995.00\nJournal No: JRN48213977'), { journalNo: 'JRN48213977', amount: 995 });
  assert.equal(parseReceiptText('Jrnl. No. 202611070045').journalNo, '202611070045');
  assert.equal(parseReceiptText('Reference ID : TB-8841203').journalNo, 'TB-8841203');
  assert.equal(parseReceiptText('Txn ID 77120093').journalNo, '77120093');
  assert.equal(parseReceiptText('Transaction Successful').journalNo, null, 'a word is not a journal number');
  assert.equal(parseReceiptText('Amount: 1,250.50').amount, 1250.5);
});

test('the journal number is read from a screenshot, and the same receipt cannot pay for a second order', async () => {
  const a = await order();
  assert.equal((await proof(a.orderId, { screenshot: receiptCopy() })).status, 200);
  const first = t.store.get(a.orderId);
  assert.equal(first.txnRef, 'JRN48213977');
  assert.equal(first.receiptAmount, 995);
  assert.match(chatTexts(a.orderId), /Journal no\.: JRN48213977/);

  const b = await order('dm-706', '987654321');
  const r = await proof(b.orderId, { screenshot: receiptCopy() });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /JRN48213977\) was already used/);
  assert.equal(t.store.get(b.orderId).status, 'pending_payment');

  // typing the same number by hand is refused too
  assert.equal((await proof(b.orderId, { txnRef: 'jrn48213977' })).status, 409);
});

test('the exact same screenshot file is refused even when no number can be read', async () => {
  const img = freshPng();
  const a = await order('dm-86', '11112222');
  assert.equal((await proof(a.orderId, { screenshot: img })).status, 200);
  assert.match(chatTexts(a.orderId), /No journal number found on the screenshot/);
  const b = await order('dm-86', '11113333');
  const r = await proof(b.orderId, { screenshot: img });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /screenshot was already used/);
});

test('a reused receipt sent as a chat photo is refused with a message to the buyer', async () => {
  const c = await order('dm-706', '55556666');
  await t.post(`/api/chats/${c.chatId}/messages`, { image: receiptCopy() });
  for (let i = 0; i < 100 && !/already used/.test(chatTexts(c.orderId)); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(chatTexts(c.orderId), /⚠️ This receipt \(journal no\. JRN48213977\) was already used/);
  assert.equal(t.store.get(c.orderId).status, 'pending_payment');
});

test('admin gets a private warning when the screenshot shows less than the price', async () => {
  const small = fs.readFileSync(path.join(__dirname, 'fixtures', 'receipt-500.png')); // Nu. 500.00, JRN77700055
  const d = await order('dm-706', '77778888'); // Nu. 995 due
  assert.equal((await proof(d.orderId, { screenshot: 'data:image/png;base64,' + small.toString('base64') })).status, 200);
  const o = t.store.get(d.orderId);
  assert.equal(o.txnRef, 'JRN77700055');
  assert.equal(o.receiptAmount, 500);
  const notes = t.chats.get(o.chatId).messages.filter((m) => m.adminOnly).map((m) => m.text).join('\n');
  assert.match(notes, /Screenshot shows Nu\. 500 but Nu\. 995 is due/);
  // ...and the buyer never sees that note
  const buyerView = await (await fetch(`${t.base}/api/chats/${o.chatId}`)).json();
  assert.ok(!buyerView.messages.some((m) => /Screenshot shows/.test(m.text)));
});

test('admin can set a journal number, but not one that is already used; approve re-checks', async () => {
  const e = await order('dm-86', '99990000');
  await proof(e.orderId, { screenshot: freshPng() });
  const clash = await t.post(`/api/admin/orders/${e.orderId}/journal`, { txnRef: 'JRN48213977' }, t.admin);
  assert.equal(clash.status, 400);
  assert.match((await clash.json()).error, /already used by order/);
  assert.equal((await t.post(`/api/admin/orders/${e.orderId}/journal`, { txnRef: 'JRN55500011' }, t.admin)).status, 200);
  assert.equal(t.store.get(e.orderId).txnRef, 'JRN55500011');
  assert.equal((await t.post(`/api/admin/orders/${e.orderId}/approve`, {}, t.admin)).status, 200);
});

test('after "Paid less", re-sending the first receipt is refused', async () => {
  const f = await order('dm-706', '24242424');
  await proof(f.orderId, { txnRef: 'PART-0001' });
  await t.post(`/api/admin/orders/${f.orderId}/partial`, { received: 500 }, t.admin);
  const again = await proof(f.orderId, { txnRef: 'PART-0001' });
  assert.equal(again.status, 409);
  assert.equal((await proof(f.orderId, { txnRef: 'PART-0002' })).status, 200);
});

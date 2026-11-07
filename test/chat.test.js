const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');
const payment = require('../server/providers/payment-bank-qr');
const supplier = require('../server/providers/supplier-manual');

let t;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const me = { gameName: 'JungleCat', userId: '55554444', zoneId: '3001' };

before(async () => { t = await start({ payment, supplier }); });
after(() => t.server.close());

const json = (r) => r.json();

test('buyer starts a chat, sends text + photo, admin sees it and replies', async () => {
  const c = await json(await t.post('/api/chats', me));
  assert.ok(c.id.length >= 20);

  assert.equal((await t.post(`/api/chats/${c.id}/messages`, { text: 'Hi, I paid' })).status, 201);
  const photo = await json(await t.post(`/api/chats/${c.id}/messages`, { image: PNG }));
  assert.match(photo.image, new RegExp(`^/api/chats/${c.id}/images/\\d+$`));

  // buyer can load their own photo
  const img = await fetch(t.base + photo.image);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');

  // admin inbox shows it as unread
  const inbox = await json(await fetch(t.base + '/api/admin/chats', { headers: t.admin }));
  const row = inbox.chats.find((x) => x.id === c.id);
  assert.equal(row.gameName, 'JungleCat');
  assert.equal(row.unread, 2);
  assert.equal(row.preview, '📷 Photo');

  // opening clears unread; admin can fetch the photo with their token only
  const thread = await json(await fetch(`${t.base}/api/admin/chats/${c.id}`, { headers: t.admin }));
  assert.equal(thread.messages.length, 2);
  assert.equal((await fetch(t.base + thread.messages[1].image)).status, 401);
  assert.equal((await fetch(t.base + thread.messages[1].image, { headers: t.admin })).status, 200);

  await t.post(`/api/admin/chats/${c.id}/messages`, { text: 'Got it, checking!' }, t.admin);
  const view = await json(await fetch(`${t.base}/api/chats/${c.id}?after=2`));
  assert.deepEqual(view.messages.map((m) => [m.from, m.text]), [['admin', 'Got it, checking!']]);
  assert.equal(view.unread, 1);
  await fetch(`${t.base}/api/chats/${c.id}?read=1`);
  assert.equal(t.chats.get(c.id).buyerUnread, 0);
});

test('placing an order reuses the open chat for the same account', async () => {
  const c = await json(await t.post('/api/chats', me));
  const o = await json(await t.post('/api/orders', { ...me, packageId: 'dm-86', chatId: c.id }));
  assert.equal(o.chatId, c.id);
  assert.deepEqual(t.chats.get(c.id).orderIds, [o.orderId]);

  // a different account gets a fresh chat instead
  const other = await json(await t.post('/api/orders', { ...me, userId: '99998888', packageId: 'dm-86', chatId: c.id }));
  assert.notEqual(other.chatId, c.id);

  const thread = await json(await fetch(`${t.base}/api/admin/chats/${c.id}`, { headers: t.admin }));
  assert.equal(thread.orders[0].id, o.orderId);
});

test('validation', async () => {
  assert.equal((await t.post('/api/chats', { ...me, gameName: '' })).status, 400);
  assert.equal((await t.post('/api/chats', { ...me, userId: 'abc' })).status, 400);
  const c = await json(await t.post('/api/chats', me));
  assert.equal((await t.post(`/api/chats/${c.id}/messages`, {})).status, 400);
  assert.equal((await t.post(`/api/chats/${c.id}/messages`, { text: 'x'.repeat(1001) })).status, 400);
  assert.equal((await t.post(`/api/chats/${c.id}/messages`, { image: 'data:text/html;base64,PGgxPg==' })).status, 400);
  assert.equal((await t.post('/api/chats/nope/messages', { text: 'hi' })).status, 404);
  assert.equal((await fetch(`${t.base}/api/chats/${c.id}/images/999`)).status, 404);
  assert.equal((await fetch(t.base + '/api/admin/chats')).status, 401);
});

test('automatic notes are unread only for the other side', async () => {
  const { orderId, chatId } = await json(await t.post('/api/orders', { ...me, userId: '77776666', packageId: 'dm-86' }));
  assert.equal(t.chats.get(chatId).adminUnread, 1, 'new order note is for the admin');
  assert.equal(t.chats.get(chatId).buyerUnread, 0);
  await t.post(`/api/orders/${orderId}/payment-proof`, { txnRef: 'UNREAD-01' });
  await fetch(`${t.base}/api/admin/chats/${chatId}`, { headers: t.admin }); // admin reads
  await t.post(`/api/admin/orders/${orderId}/approve`, {}, t.admin);
  assert.equal(t.chats.get(chatId).adminUnread, 0, "admin's own action is not unread for admin");
  assert.equal(t.chats.get(chatId).buyerUnread, 1);
});

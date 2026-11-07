// Sends alerts to the shop owner's Telegram when a buyer pays or messages.
// Setup: see README → "Telegram alerts". Disabled when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset.
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function createNotifier({ token, chatId, baseUrl, money, fetchImpl = globalThis.fetch }) {
  const enabled = Boolean(token && chatId);
  const api = (method) => `https://api.telegram.org/bot${token}/${method}`;

  async function send({ text, imagePath }) {
    if (!enabled) return;
    try {
      let res;
      if (imagePath && fs.existsSync(imagePath)) {
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('caption', text.slice(0, 1024));
        form.append('parse_mode', 'HTML');
        form.append('photo', new Blob([fs.readFileSync(imagePath)]), path.basename(imagePath));
        res = await fetchImpl(api('sendPhoto'), { method: 'POST', body: form });
      } else {
        res = await fetchImpl(api('sendMessage'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096), parse_mode: 'HTML', disable_web_page_preview: true }),
        });
      }
      if (!res.ok) console.error('Telegram alert failed:', res.status, await res.text().catch(() => ''));
    } catch (e) {
      console.error('Telegram alert failed:', e.message);
    }
  }

  const chatLink = (chatId_) => `${baseUrl}/admin.html#chat=${encodeURIComponent(chatId_)}`;
  const player = (x) => `${esc(x.gameName || x.nickname || '?')} · <code>${esc(x.userId)}</code> (<code>${esc(x.zoneId)}</code>)`;

  return {
    enabled,

    // Buyer pressed "I have paid": everything needed to check the bank app.
    paymentSubmitted(order, receiptPath) {
      return send({
        imagePath: receiptPath,
        text: [
          '💳 <b>New payment to verify</b>',
          `Amount: <b>${esc(money(order.amount))}</b>`,
          `Journal no.: <code>${esc(order.txnRef)}</code>`,
          `Item: ${esc(order.item)}`,
          `Player: ${player(order)}`,
          '',
          `<a href="${chatLink(order.chatId)}">Open in admin</a>`,
        ].join('\n'),
      });
    },

    newOrder(order) {
      return send({ text: `🛒 New order: ${esc(order.item)} · ${esc(money(order.amount))}\nPlayer: ${player(order)}` });
    },

    // Buyer wrote in the chat.
    buyerMessage(chat, msg, imagePath) {
      return send({
        imagePath,
        text: `💬 <b>${esc(chat.gameName)}</b> (<code>${esc(chat.userId)}</code>):\n${esc(msg.text || '📷 Photo')}\n\n<a href="${chatLink(chat.id)}">Reply</a>`,
      });
    },
  };
}

module.exports = { createNotifier };

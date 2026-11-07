// Finds your Telegram chat id. Usage:
//   1. Send any message (e.g. "hi") to your bot in Telegram.
//   2. TELEGRAM_BOT_TOKEN=123:abc npm run telegram:chat-id
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Set TELEGRAM_BOT_TOKEN first (from @BotFather).');
  process.exit(1);
}
(async () => {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const data = await res.json();
  if (!data.ok) return console.error('Telegram said:', data.description);
  const chats = new Map();
  for (const u of data.result) {
    const c = (u.message || u.channel_post || u.my_chat_member || {}).chat;
    if (c) chats.set(c.id, c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username);
  }
  if (!chats.size) return console.log('No messages yet. Send "hi" to your bot in Telegram, then run this again.');
  for (const [id, name] of chats) console.log(`TELEGRAM_CHAT_ID=${id}   (${name})`);
})();

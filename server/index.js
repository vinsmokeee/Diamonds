const path = require('path');
const config = require('./config');
const { createApp } = require('./app');
const { JsonStore } = require('./store');
const providers = require('./providers');

const app = createApp({
  store: new JsonStore(path.join(config.dataDir, 'orders.json')),
  chats: new JsonStore(path.join(config.dataDir, 'chats.json')),
  dataDir: config.dataDir,
  ...providers,
});

app.listen(config.port, () => {
  console.log(`Diamonds running at ${config.baseUrl} (payment: ${providers.payment.name}, supplier: ${providers.supplier.name})`);
  if (!config.adminToken) console.log('ADMIN_TOKEN is not set — the admin page is disabled.');
});

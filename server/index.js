const path = require('path');
const config = require('./config');
const { createApp } = require('./app');
const { OrderStore } = require('./store');
const providers = require('./providers');

const store = new OrderStore(path.join(config.dataDir, 'orders.json'));
const app = createApp({ store, ...providers, receiptsDir: path.join(config.dataDir, 'receipts') });

app.listen(config.port, () => {
  console.log(`Diamonds running at ${config.baseUrl} (payment: ${providers.payment.name}, supplier: ${providers.supplier.name})`);
  if (!config.adminToken) console.log('ADMIN_TOKEN is not set — the admin page is disabled.');
});

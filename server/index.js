const config = require('./config');
const { createApp } = require('./app');
const { OrderStore } = require('./store');
const providers = require('./providers');

const app = createApp({ store: new OrderStore(config.dataFile), ...providers });

app.listen(config.port, () => {
  console.log(`Diamonds running at ${config.baseUrl} (payment: ${providers.payment.name}, supplier: ${providers.supplier.name})`);
});

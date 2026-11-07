const config = require('../config');

const payments = {
  'bank-qr': () => require('./payment-bank-qr'),
  mock: () => require('./payment-mock'),
};
const suppliers = {
  manual: () => require('./supplier-manual'),
  mock: () => require('./supplier-mock'),
  fazercards: () => require('./supplier-fazercards').fromEnv(),
};

function load(registry, name, kind) {
  if (!registry[name]) throw new Error(`Unknown ${kind} provider "${name}". Add it in server/providers/index.js`);
  return registry[name]();
}

module.exports = {
  payment: load(payments, config.paymentProvider, 'payment'),
  supplier: load(suppliers, config.supplierProvider, 'supplier'),
};

const config = require('../config');

const payments = { mock: () => require('./payment-mock') };
const suppliers = { mock: () => require('./supplier-mock') };

function load(registry, name, kind) {
  if (!registry[name]) throw new Error(`Unknown ${kind} provider "${name}". Add it in server/providers/index.js`);
  return registry[name]();
}

module.exports = {
  payment: load(payments, config.paymentProvider, 'payment'),
  supplier: load(suppliers, config.supplierProvider, 'supplier'),
};

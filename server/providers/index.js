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

const payment = load(payments, config.paymentProvider, 'payment');
const supplier = load(suppliers, config.supplierProvider, 'supplier');

// In-game name lookup: the supplier's own, or FazerCards' free nickname check whenever
// FAZER_API_KEY is set (even if diamonds are still delivered by hand).
let playerLookup = null;
if (supplier.verifiesPlayer) playerLookup = supplier;
else if (process.env.FAZER_API_KEY) playerLookup = require('./supplier-fazercards').fromEnv();

module.exports = { payment, supplier, playerLookup };

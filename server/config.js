const config = {
  port: Number(process.env.PORT) || 3000,
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  currency: process.env.CURRENCY || 'USD',
  webhookSecret: process.env.WEBHOOK_SECRET || 'change-me',
  adminToken: process.env.ADMIN_TOKEN || '',
  paymentProvider: process.env.PAYMENT_PROVIDER || 'mock',
  supplierProvider: process.env.SUPPLIER_PROVIDER || 'mock',
  dataFile: process.env.DATA_FILE || require('path').join(__dirname, '..', 'data', 'orders.json'),
};

if (process.env.NODE_ENV === 'production') {
  if (config.webhookSecret === 'change-me') throw new Error('Set WEBHOOK_SECRET in production');
  if (config.paymentProvider === 'mock') throw new Error('The mock payment provider must not run in production');
}

module.exports = config;

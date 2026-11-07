const path = require('path');

const config = {
  port: Number(process.env.PORT) || 3000,
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  currency: process.env.CURRENCY || 'BTN',
  currencySymbol: process.env.CURRENCY_SYMBOL || 'Nu.',
  webhookSecret: process.env.WEBHOOK_SECRET || 'change-me',
  adminToken: process.env.ADMIN_TOKEN || '',
  paymentProvider: process.env.PAYMENT_PROVIDER || 'bank-qr',
  supplierProvider: process.env.SUPPLIER_PROVIDER || 'manual',
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

  // Shown to buyers on the payment page (bank-qr provider).
  bank: {
    bankName: process.env.PAY_BANK_NAME || 'T Bank',
    accountName: process.env.PAY_ACCOUNT_NAME || 'Tshering Phuntsho',
    accountNumber: process.env.PAY_ACCOUNT_NUMBER || '',
    // Put your bank's QR image in public/ and point this at it.
    qrImage: process.env.PAY_QR_IMAGE || '/payment-qr.jpg',
  },
  support: process.env.SUPPORT_CONTACT || '',

  // Profit protection: cost in Nu. = supplier USD price x usdToLocal.
  pricing: {
    usdToLocal: Number(process.env.USD_TO_NU) || 97,
    minMarginPercent: process.env.MIN_MARGIN_PERCENT !== undefined ? Number(process.env.MIN_MARGIN_PERCENT) : 10,
  },

  // Telegram alerts to the shop owner (optional)
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    // Which events: payments | orders | messages (comma-separated)
    events: (process.env.TELEGRAM_ALERTS || 'payments,messages').split(',').map((x) => x.trim()),
  },
};

if (process.env.NODE_ENV === 'production') {
  if (!config.adminToken || config.adminToken.length < 16) throw new Error('Set a long ADMIN_TOKEN in production');
  if (config.paymentProvider === 'mock') throw new Error('The mock payment provider must not run in production');
}

module.exports = config;

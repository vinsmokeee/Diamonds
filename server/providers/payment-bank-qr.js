// Manual bank-QR payment: the buyer scans the shop's bank QR (mBoB, BNB, T-Bank,
// BDBL, DK, ...), pays, and submits the journal/reference number + a screenshot.
// An admin checks the bank app and approves or rejects the order.
module.exports = {
  name: 'bank-qr',
  manual: true,
  createCheckout(order) {
    return { checkoutUrl: `/pay.html?id=${encodeURIComponent(order.id)}`, reference: null };
  },
  parseWebhook() {
    return null; // no webhooks for manual payments
  },
};

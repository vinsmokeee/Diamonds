# Diamonds — MLBB Diamond Top-Up

A storefront where players top up Mobile Legends: Bang Bang diamonds using their
User ID and Zone ID.

## Run it

```bash
npm install
npm start            # http://localhost:3000
npm test
```

Copy `.env.example` to `.env` (or set the variables yourself) to change port, currency, secrets.

## How it works

1. **Player check.** The buyer enters a User ID and Zone ID, and the site looks up the in-game nickname so they can confirm it's the right account.
2. **Package and payment.** The buyer picks a package and a payment method. The browser sends only a package **id**. Prices live on the server in `server/catalog.js`.
3. **Order.** The server creates an order (`pending_payment`) and redirects the buyer to the payment provider.
4. **Webhook.** The provider calls `POST /api/webhooks/payment`, and the signature is checked. The order moves `pending_payment → processing` exactly once, so a webhook retry can't double-deliver.
5. **Delivery.** The supplier credits the diamonds, and the order becomes `completed`, or `failed` if delivery didn't work.
6. **Tracking.** The buyer watches `/order.html?id=…`, which refreshes until the order is finished.

```
public/          storefront (index.html), order tracking, mock checkout
server/app.js    routes, validation, order state machine
server/catalog.js  packages & prices (edit these)
server/store.js  JSON-file order storage
server/providers/  payment + supplier adapters (mock ones included)
```

## Going live: what you still need

The site ships with **mock** payment and supplier adapters so you can build and test without spending money. Before you take real orders:

1. **A diamond supplier.** You need an authorised source that can credit diamonds to a User ID/Zone ID: an official reseller or partner program, or a wholesale top-up API. Write `server/providers/supplier-<name>.js` with `lookupPlayer()` and `fulfill()` (see `supplier-mock.js` for the contract). Register it in `providers/index.js` and set `SUPPLIER_PROVIDER`.
2. **A payment gateway** for your market, for example Stripe, PayPal, Xendit, PayMongo or Razorpay. Write `payment-<name>.js` with `createCheckout()` and `parseWebhook()`, and set `PAYMENT_PROVIDER`. The server refuses to start in production with the mock provider.
3. **A real database.** `store.js` is a single JSON file. Move to Postgres or SQLite before you get real traffic.
4. **Set the secrets.** `WEBHOOK_SECRET` and `ADMIN_TOKEN`, then run with `NODE_ENV=production` behind HTTPS.
5. **Set your prices** in `server/catalog.js`. They are in cents of `CURRENCY`.
6. **Legal.** Add terms, a refund policy and a support contact. Don't use official game logos or art without permission.

Admin order list: `GET /api/admin/orders` with header `Authorization: Bearer $ADMIN_TOKEN`.

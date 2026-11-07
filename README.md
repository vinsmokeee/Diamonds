# Diamonds — MLBB Diamond Top-Up for Bhutan

A storefront where players in Bhutan buy Mobile Legends: Bang Bang diamonds in
**Ngultrum (Nu.)** and pay by scanning the shop's **bank QR code** in their banking app.
No international card is needed.

## Run it

```bash
npm install
cp .env.example .env     # edit your bank details + ADMIN_TOKEN
ADMIN_TOKEN=pick-a-long-secret npm start     # http://localhost:3000
npm test
```

The variables in `.env.example` are read from the environment. Load the file with
`node --env-file=.env server/index.js`, or set them in your hosting dashboard.

## How an order works

| Step | Buyer | You (admin) |
|---|---|---|
| 1 | Enters game name, User ID + Zone ID, confirms they're correct, picks a package | |
| 2 | Sees your bank QR and the exact amount in Nu. Pays in their banking app (mBoB, BNB, T-Bank, BDBL, DK…) | |
| 3 | Enters the **journal number** from the receipt and uploads a screenshot. Both appear in the order's chat | The chat appears in **/admin.html → Chats**, with the order card on top |
| 4 | | Check that the money arrived in your bank app, then press **Payment received** (or **Reject** with a reason) right in the chat |
| 5 | | Top up the player from your reseller account, then press **Mark delivered** |
| 6 | Order page shows **Delivered!** | |

The buyer's order page updates by itself as you move the order along.

## Chat

A chat button sits in the bottom-right of every page. Buyers can send text and photos, such as receipts or in-game screenshots.

- **Every order gets its own chat.** Buyers can also start one before ordering by giving their game name and ID.
- **Payment submissions** (journal number and screenshot) are posted into the chat automatically.
- **Status updates** ("Payment confirmed", "Delivered") are posted into the chat automatically too.
- **In `/admin.html → Chats`** you see every conversation with its unread count. The buyer's order sits at the top with the approve and deliver buttons, so you can check a payment and reply without leaving the chat. There are also quick-reply buttons for common answers.
- **Photos are private.** A buyer can only open photos in their own chat, and you need your admin password to open them.

Chat history is checked every few seconds, so there's no extra service to run.

**Built-in protections**
- Prices are set on the server in `server/catalog.js`, so the buyer can't change the amount.
- A journal number can only be used on one order.
- Only image screenshots up to 2 MB are accepted, and they're shrunk in the browser first.
- Each order can only be approved once and delivered once.

## Set up for your shop

1. **Your QR code.** Save the QR image from your banking app as `public/payment-qr.png`, then set `PAY_QR_IMAGE=/payment-qr.png`.
2. **Bank details.** Set `PAY_BANK_NAME`, `PAY_ACCOUNT_NAME`, and optionally `PAY_ACCOUNT_NUMBER`.
3. **Prices.** Edit `server/catalog.js`. Prices are whole Nu. The current ones are placeholders, so set them from your supplier cost plus your margin.
4. **Extra contact (optional).** Set `SUPPORT_CONTACT` if you also want to show a WhatsApp number or Facebook page. The built-in chat is the main channel.
5. **Admin password.** Set `ADMIN_TOKEN` to a long random string. The admin page is `/admin.html`.
6. **Hosting.** Deploy with `NODE_ENV=production` on any Node host behind HTTPS, and keep the `data/` folder on persistent storage. That folder holds your orders, chats and photos.

## Project layout

```
public/            storefront, pay.html (QR), order.html (tracking), admin.html, chat.js (chat box)
server/app.js      routes, validation, order state machine
server/chat.js     buyer <-> shop chat
server/catalog.js  packages & prices
server/store.js    JSON-file storage for orders + chats (move to SQLite/Postgres as you grow)
server/providers/  payment + supplier adapters
```

## Later: automation

- **Automatic delivery.** If your diamond supplier has an API, write `server/providers/supplier-<name>.js` with `lookupPlayer()` and `fulfill()`, and set `SUPPLIER_PROVIDER`. Orders then deliver as soon as you approve the payment, and buyers see their in-game nickname before paying.
- **Automatic payment confirmation.** If your bank gives merchants a payment API or webhooks, add `payment-<name>.js`. There is already a webhook route in `server/app.js` for this.

## Notes

Not affiliated with Moonton. Don't use official game logos or art without permission.
Add terms of service and a refund policy before you launch.

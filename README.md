# SOMA Diamonds — MLBB Diamond Top-Up for Bhutan

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

## Telegram alerts (payment details straight to your phone)

When a buyer presses **I have paid**, your Telegram receives a message with the amount, journal number, game name, User ID and Zone ID. The receipt screenshot is attached, and there's a link that opens that chat in the admin page. New chat messages from buyers are sent to you too.

Setup takes about 5 minutes:

1. **Create a bot.** In Telegram, open **@BotFather**, send `/newbot` and follow the prompts. It gives you a **token** like `123456:ABC-...`.
2. **Message your bot.** Open your new bot and send it any message, for example "hi".
3. **Find your chat ID** with `TELEGRAM_BOT_TOKEN=<token> npm run telegram:chat-id`. This prints `TELEGRAM_CHAT_ID=...`.
4. **Add both values to your settings:**
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC-...
   TELEGRAM_CHAT_ID=987654321
   TELEGRAM_ALERTS=payments,messages     # add ",orders" to also get an alert for every new unpaid order
   ```
5. **Restart the site.**

**Alerts to a group:** to alert several people, such as you and a helper, add the bot to a Telegram group, send a message there, and run step 3 again. Use the group's ID, which is a negative number.

**Admin page sound:** `/admin.html` also has a **🔔 Alerts** button. While the admin page is open, it plays a sound and shows a pop-up for new payments and messages.

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

## Hosting (get a public link)

The repo includes `render.yaml` for [Render](https://render.com).

1. Sign up at render.com with your GitHub account.
2. Click **New → Blueprint**, pick the **Diamonds** repository and branch, then click **Apply**.
3. After a few minutes you get a link like `https://soma-diamonds.onrender.com`.
4. Your admin password is in the service's **Environment** tab as `ADMIN_TOKEN`. Use it at `/admin.html`.

**Free plan limits:** good for previews only.
- The site sleeps when unused, so the first visit takes about a minute.
- Orders and chats are wiped when it restarts.

**For the real shop:**
- Switch to the **Starter** plan and add a **Disk** mounted at `/var/data`.
- Set `DATA_DIR=/var/data`.
- For automatic delivery, set `SUPPLIER_PROVIDER=fazercards` and add `FAZER_API_KEY` as a secret in the Environment tab.

## Project layout

```
public/            storefront, pay.html (QR), order.html (tracking), admin.html, chat.js (chat box)
server/app.js      routes, validation, order state machine
server/chat.js     buyer <-> shop chat
server/catalog.js  packages & prices
server/store.js    JSON-file storage for orders + chats (move to SQLite/Postgres as you grow)
server/providers/  payment + supplier adapters
```

## In-game name popup

When a player enters their User ID and Zone ID and ticks **"I have double-checked…"**, the site looks up their **in-game name** and shows it ("✓ In-game name: Tashi. Is this you?"). A wrong ID shows **"Player not found"** and they can't pay. Names are cached for 10 minutes.

This uses FazerCards' free nickname check. It only needs `FAZER_API_KEY`, and works even while you deliver diamonds by hand. If the check is down, buyers can still order.

## Automatic delivery with FazerCards

When this is set up, pressing **✓ Payment received** tells FazerCards to send the diamonds straight to the player's User ID and Zone ID. You don't have to top up by hand.

**Setup:**
1. **Get an API key.** Create a reseller account at reseller.fazercards.com, add balance, and copy your **API key** from the dashboard.
2. **List the products.** Run `FAZER_API_KEY=fc_... USD_TO_NU=84 MARGIN=15 npm run fazer:offers`. This shows FazerCards' Mobile Legends categories and products, what each costs you in Nu., and a suggested price at your margin. It also tells you whether nickname checking is available.
3. **Match your packages.** Fill in `config/fazercards.json` with the FazerCards product ID for each package. Leave a package as `""` to deliver it by hand. Update your prices in `server/catalog.js` so each one makes a profit.
4. **Turn it on.** Set `SUPPLIER_PROVIDER=fazercards` and `FAZER_API_KEY=...`, then restart the site.
5. **Webhook (optional, faster).** In FazerCards' webhook settings, set the URL to `https://<your-site>/api/webhooks/supplier`, and copy the signing secret into `FAZER_WEBHOOK_SECRET`. Without this, the site checks unfinished top-ups every 30 seconds.

**What happens on each order:**
- **Normal top-up:** the order shows **Deliver** while FazerCards works, then **Delivered**. The buyer's chat shows "💎 Delivered".
- **Top-up fails** (for example, an unsupported region): the buyer sees "Delivery is delayed". You see the real reason in a private 🔒 note, with **🔁 Retry delivery** and **💎 Delivered by hand** buttons.
- **No double charging:** every top-up request carries a unique key, so a network retry can never pay FazerCards twice for one order.
- **Balance warning:** the admin page shows your FazerCards balance and turns red when it's low.

**Before going live**, test one small package on a real Bhutanese account. FazerCards funds balances in crypto (USDT and similar), so check that you can pay them from Bhutan.

## Receipts: a journal number can only be used once

Every receipt is checked, whether the buyer uses the payment form, the "I have paid" card, or just sends a photo in the chat:
- **Journal number read automatically.** The site reads the journal or reference number and the amount from the screenshot. This runs on your own server and takes about a second. It recognises labels like *Journal No*, *Jrnl No*, *Reference ID*, *Txn ID* and *RRN*.
- **No reuse.** A journal number that was already used on any order is refused, whether it was typed or read from a screenshot. So is the exact same screenshot file. The buyer is told: "This receipt was already used. Please send the receipt for this payment."
- **Private warnings to you:**
  - No journal number could be read.
  - The amount on the screenshot is lower than the price.
  - The typed number doesn't match the screenshot.
- **Fixing it by hand:** use **✏️ Set journal no.** to add or correct a number. Duplicates are refused there too, and approving checks again.

Your bank app is still the final check. A screenshot can be edited; the money in your account can't.
Set `RECEIPT_OCR=off` to turn off screenshot reading. Typed numbers and identical screenshots are still checked.

## Profit protection

Prices in `server/catalog.js` are set for about **20% profit** over FazerCards' cost at **Nu. 97 per USD**.

With FazerCards connected, the site re-checks FazerCards' prices **every hour**:
- **Profit drops too low:** if a package would earn less than `MIN_MARGIN_PERCENT` (default **10%**), it's **paused**. Buyers can't see it or order it.
- **Pack removed:** if FazerCards stops selling a pack, that package is paused too.
- **Cost drops back:** a paused package returns by itself.
- **Admin view:** `/admin.html` shows a **✅ / ⏸ profit panel** with each package's cost, price and margin.
- **Supplier unreachable:** nothing changes. The last check is kept.

Set `USD_TO_NU` to what you **actually** pay for 1 USD of FazerCards balance, including USDT fees, so the margins are real.

## Later: more automation

- **Automatic delivery.** If your diamond supplier has an API, write `server/providers/supplier-<name>.js` with `lookupPlayer()` and `fulfill()`, and set `SUPPLIER_PROVIDER`. Orders then deliver as soon as you approve the payment, and buyers see their in-game nickname before paying.
- **Automatic payment confirmation.** If your bank gives merchants a payment API or webhooks, add `payment-<name>.js`. There is already a webhook route in `server/app.js` for this.

## Notes

Not affiliated with Moonton. Don't use official game logos or art without permission.
Add terms of service and a refund policy before you launch.

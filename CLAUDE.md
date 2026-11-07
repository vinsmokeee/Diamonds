# SOMA Diamonds

Mobile Legends: Bang Bang diamond top-up website for the Bhutanese gaming community, live at https://soma-diamonds.onrender.com.

**Start every session by reading `STATUS.md`.** It says what's live, the Render settings, what we're waiting on (funding the FazerCards supplier with USDT), and the exact next steps.

## How to work on this repo

- **Owner:** non-technical, works from a phone. Explain steps simply, in short numbered lists, and send screenshots of UI changes at phone size (390px wide).
- **Run it:** `npm install`, then `npm start` (port 3000). Admin is at `/admin.html` with `ADMIN_TOKEN`.
- **Test:** `npm test` (node:test). Keep all tests passing, and add tests for new behaviour.
- **Deploy:** Render auto-deploys `main`. Make changes on a branch and open a pull request. The owner merges it to go live.
- **Never commit secrets.** The FazerCards key lives in Render's Environment tab (and in the "Diamonds" cloud environment for testing). Never in code or chat.
- **Prices** are in whole Ngultrum in `server/catalog.js`. Check new prices against live supplier cost (`npm run fazer:offers`) so every package stays profitable. The price guard pauses anything below `MIN_MARGIN_PERCENT`.

## Map

- `server/app.js`: routes, order state machine, receipts/journal-number checks, admin actions.
- `server/chat.js`: buyer ↔ shop chat.
- `server/receipts.js`: OCR on receipt screenshots.
- `server/pricing.js`: profit guard.
- `server/providers/`: payment (`bank-qr`) and supplier (`manual`, `fazercards`) adapters.
- `public/`: storefront, pay page, order tracking, admin page, terms, chat widget.
- `config/fazercards.json`: SOMA package → FazerCards offer ids. A list means several top-ups.

## Future plans the owner mentioned

- **Several SOMA projects:** this top-up shop, games, an SMM panel and more. Each is built and perfected as its own repo and Render service.
- **One website for all of them.** When ready, everything goes under **one domain**:
  - A **hub** page at the root, with one card per service.
  - Each project on a subdomain: `diamonds.<domain>`, `play.<domain>`, `smm.<domain>`.
  - Shared SOMA look and menu across all of them.
  - Possibly a shared login and wallet later.
- **SMM panel:** remind the owner that selling followers, likes or views breaks the major platforms' terms. Discuss safer services and clear terms before building.

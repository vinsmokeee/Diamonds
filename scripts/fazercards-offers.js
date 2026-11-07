// Lists FazerCards Mobile Legends products so you can fill config/fazercards.json.
//   FAZER_API_KEY=fc_... npm run fazer:offers
//   FAZER_API_KEY=fc_... USD_TO_NU=84 MARGIN=15 npm run fazer:offers   (also suggests Nu. prices)
const path = require('path');
const { createFazerCards, loadSettings } = require('../server/providers/supplier-fazercards');

const apiKey = process.env.FAZER_API_KEY;
if (!apiKey) {
  console.error('Set FAZER_API_KEY first (FazerCards dashboard → API).');
  process.exit(1);
}
const settings = loadSettings(process.env.FAZER_CONFIG || path.join(__dirname, '..', 'config', 'fazercards.json'));
const fz = createFazerCards({ apiKey, baseUrl: process.env.FAZER_BASE_URL || undefined, settings });
const rate = Number(process.env.USD_TO_NU) || 0;
const margin = Number(process.env.MARGIN) || 15;

(async () => {
  const bal = await fz.getBalance();
  console.log(`Balance: ${bal.balance} ${bal.currency}\n`);

  // Find Mobile Legends categories.
  const cats = [];
  let cursor;
  do {
    const page = await fz._request('GET', `/topups?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    cats.push(...(page.items || []));
    cursor = page.meta && page.meta.next_cursor;
  } while (cursor);
  const ml = cats.filter((c) => /mobile.?legends|mlbb/i.test(`${c.category_id} ${c.name}`));
  console.log('Mobile Legends top-up categories (put one in "categoryId"):');
  for (const c of ml) console.log(`  ${c.category_id.padEnd(30)} ${c.name}`);
  if (!ml.length) console.log('  (none found — check the FazerCards catalog)');

  const categoryId = process.env.CATEGORY || settings.categoryId;
  const offers = await fz._request('GET', `/topups/offers?category_id=${encodeURIComponent(categoryId)}`);
  console.log(`\nOffers in "${categoryId}" — required fields: ${(offers.fields || []).map((f) => f.key).join(', ')}`);
  for (const o of offers.offers || []) {
    const cost = Number(o.price_usd);
    const suggest = rate
      ? `  → cost Nu. ${Math.ceil(cost * rate)}, sell at least Nu. ${Math.ceil(cost * rate * (1 + margin / 100))} (+${margin}%)`
      : '';
    console.log(`  ${String(o.offer_id).padEnd(24)} $${String(o.price_usd).padEnd(8)} ${o.name}${suggest}`);
  }

  try {
    const v = await fz._request('GET', '/topups/validate-id');
    const mv = (v.items || []).filter((g) => /mobile.?legends|mlbb/i.test(`${g.category_id} ${g.name}`));
    console.log('\nNickname check: ' + (mv.length ? `available — set "validateCategoryId": "${mv[0].category_id}"` : 'not available for Mobile Legends'));
  } catch (e) {
    console.log(`\nNickname check: could not query (${e.message})`);
  }
})().catch((e) => {
  console.error('FazerCards error:', e.message);
  process.exit(1);
});

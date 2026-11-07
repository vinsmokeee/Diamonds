// Profit protection. Periodically compares each package's selling price with the
// supplier's current cost and pauses packages that would earn less than the minimum
// margin, so nobody can buy them at a loss. Paused packages come back automatically
// when the cost drops again (or after you raise the price and restart).
const catalog = require('./catalog');

function createPriceGuard({ supplier, usdToLocal, minMarginPercent }) {
  const state = { checkedAt: null, error: null, rows: [], paused: new Set() };
  const enabled = Boolean(supplier && supplier.getPackageCosts);

  async function check() {
    if (!enabled) return state;
    try {
      const costs = await supplier.getPackageCosts();
      const rows = [];
      const paused = new Set();
      for (const p of catalog.packages) {
        if (!(p.id in costs)) continue; // delivered by hand: no automatic cost
        const usd = costs[p.id];
        if (usd === null) {
          rows.push({ id: p.id, label: catalog.label(p), price: p.price, cost: null, margin: null, paused: true, reason: 'Supplier no longer sells this pack' });
          paused.add(p.id);
          continue;
        }
        const cost = Math.round(usd * usdToLocal * 100) / 100;
        const margin = Math.round(((p.price - cost) / cost) * 1000) / 10;
        const isPaused = margin < minMarginPercent;
        if (isPaused) paused.add(p.id);
        rows.push({
          id: p.id,
          label: catalog.label(p),
          price: p.price,
          cost,
          costUsd: usd,
          margin,
          paused: isPaused,
          reason: isPaused ? `Profit ${margin}% is below your minimum ${minMarginPercent}%` : null,
        });
      }
      Object.assign(state, { checkedAt: new Date().toISOString(), error: null, rows, paused });
    } catch (e) {
      // Keep the last known state; never pause everything because the supplier was unreachable.
      state.error = e.message;
      console.error('price check failed:', e.message);
    }
    return state;
  }

  return {
    enabled,
    check,
    isPaused: (packageId) => state.paused.has(packageId),
    report: () => ({ enabled, usdToLocal, minMarginPercent, checkedAt: state.checkedAt, error: state.error, rows: state.rows }),
  };
}

module.exports = { createPriceGuard };

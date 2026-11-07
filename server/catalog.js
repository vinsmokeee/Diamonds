// Prices are whole Ngultrum (Nu.) and are the ONLY source of truth.
// The browser never sends a price; it sends a package id.
// Set for ~20% profit over FazerCards cost at Nu. 97/USD (Nov 2026); the three biggest packs
// at ~16% to stay close to SEAGM / Joytify / Elitedias prices. Packages that lost money
// (11, 22, 56) or that FazerCards doesn't sell (344) were removed.
// The price guard (server/pricing.js) pauses any package whose profit drops below MIN_MARGIN_PERCENT.
const packages = [
  { id: 'dm-86',   type: 'diamonds', diamonds: 78,   bonus: 8,   price: 130 },
  { id: 'dm-172',  type: 'diamonds', diamonds: 156,  bonus: 16,  price: 255 },
  { id: 'dm-257',  type: 'diamonds', diamonds: 234,  bonus: 23,  price: 370 },
  { id: 'dm-706',  type: 'diamonds', diamonds: 625,  bonus: 81,  price: 995, tag: 'Popular' },
  { id: 'dm-2195', type: 'diamonds', diamonds: 1860, bonus: 335, price: 2900 },
  { id: 'dm-3688', type: 'diamonds', diamonds: 3099, bonus: 589, price: 4850 },
  { id: 'dm-5532', type: 'diamonds', diamonds: 4649, bonus: 883, price: 7300, tag: 'Best value' },
  { id: 'wdp',      type: 'pass', name: 'Weekly Diamond Pass', description: '80 diamonds over 7 days', price: 160, tag: 'Hot' },
  { id: 'twilight', type: 'pass', name: 'Twilight Pass', description: 'Monthly pass bundle', price: 845 },
];

function getPackage(id) {
  return packages.find((p) => p.id === id) || null;
}

function label(pkg) {
  if (pkg.type === 'pass') return pkg.name;
  return `${pkg.diamonds + pkg.bonus} Diamonds`;
}

module.exports = { packages, getPackage, label };

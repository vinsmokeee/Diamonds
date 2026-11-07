// Prices are whole Ngultrum (Nu.) and are the ONLY source of truth.
// The browser never sends a price; it sends a package id.
// These are placeholders — set them from your own supplier cost + margin.
const packages = [
  { id: 'dm-11',   type: 'diamonds', diamonds: 11,   bonus: 0,   price: 20 },
  { id: 'dm-22',   type: 'diamonds', diamonds: 22,   bonus: 0,   price: 38 },
  { id: 'dm-56',   type: 'diamonds', diamonds: 56,   bonus: 0,   price: 85 },
  { id: 'dm-86',   type: 'diamonds', diamonds: 78,   bonus: 8,   price: 125 },
  { id: 'dm-172',  type: 'diamonds', diamonds: 156,  bonus: 16,  price: 245 },
  { id: 'dm-257',  type: 'diamonds', diamonds: 234,  bonus: 23,  price: 365 },
  { id: 'dm-344',  type: 'diamonds', diamonds: 312,  bonus: 32,  price: 490 },
  { id: 'dm-706',  type: 'diamonds', diamonds: 625,  bonus: 81,  price: 980, tag: 'Popular' },
  { id: 'dm-2195', type: 'diamonds', diamonds: 1860, bonus: 335, price: 2950 },
  { id: 'dm-3688', type: 'diamonds', diamonds: 3099, bonus: 589, price: 4900 },
  { id: 'dm-5532', type: 'diamonds', diamonds: 4649, bonus: 883, price: 7350, tag: 'Best value' },
  { id: 'wdp',      type: 'pass', name: 'Weekly Diamond Pass', description: '80 diamonds over 7 days', price: 160, tag: 'Hot' },
  { id: 'twilight', type: 'pass', name: 'Twilight Pass', description: 'Monthly pass bundle', price: 820 },
];

function getPackage(id) {
  return packages.find((p) => p.id === id) || null;
}

function label(pkg) {
  if (pkg.type === 'pass') return pkg.name;
  return `${pkg.diamonds + pkg.bonus} Diamonds`;
}

module.exports = { packages, getPackage, label };

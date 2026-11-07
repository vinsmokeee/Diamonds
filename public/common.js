// Shared helpers for all pages.

// "Nu. 1,250"
window.formatMoney = (amount, symbol = 'Nu.') =>
  `${symbol} ${Number(amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// Shrink a photo in the browser so uploads stay small on mobile data. Returns a JPEG data: URL.
window.compressImage = async (file, maxSide = 1400) => {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IMAGE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Validate a data: URL image and save it under dir. Returns { file } or { error }.
 * The file name is random, so it can't be guessed or collide.
 */
function saveDataUrlImage(dataUrl, dir) {
  const m = IMAGE.exec(String(dataUrl));
  if (!m) return { error: 'Photo must be a JPG, PNG or WebP image.' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_BYTES) return { error: 'Photo is too large (max 2 MB).' };
  fs.mkdirSync(dir, { recursive: true });
  const file = `${crypto.randomBytes(12).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(dir, file), buf);
  return { file };
}

module.exports = { saveDataUrlImage };

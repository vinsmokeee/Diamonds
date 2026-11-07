// Reads payment receipt screenshots: finds the journal / reference number and the
// amount, so a receipt can't be reused for a second order and underpayments stand out.
// Runs locally (tesseract.js + bundled English data) — no image leaves the server.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Labels banks use for the transaction number on a receipt.
const JOURNAL_LABEL = /(journal|jrnl|jrn|reference|ref|transaction|txn|trx|rrn|utr)\.?\s*(no|number|id|#)?\.?\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{5,30})/gi;
const AMOUNT = /(?:Nu\.?|BTN|Ngultrum|Amount\s*:?)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i;

/** Pull the journal number and amount out of OCR text. Pure function (unit-tested). */
function parseReceiptText(text) {
  const clean = String(text || '').replace(/[|]/g, ' ');
  let journalNo = null;
  for (const m of clean.matchAll(JOURNAL_LABEL)) {
    const token = m[3].replace(/[^A-Z0-9-]/gi, '').toUpperCase();
    // Must look like an id (enough digits), not a word like "Successful".
    if ((token.match(/\d/g) || []).length >= 4) {
      journalNo = token;
      break;
    }
  }
  const a = AMOUNT.exec(clean);
  const amount = a ? Number(a[1].replace(/,/g, '')) : null;
  return { journalNo, amount: Number.isFinite(amount) ? amount : null };
}

function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function createReceiptReader({ enabled = true, timeoutMs = 20_000 } = {}) {
  let workerPromise = null;
  let queue = Promise.resolve();

  function getWorker() {
    if (!workerPromise) {
      const { createWorker } = require('tesseract.js');
      const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
      workerPromise = createWorker('eng', 1, { langPath, cacheMethod: 'none', gzip: true }).catch((e) => {
        workerPromise = null;
        throw e;
      });
    }
    return workerPromise;
  }

  /** -> { journalNo, amount, text } or null if OCR is off / failed / too slow. */
  function read(file) {
    if (!enabled || !file || !fs.existsSync(file)) return Promise.resolve(null);
    const job = queue.then(async () => {
      const worker = await getWorker();
      const { data } = await worker.recognize(file);
      return { ...parseReceiptText(data.text), text: data.text };
    });
    queue = job.catch(() => {}); // one image at a time; a failure doesn't block the next
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs).unref());
    return Promise.race([job.catch((e) => { console.error('receipt OCR failed:', e.message); return null; }), timeout]);
  }

  async function close() {
    if (!workerPromise) return;
    const w = await workerPromise.catch(() => null);
    workerPromise = null;
    if (w) await w.terminate();
  }

  return { enabled, read, close };
}

module.exports = { createReceiptReader, parseReceiptText, fileHash };

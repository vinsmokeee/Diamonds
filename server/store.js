// Minimal JSON-file record store (used for orders and chats). Good enough to start;
// swap for Postgres/SQLite before real traffic (keeps everything in memory, rewrites the file on save).
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file) {
    this.file = file;
    this.orders = new Map();
    if (file && fs.existsSync(file)) {
      for (const o of JSON.parse(fs.readFileSync(file, 'utf8'))) this.orders.set(o.id, o);
    }
  }

  _save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.orders.values()], null, 2));
    fs.renameSync(tmp, this.file);
  }

  create(order) {
    this.orders.set(order.id, order);
    this._save();
    return order;
  }

  get(id) {
    return this.orders.get(id) || null;
  }

  update(id, patch) {
    const o = this.orders.get(id);
    if (!o) return null;
    Object.assign(o, patch, { updatedAt: new Date().toISOString() });
    this._save();
    return o;
  }

  /** Atomically move an order from one status to another. Returns null if it wasn't in `from`. */
  transition(id, from, to, patch = {}) {
    const o = this.orders.get(id);
    if (!o || o.status !== from) return null;
    return this.update(id, { ...patch, status: to });
  }

  list() {
    return [...this.orders.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

module.exports = { JsonStore, OrderStore: JsonStore };

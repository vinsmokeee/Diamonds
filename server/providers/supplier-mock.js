// Mock diamond supplier. A real adapter talks to an authorised MLBB reseller /
// top-up API and must expose:
//
//   lookupPlayer(userId, zoneId) -> { ok: true, nickname } | { ok: false, error }
//   fulfill(order)               -> { ok: true, reference } | { ok: false, error }
//
// fulfill() must be idempotent on order.id: pass order.id to the supplier as
// your unique transaction reference so a retry never double-credits a player.
const crypto = require('crypto');

const NAMES = ['ShadowBlade', 'MoonArcher', 'IronTank', 'LaneKing', 'JungleCat', 'MythicDream'];

async function lookupPlayer(userId, zoneId) {
  // Deterministic fake nickname so the same ID always "resolves" the same way.
  if (userId.startsWith('0')) return { ok: false, error: 'Player not found' };
  const h = crypto.createHash('sha1').update(`${userId}:${zoneId}`).digest();
  return { ok: true, nickname: `${NAMES[h[0] % NAMES.length]}${h[1] % 100}` };
}

async function fulfill(order) {
  return { ok: true, reference: `sup_${order.id}` };
}

module.exports = { name: 'mock', lookupPlayer, fulfill };

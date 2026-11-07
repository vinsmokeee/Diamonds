// Manual supplier: you top up the player yourself (from your reseller account)
// and then press "Mark delivered" in the admin page. There is no API to check
// nicknames, so lookupPlayer returns no nickname and buyers confirm their ID.
module.exports = {
  name: 'manual',
  manual: true,
  async lookupPlayer() {
    return { ok: true, nickname: null };
  },
  async fulfill() {
    return { ok: true, pending: true };
  },
};

(() => {
  const $ = (id) => document.getElementById(id);
  const GEM = '<svg class="gem" viewBox="0 0 32 32" aria-hidden="true"><path d="M8 4h16l6 8-14 17L2 12z" fill="#4fc3ff"/><path d="M2 12h28L16 29z" fill="#8b5cf6" opacity=".55"/></svg>';
  const PASS = '<svg class="gem" viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="7" width="26" height="18" rx="4" fill="#ffc85a"/><path d="M3 13h26" stroke="#2a1c00" stroke-opacity=".35" stroke-width="2"/></svg>';

  // player: in-game name found for checkedKey; notFound: lookup said the ID doesn't exist.
  const state = { catalog: null, tab: 'diamonds', pkg: null, player: null, checkedKey: null, looking: false, notFound: false };

  const money = (n) => window.formatMoney(n, state.catalog.currencySymbol);
  const idKey = () => `${$('userId').value.trim()}|${$('zoneId').value.trim()}`;
  const idsValid = () => /^\d{5,12}$/.test($('userId').value.trim()) && /^\d{1,6}$/.test($('zoneId').value.trim());

  function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function renderPackages() {
    const box = $('packages');
    box.innerHTML = '';
    for (const p of state.catalog.packages.filter((x) => x.type === state.tab)) {
      const b = el('button', 'pkg' + (state.pkg?.id === p.id ? ' selected' : ''));
      b.type = 'button';
      b.innerHTML = p.type === 'pass' ? PASS : GEM;
      if (p.tag) b.appendChild(el('span', 'tag')).textContent = p.tag;
      if (p.type === 'pass') {
        b.appendChild(el('div', 'amt')).textContent = p.name;
        b.appendChild(el('div', 'desc')).textContent = p.description;
      } else {
        b.appendChild(el('div', 'amt')).textContent = `${p.diamonds + p.bonus} 💎`;
        b.appendChild(el('div', 'bonus')).textContent = p.bonus ? `${p.diamonds} + ${p.bonus} bonus` : '';
      }
      b.appendChild(el('div', 'price')).textContent = money(p.price);
      b.addEventListener('click', () => { state.pkg = p; renderPackages(); update(); });
      box.appendChild(b);
    }
  }

  function accountReady() {
    return idsValid() && $('confirmId').checked && !state.looking && !state.notFound;
  }

  function update() {
    const uid = $('userId').value.trim();
    const zid = $('zoneId').value.trim();
    let who = '—';
    if (idsValid()) who = state.player && state.checkedKey === idKey() ? `${state.player} · ${uid} (${zid})` : `${uid} (${zid})`;
    $('sumPlayer').textContent = who;
    $('sumItem').textContent = state.pkg ? state.pkg.label : '—';
    $('sumTotal').textContent = state.pkg ? money(state.pkg.price) : '—';
    $('buyBtn').disabled = !(accountReady() && state.pkg);
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // Show the player's in-game name as soon as they confirm their ID.
  let lookupTimer = null;
  let lookupSeq = 0;
  function showPlayer(cls, text) {
    const box = $('playerBox');
    box.className = cls ? `player ${cls}` : 'player';
    box.textContent = text || '';
  }

  async function lookupName() {
    if (!state.catalog.verifiesPlayer || !idsValid() || !$('confirmId').checked) return;
    const key = idKey();
    if (state.checkedKey === key && (state.player || state.notFound)) return;
    const seq = ++lookupSeq;
    state.looking = true;
    state.notFound = false;
    showPlayer('wait', 'Looking up your in-game name…');
    update();
    try {
      const { nickname } = await api('/api/players/lookup', { userId: $('userId').value.trim(), zoneId: $('zoneId').value.trim() });
      if (seq !== lookupSeq) return;
      state.checkedKey = key;
      state.player = nickname || null;
      if (nickname) showPlayer('ok', `✓ In-game name: ${nickname}. Is this you?`);
      else showPlayer('', '');
    } catch (e) {
      if (seq !== lookupSeq) return;
      state.checkedKey = key;
      state.player = null;
      if (/not found/i.test(e.message)) {
        state.notFound = true;
        showPlayer('err', '✕ Player not found. Check your User ID and Zone ID.');
        $('confirmId').checked = false;
      } else {
        showPlayer('', 'Could not check the name right now. Make sure your ID is correct.');
      }
    } finally {
      if (seq === lookupSeq) {
        state.looking = false;
        update();
      }
    }
  }

  async function buy() {
    const btn = $('buyBtn');
    $('formError').textContent = '';
    btn.disabled = true;
    btn.textContent = 'Creating order…';
    try {
      const { checkoutUrl, chatId } = await api('/api/orders', {
        userId: $('userId').value.trim(),
        zoneId: $('zoneId').value.trim(),
        packageId: state.pkg.id,
        chatId: window.Chat ? window.Chat.id() : null,
      });
      if (window.Chat) window.Chat.attach(chatId);
      window.location.href = checkoutUrl;
    } catch (e) {
      $('formError').textContent = e.message;
      btn.textContent = 'Buy now';
      update();
    }
  }

  for (const id of ['userId', 'zoneId']) {
    $(id).addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, '');
      if (state.checkedKey !== idKey()) {
        lookupSeq++;
        Object.assign(state, { player: null, notFound: false, looking: false });
        showPlayer('', '');
        // Already ticked and still typing: look up again once they stop.
        clearTimeout(lookupTimer);
        lookupTimer = setTimeout(lookupName, 700);
      }
      update();
    });
  }
  $('confirmId').addEventListener('change', () => {
    if ($('confirmId').checked) {
      if (!idsValid()) showPlayer('err', 'Enter your User ID and Zone ID first.');
      lookupName();
    } else if (!state.notFound) {
      showPlayer('', '');
    }
    update();
  });
  $('buyBtn').addEventListener('click', buy);
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    state.tab = t.dataset.type;
    renderPackages();
  }));

  api('/api/catalog').then((c) => {
    state.catalog = c;
    $('fields').style.gridTemplateColumns = '2fr 1fr';
    if (c.support) $('supportLine').textContent = `Help: ${c.support}`;
    renderPackages();
    update();
  }).catch(() => { $('packages').innerHTML = '<p class="hint">Could not load packages. Refresh to try again.</p>'; });
})();

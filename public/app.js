(() => {
  const $ = (id) => document.getElementById(id);
  const GEM = '<svg class="gem" viewBox="0 0 32 32" aria-hidden="true"><path d="M8 4h16l6 8-14 17L2 12z" fill="#4fc3ff"/><path d="M2 12h28L16 29z" fill="#8b5cf6" opacity=".55"/></svg>';
  const PASS = '<svg class="gem" viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="7" width="26" height="18" rx="4" fill="#ffc85a"/><path d="M3 13h26" stroke="#2a1c00" stroke-opacity=".35" stroke-width="2"/></svg>';

  const state = { catalog: null, tab: 'diamonds', pkg: null, player: null, checkedKey: null };

  const money = (n) => window.formatMoney(n, state.catalog.currencySymbol);
  const idKey = () => `${$('userId').value.trim()}|${$('zoneId').value.trim()}`;
  const gameNameValid = () => $('gameName').value.trim().length > 0;
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
    if (state.catalog.verifiesPlayer) return state.player && state.checkedKey === idKey() && gameNameValid();
    return idsValid() && $('confirmId').checked && gameNameValid();
  }

  function update() {
    const uid = $('userId').value.trim();
    const zid = $('zoneId').value.trim();
    let who = '—';
    if (state.catalog.verifiesPlayer) {
      if (state.player && state.checkedKey === idKey()) who = `${state.player} (${uid})`;
    } else if (idsValid()) {
      who = (gameNameValid() ? `${$('gameName').value.trim()} · ` : '') + `${uid} (${zid})`;
    }
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

  async function checkPlayer() {
    if (!state.catalog.verifiesPlayer) return;
    const box = $('playerBox');
    const btn = $('checkBtn');
    state.player = null;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const { nickname } = await api('/api/players/lookup', { userId: $('userId').value.trim(), zoneId: $('zoneId').value.trim() });
      state.player = nickname;
      state.checkedKey = idKey();
      box.className = 'player ok';
      box.textContent = `✓ Found: ${nickname}`;
    } catch (e) {
      box.className = 'player err';
      box.textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Check';
      update();
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
        gameName: $('gameName').value.trim(),
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
      if (state.checkedKey !== idKey()) $('playerBox').className = 'player';
      update();
    });
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') checkPlayer(); });
  }
  $('confirmId').addEventListener('change', update);
  $('gameName').addEventListener('input', update);
  $('checkBtn').addEventListener('click', checkPlayer);
  $('buyBtn').addEventListener('click', buy);
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    state.tab = t.dataset.type;
    renderPackages();
  }));

  api('/api/catalog').then((c) => {
    state.catalog = c;
    if (c.verifiesPlayer) $('checkBtn').hidden = false;
    else { $('confirmRow').hidden = false; $('fields').style.gridTemplateColumns = '2fr 1fr'; }
    if (c.support) $('supportLine').textContent = `Help: ${c.support}`;
    renderPackages();
    update();
  }).catch(() => { $('packages').innerHTML = '<p class="hint">Could not load packages. Refresh to try again.</p>'; });
})();

// Floating chat box: buyers message the shop (text + photos) without leaving the page.
(() => {
  const KEY = 'diamondsChatId';
  const store = {
    get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
    set: (v) => { try { localStorage.setItem(KEY, v); } catch {} },
    clear: () => { try { localStorage.removeItem(KEY); } catch {} },
  };

  const state = { chatId: store.get(), open: false, lastId: 0, timer: null, sending: false, image: null };

  // ---- DOM ----------------------------------------------------------------------
  const root = document.createElement('div');
  root.className = 'chat-root';
  root.innerHTML = `
    <button class="chat-fab" type="button" aria-label="Open chat">
      <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>
      <span class="chat-badge" hidden></span>
    </button>
    <section class="chat-panel" hidden aria-label="Chat with the shop">
      <header class="chat-head">
        <div><strong>Chat with us</strong><small class="chat-who"></small></div>
        <button class="chat-close" type="button" aria-label="Close chat">✕</button>
      </header>
      <form class="chat-start" hidden>
        <p>Tell us who you are so we can find your account and payment.</p>
        <label>Game name<input name="gameName" type="text" maxlength="30" required autocomplete="nickname"></label>
        <div class="chat-row">
          <label>User ID<input name="userId" type="text" inputmode="numeric" maxlength="12" required></label>
          <label>Zone ID<input name="zoneId" type="text" inputmode="numeric" maxlength="6" required></label>
        </div>
        <button class="btn block" type="submit">Start chat</button>
        <div class="form-error"></div>
      </form>
      <div class="chat-body" hidden><div class="chat-list" aria-live="polite"></div></div>
      <form class="chat-compose" hidden>
        <div class="chat-attach-preview" hidden><img alt="Photo to send"><button type="button" aria-label="Remove photo">✕</button></div>
        <div class="chat-input-row">
          <label class="chat-photo" title="Send a photo" aria-label="Send a photo">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>
            <input type="file" accept="image/*" hidden>
          </label>
          <textarea rows="1" maxlength="1000" placeholder="Type a message…"></textarea>
          <button class="chat-send" type="submit" aria-label="Send">➤</button>
        </div>
        <div class="form-error"></div>
      </form>
    </section>`;
  document.body.appendChild(root);
  document.body.classList.add('has-chat');

  const q = (s) => root.querySelector(s);
  const fab = q('.chat-fab'), panel = q('.chat-panel'), badge = q('.chat-badge');
  const startForm = q('.chat-start'), body = q('.chat-body'), list = q('.chat-list');
  const compose = q('.chat-compose'), textarea = compose.querySelector('textarea');
  const fileInput = compose.querySelector('input[type=file]'), preview = q('.chat-attach-preview');

  // ---- API ----------------------------------------------------------------------
  async function api(path, payload) {
    const res = await fetch(path, {
      method: payload ? 'POST' : 'GET',
      headers: payload ? { 'Content-Type': 'application/json' } : {},
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || 'Something went wrong'); e.status = res.status; throw e; }
    return data;
  }

  // ---- Rendering ----------------------------------------------------------------
  function fmtTime(iso) {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return d.toLocaleString([], today ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function addMessage(m) {
    if (list.querySelector(`[data-id="${m.id}"]`)) return;
    const row = document.createElement('div');
    row.className = 'chat-msg ' + m.from;
    row.dataset.id = m.id;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (m.image) {
      const a = document.createElement('a');
      a.href = m.image; a.target = '_blank'; a.rel = 'noopener';
      const img = document.createElement('img');
      img.src = m.image; img.alt = 'Photo'; img.loading = 'lazy';
      img.addEventListener('load', scrollDown);
      a.append(img);
      bubble.append(a);
    }
    if (m.text) {
      const t = document.createElement('div');
      t.className = 'text';
      t.textContent = m.text;
      bubble.append(t);
    }
    const time = document.createElement('time');
    time.textContent = (m.from === 'admin' ? 'Shop · ' : '') + fmtTime(m.at);
    bubble.append(time);
    row.append(bubble);
    list.append(row);
    state.lastId = Math.max(state.lastId, m.id);
  }

  function scrollDown() { body.scrollTop = body.scrollHeight; }

  function showUnread(n) {
    badge.hidden = !n || state.open;
    badge.textContent = n > 9 ? '9+' : String(n);
  }

  function renderMode() {
    const hasChat = Boolean(state.chatId);
    startForm.hidden = hasChat;
    body.hidden = !hasChat;
    compose.hidden = !hasChat;
    if (!hasChat) {
      // Prefill from the storefront form when the buyer already typed their ID.
      for (const [name, id] of [['userId', 'userId'], ['zoneId', 'zoneId'], ['gameName', 'gameName']]) {
        const src = document.getElementById(id);
        if (src && src.value && !startForm.elements[name].value) startForm.elements[name].value = src.value;
      }
    }
  }

  function welcome() {
    if (list.children.length) return;
    const w = document.createElement('div');
    w.className = 'chat-msg system';
    w.innerHTML = '<div class="bubble"><div class="text">Hi! Send us a message or a photo of your payment receipt. We usually reply within a few minutes.</div></div>';
    list.append(w);
  }

  // ---- Sync ---------------------------------------------------------------------
  async function poll() {
    if (!state.chatId) return;
    try {
      const c = await api(`/api/chats/${encodeURIComponent(state.chatId)}?after=${state.lastId}${state.open ? '&read=1' : ''}`);
      q('.chat-who').textContent = `${c.gameName} · ${c.userId} (${c.zoneId})`;
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
      welcome();
      c.messages.forEach(addMessage);
      if (c.messages.length && (atBottom || state.firstLoad)) scrollDown();
      state.firstLoad = false;
      showUnread(state.open ? 0 : c.unread);
    } catch (e) {
      if (e.status === 404) { store.clear(); state.chatId = null; renderMode(); }
    }
  }

  function schedule() {
    clearTimeout(state.timer);
    if (!state.chatId) return;
    state.timer = setTimeout(async () => { await poll(); schedule(); }, state.open ? 4000 : 20000);
  }

  function setOpen(open) {
    state.open = open;
    panel.hidden = !open;
    fab.hidden = open;
    if (open) {
      renderMode();
      state.firstLoad = true;
      poll().then(() => { scrollDown(); showUnread(0); });
      if (state.chatId) setTimeout(() => textarea.focus(), 50);
    }
    schedule();
  }

  // ---- Events -------------------------------------------------------------------
  fab.addEventListener('click', () => setOpen(true));
  q('.chat-close').addEventListener('click', () => setOpen(false));

  startForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = startForm.querySelector('.form-error');
    err.textContent = '';
    try {
      const c = await api('/api/chats', {
        gameName: startForm.elements.gameName.value.trim(),
        userId: startForm.elements.userId.value.trim(),
        zoneId: startForm.elements.zoneId.value.trim(),
      });
      attach(c.id);
      renderMode();
      poll();
      textarea.focus();
    } catch (ex) { err.textContent = ex.message; }
  });
  for (const n of ['userId', 'zoneId']) {
    startForm.elements[n].addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, ''); });
  }

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    try {
      state.image = await window.compressImage(f);
      preview.querySelector('img').src = state.image;
      preview.hidden = false;
      textarea.focus();
    } catch { compose.querySelector('.form-error').textContent = 'Could not read that photo.'; }
  });
  preview.querySelector('button').addEventListener('click', () => { state.image = null; preview.hidden = true; });

  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); compose.requestSubmit(); }
  });

  compose.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.sending) return;
    const text = textarea.value.trim();
    if (!text && !state.image) return;
    const err = compose.querySelector('.form-error');
    err.textContent = '';
    state.sending = true;
    compose.classList.add('sending');
    try {
      const m = await api(`/api/chats/${encodeURIComponent(state.chatId)}/messages`, { text, image: state.image });
      textarea.value = '';
      textarea.style.height = 'auto';
      state.image = null;
      preview.hidden = true;
      addMessage(m);
      scrollDown();
      // A photo can be the payment receipt: the server then marks the order as paid-pending-check.
      if (m.image) setTimeout(() => { poll(); resumePending({ force: true }); }, 300);
    } catch (ex) { err.textContent = ex.message; }
    state.sending = false;
    compose.classList.remove('sending');
  });

  // ---- "I have paid" card -------------------------------------------------------
  // Remembers an unpaid order. When the buyer comes back from their banking app
  // (or reopens the site later), the chat opens with a one-tap "I have paid" card.
  const PENDING_KEY = 'somaPendingOrder';
  const pending = {
    get: () => { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch { return null; } },
    set: (v) => { try { localStorage.setItem(PENDING_KEY, JSON.stringify(v)); } catch {} },
    clear: () => { try { localStorage.removeItem(PENDING_KEY); } catch {} },
  };
  const money = (n) => (window.formatMoney ? window.formatMoney(n) : `Nu. ${n}`);
  let card = null;

  function trackPending(order) {
    const prev = pending.get();
    pending.set({ id: order.id, amount: order.amount, item: order.item, chatId: order.chatId, leftAt: prev && prev.id === order.id ? prev.leftAt : null });
  }

  function markLeft() {
    const p = pending.get();
    if (p && !p.leftAt) pending.set({ ...p, leftAt: Date.now() });
  }

  function hidePaymentCard() {
    if (card) card.remove();
    card = null;
  }

  function showPaymentCard(p) {
    if (p.chatId) attach(p.chatId);
    setOpen(true);
    if (card) return;
    card = document.createElement('div');
    card.className = 'chat-paycard';
    card.innerHTML = `
      <strong class="pc-title"></strong>
      <p class="pc-sub">Send us your receipt and we will send your diamonds to your game account.</p>
      <label class="file-drop pc-drop"><span class="pc-drop-text">📷 Attach receipt screenshot</span><input type="file" accept="image/*" hidden></label>
      <input class="pc-ref" type="text" maxlength="40" placeholder="Journal no. (optional)" autocomplete="off">
      <button class="btn block pc-paid" type="button">✅ I have paid</button>
      <div class="form-error pc-err"></div>
      <div class="pc-links"><a class="pc-qr" href="#">Not paid yet? Show the QR again</a> · <a class="pc-cancel" href="#">Cancel order</a></div>`;
    card.querySelector('.pc-title').textContent = `💳 Did you pay ${money(p.amount)} for ${p.item}?`;
    card.querySelector('.pc-qr').href = `/pay.html?id=${encodeURIComponent(p.id)}`;
    let shot = null;
    const fileIn = card.querySelector('input[type=file]');
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0];
      if (!f) return;
      try {
        shot = await window.compressImage(f);
        const drop = card.querySelector('.pc-drop');
        drop.querySelector('img')?.remove();
        const img = new Image();
        img.src = shot; img.alt = 'Receipt';
        drop.prepend(img);
        card.querySelector('.pc-drop-text').textContent = 'Tap to change';
      } catch { card.querySelector('.pc-err').textContent = 'Could not read that photo.'; }
    });
    card.querySelector('.pc-cancel').addEventListener('click', (e) => {
      e.preventDefault();
      pending.clear();
      hidePaymentCard();
    });
    card.querySelector('.pc-paid').addEventListener('click', async () => {
      const btn = card.querySelector('.pc-paid');
      const err = card.querySelector('.pc-err');
      const txnRef = card.querySelector('.pc-ref').value.trim();
      err.textContent = '';
      if (!shot && !txnRef) { err.textContent = 'Please attach a screenshot of your payment receipt.'; return; }
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        await api(`/api/orders/${encodeURIComponent(p.id)}/payment-proof`, { txnRef, screenshot: shot });
        pending.clear();
        hidePaymentCard();
        await poll();
        scrollDown();
        if (window.onPaymentSubmitted) window.onPaymentSubmitted(p.id);
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
        btn.textContent = '✅ I have paid';
        if (ex.status === 409) { pending.clear(); setTimeout(hidePaymentCard, 2500); }
      }
    });
    panel.insertBefore(card, compose);
  }

  // Ask the server whether the remembered order still needs payment; if so, show the card.
  async function resumePending({ force = false } = {}) {
    const p = pending.get();
    if (!p || (!p.leftAt && !force)) return false;
    if (Date.now() - (p.leftAt || Date.now()) > 3 * 24 * 3600 * 1000) { pending.clear(); return false; }
    try {
      const o = await api(`/api/orders/${encodeURIComponent(p.id)}`);
      if (o.status !== 'pending_payment') { pending.clear(); hidePaymentCard(); return false; }
      showPaymentCard({ ...p, amount: o.amount, item: o.item, chatId: o.chatId || p.chatId });
      return true;
    } catch (e) {
      if (e.status === 404) pending.clear();
      return false;
    }
  }

  // Leaving the page (switching to the bank app, or closing the tab) marks the order as "went to pay".
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) markLeft();
    else resumePending();
  });
  window.addEventListener('pagehide', markLeft);

  // ---- Public API ---------------------------------------------------------------
  function attach(chatId) {
    if (!chatId) return;
    if (chatId !== state.chatId) { list.innerHTML = ''; state.lastId = 0; }
    state.chatId = chatId;
    store.set(chatId);
    schedule();
  }

  window.Chat = {
    attach,
    open: () => setOpen(true),
    id: () => state.chatId,
    trackPending,
    clearPending: () => { pending.clear(); hidePaymentCard(); },
    askForPayment: () => resumePending({ force: true }),
  };

  if (state.chatId) poll().then(schedule);
  // Reopened the site after going to pay: jump straight to the "I have paid" card.
  resumePending();
})();

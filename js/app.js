/**
 * app.js — controller and views.
 *
 * Every piece of user text reaches the page through textContent, never
 * innerHTML. The only innerHTML in this file is static icon markup and
 * SVG built from numbers.
 *
 * Nothing readable leaves this browser. Entries, settings and tab names
 * are sealed with vault.js before any request; the worker only routes.
 */
(() => {
  const $ = id => document.getElementById(id);
  // https only, except a local worker during development.
  const okUrl = u => /^https:\/\/[^\s]+$/.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u);

  // ── tiny DOM builder ─────────────────────────────────────────────────
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;            // static markup only
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const ICON = {
    mark: '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="12" fill="none" style="stroke:var(--cold)" stroke-width="3.5"/><path d="M16 16 L22 8" style="stroke:var(--warm)" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="16" r="2.5" style="fill:var(--ink)"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    eye:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    drop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/></svg>',
  };
  const icon = (name, cls) => h('span', { class: cls, html: ICON[name], style: 'display:inline-flex' });

  // ── state ────────────────────────────────────────────────────────────
  const S = {
    me: null,           // { id, displayName, wrappedDataKey, hasGoogle }
    dataKey: null,      // this person's data key (CryptoKey)
    forecasts: [],      // decorated: key, label, relation, cycleLength, ...
    active: null,
    raw: {},            // fid → Map(id → entry as the server sent it)
    cursor: {},
    gConfig: null,
  };
  const activeForecast = () => S.forecasts.find(f => f.id === S.active);

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3400);
  }
  function uid(n = 12) {
    const b = crypto.getRandomValues(new Uint8Array(n));
    return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function busy(btn, fn) {
    btn.disabled = true;
    try { return await fn(); }
    catch (e) { console.error(e); toast(e.message || 'Something went wrong'); }
    finally { btn.disabled = false; }
  }
  const check = (label) => {
    const box = h('input', { type: 'checkbox' });
    const row = h('label', { class: 'row small check' }, box, h('span', { text: label }));
    row.checked = () => box.checked;
    return row;
  };
  const cleanUrl = () => history.replaceState(null, '', location.pathname);

  // ── decrypting what the worker sends ─────────────────────────────────
  const DEFAULT_SHARED = { cycleLength: 28, periodLength: 5, asksDesire: false };

  async function decorate(f) {
    const k = S.dataKey && f.wrappedKey ? await Vault.unwrapForecast(S.dataKey, f.wrappedKey, f.id, f.kcv) : null;
    let shared = { ...DEFAULT_SHARED };
    if (k && f.sharedEnc) { try { shared = { ...shared, ...await Vault.open(k.key, f.sharedEnc, `shared:${f.id}`) }; } catch {} }
    let own = { label: 'Forecast', relation: 'partner' };
    if (f.role === 'owner' && f.ownerEnc) { try { own = { ...own, ...await Vault.open(S.dataKey, f.ownerEnc, `owner:${f.id}`) }; } catch {} }
    return Object.assign(f, { key: k, locked: !k, ...shared, ...(f.role === 'owner' ? own : {}) });
  }

  async function decryptEntry(f, e) {
    if (e.deleted) return e;
    const key = e.keyRef === 'a' ? S.dataKey : f.key?.key;
    try {
      const p = await Vault.open(key, e.ct, `${f.id}:${e.id}`);
      return { ...e, kind: p.kind, date: p.date, body: p.body ?? null, fields: p.fields || {} };
    } catch { return { ...e, unreadable: true }; }
  }

  // Decrypted view of a forecast. Cached per server entry, since entries
  // never change once written.
  const plainCache = new Map();
  async function plainEntries(f) {
    const out = [];
    for (const e of S.raw[f.id]?.values() || []) {
      if (!plainCache.has(e.id)) plainCache.set(e.id, await decryptEntry(f, e));
      out.push(plainCache.get(e.id));
    }
    const resolved = resolveEntries(out);
    return { entries: resolved.filter(e => !e.unreadable), unreadable: resolved.filter(e => e.unreadable).length };
  }

  const authorName = (f, e) => e.authorId === S.me.id ? 'You'
    : e.authorRole === 'owner' ? f.ownerName : (f.subjectName || 'Her');

  async function writeEntry(f, payload, visibility) {
    const id = uid();
    const privateEntry = visibility === 'private';
    const key = privateEntry ? S.dataKey : f.key.key;
    const ct = await Vault.seal(key, payload, `${f.id}:${id}`);
    await save(f.id, [{ id, visibility, keyRef: privateEntry ? 'a' : 'f', ct }]);
  }
  const deleteEntry = (f, e) => save(f.id, [{ id: uid(), visibility: e.visibility, supersedes: e.id, deleted: true }]);

  // ── boot ─────────────────────────────────────────────────────────────
  async function boot() {
    const q = new URLSearchParams(location.search);
    const frag = new URLSearchParams(location.hash.slice(1));
    const pending = {
      invite: q.get('invite'), unlock: q.get('unlock'), k: frag.get('k'),
    };

    let base = Local.get('worker');
    const fromLink = q.get('w');
    if (!base && fromLink && okUrl(fromLink)) { base = fromLink; Local.set('worker', base); }
    if (base) Api.setBase(base);
    Api.setSession(Local.get('session'));

    if (!base) return gateWorker(() => route(pending));
    route(pending);
  }

  async function route(pending) {
    if (pending.invite) return gateJoin(pending.invite, pending.k);
    if (!Local.get('session')) return gateSignIn();
    try {
      const me = await Api.me();
      S.me = me.person;
      S.dataKey = await Vault.loadDataKey(S.me.id);
      if (!S.dataKey) return gateUnlock(() => enterApp(me.forecasts, pending));
      await enterApp(me.forecasts, pending);
    } catch (e) {
      if (e.status === 401) { Local.set('session', ''); return gateSignIn(); }
      showGate(h('div', { class: 'gate-card sheet' },
        ...gateHeader('Can\u2019t reach Forecast', e.message),
        h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Try again')));
    }
  }

  function showGate(card) {
    $('app').hidden = true;
    const g = $('gate');
    g.replaceChildren(card);
    g.hidden = false;
    window.scrollTo(0, 0);
  }
  function gateHeader(title, sub) {
    return [h('span', { class: 'gate-mark', html: ICON.mark }), h('h1', { text: title }), sub ? h('p', { class: 'muted', text: sub }) : null];
  }
  const backLink = () => h('button', { class: 'linky', type: 'button', onclick: gateSignIn }, 'Back');

  // ── gate: worker address ─────────────────────────────────────────────
  function gateWorker(next) {
    const input = h('input', { type: 'url', placeholder: 'https://your-worker.workers.dev', autocomplete: 'off', spellcheck: 'false', inputmode: 'url' });
    const go = h('button', { class: 'btn', type: 'button' }, 'Connect');
    go.onclick = () => busy(go, async () => {
      const url = input.value.trim().replace(/\/+$/, '');
      if (!okUrl(url)) return toast('Enter the full https:// address.');
      if (!(await Api.ping(url))) return toast('That address did not answer as a Forecast worker.');
      Local.set('worker', url);
      Api.setBase(url);
      next();
    });
    showGate(h('div', { class: 'gate-card sheet' },
      ...gateHeader('Forecast', 'A shared cycle forecast for the people you choose.'),
      h('label', { class: 'field-group' }, h('span', { class: 'field-name', text: 'Sync address' }), input),
      go,
      h('p', { class: 'small muted', text: 'This is the worker address whoever set up Forecast gave you. It is stored on this device only.' })));
  }

  // ── gate: sign in ────────────────────────────────────────────────────
  function gateSignIn() {
    const gbox = h('div');
    showGate(h('div', { class: 'gate-card sheet' },
      ...gateHeader('Forecast', 'A shared cycle forecast for the people you choose.'),
      gbox,
      h('button', { class: 'btn', type: 'button', onclick: () => gateSignup() }, 'Create an account'),
      h('button', { class: 'btn quiet', type: 'button', onclick: gateRecover }, 'Sign in with a recovery key'),
      h('button', { class: 'btn quiet', type: 'button', onclick: gatePasteInvite }, 'I have an invite link'),
      h('button', { class: 'linky', type: 'button', onclick: () => { Local.set('worker', ''); location.reload(); } }, 'Use a different sync address')));
    renderGoogle(gbox, 'signin');
  }

  function nicknameField() {
    return h('input', { type: 'text', placeholder: 'A nickname, not your full name', autocomplete: 'nickname', maxlength: 24 });
  }

  // ── gate: create account ─────────────────────────────────────────────
  // `google` is an ID token from a Google sign-in that matched no account.
  async function gateSignup(google = null) {
    const nick = nicknameField();
    const adult = check('I\u2019m 18 or older');
    const ts = h('div');
    const go = h('button', { class: 'btn', type: 'button' }, 'Create account');
    showGate(h('div', { class: 'gate-card sheet' },
      ...gateHeader('Create an account', google
        ? 'That Google account isn\u2019t set up yet. Pick a nickname and it will be linked to your new account.'
        : 'Just a nickname. No email, no full name.'),
      h('label', { class: 'field-group' }, h('span', { class: 'field-name', text: 'Nickname' }), nick),
      adult, ts, go,
      h('p', { class: 'small muted', text: 'Invited by someone? Use their invite link instead.' }),
      backLink()));
    const token = await renderTurnstile(ts);

    go.onclick = () => busy(go, async () => {
      if (!nick.value.trim()) return toast('Choose a nickname.');
      if (!adult.checked()) return toast('Forecast is for adults 18 and over.');
      const id = await Vault.newIdentity();
      const r = await Api.signup({
        displayName: nick.value.trim(), loginSecret: id.loginSecret, wrappedDataKey: id.wrappedDataKey,
        adult: true, turnstileToken: token(), idToken: google || undefined,
      });
      await Vault.saveDataKey(r.person.id, id.dataKey);
      Local.set('session', r.sessionId);
      Api.setSession(r.sessionId);
      gateShowRecovery(id.recoveryText, () => route({}));
    });
  }

  // ── gate: show a recovery key once ───────────────────────────────────
  function gateShowRecovery(text, next, intro) {
    const saved = check('I\u2019ve saved my recovery key somewhere safe');
    const go = h('button', { class: 'btn', type: 'button' }, 'Continue');
    go.onclick = () => { if (!saved.checked()) return toast('Save your recovery key first.'); next(); };
    showGate(h('div', { class: 'gate-card sheet' },
      ...gateHeader('Your recovery key', intro || 'This is the only way back into your account on a new device. Nobody else has a copy, including whoever runs this site, so it can\u2019t be reset for you.'),
      h('p', { class: 'recovery', text: text }),
      h('div', { class: 'row' },
        h('button', { class: 'btn quiet', type: 'button', onclick: async () => {
          try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Select the key and copy it'); }
        } }, 'Copy'),
        h('button', { class: 'btn quiet', type: 'button', onclick: () => download('forecast-recovery-key.txt',
          `Forecast recovery key\n\n${text}\n\nKeep this private. Anyone with it can open your account.\n`, 'text/plain') }, 'Download')),
      h('p', { class: 'small muted', text: 'A password manager is a good place for it.' }),
      saved, go));
  }

  function download(name, text, type = 'application/json') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ── gate: sign in with a recovery key ────────────────────────────────
  function gateRecover() {
    const input = h('textarea', { placeholder: 'XXXX-XXXX-XXXX-…', spellcheck: 'false', autocomplete: 'off', rows: 3, class: 'mono' });
    const go = h('button', { class: 'btn', type: 'button' }, 'Sign in');
    go.onclick = () => busy(go, async () => {
      const d = await Vault.fromRecoveryText(input.value);
      if (!d) return toast('That isn\u2019t a complete recovery key.');
      const r = await Api.recover(d.loginSecret);
      const key = await d.unwrap(r.person.wrappedDataKey);
      if (!key) return toast('That key didn\u2019t unlock the account.');
      await Vault.saveDataKey(r.person.id, key);
      Local.set('session', r.sessionId);
      Api.setSession(r.sessionId);
      route({});
    });
    showGate(h('div', { class: 'gate-card sheet' },
      ...gateHeader('Sign in with your recovery key'),
      input, go, backLink()));
  }

  // ── gate: signed in, but this device has no data key ─────────────────
  function gateUnlock(next) {
    const input = h('textarea', { placeholder: 'XXXX-XXXX-XXXX-…', spellcheck: 'false', autocomplete: 'off', rows: 3, class: 'mono' });
    const go = h('button', { class: 'btn', type: 'button' }, 'Unlock');
    go.onclick = () => busy(go, async () => {
      const d = await Vault.fromRecoveryText(input.value);
      const key = d && await d.unwrap(S.me.wrappedDataKey);
      if (!key) return toast('That recovery key doesn\u2019t match this account.');
      await Vault.saveDataKey(S.me.id, key);
      S.dataKey = key;
      next();
    });
    const lost = h('button', { class: 'linky', type: 'button' }, 'I lost my recovery key');
    lost.onclick = () => busy(lost, async () => {
      if (!confirm('This makes a new recovery key and a new data key. Your private notes become permanently unreadable, and each shared forecast stays locked until the other person sends you an unlock link. Continue?')) return;
      const id = await Vault.newIdentity();
      const r = await Api.rekey({ loginSecret: id.loginSecret, wrappedDataKey: id.wrappedDataKey });
      S.me = r.person;
      await Vault.saveDataKey(S.me.id, id.dataKey);
      S.dataKey = id.dataKey;
      gateShowRecovery(id.recoveryText, next, 'Your new recovery key. The old one no longer works.');
    });
    showGate(h('div', { class: 'gate-card sheet' },
      ...gateHeader(`Welcome back, ${S.me.displayName}`, 'Enter your recovery key to unlock your forecasts on this device.'),
      input, go, lost,
      h('button', { class: 'linky', type: 'button', onclick: signOut }, 'Sign out')));
  }

  function gatePasteInvite() {
    const input = h('input', { type: 'text', placeholder: 'Paste the whole link', spellcheck: 'false' });
    const go = h('button', { class: 'btn', type: 'button' }, 'Continue');
    go.onclick = () => {
      let u;
      try { u = new URL(input.value.trim()); } catch { return toast('Paste the complete link, starting with https.'); }
      const token = u.searchParams.get('invite');
      if (!token) return toast('That doesn\u2019t look like an invite link.');
      const w = u.searchParams.get('w');
      if (w && !Api.getBase() && okUrl(w)) { Local.set('worker', w); Api.setBase(w); }
      gateJoin(token, new URLSearchParams(u.hash.slice(1)).get('k'));
    };
    showGate(h('div', { class: 'gate-card sheet' }, ...gateHeader('Join with an invite'), input, go, backLink()));
  }

  // ── gate: join from an invite ────────────────────────────────────────
  async function gateJoin(token, kText) {
    const fail = (title, msg) => showGate(h('div', { class: 'gate-card sheet' },
      ...gateHeader(title, msg),
      h('button', { class: 'btn quiet', type: 'button', onclick: () => { cleanUrl(); gateSignIn(); } }, 'Go to sign in')));

    let preview;
    try { preview = await Api.invitePreview(token); }
    catch (e) { return fail('This invite can\u2019t be used', `${e.message}. Ask whoever sent it for a new link.`); }

    const raw = Vault.parseFragmentKey(kText);
    const fk = raw && await Vault.forecastFromRaw(raw, preview.forecastId, preview.kcv);
    if (!fk) return fail('This link is incomplete', 'Part of the link is missing or changed, often because a messaging app cut it off. Ask for it to be sent again, ideally by copy and paste.');

    // Already signed in here? Attach to that account, after unlocking it.
    let me = null;
    if (Local.get('session')) { try { me = await Api.me(); } catch {} }
    if (me) {
      S.me = me.person;
      S.dataKey = await Vault.loadDataKey(S.me.id);
      if (!S.dataKey) return gateUnlock(() => gateJoin(token, kText));
    }

    const owner = preview.ownerName;
    const nick = nicknameField();
    const adult = check('I\u2019m 18 or older');
    const go = h('button', { class: 'btn', type: 'button' }, 'Accept invite');
    const start = h('input', { type: 'date', max: Dates.today() });

    go.onclick = () => busy(go, async () => {
      if (!me && !nick.value.trim()) return toast('Choose a nickname.');
      if (!adult.checked()) return toast('Forecast is for adults 18 and over.');
      let r, id = null;
      if (me) {
        r = await Api.redeem({ inviteToken: token, adult: true,
          wrappedKey: await Vault.wrapForecast(S.dataKey, raw, preview.forecastId) });
      } else {
        id = await Vault.newIdentity();
        r = await Api.redeem({ inviteToken: token, adult: true,
          wrappedKey: await Vault.wrapForecast(id.dataKey, raw, preview.forecastId),
          signup: { displayName: nick.value.trim(), loginSecret: id.loginSecret, wrappedDataKey: id.wrappedDataKey } });
        await Vault.saveDataKey(r.person.id, id.dataKey);
        S.dataKey = id.dataKey;
      }
      S.me = r.person;
      Local.set('session', r.sessionId);
      Api.setSession(r.sessionId);
      Local.set('tab', r.forecastId);
      cleanUrl();
      if (start.value) {
        const f = { id: r.forecastId, key: fk };
        const eid = uid();
        await Api.write(f.id, [{ id: eid, visibility: 'shared', keyRef: 'f',
          ct: await Vault.seal(fk.key, { kind: 'period', date: start.value }, `${f.id}:${eid}`) }]);
      }
      if (id) gateShowRecovery(id.recoveryText, () => route({}));
      else route({});
    });

    showGate(h('div', { class: 'gate-card sheet' },
      ...gateHeader(`${owner} invited you`, 'Forecast estimates where you are in your cycle and lets you log how you\u2019re feeling, if you want to.'),
      h('div', { class: 'notice' },
        h('strong', { text: 'What gets shared' }),
        h('ul', {},
          h('li', { text: `${owner} sees your period start dates and anything you mark Shared.` }),
          h('li', { text: 'Anything you mark Only me is encrypted so only you can read it.' }),
          h('li', { text: `${owner} can also keep private notes you won\u2019t see.` }),
          h('li', { text: `You can stop sharing at any time, and erase what you shared. ${owner} isn\u2019t notified.` }),
          h('li', { text: 'Everything is end-to-end encrypted. Whoever runs this site can\u2019t read it.' }))),
      me ? h('p', { text: `You\u2019ll join as ${S.me.displayName}.` })
         : h('label', { class: 'field-group' }, h('span', { class: 'field-name', text: 'Nickname' }), nick),
      h('label', { class: 'field-group' }, h('span', { class: 'field-name', text: 'First day of your last period (optional)' }), start),
      adult, go,
      h('p', { class: 'small muted', text: 'Cycle predictions are estimates. They are not medical advice or birth control.' })));
  }

  // ── Google and Turnstile ─────────────────────────────────────────────
  async function config() {
    try { return S.gConfig ||= await Api.config(); } catch { return {}; }
  }
  function loadScript(src) {
    return new Promise(res => {
      if ([...document.scripts].some(s => s.src === src)) return res();
      const s = h('script', { src, async: true });
      s.onload = res; s.onerror = res;
      document.head.append(s);
    });
  }

  async function renderGoogle(host, mode) {
    const cfg = await config();
    if (!cfg.googleEnabled) return;
    await loadScript('https://accounts.google.com/gsi/client');
    if (!window.google?.accounts?.id) return;
    google.accounts.id.initialize({
      client_id: cfg.googleClientId,
      callback: async ({ credential }) => {
        try {
          if (mode === 'link') {
            const r = await Api.googleLink(credential);
            S.me = r.person;
            toast('Google linked. You can use it to sign in on another device.');
            closePanel();
            return;
          }
          try {
            const r = await Api.google(credential);
            Local.set('session', r.sessionId);
            Api.setSession(r.sessionId);
            route({});
          } catch (e) {
            if (e.status === 404) return gateSignup(credential);
            throw e;
          }
        } catch (e) { toast(e.message); }
      },
    });
    // Google's button is an iframe capped at 400px wide, so it can't stretch
    // like the other buttons. Fill the row where it fits (phones) and
    // center it where it doesn't.
    host.classList.add('gbtn');
    await new Promise(requestAnimationFrame);
    const width = Math.round(Math.min(400, Math.max(200, host.clientWidth || 300)));
    google.accounts.id.renderButton(host, { theme: 'outline', size: 'large', width, text: mode === 'link' ? 'signin_with' : 'continue_with' });
  }

  // Returns a function that yields the current token ('' when Turnstile is
  // not configured on the worker).
  async function renderTurnstile(host) {
    let token = '';
    const cfg = await config();
    if (!cfg.turnstileSiteKey) return () => token;
    await loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
    if (window.turnstile) {
      window.turnstile.render(host, {
        sitekey: cfg.turnstileSiteKey,
        callback: t => { token = t; },
        'expired-callback': () => { token = ''; },
      });
    }
    return () => token;
  }

  // ── app ──────────────────────────────────────────────────────────────
  async function enterApp(forecasts, pending = {}) {
    S.forecasts = [];
    for (const f of forecasts) S.forecasts.push(await decorate(f));

    if (pending.unlock) await applyUnlockLink(pending.unlock, pending.k);

    const saved = S.active || Local.get('tab');
    S.active = S.forecasts.some(f => f.id === saved) ? saved : S.forecasts[0]?.id || null;

    $('gate').hidden = true;
    $('app').hidden = false;
    $('brand').replaceChildren(h('span', { html: ICON.mark, style: 'display:inline-flex' }), 'Forecast');
    $('settingsBtn').innerHTML = ICON.gear;
    $('settingsBtn').onclick = openSettings;
    renderTabs();
    if (S.active) await refresh(S.active, true);
    await render();
  }

  // An unlock link carries a forecast key for a member whose device lost
  // it. It only works for someone who is already a member.
  async function applyUnlockLink(fid, kText) {
    cleanUrl();
    const f = S.forecasts.find(x => x.id === fid);
    const raw = Vault.parseFragmentKey(kText);
    if (!f) return toast('That unlock link is for a forecast you aren\u2019t part of.');
    const fk = raw && await Vault.forecastFromRaw(raw, f.id, f.kcv);
    if (!fk) return toast('That unlock link is incomplete or doesn\u2019t match.');
    await Api.putKey(f.id, await Vault.wrapForecast(S.dataKey, raw, f.id));
    f.wrappedKey = await Vault.wrapForecast(S.dataKey, raw, f.id);
    await decorate(f);
    S.active = f.id; Local.set('tab', f.id);
    toast('Forecast unlocked on this device');
  }

  const tabName = f => f.role === 'owner' ? f.label : `Shared with ${f.ownerName}`;

  function renderTabs() {
    const tabs = S.forecasts.map(f => h('button', {
      class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(f.id === S.active),
      onclick: async () => {
        S.active = f.id; Local.set('tab', f.id);
        renderTabs(); await render();
        await refresh(f.id, !S.raw[f.id]);
        await render();
      },
    }, tabName(f),
       f.locked ? h('span', { class: 'tag', text: 'locked' })
       : f.role === 'owner' && !f.subjectId ? h('span', { class: 'tag', text: 'invite' }) : null));
    tabs.push(h('button', { class: 'tab', type: 'button', 'aria-label': 'Add a forecast', onclick: openNewForecast }, '+ Add'));
    $('tabs').replaceChildren(...tabs);
  }

  async function refresh(fid, full) {
    const f = S.forecasts.find(x => x.id === fid);
    if (!f || f.locked) return;
    if (full || !S.raw[fid]) { S.raw[fid] = new Map(); S.cursor[fid] = ''; }
    let since = S.cursor[fid] ? String(Math.max(0, +S.cursor[fid] - 300000)).padStart(13, '0') : '';
    for (let page = 0; page < 20; page++) {
      const r = await Api.sync(fid, since);
      for (const e of r.entries) S.raw[fid].set(e.id, e);
      if (r.cursor) S.cursor[fid] = r.cursor;
      if (!r.more) break;
      since = r.cursor;
    }
  }

  async function save(fid, entries) {
    const r = await Api.write(fid, entries);
    for (const e of r.written) S.raw[fid].set(e.id, e);
    await render();
  }

  // ── render ───────────────────────────────────────────────────────────
  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    const f = activeForecast();
    let kids;
    if (!f) kids = [emptyState()];
    else if (f.locked) kids = [lockedView(f)];
    else {
      const { entries, unreadable } = await plainEntries(f);
      kids = f.role === 'owner' ? ownerView(f, entries) : subjectView(f, entries);
      if (unreadable) kids.push(h('p', { class: 'small muted', style: 'text-align:center',
        text: `${unreadable} older ${unreadable === 1 ? 'entry was' : 'entries were'} sealed with a key this device no longer has.` }));
    }
    if (seq === renderSeq) $('main').replaceChildren(...kids);
  }

  function emptyState() {
    return h('section', { class: 'sheet' },
      h('h2', { text: 'Start your first forecast' }),
      h('p', { class: 'muted', text: 'Each forecast is one person. Create one and send her the invite link. When she accepts, she can set day one of her cycle and log how she\u2019s feeling.' }),
      h('button', { class: 'btn', type: 'button', onclick: openNewForecast }, 'Create a forecast'));
  }

  function lockedView(f) {
    const other = f.role === 'owner' ? f.subjectName : f.ownerName;
    return h('section', { class: 'sheet' },
      h('h2', { text: 'Locked on this device' }),
      h('p', { class: 'muted', text: other
        ? `This forecast was sealed with a key this account no longer has. Ask ${other} to send you an unlock link from Settings.`
        : 'This forecast was sealed with a key this account no longer has, and nobody else holds it. You can delete it from Settings and start a new one.' }));
  }

  function cycleOf(f, entries) {
    return Cycle.compute(entries.filter(e => e.kind === 'period').map(e => e.date), f);
  }

  // ── owner ────────────────────────────────────────────────────────────
  function ownerView(f, entries) {
    const cycle = cycleOf(f, entries);
    const today = Dates.today();
    const readings = readingsFor(entries, today, f.subjectId);
    const herName = f.subjectName || f.label;
    const partner = f.relation === 'partner';
    const out = [];

    if (!f.subjectId) out.push(inviteCard(f));
    out.push(hero(cycle, herName));
    const starts = entries.filter(e => e.kind === 'period').map(e => e.date);
    out.push(todayCard(estimateReadings(entries, starts, f, f.subjectId, today), partner, f.subjectId ? 'her' : null, herName,
      trendReadings(entries, starts, f, f.subjectId, today)));

    const adv = Advisory.forOwner({ cycle, readings, relation: f.relation, name: herName, date: today });
    out.push(h('section', { class: 'advisory' + (/Clear|Fair/.test(adv.headline) ? ' fair' : '') },
      h('h2', { text: adv.headline }),
      h('ul', {}, adv.lines.map(l => h('li', { text: l }))),
      h('p', { class: 'motto', text: partner
        ? 'Helping husbands navigate the changing climate of marriage, one hormonal front at a time.'
        : 'Helping you be the one who remembers.' })));

    const other = f.subjectId ? f.subjectName : null;
    out.push(composer(`Log ${herName}\u2019s readings`, readingForm({
      showDesire: partner, otherName: other, defaultVis: 'shared',
      onSave: (fields, body, vis, date) => writeEntry(f, { kind: 'reading', date, fields, body }, vis),
    })));
    out.push(composer('Add a note', noteForm({ otherName: other, defaultVis: 'private',
      onSave: (body, vis, date) => writeEntry(f, { kind: 'note', date, body }, vis) })));
    out.push(composer('Log a period start', periodForm(d => writeEntry(f, { kind: 'period', date: d }, 'shared'))));
    out.push(timeline(f, entries));
    return out;
  }

  function linkWithKey(params, raw) {
    const url = new URL(location.pathname, location.origin);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('w', Api.getBase());
    url.hash = 'k=' + Vault.fragmentKey(raw);
    return url.toString();
  }

  function linkBox(link, note) {
    const field = h('input', { type: 'text', readonly: true, value: link });
    const copy = h('button', { class: 'btn quiet', type: 'button', onclick: async () => {
      try { await navigator.clipboard.writeText(link); toast('Link copied'); }
      catch { field.select(); toast('Select and copy the link'); }
    } }, 'Copy');
    const share = navigator.share ? h('button', { class: 'btn quiet', type: 'button', onclick: async () => {
      try { await navigator.share({ title: 'Forecast', url: link }); } catch {}
    } }, 'Share') : null;
    return h('div', {}, h('div', { class: 'row' }, h('div', { class: 'grow' }, field), copy, share),
      h('p', { class: 'small muted', text: note }));
  }

  function inviteCard(f) {
    const result = h('div');
    const make = h('button', { class: 'btn', type: 'button' }, f.hasPendingInvite ? 'Make a new invite link' : 'Create invite link');
    make.onclick = () => busy(make, async () => {
      const r = await Api.invite(f.id);
      f.hasPendingInvite = true;
      result.replaceChildren(linkBox(linkWithKey({ invite: r.token }, f.key.raw),
        `Works once and expires ${new Date(r.expiresAt).toLocaleDateString()}. The link holds the key to this forecast, so send it only to her. Making a new link cancels this one.`));
      renderTabs();
    });
    return h('section', { class: 'sheet' },
      h('h2', { text: `Invite ${f.label}` }),
      h('p', { class: 'muted', text: 'Send her the link. When she accepts, she can set day one of her cycle and log her own readings. She\u2019ll only ever see her own forecast and the notes you mark Shared.' }),
      f.hasPendingInvite ? h('p', { class: 'small', text: 'An invite is out and hasn\u2019t been accepted yet.' }) : null,
      make, result);
  }

  // ── subject ──────────────────────────────────────────────────────────
  function subjectView(f, entries) {
    const cycle = cycleOf(f, entries);
    const readings = readingsFor(entries, Dates.today(), S.me.id);
    const o = Advisory.forSubject({ cycle });
    return [
      hero(cycle, null),
      h('section', { class: 'sheet' }, h('h2', { text: 'Your outlook' }), ...o.lines.map(l => h('p', { text: l }))),
      (() => { const st = entries.filter(e => e.kind === 'period').map(e => e.date);
        return todayCard(estimateReadings(entries, st, f, S.me.id), f.asksDesire, null, 'You', trendReadings(entries, st, f, S.me.id)); })(),
      composer('Today\u2019s check-in', readingForm({
        showDesire: f.asksDesire, otherName: f.ownerName, defaultVis: 'shared',
        onSave: (fields, body, vis, date) => writeEntry(f, { kind: 'reading', date, fields, body }, vis),
      }), true),
      composer('Add a note', noteForm({ otherName: f.ownerName, defaultVis: 'private',
        onSave: (body, vis, date) => writeEntry(f, { kind: 'note', date, body }, vis) })),
      composer('My period started', periodForm(d => writeEntry(f, { kind: 'period', date: d }, 'shared'))),
      timeline(f, entries),
    ];
  }

  // ── hero dial ────────────────────────────────────────────────────────
  function hero(cycle, name) {
    const text = h('div', { class: 'hero-text' });
    if (cycle) {
      const ph = Cycle.PHASES[cycle.phase];
      const note = Advisory.phaseNote(cycle.phase, !name);
      text.append(
        h('h1', { class: 'phase-name', text: ph.name }),
        h('p', { class: 'phase-note' }, h('strong', { text: note.front + '. ' }), note.meaning),
        h('p', { class: 'muted', text: `Day ${cycle.day} of about ${cycle.length}, since ${Dates.pretty(cycle.start)}` }),
        h('span', { class: 'next' }, icon('drop'),
          cycle.late ? `Predicted ${Dates.pretty(cycle.next)}, ${-cycle.daysToNext} days ago`
                     : `Next period around ${Dates.pretty(cycle.next)}`));
    } else {
      text.append(
        h('h1', { class: 'phase-name', text: 'No cycle data yet' }),
        h('p', { class: 'muted', text: name
          ? `Log a period start, or wait for ${name} to set day one.`
          : 'Log the first day of your last period to start the forecast.' }));
    }
    const legend = h('div', { class: 'legend', 'aria-hidden': 'true' },
      [['--warm', 'Period'], ['--cold', 'Follicular'], ['--sun', 'Ovulation'], ['--occl', 'Luteal']]
        .map(([c, l]) => h('span', {}, h('i', { style: `background:var(${c})` }), l)));
    return h('section', { class: 'hero' }, h('div', {}, h('div', { html: dialSVG(cycle) }), cycle ? legend : null), text);
  }

  function dialSVG(c) {
    const R = 88, cx = 110, cy = 110, W = 20;
    const L = c ? c.length : 28;
    const pt = (day, r = R) => {
      const a = (day / L) * 2 * Math.PI - Math.PI / 2;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    };
    const arc = (from, to, color) => {
      if (to <= from) return '';
      const [x1, y1] = pt(from), [x2, y2] = pt(to);
      const large = (to - from) / L > 0.5 ? 1 : 0;
      return `<path d="M${x1.toFixed(2)} ${y1.toFixed(2)} A${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}" fill="none" style="stroke:var(${color})" stroke-width="${W}"/>`;
    };
    let rings;
    if (c) {
      const P = c.period, ov = c.ovDay;
      rings = arc(0, P, '--warm') + arc(P, ov - 2, '--cold') + arc(ov - 2, ov + 1, '--sun')
            + arc(ov + 1, L - 5, '--occl') + arc(L - 5, L, '--sheet-2');
      // stripe the premenstrual stretch so it reads as "approaching"
      rings += `<path d="${(() => { const [a, b] = pt(L - 5), [x, y] = pt(L); return `M${a.toFixed(2)} ${b.toFixed(2)} A${R} ${R} 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}`; })()}" fill="none" style="stroke:var(--occl)" stroke-width="${W}" stroke-dasharray="3 4"/>`;
    } else {
      rings = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" style="stroke:var(--sheet-2)" stroke-width="${W}"/>`;
    }
    let ticks = '';
    for (let d = 0; d < L; d++) {
      const [x1, y1] = pt(d, R - W / 2 - 3), [x2, y2] = pt(d, R - W / 2 - (d % 7 === 0 ? 10 : 6));
      ticks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" style="stroke:var(--ink-3)" stroke-width="1"/>`;
    }
    let needle = '', center;
    if (c) {
      const pos = Math.min(c.day - 0.5, L - 0.01);
      const deg = (pos / L) * 360;
      needle = `<g class="needle" style="transform-origin:${cx}px ${cy}px;transform:rotate(${deg.toFixed(1)}deg)">
        <path d="M${cx} ${cy - R + W / 2 + 12} L${cx - 6} ${cy - R + W / 2 + 2} L${cx + 6} ${cy - R + W / 2 + 2} Z" style="fill:var(--ink)"/>
        <circle cx="${cx}" cy="${cy - R}" r="9" style="fill:var(--sheet);stroke:var(--ink)" stroke-width="3.5"/></g>`;
      center = `<text x="${cx}" y="${cy - 18}" text-anchor="middle" font-size="13" style="fill:var(--ink-2)">cycle day</text>
        <text x="${cx}" y="${cy + 20}" text-anchor="middle" font-size="48" font-weight="700">${c.day}</text>
        <text x="${cx}" y="${cy + 42}" text-anchor="middle" font-size="13" style="fill:var(--ink-3)">of ~${L}</text>`;
    } else {
      center = `<text x="${cx}" y="${cy + 8}" text-anchor="middle" font-size="22" style="fill:var(--ink-3)">?</text>`;
    }
    return `<svg class="dial" viewBox="0 0 220 220" role="img" aria-label="${c ? `Cycle day ${c.day} of about ${c.length}` : 'No cycle data'}">${rings}${ticks}${center}${needle}</svg>`;
  }

  // ── today's gauges ───────────────────────────────────────────────────
  function gaugeSVG(level, estimate = false) {   // level: 0 low, 1 mid, 2 high, null none
    const seg = (a0, a1, color) => {
      const p = a => [50 + 40 * Math.cos(a), 52 - 40 * Math.sin(a)];
      const [x1, y1] = p(a0), [x2, y2] = p(a1);
      return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A40 40 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" style="stroke:var(${color})" stroke-width="9"/>`;
    };
    const gap = 0.06, t = Math.PI / 3;
    let s = seg(Math.PI, 2 * t + gap, '--warm') + seg(2 * t - gap, t + gap, '--sun') + seg(t - gap, 0, '--calm');
    if (level != null) {
      const a = Math.PI - (level * 2 + 1) * (Math.PI / 6);
      // An estimate gets a dashed, lighter needle; a logged reading a solid one.
      s += `<line x1="50" y1="52" x2="${(50 + 32 * Math.cos(a)).toFixed(1)}" y2="${(52 - 32 * Math.sin(a)).toFixed(1)}" style="stroke:var(${estimate ? '--ink-2' : '--ink'})" stroke-width="3" stroke-linecap="round"${estimate ? ' stroke-dasharray="4 4"' : ''}/>`;
    }
    s += '<circle cx="50" cy="52" r="4" style="fill:var(--ink)"/>';
    return `<svg viewBox="0 0 100 58" aria-hidden="true">${s}</svg>`;
  }

  const LEVEL = { rough: 0, okay: 1, good: 2, red: 0, yellow: 1, green: 2 };

  // est: result of estimateReadings(). herTag is 'her' on the owner's tab
  // once she has joined, so a logged value can say whose read it was.
  const TREND = {
    up:     { arrow: '\u2191', word: 'Rising',  cls: 'up' },
    down:   { arrow: '\u2193', word: 'Dipping', cls: 'down' },
    flat:   { arrow: '\u2192', word: 'Steady',  cls: 'flat' },
    sUp:    { arrow: '\u2197', word: 'Outgoing', cls: 'side' },
    sDown:  { arrow: '\u2198', word: 'Nesting', cls: 'side' },
  };
  function trendChip(field, t) {
    if (!t) return null;
    const k = t.dir === 0 ? 'flat' : field === 'social' ? (t.dir > 0 ? 'sUp' : 'sDown') : (t.dir > 0 ? 'up' : 'down');
    const T = TREND[k];
    return h('div', { class: `trend ${T.cls}`, title: 'Where this is heading over the next few days' },
      h('span', { 'aria-hidden': 'true', text: T.arrow }), h('span', { class: 'sr-hint', text: 'Next few days: ' }), T.word);
  }

  function todayCard(est, showDesire, herTag, name, trends = {}) {
    const m = est.meters;
    const note = r => {
      if (!r) return null;
      if (r.source === 'logged') return herTag ? (r.by === 'subject' ? 'Logged by her' : 'Your read') : 'Logged';
      if (r.source === 'previous') return `Previous ${r.cycles > 1 ? `${r.cycles} cycles` : 'cycle'}`;
      return 'Projected';
    };
    const shell = (r, visual, label, field) => h('div', { class: 'gauge' + (r && r.source !== 'logged' ? ' est' : '') },
      visual,
      h('div', { class: 'gauge-label', text: label }),
      h('div', { class: 'gauge-value ' + (r ? 'v-' + r.value : 'v-none'), text: r ? Vocab.label(field, r.value) : 'No reading' }),
      trendChip(field, trends[field]),
      r ? h('div', { class: 'gauge-by ' + r.source, text: note(r) }) : null);
    const g = (label, field) => {
      const r = m[field];
      return shell(r, h('span', { html: gaugeSVG(r ? LEVEL[r.value] : null, r && r.source !== 'logged') }), label, field);
    };
    const soc = m.social;
    const items = [g('Mood', 'mood'), g('Energy', 'energy')];
    if (showDesire) items.push(g('Desire', 'desire'));
    items.push(shell(soc, h('div', { class: 'soc-icon', 'aria-hidden': 'true',
      text: soc ? { home: '\u2302', either: '\u21C4', out: '\u2197' }[soc.value] : '\u2013' }), 'Social', 'social'));

    const sources = new Set(Object.values(m).map(r => r.source));
    let foot = null;
    const arrows = Object.keys(trends).length ? ' Arrows show where each meter is heading over the next few days.' : '';
    if (!est.cycle) foot = 'Log a period start and the meters will show projections for each day.';
    else if (sources.has('projected')) foot = `Projected values are broad tendencies for this phase, and people vary a lot. As ${name === 'You' ? 'you log' : `${name} logs`} readings, each meter switches to ${name === 'You' ? 'your' : 'her'} own previous cycles.`;
    else if (sources.has('previous')) foot = `Previous values come from the same point in ${name === 'You' ? 'your' : 'her'} earlier cycles.`;
    if (foot && est.cycle) foot += arrows;
    else if (!foot && arrows) foot = arrows.trim();

    return h('section', { class: 'sheet' },
      h('div', { class: 'sheet-head' }, h('h2', { text: 'Today' }), h('span', { class: 'small muted', text: Dates.pretty(Dates.today()) })),
      h('div', { class: 'gauges' }, items),
      est.symptoms.length
        ? h('div', { class: 'chips' }, est.symptoms.map(s => h('span', { class: 'chip static', text: Vocab.label('symptoms', s) })))
        : null,
      foot ? h('p', { class: 'small muted', text: foot }) : null);
  }

  // ── forms ────────────────────────────────────────────────────────────
  function composer(title, body, open = false) {
    return h('details', { class: 'composer sheet', open }, h('summary', { text: title }), body);
  }

  // Segmented control. Tapping the selected option clears it, so every
  // reading stays optional.
  function seg(options, onChange) {
    let value = null;
    const btns = options.map(([id, label]) => h('button', {
      type: 'button', 'aria-pressed': 'false',
      onclick: () => {
        value = value === id ? null : id;
        btns.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i][0] === value)));
        onChange?.(value);
      },
    }, label));
    const el = h('div', { class: 'seg', role: 'group' }, btns);
    el.getValue = () => value;
    el.setValue = v => { value = v; btns.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i][0] === v))); };
    return el;
  }

  function visControl(otherName, def) {
    const opts = otherName ? [['shared', `Share with ${otherName}`], ['private', 'Only me']]
                           : [['shared', 'Shared'], ['private', 'Only me']];
    const s = seg(opts);
    s.setValue(def);
    // Visibility is never empty: tapping the selected option keeps it.
    s.addEventListener('click', () => { if (!s.getValue()) s.setValue(def); });
    const wrap = h('div', { class: 'vis' }, s);
    wrap.getValue = () => s.getValue() || def;
    return wrap;
  }

  function dateInput() {
    return h('input', { type: 'date', value: Dates.today(), max: Dates.today(), 'aria-label': 'Date' });
  }

  function group(label, control) {
    return h('div', { class: 'field-group' }, h('span', { class: 'field-name', text: label }), control);
  }

  function readingForm({ showDesire, otherName, defaultVis, onSave }) {
    const mood = seg(Vocab.mood), energy = seg(Vocab.energy), desire = seg(Vocab.desire), social = seg(Vocab.social);
    const picked = new Set();
    const chips = h('div', { class: 'chips' }, Vocab.symptoms.map(([id, label]) => h('button', {
      class: 'chip', type: 'button', 'aria-pressed': 'false',
      onclick: e => {
        picked.has(id) ? picked.delete(id) : picked.add(id);
        e.currentTarget.setAttribute('aria-pressed', String(picked.has(id)));
      },
    }, label)));
    const note = h('textarea', { placeholder: 'Anything else worth noting', maxlength: 2000 });
    const date = dateInput();
    const vis = visControl(otherName, defaultVis);
    const go = h('button', { class: 'btn', type: 'button' }, 'Save readings');
    go.onclick = () => busy(go, async () => {
      const fields = {};
      if (mood.getValue()) fields.mood = mood.getValue();
      if (energy.getValue()) fields.energy = energy.getValue();
      if (showDesire && desire.getValue()) fields.desire = desire.getValue();
      if (social.getValue()) fields.social = social.getValue();
      if (picked.size) fields.symptoms = [...picked];
      if (!Object.keys(fields).length && !note.value.trim()) return toast('Pick at least one reading.');
      await onSave(fields, note.value.trim() || null, vis.getValue(), date.value || Dates.today());
      [mood, energy, desire, social].forEach(s => s.setValue(null));
      picked.clear(); chips.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
      note.value = '';
      toast('Readings saved');
    });
    return h('div', { class: 'composer-body' },
      group('Mood', mood), group('Energy', energy), showDesire ? group('Desire', desire) : null,
      group('Social battery', social), group('Symptoms', chips), note,
      h('div', { class: 'row' }, date, vis), go);
  }

  function noteForm({ otherName, defaultVis, onSave }) {
    const body = h('textarea', { placeholder: 'Write a note', maxlength: 6000 });
    const date = dateInput();
    const vis = visControl(otherName, defaultVis);
    const go = h('button', { class: 'btn', type: 'button' }, 'Save note');
    go.onclick = () => busy(go, async () => {
      if (!body.value.trim()) return toast('Write something first.');
      await onSave(body.value.trim(), vis.getValue(), date.value || Dates.today());
      body.value = '';
      toast(vis.getValue() === 'private' ? 'Saved, only you can see it' : 'Note shared');
    });
    return h('div', { class: 'composer-body' }, body, h('div', { class: 'row' }, date, vis), go);
  }

  function periodForm(onSave) {
    const date = dateInput();
    const go = h('button', { class: 'btn', type: 'button' }, 'Save start date');
    go.onclick = () => busy(go, async () => {
      if (!date.value) return toast('Pick a date.');
      await onSave(date.value);
      toast('Cycle updated');
    });
    return h('div', { class: 'composer-body' },
      h('p', { class: 'small muted', text: 'Day one is the first day of bleeding. Period starts are always visible to both of you, since they drive the forecast.' }),
      h('div', { class: 'row' }, date, go));
  }

  // ── timeline ─────────────────────────────────────────────────────────
  function timeline(f, entries) {
    const me = S.me.id;
    const starts = entries.filter(e => e.kind === 'period').map(e => e.date);
    const groups = new Map();
    for (const e of entries.slice(0, 120)) {
      if (!groups.has(e.date)) groups.set(e.date, []);
      groups.get(e.date).push(e);
    }
    const body = groups.size ? [...groups].map(([date, list]) => h('div', { class: 'day-group' },
      h('div', { class: 'day-head' }, h('span', { text: Dates.pretty(date) }),
        (() => { const c = Cycle.compute(starts, f, date); return c ? h('span', { class: 'small', text: `cycle day ${c.day}` }) : null; })()),
      ...list.map(e => entryRow(f, e, me)))) : [h('p', { class: 'empty', text: 'Nothing logged yet.' })];
    return h('section', { class: 'sheet' }, h('h2', { text: 'Log' }), ...body);
  }

  function entryRow(f, e, me) {
    const mine = e.authorId === me;
    const meta = h('div', { class: 'entry-meta' }, h('span', { text: authorName(f, e) }));
    if (e.kind === 'period') meta.append(h('span', { class: 'badge period' }, icon('drop'), 'Period started'));
    else meta.append(e.visibility === 'private'
      ? h('span', { class: 'badge private' }, icon('lock'), 'Only you')
      : h('span', { class: 'badge shared' }, icon('eye'), 'Shared'));

    const del = mine ? h('button', { class: 'linky small', type: 'button', onclick: async ev => {
      if (!confirm('Delete this entry?')) return;
      await busy(ev.currentTarget, () => deleteEntry(f, e));
    } }, 'Delete') : h('span');

    let content = null;
    if (e.kind === 'reading') {
      const parts = ['mood', 'energy', 'desire', 'social'].filter(k => e.fields?.[k])
        .map(k => `${k === 'social' ? 'Social' : k[0].toUpperCase() + k.slice(1)}: ${Vocab.label(k, e.fields[k])}`);
      content = h('div', { class: 'entry-body' },
        parts.length ? h('div', { text: parts.join(', ') }) : null,
        e.fields?.symptoms?.length ? h('div', { class: 'chips', style: 'margin-top:6px' },
          e.fields.symptoms.map(s => h('span', { class: 'chip static', text: Vocab.label('symptoms', s) }))) : null,
        e.body ? h('div', { style: 'margin-top:6px', text: e.body }) : null);
    } else if (e.kind === 'note') {
      content = h('div', { class: 'entry-body', text: e.body || '' });
    }
    return h('div', { class: 'entry' }, meta, del, content);
  }

  // ── panels ───────────────────────────────────────────────────────────
  function openPanel(...kids) {
    const panel = h('div', { class: 'panel', role: 'dialog', 'aria-modal': 'true' }, ...kids);
    const scrim = h('div', { class: 'scrim', onclick: e => { if (e.target === scrim) closePanel(); } }, panel);
    $('overlay').replaceChildren(scrim);
    $('overlay').hidden = false;
    document.addEventListener('keydown', escClose);
  }
  function closePanel() {
    $('overlay').hidden = true;
    $('overlay').replaceChildren();
    document.removeEventListener('keydown', escClose);
  }
  const escClose = e => { if (e.key === 'Escape') closePanel(); };
  const panelHead = title => h('div', { class: 'sheet-head' }, h('h2', { text: title }),
    h('button', { class: 'linky', type: 'button', onclick: closePanel }, 'Done'));

  // ── creating a forecast ──────────────────────────────────────────────
  function relationSeg(value) {
    const s = seg([['partner', 'Partner'], ['family', 'Family'], ['friend', 'Friend']]);
    s.setValue(value);
    return s;
  }
  const sealShared = (f, shared) => Vault.seal(f.key.key, shared, `shared:${f.id}`);
  const sealOwner = (fid, own) => Vault.seal(S.dataKey, own, `owner:${fid}`);

  function openNewForecast() {
    const label = h('input', { type: 'text', placeholder: 'Wife, Sister, Jess', maxlength: 24 });
    const rel = relationSeg('partner');
    const go = h('button', { class: 'btn', type: 'button' }, 'Create forecast');
    go.onclick = () => busy(go, async () => {
      if (!label.value.trim()) return toast('Give the tab a name.');
      const fid = uid(12);
      const relation = rel.getValue() || 'partner';
      const k = await Vault.newForecast(fid, S.dataKey);
      const r = await Api.createForecast({
        id: fid, kcv: k.kcv, wrappedKey: k.wrappedKey,
        sharedEnc: await Vault.seal(k.key, { ...DEFAULT_SHARED, asksDesire: relation === 'partner' }, `shared:${fid}`),
        ownerEnc: await sealOwner(fid, { label: label.value.trim(), relation }),
      });
      S.forecasts.push(await decorate(r.forecast));
      S.active = fid; Local.set('tab', fid);
      S.raw[fid] = new Map();
      closePanel(); renderTabs(); await render();
    });
    openPanel(panelHead('New forecast'),
      h('p', { class: 'muted', text: 'One forecast per person. The tab name is encrypted, so only you can see it.' }),
      group('Tab name', label), group('Relationship', rel),
      h('p', { class: 'small muted', text: 'Partner forecasts include the desire reading and the husband advisory. Family and friend forecasts leave those out.' }),
      go);
  }

  // ── settings ─────────────────────────────────────────────────────────
  function openSettings() {
    const f = activeForecast();
    const sections = [panelHead('Settings')];
    if (f) sections.push(f.role === 'owner' ? ownerSettings(f) : subjectSettings(f));
    sections.push(accountSettings());
    openPanel(...sections);
  }

  function cycleSettings(f) {
    if (f.locked) return [];
    const cl = h('input', { type: 'number', min: 18, max: 60, value: f.cycleLength });
    const pl = h('input', { type: 'number', min: 1, max: 12, value: f.periodLength });
    const go = h('button', { class: 'btn quiet', type: 'button' }, 'Save cycle settings');
    go.onclick = () => busy(go, async () => {
      const c = parseInt(cl.value, 10), p = parseInt(pl.value, 10);
      if (!(c >= 18 && c <= 60) || !(p >= 1 && p <= 12)) return toast('Cycle 18 to 60 days, period 1 to 12.');
      const shared = { cycleLength: c, periodLength: p, asksDesire: f.asksDesire };
      const r = await Api.settings(f.id, { sharedEnc: await sealShared(f, shared) });
      Object.assign(f, r.forecast); await decorate(f); await render(); toast('Saved');
    });
    return [
      h('div', { class: 'row' }, h('div', { class: 'grow' }, group('Typical cycle (days)', cl)), h('div', { class: 'grow' }, group('Period length (days)', pl))),
      h('p', { class: 'small muted', text: 'Once two or more period starts are logged, predictions use the logged average instead.' }),
      go,
    ];
  }

  // Either member can send the other an unlock link if they lose their key.
  function unlockLinkSection(f) {
    if (f.locked) return null;
    const other = f.role === 'owner' ? f.subjectName : f.ownerName;
    if (!other) return null;
    const out = h('div');
    const make = h('button', { class: 'btn quiet', type: 'button', onclick: () => {
      out.replaceChildren(linkBox(linkWithKey({ unlock: f.id }, f.key.raw),
        `Only works for ${other}, while they\u2019re signed in. It holds the key to this forecast, so send it only to them.`));
    } }, `Make an unlock link for ${other}`);
    return h('div', { style: 'margin-top:20px' },
      h('p', { class: 'small muted', text: `If ${other} gets a new device and loses their recovery key, this link reopens the forecast for them.` }),
      make, out);
  }

  function ownerSettings(f) {
    const parts = [h('h3', { text: f.label })];
    if (!f.locked) {
      const label = h('input', { type: 'text', value: f.label, maxlength: 24 });
      const rel = relationSeg(f.relation);
      const saveBtn = h('button', { class: 'btn quiet', type: 'button' }, 'Save tab');
      saveBtn.onclick = () => busy(saveBtn, async () => {
        const relation = rel.getValue() || f.relation;
        const r = await Api.settings(f.id, {
          ownerEnc: await sealOwner(f.id, { label: label.value.trim() || f.label, relation }),
          sharedEnc: await sealShared(f, { cycleLength: f.cycleLength, periodLength: f.periodLength, asksDesire: relation === 'partner' }),
        });
        Object.assign(f, r.forecast); await decorate(f); renderTabs(); await render(); toast('Saved');
      });
      parts.push(group('Tab name', label), group('Relationship', rel), saveBtn, ...cycleSettings(f), unlockLinkSection(f));
    }

    const danger = [];
    if (f.subjectId) {
      const rm = h('button', { class: 'btn danger', type: 'button' }, `Stop sharing with ${f.subjectName}`);
      rm.onclick = () => busy(rm, async () => {
        if (!confirm(`${f.subjectName} will lose access to this forecast. What she already shared stays here. Continue?`)) return;
        await Api.remove(f.id);
        f.subjectId = null; f.subjectName = null;
        closePanel(); renderTabs(); await render(); toast('Sharing ended');
      });
      danger.push(rm);
    } else if (f.hasPendingInvite) {
      const c = h('button', { class: 'btn quiet', type: 'button' }, 'Cancel the open invite');
      c.onclick = () => busy(c, async () => { await Api.cancelInvite(f.id); f.hasPendingInvite = false; closePanel(); renderTabs(); await render(); toast('Invite cancelled'); });
      danger.push(c);
    }
    const del = h('button', { class: 'btn danger', type: 'button' }, 'Delete this forecast');
    del.onclick = () => busy(del, async () => {
      if (!confirm('This permanently deletes every entry on this forecast, for both of you. Continue?')) return;
      await destroyForecast(f);
      closePanel(); await afterRemoval('Forecast deleted');
    });
    danger.push(del);
    parts.push(h('div', { style: 'display:grid;gap:10px;margin-top:20px' }, danger));
    return h('section', { class: 'sheet' }, ...parts);
  }

  function subjectSettings(f) {
    const erase = check('Also erase everything I shared');
    const leave = h('button', { class: 'btn danger', type: 'button' }, `Stop sharing with ${f.ownerName}`);
    leave.onclick = () => busy(leave, async () => {
      const msg = erase.checked()
        ? `Everything you wrote here will be deleted and ${f.ownerName} will lose access to your cycle. They won\u2019t be notified. Continue?`
        : `${f.ownerName} will stop receiving anything new from you, and won\u2019t be notified. What you already shared stays with them. Continue?`;
      if (!confirm(msg)) return;
      await leaveForecast(f, erase.checked());
      closePanel(); await afterRemoval('You\u2019ve stopped sharing');
    });
    return h('section', { class: 'sheet' },
      h('h3', { text: `Shared with ${f.ownerName}` }),
      ...cycleSettings(f), unlockLinkSection(f),
      h('div', { style: 'margin-top:20px;display:grid;gap:10px' }, erase, leave));
  }

  async function destroyForecast(f) {
    let cur;
    for (let i = 0; i < 500; i++) { const r = await Api.destroy(f.id, cur); if (!r.more) break; cur = r.cursor; }
  }
  async function leaveForecast(f, erase) {
    let cur;
    for (let i = 0; i < 500; i++) { const r = await Api.leave(f.id, erase, cur); if (!r.more) break; cur = r.cursor; }
  }
  async function afterRemoval(msg) {
    S.forecasts = S.forecasts.filter(x => x.id !== S.active);
    delete S.raw[S.active];
    S.active = S.forecasts[0]?.id || null; Local.set('tab', S.active || '');
    renderTabs();
    if (S.active) await refresh(S.active, true);
    await render(); toast(msg);
  }

  // ── account ──────────────────────────────────────────────────────────
  function accountSettings() {
    const gbox = h('div');
    const sec = h('section', { class: 'sheet' }, h('h3', { text: `Signed in as ${S.me.displayName}` }));

    if (S.me.hasGoogle) sec.append(h('p', { class: 'small muted', text: 'Google is linked for signing in. Only an unreadable fingerprint of it is stored.' }));
    else {
      sec.append(h('p', { class: 'small muted', text: 'Optional: link Google so you can sign in without typing your recovery key. A new device will still ask for the key once.' }), gbox);
      renderGoogle(gbox, 'link');
    }

    const rekey = h('button', { class: 'btn quiet', type: 'button' }, 'Make a new recovery key');
    rekey.onclick = () => busy(rekey, async () => {
      if (!confirm('Your current recovery key will stop working. Continue?')) return;
      const id = await Vault.rewrapIdentity(S.dataKey);
      const r = await Api.rekey({ loginSecret: id.loginSecret, wrappedDataKey: id.wrappedDataKey });
      S.me = r.person;
      closePanel();
      gateShowRecovery(id.recoveryText, () => { $('gate').hidden = true; $('app').hidden = false; }, 'Your new recovery key. The old one no longer works.');
    });

    const exp = h('button', { class: 'btn quiet', type: 'button' }, 'Download my data');
    exp.onclick = () => busy(exp, exportData);

    const delAcct = h('button', { class: 'btn danger', type: 'button' }, 'Delete my account');
    delAcct.onclick = () => busy(delAcct, deleteAccount);

    sec.append(
      h('div', { style: 'display:grid;gap:10px;margin-top:8px' }, rekey, exp,
        h('button', { class: 'btn quiet', type: 'button', onclick: () => {
          if (confirm('Signing out also removes your key from this device. You\u2019ll need your recovery key to sign back in here. Continue?')) signOut();
        } }, 'Sign out'),
        delAcct));
    return sec;
  }

  async function signOut() {
    try { await Api.signOut(); } catch {}
    if (S.me) await Vault.forgetDataKey(S.me.id).catch(() => {});
    Local.set('session', ''); Local.set('tab', '');
    cleanUrl();
    location.reload();
  }

  async function exportData() {
    const out = { exportedAt: new Date().toISOString(), nickname: S.me.displayName, forecasts: [] };
    for (const f of S.forecasts) {
      if (f.locked) { out.forecasts.push({ name: tabName(f), locked: true }); continue; }
      await refresh(f.id, true);
      const { entries } = await plainEntries(f);
      out.forecasts.push({
        name: tabName(f), role: f.role,
        cycleLength: f.cycleLength, periodLength: f.periodLength,
        entries: entries.map(e => ({ date: e.date, kind: e.kind, visibility: e.visibility, author: authorName(f, e),
          ...(e.fields && Object.keys(e.fields).length ? { fields: e.fields } : {}), ...(e.body ? { body: e.body } : {}) })),
      });
    }
    download(`forecast-${Dates.today()}.json`, JSON.stringify(out, null, 2));
  }

  async function deleteAccount() {
    const owned = S.forecasts.filter(f => f.role === 'owner').length;
    const joined = S.forecasts.length - owned;
    if (!confirm(`This deletes your account${owned ? `, ${owned} forecast${owned > 1 ? 's' : ''} you created (for everyone on them)` : ''}${joined ? `, and everything you shared on ${joined} forecast${joined > 1 ? 's' : ''} you joined` : ''}. It can\u2019t be undone. Continue?`)) return;
    if (prompt(`Type your nickname, ${S.me.displayName}, to confirm.`) !== S.me.displayName) return toast('Nickname didn\u2019t match. Nothing was deleted.');
    toast('Deleting\u2026');
    for (const f of S.forecasts) f.role === 'owner' ? await destroyForecast(f) : await leaveForecast(f, true);
    await Api.deleteAccount();
    await Vault.forgetDataKey(S.me.id).catch(() => {});
    Local.set('session', ''); Local.set('tab', '');
    location.reload();
  }

  // ── keep current ─────────────────────────────────────────────────────
  async function tick() {
    if (document.hidden || !S.active || !$('overlay').hidden || $('app').hidden) return;
    const typing = [...document.querySelectorAll('#main textarea')].some(t => t.value.trim())
      || document.querySelector('#main .seg button[aria-pressed="true"], #main .chip[aria-pressed="true"]')
      || /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '');
    if (typing) return;
    const before = S.raw[S.active]?.size || 0;
    try {
      await refresh(S.active, false);
      if ((S.raw[S.active]?.size || 0) !== before) await render();
    } catch {}
  }
  setInterval(tick, 60000);
  document.addEventListener('visibilitychange', tick);

  boot();
})();

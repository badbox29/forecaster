/**
 * app.js — controller and views.
 *
 * Every piece of user text reaches the page through textContent, never
 * innerHTML. The only innerHTML in this file is static icon markup and
 * SVG built from numbers.
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
    me: null,
    forecasts: [],
    active: null,
    raw: {},          // fid → Map(id → entry) as the server sent them
    cursor: {},       // fid → ts13
    gConfig: null,
  };
  const activeForecast = () => S.forecasts.find(f => f.id === S.active);
  const entriesFor = fid => resolveEntries([...(S.raw[fid]?.values() || [])]);

  // ── toast ────────────────────────────────────────────────────────────
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  function uid() {
    const b = crypto.getRandomValues(new Uint8Array(12));
    return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function busy(btn, fn) {
    btn.disabled = true;
    try { return await fn(); }
    catch (e) { toast(e.message || 'Something went wrong'); }
    finally { btn.disabled = false; }
  }

  // ── boot ─────────────────────────────────────────────────────────────
  async function boot() {
    const q = new URLSearchParams(location.search);
    const invite = q.get('invite');
    const fromLink = q.get('w');

    let base = Local.get('worker');
    if (!base && fromLink && okUrl(fromLink)) {
      base = fromLink;
      Local.set('worker', base);
    }
    if (base) Api.setBase(base);
    Api.setSession(Local.get('session'));

    if (!base) return gateWorker(invite);
    if (invite) return gateJoin(invite);
    if (!Local.get('session')) return gateSignIn();

    try { await enterApp(); }
    catch (e) {
      if (e.status === 401) { Local.set('session', ''); return gateSignIn(); }
      showGate(h('div', { class: 'gate-card sheet' },
        h('h2', { text: 'Can\u2019t reach the forecast' }),
        h('p', { class: 'muted', text: e.message }),
        h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Try again')));
    }
  }

  function showGate(card) {
    $('app').hidden = true;
    const g = $('gate');
    g.replaceChildren(card);
    g.hidden = false;
  }

  function gateHeader(title, sub) {
    return [
      h('span', { class: 'gate-mark', html: ICON.mark }),
      h('h1', { text: title }),
      sub ? h('p', { class: 'muted', text: sub }) : null,
    ];
  }

  // ── gate: worker address ─────────────────────────────────────────────
  function gateWorker(invite) {
    const input = h('input', { type: 'url', placeholder: 'https://your-worker.workers.dev', autocomplete: 'off', spellcheck: 'false', inputmode: 'url' });
    const go = h('button', { class: 'btn', type: 'button' }, 'Connect');
    go.onclick = () => busy(go, async () => {
      const url = input.value.trim().replace(/\/+$/, '');
      if (!okUrl(url)) return toast('Enter the full https:// address.');
      if (!(await Api.ping(url))) return toast('That address did not answer as a Forecast worker.');
      Local.set('worker', url);
      Api.setBase(url);
      invite ? gateJoin(invite) : gateSignIn();
    });
    showGate(h('div', { class: 'gate-card sheet' },
      ...gateHeader('Forecast', 'A shared cycle forecast for the people you choose.'),
      h('label', { class: 'field-group' },
        h('span', { class: 'field-name', text: 'Sync address' }), input),
      go,
      h('p', { class: 'small muted', text: 'This is the worker address whoever set up Forecast gave you. It is stored on this device only.' })));
  }

  // ── gate: sign in ────────────────────────────────────────────────────
  function gateSignIn() {
    const gbox = h('div');
    const card = h('div', { class: 'gate-card sheet' },
      ...gateHeader('Forecast', 'A shared cycle forecast for the people you choose.'),
      gbox,
      h('p', { class: 'gate-or', text: 'or' }),
      h('button', { class: 'btn quiet', type: 'button', onclick: () => gateSignup() }, 'Create an account with a sign-up code'),
      h('button', { class: 'btn quiet', type: 'button', onclick: gatePasteInvite }, 'I have an invite link'),
      h('button', { class: 'linky', type: 'button',
        onclick: () => { Local.set('worker', ''); location.reload(); } }, 'Use a different sync address'));
    showGate(card);
    renderGoogle(gbox, 'signin');
  }

  // `google` is an ID token from a Google sign-in that matched no account.
  // Rather than dead-ending, carry it into sign-up and link it as soon as
  // the account exists. Google tokens last about an hour, which is plenty.
  function gateSignup(google = null) {
    let suggested = '';
    if (google) {
      try { suggested = JSON.parse(atob(google.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).given_name || ''; } catch {}
    }
    const name = h('input', { type: 'text', placeholder: 'Chris', autocomplete: 'given-name', maxlength: 60, value: suggested });
    const code = h('input', { type: 'text', placeholder: 'Sign-up code', autocomplete: 'off', spellcheck: 'false' });
    const go = h('button', { class: 'btn', type: 'button' }, 'Create account');
    go.onclick = () => busy(go, async () => {
      if (!name.value.trim()) return toast('Enter your name.');
      const r = await Api.signup(name.value.trim(), code.value.trim());
      Local.set('session', r.sessionId);
      Api.setSession(r.sessionId);
      if (google) {
        try { await Api.googleLink(google); }
        catch { toast('Account created. Link Google from Settings to finish.'); }
      }
      await enterApp();
    });
    showGate(h('div', { class: 'gate-card sheet' },
      ...gateHeader('Create an account', google
        ? 'That Google account isn\u2019t set up yet. Enter your sign-up code and it will be linked to your new account.'
        : 'The sign-up code is the SIGNUP_TOKEN set on your worker. People you invite never need it.'),
      h('label', { class: 'field-group' }, h('span', { class: 'field-name', text: 'Your name' }), name),
      h('label', { class: 'field-group' }, h('span', { class: 'field-name', text: 'Sign-up code' }), code),
      go,
      h('p', { class: 'small muted', text: 'Invited by someone? Use their invite link instead. You don\u2019t need a code.' }),
      h('button', { class: 'linky', type: 'button', onclick: gateSignIn }, 'Back')));
  }

  function gatePasteInvite() {
    const input = h('input', { type: 'text', placeholder: 'Paste the whole link', spellcheck: 'false' });
    const go = h('button', { class: 'btn', type: 'button' }, 'Continue');
    go.onclick = () => {
      const v = input.value.trim();
      const m = v.match(/invite=([A-Za-z0-9_-]{16,})/) || v.match(/^([A-Za-z0-9_-]{16,})$/);
      if (!m) return toast('That doesn\u2019t look like an invite link.');
      const w = v.match(/[?&]w=([^&]+)/);
      if (w && !Api.getBase()) { const url = decodeURIComponent(w[1]); if (okUrl(url)) { Local.set('worker', url); Api.setBase(url); } }
      gateJoin(m[1]);
    };
    showGate(h('div', { class: 'gate-card sheet' },
      ...gateHeader('Join with an invite'), input, go,
      h('button', { class: 'linky', type: 'button', onclick: gateSignIn }, 'Back')));
  }

  // ── gate: join from invite ───────────────────────────────────────────
  async function gateJoin(token) {
    let preview;
    try { preview = await Api.invitePreview(token); }
    catch (e) {
      return showGate(h('div', { class: 'gate-card sheet' },
        ...gateHeader('This invite can\u2019t be used', e.message),
        h('p', { class: 'muted', text: 'Ask whoever sent it for a new link.' }),
        h('button', { class: 'btn quiet', type: 'button', onclick: () => { history.replaceState(null, '', location.pathname); gateSignIn(); } }, 'Go to sign in')));
    }

    // Already signed in on this device? Attach to that account instead of
    // making a second one.
    let existing = null;
    if (Local.get('session')) { try { existing = (await Api.me()).person; } catch {} }

    const owner = preview.ownerName;
    const name = h('input', { type: 'text', placeholder: 'Your first name', autocomplete: 'given-name', maxlength: 60 });
    const start = h('input', { type: 'date', max: Dates.today() });
    const go = h('button', { class: 'btn', type: 'button' }, 'Accept invite');

    go.onclick = () => busy(go, async () => {
      if (!existing && !name.value.trim()) return toast('Enter your name.');
      const r = await Api.redeem({
        inviteToken: token,
        displayName: existing ? undefined : name.value.trim(),
        periodStart: start.value || undefined,
      });
      history.replaceState(null, '', location.pathname);
      S.active = r.forecastId;
      Local.set('tab', r.forecastId);
      await afterSession(r.sessionId);
    });

    showGate(h('div', { class: 'gate-card sheet' },
      ...gateHeader(`${owner} invited you`, 'Forecast estimates where you are in your cycle and lets you log how you\u2019re feeling, if you want to.'),
      h('div', { class: 'notice' },
        h('strong', { text: 'What gets shared' }),
        h('ul', {},
          h('li', { text: `${owner} sees your period start dates and anything you mark Shared.` }),
          h('li', { text: 'Anything you mark Only me stays private to you.' }),
          h('li', { text: `${owner} can also keep private notes you won\u2019t see.` }),
          h('li', { text: 'You can stop sharing at any time, and choose to erase what you shared.' }))),
      existing
        ? h('p', { text: `You\u2019ll join as ${existing.displayName}.` })
        : h('label', { class: 'field-group' }, h('span', { class: 'field-name', text: 'Your name' }), name),
      h('label', { class: 'field-group' },
        h('span', { class: 'field-name', text: 'First day of your last period (optional)' }), start),
      go,
      h('p', { class: 'small muted', text: 'Cycle predictions are estimates. They are not medical advice or birth control.' })));
  }

  async function afterSession(sid) {
    Local.set('session', sid);
    Api.setSession(sid);
    await enterApp();
  }

  // ── Google ───────────────────────────────────────────────────────────
  async function renderGoogle(host, mode) {
    try { S.gConfig = S.gConfig || await Api.config(); } catch { return; }
    if (!S.gConfig.googleEnabled) return;
    await new Promise(res => {
      if (window.google?.accounts?.id) return res();
      const s = h('script', { src: 'https://accounts.google.com/gsi/client', async: true });
      s.onload = res; s.onerror = res;
      document.head.append(s);
    });
    if (!window.google?.accounts?.id) return;
    google.accounts.id.initialize({
      client_id: S.gConfig.googleClientId,
      callback: async ({ credential }) => {
        try {
          if (mode === 'link') {
            await Api.googleLink(credential);
            S.me.hasGoogle = true;
            toast('Google linked. You can sign in on any device now.');
            closePanel();
          } else {
            try {
              const r = await Api.google(credential);
              await afterSession(r.sessionId);
            } catch (e) {
              if (e.status === 404) return gateSignup(credential);
              throw e;
            }
          }
        } catch (e) { toast(e.message); }
      },
    });
    google.accounts.id.renderButton(host, { theme: 'outline', size: 'large', width: 300,
      text: mode === 'link' ? 'signin_with' : 'continue_with' });
  }

  // ── app ──────────────────────────────────────────────────────────────
  async function enterApp() {
    const me = await Api.me();
    S.me = me;
    S.forecasts = me.forecasts;
    const saved = S.active || Local.get('tab');
    S.active = S.forecasts.some(f => f.id === saved) ? saved : S.forecasts[0]?.id || null;

    $('gate').hidden = true;
    $('app').hidden = false;
    $('brand').replaceChildren(h('span', { html: ICON.mark, style: 'display:inline-flex' }), 'Forecast');
    $('settingsBtn').innerHTML = ICON.gear;
    $('settingsBtn').onclick = openSettings;

    renderTabs();
    if (S.active) await refresh(S.active, true);
    render();
  }

  function renderTabs() {
    const tabs = S.forecasts.map(f => h('button', {
      class: 'tab', role: 'tab', type: 'button',
      'aria-selected': String(f.id === S.active),
      onclick: async () => {
        S.active = f.id; Local.set('tab', f.id);
        renderTabs(); render();
        await refresh(f.id, !S.raw[f.id]);
        render();
      },
    }, f.role === 'owner' ? f.label : `Shared with ${f.ownerName}`,
       f.role === 'owner' && !f.subjectId ? h('span', { class: 'tag', text: 'invite' }) : null));
    if (S.me.person.canOwn) {
      tabs.push(h('button', { class: 'tab', type: 'button', 'aria-label': 'Add a forecast', onclick: openNewForecast }, '+ Add'));
    }
    $('tabs').replaceChildren(...tabs);
  }

  // Full pull on first open, then incremental with a five minute overlap
  // to absorb KV list lag. Entries are immutable, so overlap is free.
  async function refresh(fid, full) {
    if (full || !S.raw[fid]) { S.raw[fid] = new Map(); S.cursor[fid] = ''; }
    let since = S.cursor[fid]
      ? String(Math.max(0, +S.cursor[fid] - 300000)).padStart(13, '0') : '';
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
    render();
  }

  // ── render ───────────────────────────────────────────────────────────
  function render() {
    const main = $('main');
    const f = activeForecast();
    if (!f) {
      main.replaceChildren(S.me.person.canOwn ? emptyOwner() : emptySubject());
      return;
    }
    main.replaceChildren(...(f.role === 'owner' ? ownerView(f) : subjectView(f)));
  }

  function emptyOwner() {
    return h('section', { class: 'sheet' },
      h('h2', { text: 'Start your first forecast' }),
      h('p', { class: 'muted', text: 'Each forecast is one person. Create one, send her the invite link, and once she accepts she can set day one of her cycle and log how she\u2019s feeling.' }),
      h('button', { class: 'btn', type: 'button', onclick: openNewForecast }, 'Create a forecast'));
  }
  function emptySubject() {
    return h('section', { class: 'sheet' },
      h('h2', { text: 'Nothing shared with you right now' }),
      h('p', { class: 'muted', text: 'If someone sends you a new invite link, open it on this device to join.' }));
  }

  function cycleOf(f, entries) {
    const starts = entries.filter(e => e.kind === 'period').map(e => e.date);
    return Cycle.compute(starts, f);
  }

  // ── owner ────────────────────────────────────────────────────────────
  function ownerView(f) {
    const entries = entriesFor(f.id);
    const cycle = cycleOf(f, entries);
    const today = Dates.today();
    const readings = readingsFor(entries, today, f.subjectId);
    const herName = f.subjectName || f.label;
    const out = [];

    if (!f.subjectId) out.push(inviteCard(f));
    out.push(hero(cycle, herName));
    out.push(todayCard(readings, f.relation === 'partner', herName, f.subjectId ? 'her' : null));

    const adv = Advisory.forOwner({ cycle, readings, relation: f.relation, name: herName, date: today });
    out.push(h('section', { class: 'advisory' + (/Clear|Fair/.test(adv.headline) ? ' fair' : '') },
      h('h2', { text: adv.headline }),
      h('ul', {}, adv.lines.map(l => h('li', { text: l }))),
      h('p', { class: 'motto', text: f.relation === 'partner'
        ? 'Helping husbands navigate the changing climate of marriage, one hormonal front at a time.'
        : 'Helping you be the one who remembers.' })));

    const other = f.subjectId ? f.subjectName : null;
    out.push(composer(`Log ${herName}\u2019s readings`, readingForm({
      showDesire: f.relation === 'partner', otherName: other, defaultVis: 'shared',
      onSave: (fields, body, vis, date) => save(f.id, [{ id: uid(), kind: 'reading', date, fields, body, visibility: vis }]),
    })));
    out.push(composer('Add a note', noteForm({ otherName: other, defaultVis: 'private',
      onSave: (body, vis, date) => save(f.id, [{ id: uid(), kind: 'note', date, body, visibility: vis }]) })));
    out.push(composer('Log a period start', periodForm(d => save(f.id, [{ id: uid(), kind: 'period', date: d }]))));
    out.push(timeline(f, entries));
    return out;
  }

  function inviteCard(f) {
    const result = h('div');
    const make = h('button', { class: 'btn', type: 'button' }, f.hasPendingInvite ? 'Make a new invite link' : 'Create invite link');
    make.onclick = () => busy(make, async () => {
      const r = await Api.invite(f.id);
      f.hasPendingInvite = true;
      const url = new URL(location.pathname, location.origin);
      url.searchParams.set('invite', r.token);
      // The address rides along in the link, so the person you invite
      // never has to type it.
      url.searchParams.set('w', Api.getBase());
      const link = url.toString();
      const field = h('input', { type: 'text', readonly: true, value: link });
      const copy = h('button', { class: 'btn quiet', type: 'button', onclick: async () => {
        try { await navigator.clipboard.writeText(link); toast('Link copied'); }
        catch { field.select(); toast('Select and copy the link'); }
      } }, 'Copy');
      const share = navigator.share ? h('button', { class: 'btn quiet', type: 'button', onclick: async () => {
        try { await navigator.share({ title: 'Forecast invite', text: `${S.me.person.displayName} invited you to Forecast`, url: link }); } catch {}
      } }, 'Share') : null;
      result.replaceChildren(
        h('div', { class: 'row' }, h('div', { class: 'grow' }, field), copy, share),
        h('p', { class: 'small muted', text: `Works once and expires ${new Date(r.expiresAt).toLocaleDateString()}. Making a new link cancels this one.` }));
      renderTabs();
    });
    return h('section', { class: 'sheet' },
      h('h2', { text: `Invite ${f.label}` }),
      h('p', { class: 'muted', text: 'Send her the link. When she accepts, she can set day one of her cycle and log her own readings. She\u2019ll only ever see her own forecast and the notes you mark Shared.' }),
      f.hasPendingInvite ? h('p', { class: 'small', text: 'An invite is out and hasn\u2019t been accepted yet.' }) : null,
      make, result);
  }

  // ── subject ──────────────────────────────────────────────────────────
  function subjectView(f) {
    const entries = entriesFor(f.id);
    const cycle = cycleOf(f, entries);
    const today = Dates.today();
    const readings = readingsFor(entries, today, S.me.person.id);
    const out = [];

    out.push(hero(cycle, null));
    const o = Advisory.forSubject({ cycle });
    out.push(h('section', { class: 'sheet' },
      h('h2', { text: 'Your outlook' }),
      ...o.lines.map(l => h('p', { text: l }))));
    out.push(todayCard(readings, f.asksDesire, 'You', null));

    out.push(composer('Today\u2019s check-in', readingForm({
      showDesire: f.asksDesire, otherName: f.ownerName, defaultVis: 'shared',
      onSave: (fields, body, vis, date) => save(f.id, [{ id: uid(), kind: 'reading', date, fields, body, visibility: vis }]),
    }), true));
    out.push(composer('Add a note', noteForm({ otherName: f.ownerName, defaultVis: 'private',
      onSave: (body, vis, date) => save(f.id, [{ id: uid(), kind: 'note', date, body, visibility: vis }]) })));
    out.push(composer('My period started', periodForm(d => save(f.id, [{ id: uid(), kind: 'period', date: d }]))));
    out.push(timeline(f, entries));
    return out;
  }

  // ── hero dial ────────────────────────────────────────────────────────
  function hero(cycle, name) {
    const text = h('div', { class: 'hero-text' });
    if (cycle) {
      const ph = Cycle.PHASES[cycle.phase];
      text.append(
        h('p', { class: 'front', text: ph.front }),
        h('h1', { class: 'phase-name', text: ph.name }),
        h('p', { class: 'muted', text: `Day ${cycle.day} of about ${cycle.length}, since ${Dates.pretty(cycle.start)}` }),
        h('span', { class: 'next' }, icon('drop'),
          cycle.late ? `Predicted ${Dates.pretty(cycle.next)}, ${-cycle.daysToNext} days ago`
                     : `Next period around ${Dates.pretty(cycle.next)}`));
    } else {
      text.append(
        h('p', { class: 'front', text: 'Instruments offline' }),
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
  function gaugeSVG(level) {   // level: 0 low, 1 mid, 2 high, null none
    const seg = (a0, a1, color) => {
      const p = a => [50 + 40 * Math.cos(a), 52 - 40 * Math.sin(a)];
      const [x1, y1] = p(a0), [x2, y2] = p(a1);
      return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A40 40 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" style="stroke:var(${color})" stroke-width="9"/>`;
    };
    const gap = 0.06, t = Math.PI / 3;
    let s = seg(Math.PI, 2 * t + gap, '--warm') + seg(2 * t - gap, t + gap, '--sun') + seg(t - gap, 0, '--calm');
    if (level != null) {
      const a = Math.PI - (level * 2 + 1) * (Math.PI / 6);
      s += `<line x1="50" y1="52" x2="${(50 + 32 * Math.cos(a)).toFixed(1)}" y2="${(52 - 32 * Math.sin(a)).toFixed(1)}" style="stroke:var(--ink)" stroke-width="3" stroke-linecap="round"/>`;
    }
    s += '<circle cx="50" cy="52" r="4" style="fill:var(--ink)"/>';
    return `<svg viewBox="0 0 100 58" aria-hidden="true">${s}</svg>`;
  }

  const LEVEL = { rough: 0, okay: 1, good: 2, red: 0, yellow: 1, green: 2 };

  function todayCard(readings, showDesire, who, herTag) {
    const by = r => !r ? null : herTag && r.by === 'subject' ? 'from her' : herTag ? 'your read' : null;
    const g = (label, field) => {
      const r = readings[field];
      return h('div', { class: 'gauge' },
        h('span', { html: gaugeSVG(r ? LEVEL[r.value] : null) }),
        h('div', { class: 'gauge-label', text: label }),
        h('div', { class: 'gauge-value ' + (r ? 'v-' + r.value : 'v-none'), text: r ? Vocab.label(field, r.value) : 'No reading' }),
        by(r) ? h('div', { class: 'gauge-by', text: by(r) }) : null);
    };
    const soc = readings.social;
    const items = [g('Mood', 'mood'), g('Energy', 'energy')];
    if (showDesire) items.push(g('Desire', 'desire'));
    items.push(h('div', { class: 'gauge' },
      h('div', { style: 'height:62px;display:grid;place-items:center;font-size:30px', 'aria-hidden': 'true',
        text: soc ? { home: '\u2302', either: '\u21C4', out: '\u2197' }[soc.value] : '\u2013' }),
      h('div', { class: 'gauge-label', text: 'Social' }),
      h('div', { class: 'gauge-value ' + (soc ? 'v-' + soc.value : 'v-none'), text: soc ? Vocab.label('social', soc.value) : 'No reading' })));

    return h('section', { class: 'sheet' },
      h('div', { class: 'sheet-head' }, h('h2', { text: 'Today' }), h('span', { class: 'small muted', text: Dates.pretty(Dates.today()) })),
      h('div', { class: 'gauges' }, items),
      readings.symptoms?.length
        ? h('div', { class: 'chips' }, readings.symptoms.map(s => h('span', { class: 'chip static', text: Vocab.label('symptoms', s) })))
        : null);
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
    const me = S.me.person.id;
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
    const who = mine ? 'You' : e.authorName;
    const meta = h('div', { class: 'entry-meta' }, h('span', { text: who }));
    if (e.kind === 'period') meta.append(h('span', { class: 'badge period' }, icon('drop'), 'Period started'));
    else meta.append(e.visibility === 'private'
      ? h('span', { class: 'badge private' }, icon('lock'), 'Only you')
      : h('span', { class: 'badge shared' }, icon('eye'), 'Shared'));

    const del = mine ? h('button', { class: 'linky small', type: 'button', onclick: async ev => {
      if (!confirm('Delete this entry?')) return;
      await busy(ev.currentTarget, () => save(f.id, [{ id: uid(), kind: e.kind, date: e.date, supersedes: e.id, deleted: true }]));
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

  function openNewForecast() {
    const label = h('input', { type: 'text', placeholder: 'Wife, Sister, Jess', maxlength: 40 });
    const rel = seg([['partner', 'Partner'], ['family', 'Family'], ['friend', 'Friend']]);
    rel.setValue('partner');
    const go = h('button', { class: 'btn', type: 'button' }, 'Create forecast');
    go.onclick = () => busy(go, async () => {
      if (!label.value.trim()) return toast('Give the tab a name.');
      const r = await Api.createForecast(label.value.trim(), rel.getValue() || 'partner');
      S.forecasts.push(r.forecast);
      S.active = r.forecast.id; Local.set('tab', S.active);
      S.raw[S.active] = new Map();
      closePanel(); renderTabs(); render();
    });
    openPanel(panelHead('New forecast'),
      h('p', { class: 'muted', text: 'One forecast per person. Only you see the tab name.' }),
      group('Tab name', label),
      group('Relationship', rel),
      h('p', { class: 'small muted', text: 'Partner forecasts include the desire reading and the husband advisory. Family and friend forecasts leave those out.' }),
      go);
  }

  function openSettings() {
    const f = activeForecast();
    const sections = [panelHead('Settings')];
    if (f) sections.push(f.role === 'owner' ? ownerSettings(f) : subjectSettings(f));
    sections.push(accountSettings());
    openPanel(...sections);
  }

  function cycleSettings(f) {
    const cl = h('input', { type: 'number', min: 18, max: 60, value: f.cycleLength });
    const pl = h('input', { type: 'number', min: 1, max: 12, value: f.periodLength });
    const go = h('button', { class: 'btn quiet', type: 'button' }, 'Save cycle settings');
    go.onclick = () => busy(go, async () => {
      const r = await Api.settings(f.id, { cycleLength: cl.value, periodLength: pl.value });
      Object.assign(f, r.forecast); render(); toast('Saved');
    });
    return [
      h('div', { class: 'row' }, h('div', { class: 'grow' }, group('Typical cycle (days)', cl)), h('div', { class: 'grow' }, group('Period length (days)', pl))),
      h('p', { class: 'small muted', text: 'Once two or more period starts are logged, predictions use the logged average instead.' }),
      go,
    ];
  }

  function ownerSettings(f) {
    const label = h('input', { type: 'text', value: f.label, maxlength: 40 });
    const rel = seg([['partner', 'Partner'], ['family', 'Family'], ['friend', 'Friend']]);
    rel.setValue(f.relation);
    const saveBtn = h('button', { class: 'btn quiet', type: 'button' }, 'Save tab');
    saveBtn.onclick = () => busy(saveBtn, async () => {
      const r = await Api.settings(f.id, { label: label.value.trim(), relation: rel.getValue() || f.relation });
      Object.assign(f, r.forecast); renderTabs(); render(); toast('Saved');
    });

    const danger = [];
    if (f.subjectId) {
      const rm = h('button', { class: 'btn danger', type: 'button' }, `Stop sharing with ${f.subjectName}`);
      rm.onclick = () => busy(rm, async () => {
        if (!confirm(`${f.subjectName} will lose access to this forecast. What she already shared stays here. Continue?`)) return;
        await Api.remove(f.id);
        f.subjectId = null; f.subjectName = null;
        closePanel(); renderTabs(); render(); toast('Sharing ended');
      });
      danger.push(rm);
    } else if (f.hasPendingInvite) {
      const c = h('button', { class: 'btn quiet', type: 'button' }, 'Cancel the open invite');
      c.onclick = () => busy(c, async () => { await Api.cancelInvite(f.id); f.hasPendingInvite = false; closePanel(); renderTabs(); render(); toast('Invite cancelled'); });
      danger.push(c);
    }
    const del = h('button', { class: 'btn danger', type: 'button' }, 'Delete this forecast');
    del.onclick = () => busy(del, async () => {
      if (!confirm('This permanently deletes every entry on this forecast, for both of you. Continue?')) return;
      let cur; for (let i = 0; i < 200; i++) { const r = await Api.destroy(f.id, cur); if (!r.more) break; cur = r.cursor; }
      S.forecasts = S.forecasts.filter(x => x.id !== f.id);
      delete S.raw[f.id];
      S.active = S.forecasts[0]?.id || null; Local.set('tab', S.active || '');
      closePanel(); renderTabs(); if (S.active) await refresh(S.active, true); render(); toast('Forecast deleted');
    });
    danger.push(del);

    return h('section', { class: 'sheet' },
      h('h3', { text: f.label }),
      group('Tab name', label), group('Relationship', rel), saveBtn,
      ...cycleSettings(f),
      h('div', { style: 'display:grid;gap:10px;margin-top:20px' }, danger));
  }

  function subjectSettings(f) {
    const leave = h('button', { class: 'btn danger', type: 'button' }, `Stop sharing with ${f.ownerName}`);
    const erase = h('input', { type: 'checkbox', id: 'eraseChk' });
    leave.onclick = () => busy(leave, async () => {
      const msg = erase.checked
        ? `Everything you wrote here will be deleted and ${f.ownerName} will lose access to your cycle. Continue?`
        : `${f.ownerName} will stop receiving anything new from you. What you already shared stays with them. Continue?`;
      if (!confirm(msg)) return;
      let cur; for (let i = 0; i < 200; i++) { const r = await Api.leave(f.id, erase.checked, cur); if (!r.more) break; cur = r.cursor; }
      S.forecasts = S.forecasts.filter(x => x.id !== f.id);
      delete S.raw[f.id];
      S.active = S.forecasts[0]?.id || null; Local.set('tab', S.active || '');
      closePanel(); renderTabs(); if (S.active) await refresh(S.active, true); render(); toast('You\u2019ve stopped sharing');
    });
    return h('section', { class: 'sheet' },
      h('h3', { text: `Shared with ${f.ownerName}` }),
      ...cycleSettings(f),
      h('div', { style: 'margin-top:20px;display:grid;gap:10px' },
        h('label', { class: 'row small' }, erase, 'Also erase everything I shared'),
        leave));
  }

  function accountSettings() {
    const gbox = h('div');
    const sec = h('section', { class: 'sheet' },
      h('h3', { text: `Signed in as ${S.me.person.displayName}` }));
    if (S.me.hasGoogle) {
      sec.append(h('p', { class: 'small muted', text: 'Google is linked, so you can sign in on any device.' }));
    } else {
      sec.append(h('p', { class: 'small muted', text: 'Link Google to sign in on another device. Without it, this device is your only way in.' }), gbox);
      renderGoogle(gbox, 'link');
    }
    sec.append(h('button', { class: 'btn quiet', type: 'button', onclick: async () => {
      try { await Api.signOut(); } catch {}
      Local.set('session', ''); Local.set('tab', '');
      location.reload();
    } }, 'Sign out'));
    return sec;
  }

  // ── keep current ─────────────────────────────────────────────────────
  async function tick() {
    if (document.hidden || !S.active || !$('overlay').hidden) return;
    // Never re-render under someone who is typing or has a form open.
    const typing = [...document.querySelectorAll('#main textarea')].some(t => t.value.trim())
      || document.querySelector('#main .seg button[aria-pressed="true"], #main .chip[aria-pressed="true"]')
      || /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '');
    if (typing) return;
    const before = S.raw[S.active]?.size || 0;
    try {
      await refresh(S.active, false);
      if ((S.raw[S.active]?.size || 0) !== before) render();
    } catch {}
  }
  setInterval(tick, 60000);
  document.addEventListener('visibilitychange', tick);

  boot();
})();

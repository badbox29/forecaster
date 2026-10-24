/**
 * core.js — config, worker client, cycle math, entry resolution.
 * No DOM in here, so it can be tested on its own.
 */

// ── Local settings ─────────────────────────────────────────────────────────
// The worker address is entered on first run and kept here, so nothing
// about your deployment lives in the repo. localStorage holds only the
// worker address, the session token and the selected tab. The data key
// lives in IndexedDB (see vault.js). Entries are fetched fresh, so a deletion on one side can
// never linger in a cache on the other.
const Local = {
  get: k => { try { return localStorage.getItem('fc.' + k) || ''; } catch { return ''; } },
  set: (k, v) => { try { v ? localStorage.setItem('fc.' + k, v) : localStorage.removeItem('fc.' + k); } catch {} },
};

// ── Worker client ──────────────────────────────────────────────────────────
const Api = (() => {
  let base = '';
  let session = '';

  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  async function call(path, { method = 'GET', body } = {}) {
    if (!base) throw new ApiError('No sync address set', 0);
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (session) headers['Authorization'] = `Bearer ${session}`;
    let res;
    try {
      res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new ApiError('You look offline. Try again when you have a connection.', 0);
    }
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
    return data;
  }

  async function ping(url) {
    try {
      const r = await fetch(url.replace(/\/+$/, '') + '/');
      const j = await r.json();
      return j?.service === 'forecast';
    } catch { return false; }
  }

  const post = (p, b) => call(p, { method: 'POST', body: b || {} });

  return {
    ApiError, ping,
    setBase: u => { base = (u || '').replace(/\/+$/, ''); },
    getBase: () => base,
    setSession: s => { session = s || ''; },
    config:       () => call('/auth/config'),
    me:           () => call('/auth/me'),
    signup:       (b) => post('/auth/signup', b),
    recover:      (loginSecret) => post('/auth/recover', { loginSecret }),
    rekey:        (b) => post('/auth/rekey', b),
    invitePreview:(t) => call(`/auth/invite/${encodeURIComponent(t)}`),
    redeem:       (b) => post('/auth/invite/redeem', b),
    google:       (idToken) => post('/auth/google', { idToken }),
    googleLink:   (idToken) => post('/auth/google/link', { idToken }),
    signOut:      () => post('/auth/signout'),
    deleteAccount:() => post('/auth/delete'),
    createForecast: (b) => post('/forecasts', b),
    settings:     (fid, b) => call(`/f/${fid}/settings`, { method: 'PUT', body: b }),
    putKey:       (fid, wrappedKey) => call(`/f/${fid}/key`, { method: 'PUT', body: { wrappedKey } }),
    write:        (fid, entries) => post(`/f/${fid}/entries`, { entries }),
    sync:         (fid, since) => call(`/f/${fid}/sync?since=${since || ''}`),
    invite:       (fid) => post(`/f/${fid}/invite`),
    cancelInvite: (fid) => post(`/f/${fid}/invite/cancel`),
    remove:       (fid) => post(`/f/${fid}/remove`),
    leave:        (fid, erase, cursor) => post(`/f/${fid}/leave`, { erase, cursor }),
    destroy:      (fid, cursor) => post(`/f/${fid}/delete`, { cursor }),
  };
})();

// ── Dates ──────────────────────────────────────────────────────────────────
// Everything is a calendar date string in the device's own time zone.
// A period starts on a day, not at an instant.
const Dates = {
  today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
  // Noon UTC avoids every daylight-saving edge.
  toUTC: s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), 12),
  diff: (a, b) => Math.round((Dates.toUTC(b) - Dates.toUTC(a)) / 86400000),
  add(s, n) {
    const d = new Date(Dates.toUTC(s) + n * 86400000);
    return d.toISOString().slice(0, 10);
  },
  pretty(s, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
    return new Date(Dates.toUTC(s)).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
  },
};

// ── Entries ────────────────────────────────────────────────────────────────
// Append-only on the server. Here we fold supersedes and tombstones into
// the current picture.
function resolveEntries(raw) {
  const byId = new Map(raw.map(e => [e.id, e]));
  const replaced = new Set(raw.filter(e => e.supersedes).map(e => e.supersedes));
  return [...byId.values()]
    .filter(e => !replaced.has(e.id) && !e.deleted)
    .sort((a, b) => ((b.date || '').localeCompare(a.date || '')) || (b.createdAt - a.createdAt));
}

// ── Cycle ──────────────────────────────────────────────────────────────────
const Cycle = {
  /**
   * starts: YYYY-MM-DD strings. meta: { cycleLength, periodLength }.
   * Returns null when there is no start on or before `on`.
   */
  compute(starts, meta, on = Dates.today()) {
    const sorted = [...new Set(starts)].sort();
    const past = sorted.filter(s => s <= on);
    if (!past.length) return null;

    // Average of the last few real gaps, if there are any. Gaps outside a
    // plausible range are skipped: they are usually a missed log, not a
    // 70-day cycle.
    const gaps = [];
    for (let i = 1; i < past.length; i++) {
      const g = Dates.diff(past[i - 1], past[i]);
      if (g >= 18 && g <= 60) gaps.push(g);
    }
    const recent = gaps.slice(-6);
    const length = recent.length
      ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length)
      : (meta.cycleLength || 28);
    const learned = recent.length > 0;

    const start  = past.at(-1);
    const day    = Dates.diff(start, on) + 1;
    const period = meta.periodLength || 5;
    const ovDay  = Math.max(period + 2, length - 14);
    const next   = Dates.add(start, length);
    const late   = day > length;

    let phase;
    if (day <= period)          phase = 'menstrual';
    else if (day < ovDay - 1)   phase = 'follicular';
    else if (day <= ovDay + 1)  phase = 'ovulation';
    else if (day <= length - 5) phase = 'luteal';
    else if (!late)             phase = 'premenstrual';
    else                        phase = 'late';

    return { start, day, length, period, ovDay, next, late, phase, learned, daysToNext: Dates.diff(on, next) };
  },

  PHASES: {
    menstrual:    { name: 'Period',          front: 'Low-pressure system' },
    follicular:   { name: 'Follicular phase', front: 'Clearing skies' },
    ovulation:    { name: 'Ovulation window', front: 'High-pressure ridge' },
    luteal:       { name: 'Luteal phase',     front: 'Stable, warming' },
    premenstrual: { name: 'Late luteal',      front: 'Front approaching' },
    late:         { name: 'Past the predicted start', front: 'Front stalled' },
  },
};

// ── Readings vocabulary ────────────────────────────────────────────────────
// Ids are stored forever. Labels can change.
const Vocab = {
  mood:   [['good', 'Good'], ['okay', 'Okay'], ['rough', 'Rough']],
  energy: [['green', 'High'], ['yellow', 'Medium'], ['red', 'Low']],
  desire: [['green', 'High'], ['yellow', 'Medium'], ['red', 'Low']],
  social: [['home', 'Staying in'], ['either', 'Either way'], ['out', 'Going out']],
  symptoms: [
    ['hot_flashes', 'Hot flashes'], ['cramps', 'Cramps'], ['headache', 'Headache'],
    ['fatigue', 'Fatigue'], ['bloating', 'Bloating'], ['cravings', 'Cravings'],
    ['tender', 'Tenderness'], ['poor_sleep', 'Poor sleep'], ['irritable', 'Irritable'],
    ['acne', 'Breakouts'],
  ],
  label(field, id) { return (this[field] || []).find(([k]) => k === id)?.[1] || id; },
};

// Most recent value for each field on a given date. Her own report wins
// over his observation when both exist, because she is the instrument.
function readingsFor(entries, date, subjectId) {
  const out = {};
  const rs = entries.filter(e => e.kind === 'reading' && e.date === date)
    .sort((a, b) => {
      const sa = a.authorId === subjectId ? 1 : 0, sb = b.authorId === subjectId ? 1 : 0;
      return sa - sb || a.createdAt - b.createdAt;
    });
  for (const r of rs) {
    for (const f of ['mood', 'energy', 'desire', 'social']) {
      if (r.fields?.[f]) out[f] = { value: r.fields[f], by: r.authorRole };
    }
    if (r.fields?.symptoms?.length) {
      out.symptoms = [...new Set([...(out.symptoms || []), ...r.fields.symptoms])];
    }
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { Dates, Cycle, resolveEntries, readingsFor, Vocab };

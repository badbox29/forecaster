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

// ── Estimates for today's meters ───────────────────────────────────────────
//
// Each meter resolves in this order:
//   logged     a reading for today exists
//   previous   readings from her own past cycles at the same point
//   projected  a general pattern for this phase
//
// "The same point" depends on the phase. The first half of a cycle varies
// in length from cycle to cycle; the second half (ovulation to the next
// period) is much steadier. So early days are matched by day since the
// period started, and later days by days until the next one. That is what
// lets a 26-day cycle and a 31-day cycle line up sensibly.
//
// The projected table is deliberately mild. These are broad tendencies
// reported in the literature, individual variation is large, and the only
// job of a projection is to be replaced by her own history.
const TYPICAL = {
  menstrual:    { mood: 'okay', energy: 'yellow', desire: 'yellow', social: 'home' },
  follicular:   { mood: 'good', energy: 'green',  desire: 'yellow', social: 'out' },
  ovulation:    { mood: 'good', energy: 'green',  desire: 'green',  social: 'out' },
  luteal:       { mood: 'okay', energy: 'yellow', desire: 'yellow', social: 'either' },
  premenstrual: { mood: 'okay', energy: 'yellow', desire: 'red',    social: 'home' },
};
const ORDINAL = { mood: ['rough', 'okay', 'good'], energy: ['red', 'yellow', 'green'], desire: ['red', 'yellow', 'green'] };
const EARLY = new Set(['menstrual', 'follicular']);

function estimateReadings(entries, starts, meta, subjectId, on = Dates.today()) {
  const out = {};
  const logged = readingsFor(entries, on, subjectId);
  for (const [f, r] of Object.entries(logged)) if (f !== 'symptoms') out[f] = { ...r, source: 'logged' };

  const cycle = Cycle.compute(starts, meta, on);
  if (!cycle) return { meters: out, cycle: null, symptoms: logged.symptoms || [] };

  // Past, completed cycles only: [start, nextStart)
  const sorted = [...new Set(starts)].sort().filter(s => s < cycle.start);
  sorted.push(cycle.start);
  const windows = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const len = Dates.diff(sorted[i], sorted[i + 1]);
    if (len >= 18 && len <= 60) windows.push([sorted[i], sorted[i + 1]]);
  }

  const early = EARLY.has(cycle.phase);
  const target = early ? cycle.day : cycle.daysToNext;
  const hist = { mood: [], energy: [], desire: [], social: [] };
  const cyclesSeen = new Set();
  if (cycle.phase !== 'late') {
    for (const e of entries) {
      if (e.kind !== 'reading') continue;
      const w = windows.find(([a, b]) => e.date >= a && e.date < b);
      if (!w) continue;
      const pos = early ? Dates.diff(w[0], e.date) + 1 : Dates.diff(e.date, w[1]);
      if (Math.abs(pos - target) > 1) continue;
      for (const f of Object.keys(hist)) {
        if (e.fields?.[f]) { hist[f].push({ v: e.fields[f], at: e.date }); cyclesSeen.add(f + w[0]); }
      }
    }
  }

  const typical = TYPICAL[cycle.phase === 'late' ? 'premenstrual' : cycle.phase];
  for (const f of ['mood', 'energy', 'desire', 'social']) {
    if (out[f]) continue;
    const vals = hist[f];
    if (vals.length) {
      let value;
      if (ORDINAL[f]) {
        const avg = vals.reduce((a, x) => a + ORDINAL[f].indexOf(x.v), 0) / vals.length;
        value = ORDINAL[f][Math.round(avg)];
      } else {
        const count = {};
        for (const x of vals) count[x.v] = (count[x.v] || 0) + 1;
        const best = Math.max(...Object.values(count));
        value = vals.filter(x => count[x.v] === best).sort((a, b) => b.at.localeCompare(a.at))[0].v;
      }
      const cycles = [...cyclesSeen].filter(k => k.startsWith(f)).length;
      out[f] = { value, source: 'previous', cycles };
    } else {
      out[f] = { value: typical[f], source: 'projected' };
    }
  }
  return { meters: out, cycle, symptoms: logged.symptoms || [] };
}

if (typeof module !== 'undefined') module.exports = { Dates, Cycle, resolveEntries, readingsFor, Vocab, estimateReadings };

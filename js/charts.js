/**
 * charts.js — the two reference panels beside Today.
 *
 * Both return SVG markup built only from numbers and fixed labels. No user
 * text ever goes into these strings, so they are safe to set as innerHTML.
 *
 * Every curve is drawn against HER cycle length, with ovulation placed 14
 * days before the next period, so the chart lines up with the dial.
 */
const Charts = (() => {

  // Drawn at the container's real pixel width (one SVG unit = one CSS
  // pixel), so labels stay the same size on a phone and on a desktop.
  let W = 400, R0 = 392;
  const H = 214, L0 = 34, T0 = 16, B0 = 172;
  function setWidth(w) { W = Math.round(Math.max(280, Math.min(720, w || 400))); R0 = W - 8; }
  const gauss = (x, mu, sd) => Math.exp(-((x - mu) ** 2) / (2 * sd * sd));
  const fx = (d, len) => L0 + ((d - 1) / (len - 1)) * (R0 - L0);
  const path = pts => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');

  const PHASE_COLOR = { menstrual: '--warm', follicular: '--cold', ovulation: '--sun', luteal: '--occl', premenstrual: '--occl' };

  function phaseStrip(len, period, y, h) {
    let s = '';
    for (let d = 1; d <= len; d++) {
      const ph = Cycle.phaseOf(d, len, period);
      const x0 = fx(d - 0.5, len), x1 = fx(d + 0.5, len);
      s += `<rect x="${Math.max(L0, x0).toFixed(1)}" y="${y}" width="${(Math.min(R0, x1) - Math.max(L0, x0)).toFixed(1)}" height="${h}" style="fill:var(${PHASE_COLOR[ph]})" opacity="${ph === 'premenstrual' ? .55 : .9}"/>`;
    }
    return s;
  }

  function dayAxis(len, y, size = 12) {
    let s = '';
    const marks = [1, 7, 14, 21, len].filter((v, i, a) => v <= len && a.indexOf(v) === i);
    for (const d of marks) {
      s += `<text x="${fx(d, len).toFixed(1)}" y="${y}" text-anchor="middle" font-size="${size}" style="fill:var(--ink-3)">${d}</text>`;
    }
    return s;
  }

  function todayLine(day, len, y0, y1, label = true) {
    if (!day || day > len) return '';
    const x = fx(day, len).toFixed(1);
    return `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}" style="stroke:var(--ink)" stroke-width="1.5" stroke-dasharray="3 3"/>`
      + (label ? `<text x="${x}" y="${y0 - 3}" text-anchor="middle" font-size="11" font-weight="600" style="fill:var(--ink)">today</text>` : '');
  }

  // ── hormones ─────────────────────────────────────────────────────────
  // Shapes, not measurements: estrogen rises through the follicular phase
  // and peaks just before ovulation, dips, then makes a second smaller rise
  // mid-luteal. LH spikes briefly to trigger ovulation. Progesterone stays
  // low until ovulation, peaks about a week after, and falls before the
  // period. Each is scaled to its own peak; they are not comparable units.
  function hormoneLevels(d, len) {
    const ov = len - 14;
    return {
      estrogen: 0.16 + 0.78 * gauss(d, ov - 1, 2.4) + 0.42 * gauss(d, ov + 7, 3.2),
      progesterone: 0.05 + 0.85 * gauss(d, ov + 7, 3.1),
      lh: 0.08 + 0.86 * gauss(d, ov - 0.4, 0.75),
    };
  }

  function hormones({ length, period, day, width, context = {} }) {
    setWidth(width);
    const top = T0 + 12, bottom = B0 - 6;
    const y = v => bottom - v * (bottom - top);
    const series = { estrogen: [], progesterone: [], lh: [] };
    for (let d = 1; d <= length; d += 0.2) {
      const v = hormoneLevels(d, length);
      for (const k in series) series[k].push([fx(d, length), y(v[k])]);
    }
    // Perimenopause: a band for how far estrogen can swing, and a lower,
    // dashed progesterone for cycles that don't ovulate.
    let band = '', lowP = '';
    if (context.perimenopause) {
      const up = [], dn = [];
      for (let d = 1; d <= length; d += 0.2) {
        const e = hormoneLevels(d, length).estrogen;
        up.push([fx(d, length), y(Math.min(1.05, e * 1.45 + 0.05))]);
        dn.push([fx(d, length), y(Math.max(0.03, e * 0.5))]);
      }
      band = `<path d="${path(up)} ${path(dn.reverse()).replace(/^M/, 'L')} Z" style="fill:var(--cold-sk)"/>`;
      lowP = `<path d="${path(series.progesterone.map(([x, yy]) => [x, bottom - (bottom - yy) * 0.45]))}" fill="none" style="stroke:var(--calm)" stroke-width="2" stroke-dasharray="2 4"/>`;
    }
    const line = (k, color, w, dash = '') =>
      `<path d="${path(series[k])}" fill="none" style="stroke:var(${color})" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Typical estrogen, progesterone and LH across a ${length}-day cycle">
      <line x1="${L0}" y1="${bottom}" x2="${R0}" y2="${bottom}" style="stroke:var(--rule)"/>
      <text x="${L0 - 6}" y="${top + 4}" text-anchor="end" font-size="12" style="fill:var(--ink-3)">high</text>
      <text x="${L0 - 6}" y="${bottom}" text-anchor="end" font-size="12" style="fill:var(--ink-3)">low</text>
      <g opacity="${context.hormonalBC ? .4 : 1}">
      ${band}
      ${line('lh', '--sun', 2, '4 3')}
      ${line('estrogen', '--cold', 3)}
      ${line('progesterone', '--calm', 3)}
      ${lowP}
      </g>
      ${todayLine(day, length, top, bottom)}
      ${phaseStrip(length, period, B0, 8)}
      ${dayAxis(length, B0 + 24)}
    </svg>`;
  }

  // ── her pattern against the typical one ──────────────────────────────
  const FIELDS = {
    mood:   { levels: ['rough', 'okay', 'good'], low: 'low', high: 'high' },
    energy: { levels: ['red', 'yellow', 'green'], low: 'low', high: 'high' },
    desire: { levels: ['red', 'yellow', 'green'], low: 'low', high: 'high' },
    social: { levels: ['home', 'either', 'out'], low: 'in', high: 'out' },
  };

  // The typical curve is the projected table from core.js, smoothed over
  // five days and wrapped around the cycle, so it agrees with the meters.
  function typicalCurve(field, len, period, table = TYPICAL) {
    const raw = [];
    for (let d = 1; d <= len; d++) raw.push(FIELDS[field].levels.indexOf(table[Cycle.phaseOf(d, len, period)][field]));
    return raw.map((_, i) => {
      let sum = 0;
      for (let k = -2; k <= 2; k++) sum += raw[(i + k + len) % len];
      return sum / 5;
    });
  }

  /**
   * Place each reading on the reference cycle. Early days align by day
   * since the period started, later days by days until the next one, the
   * same rule the meters use, so a 26-day and a 31-day cycle line up.
   */
  function placeReadings(entries, starts, len, period, nextPredicted) {
    const s = [...new Set(starts)].sort();
    const ends = [...s.slice(1), nextPredicted];
    const pts = { mood: [], energy: [], desire: [], social: [] };
    for (const e of entries) {
      if (e.kind !== 'reading') continue;
      let i = -1;
      for (let j = 0; j < s.length; j++) if (s[j] <= e.date) i = j;
      if (i < 0) continue;
      const cLen = Dates.diff(s[i], ends[i]);
      if (cLen < 18 || cLen > 60) continue;
      const dfs = Dates.diff(s[i], e.date) + 1;
      if (dfs > cLen) continue;
      const x = dfs <= cLen - 14 ? Math.min(dfs, len - 14) : len - (cLen - dfs);
      for (const f in pts) {
        const lv = e.fields?.[f] ? FIELDS[f].levels.indexOf(e.fields[f]) : -1;
        if (lv >= 0) pts[f].push({ x, v: lv, cycle: i });
      }
    }
    return pts;
  }

  /** One small chart per measure, plus a one-line comparison. */
  function pattern({ entries, starts, length, period, day, next, fields, width, table }) {
    setWidth(width);
    const pts = placeReadings(entries, starts, length, period, next);
    const out = [];
    for (const f of fields) {
      const h = 98, top = 8, bottom = 74;
      const y = v => bottom - (v / 2) * (bottom - top);
      const typ = typicalCurve(f, length, period, table || TYPICAL);
      const typPath = path(typ.map((v, i) => [fx(i + 1, length), y(v)]));

      // Her line: average per placed day.
      const byX = new Map();
      for (const p of pts[f]) { const a = byX.get(p.x) || []; a.push(p.v); byX.set(p.x, a); }
      const avg = [...byX].map(([x, a]) => [x, a.reduce((m, n) => m + n, 0) / a.length]).sort((a, b) => a[0] - b[0]);
      const dots = pts[f].map(p => `<circle cx="${fx(p.x, length).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3.2" style="fill:var(--ink)" opacity=".35"/>`).join('');
      const herLine = avg.length > 1 ? `<path d="${path(avg.map(([x, v]) => [fx(x, length), y(v)]))}" fill="none" style="stroke:var(--ink)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>` : '';

      // How she compares, only once there is enough to say anything.
      // Compared half by half, because a single average lets a high first
      // half cancel a low second half and call the whole thing typical.
      let verdict = null;
      if (pts[f].length >= 3) {
        const ov = length - 14;
        const half = sel => {
          const ps = pts[f].filter(sel);
          if (ps.length < 2) return null;
          return ps.reduce((a, p) => a + (p.v - typ[Math.round(p.x) - 1]), 0) / ps.length;
        };
        verdict = { before: half(p => p.x <= ov), after: half(p => p.x > ov) };
      }

      const svg = `<svg class="chart mini" viewBox="0 0 ${W} ${h}" aria-hidden="true">
        <rect x="${L0}" y="${top}" width="${R0 - L0}" height="${(bottom - top) / 3}" style="fill:var(--calm-sk)"/>
        <rect x="${L0}" y="${top + (bottom - top) / 3}" width="${R0 - L0}" height="${(bottom - top) / 3}" style="fill:var(--sun-sk)"/>
        <rect x="${L0}" y="${top + 2 * (bottom - top) / 3}" width="${R0 - L0}" height="${(bottom - top) / 3}" style="fill:var(--warm-sk)"/>
        <text x="${L0 - 6}" y="${top + 9}" text-anchor="end" font-size="12" style="fill:var(--ink-3)">${FIELDS[f].high}</text>
        <text x="${L0 - 6}" y="${bottom}" text-anchor="end" font-size="12" style="fill:var(--ink-3)">${FIELDS[f].low}</text>
        <path d="${typPath}" fill="none" style="stroke:var(--ink-2)" stroke-width="2" stroke-dasharray="5 4"/>
        ${dots}${herLine}
        ${todayLine(day, length, top, bottom, false)}
        ${phaseStrip(length, period, bottom + 4, 5)}
        ${dayAxis(length, bottom + 18)}
      </svg>`;
      out.push({ field: f, svg, count: pts[f].length, cycles: new Set(pts[f].map(p => p.cycle)).size, verdict });
    }
    return out;
  }

  return { hormones, pattern };
})();

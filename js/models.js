/**
 * models.js — two forecast models, one person's weather.
 *
 *   Her model   what she reports about herself. Always the authority.
 *   His model   what he reads from the outside.
 *
 * The score measures how well he reads her, never whether she is "right".
 * Only reads he made blind count toward accuracy: before her report for
 * that day existed, or while it was sealed by "make your call first". A
 * read logged after he could already see hers is shown but not scored.
 *
 * Plain data and plain text in, plain data and plain text out. The only
 * markup is a chart built from numbers.
 */
const Models = (() => {

  const LEVELS = {
    mood: ['rough', 'okay', 'good'],
    energy: ['red', 'yellow', 'green'],
    desire: ['red', 'yellow', 'green'],
    social: ['home', 'either', 'out'],
  };
  const lv = (f, v) => LEVELS[f].indexOf(v);

  /** Desire is only compared if SHE opted in. Her latest pref entry wins. */
  function desireOptIn(entries) {
    const prefs = entries.filter(e => e.kind === 'pref' && e.authorRole === 'subject')
      .sort((a, b) => b.createdAt - a.createdAt);
    return !!prefs[0]?.fields?.scoreDesire;
  }

  /**
   * Per day:
   *   her      her CURRENT values (latest per field), for the model card
   *   his      his values: his first read if it was a blind call, else latest
   *   herAt    her values as they stood when he made his call, which is what
   *            his call is scored against. If she hadn't logged yet, her
   *            first report after the call.
   *   shifts   fields where she updated after his call
   */
  function byDay(entries, fields) {
    const days = new Map();
    const sorted = entries.filter(e => e.kind === 'reading').sort((a, b) => a.createdAt - b.createdAt);
    for (const e of sorted) {
      if (!days.has(e.date)) days.set(e.date, { hers: [], his: [] });
      days.get(e.date)[e.authorRole === 'subject' ? 'hers' : 'his'].push(e);
    }
    const out = new Map();
    for (const [date, d] of days) {
      const latest = list => {
        const o = {};
        for (const e of list) for (const f of fields) if (e.fields?.[f]) o[f] = e.fields[f];
        return o;
      };
      const her = latest(d.hers);
      const call = d.his[0] || null;
      const herFirstAt = d.hers[0]?.createdAt ?? null;
      const called = !!call && (!!call.fields?.called || herFirstAt == null || call.createdAt < herFirstAt);
      const his = called ? latest([call]) : latest(d.his);
      const herAt = {}, shifts = [];
      if (call) {
        for (const f of fields) {
          const before = d.hers.filter(e => e.fields?.[f] && e.createdAt <= call.createdAt).at(-1);
          const after = d.hers.find(e => e.fields?.[f] && e.createdAt > call.createdAt);
          const ref = before || after;
          if (!ref) continue;
          herAt[f] = ref.fields[f];
          if (called && her[f] && her[f] !== herAt[f]) {
            const last = d.hers.filter(e => e.fields?.[f]).at(-1);
            shifts.push({ field: f, from: herAt[f], to: her[f], at: last.createdAt });
          }
        }
      }
      out.set(date, { her, his, herAt: call ? herAt : her, called, shifts, hisAt: call?.createdAt ?? null });
    }
    return out;
  }

  /** Agreement for one day: 1 match, 0.5 one step apart, 0 opposite ends. */
  function compareDay(d, fields) {
    const per = {};
    let sum = 0, n = 0;
    for (const f of fields) {
      const a = d.herAt[f], b = d.his[f];
      if (!a || !b) continue;
      const diff = lv(f, b) - lv(f, a);          // + means he read her higher
      const agree = diff === 0 ? 1 : Math.abs(diff) === 1 ? 0.5 : 0;
      per[f] = { her: a, his: b, diff, agree };
      sum += agree; n++;
    }
    return { per, score: n ? sum / n : null, n };
  }

  /** Everything the panel needs. */
  function summary(entries, { today, scoreDesire }) {
    const fields = ['mood', 'energy', 'social', ...(scoreDesire ? ['desire'] : [])];
    const days = byDay(entries, [...fields, 'desire']);
    const todayDay = days.get(today) || { her: {}, his: {}, herAt: {}, called: false, shifts: [] };
    const todayCmp = compareDay(todayDay, fields);

    const series = [];
    for (let i = 29; i >= 0; i--) {
      const date = Dates.add(today, -i);
      const d = days.get(date);
      const c = d && d.called ? compareDay(d, fields) : null;
      series.push({ date, score: c && c.n ? c.score : null });
    }
    const window = n => {
      const pts = series.slice(-n).filter(p => p.score != null);
      return pts.length ? { score: pts.reduce((a, p) => a + p.score, 0) / pts.length, days: pts.length } : null;
    };

    // Bias: does he consistently read her higher or lower, per field?
    const since7 = Dates.add(today, -6);
    const bias = {};
    for (const f of fields) {
      const diffs = [];
      for (const [date, d] of days) {
        if (date < since7 || date > today || !d.called) continue;
        const c = compareDay(d, [f]).per[f];
        if (c) diffs.push(c.diff);
      }
      if (diffs.length >= 3) bias[f] = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    }

    // Streak of days in a row (most recent first) with a score under 50%.
    let missStreak = 0, matchStreak = 0;
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i].score == null) continue;
      if (series[i].score < 0.5) { if (matchStreak) break; missStreak++; }
      else if (series[i].score === 1) { if (missStreak) break; matchStreak++; }
      else break;
    }

    // Overall conditions per model today, from mood and energy.
    const condition = side => {
      const vals = ['mood', 'energy'].map(f => todayDay[side][f] ? lv(f, todayDay[side][f]) : null).filter(v => v != null);
      if (!vals.length) return null;
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      return avg >= 1.5 ? 'green' : avg >= 0.75 ? 'yellow' : 'red';
    };

    return {
      fields, today: todayCmp, todayCalled: !!todayDay.called,
      her: condition('her'), his: condition('his'),
      series, s7: window(7), s30: window(30), bias, missStreak, matchStreak,
      hasHer: Object.keys(todayDay.her).length > 0, hasHis: Object.keys(todayDay.his).length > 0,
      shifts: todayDay.shifts || [],
    };
  }

  // ── forecast discussion ──────────────────────────────────────────────
  const NAMES = { mood: 'mood', energy: 'energy', desire: 'desire', social: 'social battery' };

  function discussion(s, { herModel, hisModel, partner }) {
    const lines = [];
    const t = s.today;

    if (s.hasHer && s.hasHis && t.n) {
      if (t.score === 1) {
        lines.push(`Both models agree on every measure today. Confidence is unusually high.`
          + (partner ? ' The partner is cautioned against interpreting consensus as authorization.' : ''));
      } else if (t.score === 0) {
        lines.push(`The ${hisModel} and the ${herModel} disagree on everything today. Meteorologists suspect a calibration issue in the ${hisModel}.`);
      } else {
        const misses = Object.entries(t.per).filter(([, c]) => c.agree < 1).map(([f]) => NAMES[f]);
        lines.push(`The models agree in part. Divergence on ${misses.join(' and ')}. The ${herModel} is authoritative; the ${hisModel} has been notified.`);
      }
      if (!s.todayCalled) lines.push(`Today\u2019s ${hisModel} reading was filed after the ${herModel} report was visible, so it doesn\u2019t count toward accuracy.`);
      for (const sh of s.shifts) {
        const time = new Date(sh.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        lines.push(`Conditions changed after the ${hisModel} filed: ${NAMES[sh.field]} ${Vocab.label(sh.field, sh.from).toLowerCase()} \u2192 ${Vocab.label(sh.field, sh.to).toLowerCase()} at ${time}. The call is scored against conditions when it was made.`);
      }
    } else if (s.hasHer && !s.hasHis) {
      lines.push(`The ${herModel} has reported. The ${hisModel} has yet to file an observation.`);
    } else if (!s.hasHer && s.hasHis) {
      lines.push(`The ${hisModel} has filed today. Awaiting ground truth from the ${herModel}.`);
    } else {
      lines.push('No observations from either model today. Conditions remain a mystery to science.');
    }

    // Bias over the week.
    const pos = Object.entries(s.bias).filter(([, b]) => b >= 0.5).map(([f]) => f);
    const neg = Object.entries(s.bias).filter(([, b]) => b <= -0.5).map(([f]) => f);
    if (pos.length) {
      const social = pos.includes('social') && pos.length === 1;
      lines.push(social
        ? `The ${hisModel} keeps forecasting a night out while the ${herModel} reports a night in. Seven-day trend confirmed.`
        : `The ${hisModel} has shown a persistent optimism bias on ${pos.map(f => NAMES[f]).join(' and ')} over the past week. Officials are investigating whether wishful thinking has contaminated the observational data.`);
    }
    if (neg.length) {
      lines.push(`The ${hisModel} has been reading ${neg.map(f => NAMES[f]).join(' and ')} lower than reported all week. Excess caution is still a calibration error.`);
    }

    if (s.missStreak >= 3) lines.push(`${s.missStreak} days running below 50% agreement. Funding for the ${hisModel} is currently under review.`);
    if (s.matchStreak >= 3) lines.push(`${s.matchStreak} perfect days in a row. The ${hisModel} is being studied by other households.`);

    if (s.s30 && s.s30.days >= 7) {
      if (s.s30.score >= 0.8) lines.push(`Over 30 days the ${hisModel} now outperforms climatology. Funding renewed.`);
      else if (s.s30.score < 0.45) lines.push(`The ${herModel} continues to outperform all competing guidance.`);
    }
    return lines;
  }

  // ── accuracy chart ───────────────────────────────────────────────────
  function chart(series, width) {
    const W = Math.round(Math.max(280, Math.min(720, width || 400)));
    const H = 120, L = 40, R = W - 8, T = 10, B = 92;
    const x = i => L + (i / (series.length - 1)) * (R - L);
    const y = v => B - v * (B - T);
    const pts = series.map((p, i) => p.score == null ? null : [x(i), y(p.score)]);
    let line = '';
    let pen = false;
    for (const p of pts) {
      if (!p) { pen = false; continue; }
      line += `${pen ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)} `;
      pen = true;
    }
    const dots = pts.filter(Boolean).map(([px, py]) => `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.5" style="fill:var(--ink)"/>`).join('');
    const grid = [0, 0.5, 1].map(v => `<line x1="${L}" y1="${y(v)}" x2="${R}" y2="${y(v)}" style="stroke:var(--rule)" stroke-dasharray="${v === 0.5 ? '3 4' : ''}"/>
      <text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="12" style="fill:var(--ink-3)">${Math.round(v * 100)}%</text>`).join('');
    const labels = [[0, '30 days ago'], [series.length - 1, 'today']].map(([i, t]) =>
      `<text x="${x(i).toFixed(1)}" y="${B + 20}" text-anchor="${i ? 'end' : 'start'}" font-size="12" style="fill:var(--ink-3)">${t}</text>`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily agreement over the last 30 days">
      <rect x="${L}" y="${y(1)}" width="${R - L}" height="${y(0.5) - y(1)}" style="fill:var(--calm)" opacity=".12"/>
      ${grid}<path d="${line}" fill="none" style="stroke:var(--ink)" stroke-width="2.4" stroke-linejoin="round"/>${dots}${labels}
    </svg>`;
  }

  return { desireOptIn, summary, discussion, chart, LEVELS };
})();

/**
 * insights.js — what changes when a life stage is switched on.
 *
 * Plain text only (no markup), so app.js can render it with textContent.
 * Every block says what is generally true and, where her own logs say
 * something, what HER data shows. Nothing here diagnoses; the app cannot
 * tell anyone they are in perimenopause, only show what the logs look like
 * next to the criteria researchers use.
 *
 * Sources for the perimenopause material: the STRAW+10 staging criteria
 * (Harlow et al., 2012) and findings from SWAN, the Study of Women's Health
 * Across the Nation.
 */
const Insights = (() => {

  const CONTEXTS = [
    ['perimenopause', 'Perimenopause', 'The years of change before periods stop for good.'],
    ['hormonalBC', 'Hormonal birth control', 'Pill, patch, ring, shot, implant or hormonal IUD.'],
    ['postpartum', 'Postpartum or breastfeeding', 'The first year or so after a baby.'],
  ];

  const PERI_SYMPTOMS = ['hot_flashes', 'night_sweats', 'poor_sleep', 'brain_fog', 'irritable', 'anxious', 'joint_aches', 'heavy_flow', 'palpitations'];

  function words(you) {
    return you
      ? { her: 'your', she: 'you', She: 'You', hers: 'yours', is: 'are', has: 'have', logs: 'log' }
      : { her: 'her', she: 'she', She: 'She', hers: 'hers', is: 'is', has: 'has', logs: 'logs' };
  }

  // ── perimenopause ────────────────────────────────────────────────────
  function perimenopause({ entries, starts, cycle, you, today }) {
    const w = words(you);
    const blocks = [];
    const gaps = cycleGaps(starts);
    const recent = gaps.slice(-8);

    // What her own cycle lengths show, against STRAW+10.
    let cyc;
    if (recent.length < 2) {
      cyc = {
        title: `${you ? 'Your' : 'Her'} cycle lengths`,
        paras: [`Log a few more period starts to see how much ${w.her} cycle varies. In perimenopause, the spread between cycles is the most telling thing to watch.`],
      };
    } else {
      const lens = recent.map(g => g.days);
      let maxJump = 0;
      for (let i = 1; i < lens.length; i++) maxJump = Math.max(maxJump, Math.abs(lens[i] - lens[i - 1]));
      const jumps7 = lens.slice(1).filter((d, i) => Math.abs(d - lens[i]) >= 7).length;
      const long60 = lens.filter(d => d >= 60).length;
      const paras = [`Last ${lens.length} cycles: ${lens.join(', ')} days. Shortest ${Math.min(...lens)}, longest ${Math.max(...lens)}.`];
      if (long60) {
        paras.push(`${long60 === 1 ? 'One gap' : `${long60} gaps`} of 60 days or more. In STRAW+10, the staging system researchers use, a gap that long marks the late menopausal transition, which on average starts about two years before the final period.`);
      } else if (jumps7 >= 2) {
        paras.push(`Back-to-back cycles differ by 7 days or more ${jumps7} times. STRAW+10 uses a persistent difference like that to mark the early menopausal transition.`);
      } else if (jumps7 === 1) {
        paras.push(`One pair of back-to-back cycles differs by 7 days or more. STRAW+10 looks for a difference that persists, so it\u2019s worth watching over the next few cycles.`);
      } else {
        paras.push(`So far back-to-back cycles stay within ${maxJump} days of each other. Some people see little change in cycle length right up to their last period.`);
      }
      paras.push('This compares logs to published criteria. It isn\u2019t a diagnosis; a clinician looks at the whole picture.');
      cyc = { title: `${you ? 'Your' : 'Her'} cycle lengths`, paras };
    }
    blocks.push(cyc);

    // What she has logged lately that tends to come with the transition.
    const since = Dates.add(today, -30);
    const counts = {};
    for (const e of entries) {
      if (e.kind !== 'reading' || e.date < since) continue;
      for (const s of e.fields?.symptoms || []) if (PERI_SYMPTOMS.includes(s)) counts[s] = (counts[s] || 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    blocks.push({
      title: 'Logged in the last 30 days',
      paras: top.length
        ? [top.map(([s, n]) => `${Vocab.label('symptoms', s)} \u00d7${n}`).join(', ') + '.']
        : [`Nothing transition-related yet. The check-in now includes night sweats, brain fog, joint aches, heavy flow, palpitations and feeling anxious, so they can be tracked alongside everything else.`],
    });

    blocks.push({
      title: 'How it differs from younger cycles',
      list: [
        `Hormones swing instead of cycling. Estrogen can run higher than in ${w.her} younger cycles at some points and drop sharply at others. Progesterone is often lower, because more cycles skip ovulation.`,
        'Cycle length gets less predictable, and heavier or longer bleeding is common.',
        'Hot flashes and night sweats are the best-known change. In SWAN, up to 80% of women reported them at some point during the transition.',
        'Sleep often gets worse, sometimes before anything else changes, and poor sleep can drive fatigue and irritability on its own.',
        'Low mood, irritability and anxiety are more common, and may follow sleep and hot flashes more than the cycle phase.',
        'Brain fog is common and shows up on memory tests, but research suggests it tends to improve after menopause.',
        'Desire often drops, partly from hormones and partly from sleep and comfort.',
      ],
    });

    blocks.push({
      title: 'What this means for the forecast',
      paras: [
        `The next period is shown as a range instead of a single date, built from the spread of ${w.her} own recent cycles.`,
        `The projected meters assume a textbook cycle, so they fit less well now. ${w.She} ${w.her === 'your' ? 'get' : 'gets'} more out of logging: once there\u2019s history, the meters follow ${w.hers} instead.`,
      ],
    });

    blocks.push({
      title: 'Worth raising with a clinician',
      tone: 'care',
      list: [
        'Very heavy bleeding, such as soaking a pad or tampon every hour or two, or periods lasting much longer than usual.',
        'Bleeding between periods or after sex, or periods closer together than 21 days.',
        'Any bleeding after 12 months without a period.',
        'Mood changes that last for weeks or get in the way of daily life.',
        'Symptoms that are disrupting sleep or work. There are effective treatments for hot flashes and sleep problems.',
      ],
    });
    return blocks;
  }

  // ── hormonal birth control ───────────────────────────────────────────
  function hormonalBC({ you }) {
    const w = words(you);
    return [
      {
        title: 'What changes',
        list: [
          'Combined methods (most pills, the patch and the ring) usually stop ovulation. The bleed during the break week is a withdrawal bleed, not a true period.',
          'Because of that, the ovulation window and the hormone chart describe a natural cycle that mostly isn\u2019t happening. Treat them as background, not a forecast.',
          'Progestin-only methods vary. A hormonal IUD often makes periods lighter or stops them while ovulation may continue. The shot and the implant often stop ovulation and can make bleeding irregular.',
          `Mood, energy and symptoms are still worth logging. Some people notice patterns tied to the pill pack or to a new method, and ${w.her} own history will show it.`,
        ],
      },
      {
        title: 'Worth raising with a clinician',
        tone: 'care',
        list: [
          'Mood changes after starting or switching a method.',
          'Bleeding that\u2019s heavy, very frequent, or new after months of nothing.',
          'Severe headaches, especially with vision changes, or leg pain or swelling. With estrogen-containing methods these need prompt attention.',
        ],
      },
    ];
  }

  // ── postpartum ───────────────────────────────────────────────────────
  function postpartum({ you }) {
    const w = words(you);
    return [
      {
        title: 'What changes',
        list: [
          'Breastfeeding often delays periods for months. Without breastfeeding, they commonly return within a couple of months.',
          'Ovulation can return before the first period, so a missing period doesn\u2019t mean no chance of pregnancy.',
          'The first cycles back are often irregular, so predictions will be rough until a few starts are logged.',
          `Sleep loss alone can flatten energy and mood, whatever ${w.her} cycle is doing.`,
        ],
      },
      {
        title: 'Worth raising with a clinician',
        tone: 'care',
        list: [
          'Low mood, anxiety or tearfulness that lasts more than about two weeks, or thoughts of self-harm. That can be postpartum depression, which is common and treatable.',
          'Very heavy bleeding, fever, or pain that\u2019s getting worse.',
        ],
      },
    ];
  }

  // ── for the advisory and hormone panel ───────────────────────────────
  function advisoryLine(context, partner) {
    if (context.perimenopause) return partner
      ? 'Perimenopause mode: forecasts run wider than usual. Sleep and temperature are the big levers, so keep the bedroom cool and the patience warm.'
      : 'Perimenopause mode: forecasts run wider than usual, and sleep often matters more than the calendar.';
    if (context.hormonalBC) return 'Birth control mode: the phase-based forecast is background only. Go by what she logs.';
    if (context.postpartum) return 'Postpartum mode: sleep is the main weather system. Take the night shift where you can.';
    return null;
  }

  function hormoneCaveat(context, you) {
    const her = you ? 'your' : 'her';
    if (context.hormonalBC) return `With most hormonal birth control these natural swings are largely replaced by a steady dose, so this chart may not reflect ${her} body.`;
    if (context.perimenopause) return `In perimenopause the shaded band shows how far estrogen can swing above and below the usual curve, and progesterone often stays lower when a cycle doesn\u2019t ovulate.`;
    if (context.postpartum) return `While periods are still returning after a baby, hormones may not follow this pattern yet.`;
    return null;
  }

  function build(ctx, data) {
    const out = [];
    if (ctx.perimenopause) out.push({ heading: 'Perimenopause', blocks: perimenopause(data) });
    if (ctx.hormonalBC) out.push({ heading: 'Hormonal birth control', blocks: hormonalBC(data) });
    if (ctx.postpartum) out.push({ heading: 'Postpartum or breastfeeding', blocks: postpartum(data) });
    return out;
  }

  return { CONTEXTS, build, advisoryLine, hormoneCaveat };
})();

/**
 * advisory.js — the words.
 *
 * Two voices. The owner gets the weather-desk advisory with the jokes.
 * The person being forecast gets a plain, kind outlook about her own
 * body. She never sees the advisory, and nothing here ever goes to the
 * server: it is computed on the reader's device from what they can see.
 */
const Advisory = (() => {

  // Deterministic pick so the advisory does not reshuffle on every refresh.
  function pick(list, seed) {
    let h = 0;
    for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return list[h % list.length];
  }

  const PHASE_LINES = {
    menstrual: [
      'Low-pressure system parked overhead. Heating pad deployment is authorized.',
      'Period in progress. Forecasters recommend snacks, blankets, and a total absence of opinions about her snack choices.',
      'Storm season. Volunteer for chores before anyone has to ask.',
    ],
    follicular: [
      'Skies clearing as energy builds. Good week for plans, projects, and asking what she wants to do.',
      'Rising pressure and improving visibility. If there is a weekend outing to pitch, pitch it now.',
      'Fair weather moving in. Conditions favor adventures, errands, and hard conversations you have been putting off.',
    ],
    ovulation: [
      'High-pressure ridge. Expect sunshine, sparkle, and possibly a confidence warning.',
      'Peak conditions. Good time to dress up and take her somewhere.',
    ],
    luteal: [
      'Stable and warming, with a slow drift toward cozy. Movie nights trending.',
      'Conditions holding steady. Keep the snack shelf stocked as a precaution.',
      'Calm seas. Bank some goodwill now: do the dishes, compliment the haircut.',
    ],
    premenstrual: [
      'Front approaching. Chocolate reserves should be at full capacity before landfall.',
      'Pressure dropping. Locate the heating pad now, not during the storm.',
      'PMS watch in effect. The phrase "is it that time of the month" is a known lightning rod. Do not deploy.',
    ],
    late: [
      'Front has stalled past the predicted date. Cycles drift, so no conclusions. Log the start when it arrives.',
      'Forecast models disagree with reality, and reality wins. Keep supplies ready and the questions to a minimum.',
    ],
  };

  const READING_LINES = {
    mood: {
      good:  'Mood reading is sunny. Enjoy it, and try not to be the cloud.',
      okay:  'Mood is partly cloudy. A small kindness goes a long way today.',
      rough: 'Mood is rough. Lower the volume, raise the patience, and ask what would help instead of guessing.',
    },
    energy: {
      green:  'Battery fully charged. Good day for plans.',
      yellow: 'Battery at half. Keep plans light and leave room to bail.',
      red:    'Battery in the red. You are in charge of dinner, dishes, and anything with stairs.',
    },
    desire: {
      green:  'Romance index is green. Clear your evening.',
      yellow: 'Romance index is mixed. Cuddling is a strong forecast; let her set the pace.',
      red:    'Romance index is red. Couch, blanket, her pick of the show. That is the whole plan.',
    },
    social: {
      home:   'Social battery says stay in. Cancel the group thing and make it a night for two.',
      either: 'Social forecast is flexible. Offer options, let her choose.',
      out:    'She wants to get out. Make a plan, make a reservation, and make it happen.',
    },
  };

  const SYMPTOM_LINES = {
    hot_flashes: 'Heat advisory: hot flashes reported. Fan on standby, cold water nearby, and never call the room chilly.',
    cramps:      'Cramp warning in effect. Heating pad, ibuprofen within reach, and zero commentary.',
    headache:    'Headache reported. Dim the lights and lower the noise.',
    fatigue:     'Fatigue advisory. Take something off her list today.',
    bloating:    'Bloat watch. Comfy clothes are the dress code. No remarks on anyone\u2019s outfit.',
    cravings:    'Craving alert. Know her order and keep it in stock.',
    tender:      'Tenderness reported. Hugs, but gentle ones.',
    poor_sleep:  'Poor sleep last night. Handle the morning so she can sleep in.',
    irritable:   'Irritability advisory. Not the day to reorganize her kitchen.',
    acne:        'Breakout reported. You noticed nothing. You see only radiance.',
  };

  /** The owner's advisory. Returns { headline, lines[] }. */
  function forOwner({ cycle, readings, relation, name, date }) {
    const lines = [];
    const seed = date + (cycle?.phase || '');
    if (cycle) lines.push(pick(PHASE_LINES[cycle.phase], seed));
    else lines.push(`No cycle data yet. Once ${name} sets day one, the forecast models come online.`);

    for (const f of ['mood', 'energy', 'social']) {
      if (readings[f]) lines.push(READING_LINES[f][readings[f].value]);
    }
    if (relation === 'partner' && readings.desire) lines.push(READING_LINES.desire[readings.desire.value]);
    for (const s of readings.symptoms || []) if (SYMPTOM_LINES[s]) lines.push(SYMPTOM_LINES[s]);

    // Non-partner forecasts keep it about being a good sibling or friend.
    const filtered = relation === 'partner'
      ? lines
      : lines.map(l => l.replace(/Clear your evening\.|Cancel the group thing and make it a night for two\./, 'Check in with her.'));

    let headline = 'Fair conditions';
    const e = readings.energy?.value, m = readings.mood?.value;
    if (cycle?.phase === 'menstrual' || e === 'red' || m === 'rough') headline = 'Low-pressure alert';
    else if (cycle?.phase === 'premenstrual') headline = 'PMS watch';
    else if (cycle?.phase === 'late') headline = 'Front stalled';
    else if (e === 'green' && m === 'good') headline = 'Clear skies';
    if ((readings.symptoms || []).includes('hot_flashes')) headline += ', heat advisory';

    return { headline, lines: filtered };
  }

  /** Her own outlook. Plain and useful, no jokes about her. */
  function forSubject({ cycle }) {
    if (!cycle) return { headline: 'Set day one', lines: ['Add the first day of your last period and the forecast starts working.'] };
    const lines = [];
    if (!cycle.late) lines.push(`Next period estimated ${Dates.pretty(cycle.next)}, in ${cycle.daysToNext} ${cycle.daysToNext === 1 ? 'day' : 'days'}.`);
    lines.push(cycle.learned
      ? `Predictions use your logged average of ${cycle.length} days.`
      : `Predictions use a ${cycle.length}-day cycle until you log a second start.`);
    return { headline: Cycle.PHASES[cycle.phase].name, lines };
  }


  /**
   * What each phase means, in plain words. `front` is the weather-desk
   * name; `meaning` says what is going on in the body and how it tends to
   * feel, without promising it will. `you` switches to second person for
   * her own view.
   */
  function phaseNote(phase, you) {
    const her = you ? 'your' : 'her', she = you ? 'you' : 'she', herSelf = you ? 'you' : 'her';
    const N = {
      menstrual: {
        front: 'Low-pressure system',
        meaning: `${cap(her)} period. Estrogen and progesterone are at their lowest of the cycle, so energy often dips, and cramps tend to be worst in the first day or two.`,
      },
      follicular: {
        front: 'Clearing skies',
        meaning: `Estrogen climbs steadily once ${her} period ends. For many people this is when energy and mood lift and plans feel easier.`,
      },
      ovulation: {
        front: 'High-pressure ridge',
        meaning: `Estrogen peaks and an egg is released, about two weeks before ${her} next period. Desire often runs highest here. These dates are estimates, not birth control.`,
      },
      luteal: {
        front: 'Stable, warming',
        meaning: `After ovulation, progesterone rises and holds steady, nudging ${her} resting body temperature up a few tenths of a degree. Energy often settles into a calmer, steadier range.`,
      },
      premenstrual: {
        front: 'Front approaching',
        meaning: `Estrogen and progesterone fall in the last few days before ${her} period. That drop is what brings on PMS for people who get it: tiredness, irritability, cravings, bloating. Plenty of people barely notice it.`,
      },
      late: {
        front: 'Front stalled',
        meaning: `${cap(her)} period is later than predicted. Cycles often shift by several days with stress, sleep, travel or illness. The forecast resets when ${she} log${you ? '' : 's'} a start.`,
      },
    };
    return N[phase];
  }
  const cap = s => s[0].toUpperCase() + s.slice(1);

  /** What the hormones are doing right now, for the hormone panel. */
  function hormoneNote(phase, you) {
    const her = you ? 'your' : 'her';
    return {
      menstrual:    `Estrogen and progesterone are both at their lowest. Shedding the uterine lining is what the period is.`,
      follicular:   `Estrogen is climbing as a follicle matures, which often lifts energy. Progesterone stays low.`,
      ovulation:    `Estrogen has peaked, and a short LH surge triggers ovulation. This is the most fertile point of ${her} cycle.`,
      luteal:       `Progesterone is near its peak, and estrogen makes a second, smaller rise. Progesterone is what nudges body temperature up.`,
      premenstrual: `Both hormones are falling toward ${her} next period. That drop is what brings PMS for people who get it.`,
      late:         `Hormones would normally be falling about now. A late period can shift everything a few days.`,
    }[phase];
  }

  return { forOwner, forSubject, phaseNote, hormoneNote };
})();

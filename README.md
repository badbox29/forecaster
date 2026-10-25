# Forecast

A shared, end-to-end encrypted cycle forecast for the women in your life,
written from the partner's side.

You create a forecast for someone, send her an invite link, and once she
accepts she sets day one of her cycle. From then on you both see where she is
in her cycle, what tends to come next, and anything either of you chooses to
share. She can log how she's feeling; you can keep notes she never sees, and
she can keep notes you never see.

Everything is encrypted in the browser before it leaves the device. The
server stores nicknames, hashes and ciphertext, and cannot read anyone's
cycle, readings or notes.

Static HTML, CSS and JavaScript with no build step, hosted on GitHub Pages.
Sync runs on a single Cloudflare Worker backed by KV.

> Forecast estimates; it does not diagnose. Cycle predictions are not birth
> control, and nothing in the app is medical advice.

---

## Features

### The forecast

- **Cycle dial.** A ring split into period, follicular, ovulation and luteal
  phases, sized to her cycle, with a marker on today and the cycle day in the
  middle.
- **Phase explanations.** Each phase has a weather-desk name ("Stable,
  warming") followed by a plain explanation of what her body is doing and how
  it tends to feel.
- **Next-period estimate.** A single date normally, or a likely range when
  perimenopause is switched on, built from the spread of her own recent
  cycles.
- **Learns her cycle length.** Uses the average of her last few logged cycles
  once there are two or more, otherwise the length set in Settings.

### Panels

Panels come in two decks. Move through either with the arrows, the dots,
the keyboard arrow keys, or a sideways swipe on a phone. A page load always
opens each deck on its first panel.

- **Today and Model Guidance** sit right under the dial and rotate every 10
  seconds, with a pause/play button and a progress bar. Rotation pauses
  while the pointer is over the deck, while something inside it has focus,
  while a finger is on it, while the app is in the background, and while
  Settings is open. Any manual move stops it until the next load, and it
  never runs on devices set to reduce motion. Panels swap in place, so
  rotation never disturbs a form being filled in.
- **Hormones and Patterns** sit below the advisory, right above the logging
  forms. Both are for reading, so they only move when you move them.

**Today**

- Meters for mood, energy, desire (partner forecasts only) and social
  battery.
- Each meter shows where its value came from:
  - **Logged**: a reading for today, with whose read it was.
  - **Previous**: her own earlier cycles at the same point in the cycle.
  - **Projected**: a general pattern for the current phase, used only until
    her history exists.
- Estimates are drawn with a dashed needle so they never look like something
  she reported.
- **Trend arrows** show where each meter is heading over the next few days:
  rising, dipping or steady, and outgoing or nesting for social.
- Symptoms logged today appear as chips.

**Model Guidance**

Her check-ins and your reads of her day are treated as two competing
forecast models: the **Sweetheart Model** and the **Partner Model** on partner
tabs, or named after each of you on family and friend tabs.

- Side-by-side model cards with each model's conditions for today.
- Today's agreement as a bar and a per-measure verdict: match, close or miss.
- Your accuracy over 7 and 30 days, with a 30-day chart.
- A generated **Forecast Discussion**, for example "The Partner Model has
  shown a persistent optimism bias on energy over the past week."
- **Make your call first** (on by default): once her report for today is in,
  it stays sealed across your whole view until you log your own read, then
  both are revealed and the app jumps to the comparison.
- Only **blind calls** count toward accuracy: reads logged before her report
  existed or while it was sealed. Reads logged after seeing hers are shown
  but not scored, and blind calls are badged in the log.
- Her report is always the authority; the score measures how well you read
  her.
- **Desire is left out of the comparison** unless she opts in from her own
  Settings. Her choice is stored as her own entry, which the server stamps
  with her role, so it can't be switched on for her.
- Reads you mark *Only me* count on your screen but never appear in hers.

**Hormones**

- Typical estrogen, progesterone and LH curves drawn for her cycle length,
  with a phase strip and a line on today.
- A sentence on what her hormones are doing right now.

**Patterns**

- One small chart per measure over green, yellow and red bands.
- A dashed line for the typical pattern, and her readings as dots with a
  solid average line.
- A short comparison per measure, judged separately before and after
  ovulation, such as "Hers runs lower after ovulation."
- Her logged cycle lengths.

Cycles of different lengths line up: early days are matched by days since
her period started, later days by days until the next one, because the
second half of a cycle is much steadier than the first.

### Logging

- **Readings**: mood, energy, desire, social battery, symptoms and a note,
  for today or any past date. Every field is optional.
- **Notes**: free text for any date.
- **Period starts**: always visible to both people, since they drive the
  forecast.
- **Visibility on every reading and note**: *Shared* with the other person,
  or *Only me*.
- **Delete** your own entries at any time.

### The advisory

On your tab, a weather-desk advisory turns her phase and readings into
practical, mostly humorous suggestions, for example "Battery in the red. You
are in charge of dinner, dishes, and anything with stairs." She never sees
it. On her tab she gets a plain outlook instead.

Partner forecasts include the desire reading and the partner advisory.
Family and friend forecasts leave both out.

### Her situation

Settings has checkboxes for **perimenopause**, **hormonal birth control** and
**postpartum or breastfeeding**. Either person can set them. They don't add a
new screen; they tailor the existing ones.

Perimenopause:

- Flatter projections on Today, without the textbook ovulation peak.
- A swing band on the hormone chart, and a lower progesterone line for cycles
  that don't ovulate.
- Collapsible notes on how perimenopause changes things compared with
  younger cycles, and when to talk to a clinician.
- Her cycle lengths compared with the STRAW+10 bleeding criteria researchers
  use to stage the menopausal transition.
- A 30-day count of transition symptoms.
- Extra check-in symptoms: night sweats, brain fog, joint aches, heavy flow,
  palpitations and anxious.
- The next period shown as a range.

Hormonal birth control fades the hormone chart and treats phase-based
forecasts as background only. Postpartum flattens projections and leans
toward staying in. Each adds its own explanation and clinician list.

### Sharing

- **One forecast per person.** Make as many as you need, each as its own
  tab: a partner, a sister, a friend.
- **Invite links** work once and expire after 14 days. Making a new link
  cancels the old one.
- **Before accepting**, she sees exactly what will be shared and that she can
  stop at any time.
- **She only ever sees her own forecast.** The server refuses anything else.
- **One account for several invites.** If she is already signed in, a new
  invite attaches to her existing account.
- **Leaving is silent.** She can stop sharing without the owner being
  notified, and can erase everything she wrote on the way out.
- **The owner** can end sharing or delete a forecast entirely.
- **Unlock links** let either person restore the other's access to a forecast
  if they lose their key.

### Accounts

- **Nickname only.** No email, no full name. Nicknames containing an email
  address or link are refused.
- **Recovery key.** Shown once at sign-up as 52 letters and digits, with copy
  and download. It is the way back in on a new device, and nobody else holds
  a copy.
- **Optional Google sign-in**, for signing in without typing the key.
- **Make a new recovery key** at any time while signed in. Nothing is lost.
- **Download my data** as a decrypted JSON file.
- **Delete my account**, which removes forecasts you own, erases what you
  shared on forecasts you joined, and removes every login credential.
- **Adults only.** Sign-up and invite acceptance both require confirming 18
  or older, enforced by the server.

### Everywhere

- Light and dark mode, following the device.
- Built for phones first, with full-width controls and swipeable panels.
- Keyboard focus styles and reduced-motion support.

---

## Privacy and security

### End-to-end encryption

There are three kinds of key, all handled in `js/vault.js`.

| Key | What it does | Where it lives |
|---|---|---|
| Recovery key | Signs in on a new device and unlocks the data key | Shown once; held by the person |
| Data key | Seals *Only me* entries and private tab names | On the device, and on the server only wrapped under the recovery key |
| Forecast key | Seals everything both people can see | Each member holds a copy wrapped under their own data key |

- The forecast key reaches the invitee in the invite link's `#fragment`,
  which browsers never send to any server. A link with the fragment missing
  is refused rather than half-accepted.
- *Only me* entries are sealed with the author's own data key, so the other
  person could not read them even with direct access to the database.
- Every ciphertext is AES-256-GCM, bound to the forecast and entry it belongs
  to, so a blob moved anywhere else will not open.

### What the server can see

Nicknames, which accounts share a forecast, when entries were written, and
whether each is shared or private.

It cannot see entry types, dates, readings, symptoms, notes, tab names,
relationships, life-stage settings or cycle settings.

### What the server stores about identity

- A SHA-256 hash of a login secret derived from the recovery key.
- An HMAC of the Google account ID, if linked. Email, name and photo are
  never stored.
- Rate-limit counters keyed by an HMAC of the IP address, which expire within
  minutes.
- Sessions with no user agent.

Cloudflare's own request logs record IP addresses outside this code. Keep
Workers log retention short or off.

### Abuse limits

| Limit | Value |
|---|---|
| Forecasts per account | 12 |
| Invites per account per day | 20 |
| New accounts per network per hour | 5 |
| Writes per session per 5 minutes | 200 |
| Sign-in attempts per network per 15 minutes | 30 |

Cloudflare Turnstile protects sign-up when configured.

---

## Setup

### 1. Worker

Create a KV namespace, then add these to the worker:

| Name | Type | Notes |
|---|---|---|
| `FORECAST` | KV binding | Required |
| `ID_PEPPER` | Secret | Required. A long random string. Set it once and never change it, or Google sign-in stops matching existing accounts. |
| `ALLOWED_ORIGINS` | Text | Required. Origin only, e.g. `https://you.github.io` |
| `TURNSTILE_SITE_KEY` | Text | Recommended for a public site |
| `TURNSTILE_SECRET` | Secret | Pairs with the site key |
| `GOOGLE_CLIENT_ID` | Text | Optional. Public by design. |

Generate `ID_PEPPER` with, for example:

```powershell
[Convert]::ToBase64String((1..32 | % { [byte](Get-Random -Max 256) }))
```

Paste `worker/worker.js` into the editor and deploy. Opening the worker URL
should return `{"ok":true,"service":"forecast","e2e":true,...}`.

### 2. Turnstile (recommended)

Add a Turnstile widget for your Pages hostname in the Cloudflare dashboard and
copy its site key and secret into the two variables above.

### 3. Google sign-in (optional)

Create an OAuth web client in Google Cloud, add your Pages origin under
**Authorized JavaScript origins**, and put the client ID in
`GOOGLE_CLIENT_ID`. The client secret is not used.

### 4. Client

Push this folder to a GitHub Pages repository. Nothing about your deployment
is in the code: the app asks for the worker address on first run and keeps it
in the browser. Invite links carry the address, so invited people never type
it. *Use a different sync address* on the sign-in screen switches workers.

---

## How it works

### Data model

Entries are write-once. An edit is a new entry that supersedes the old one,
and a delete is a tombstone that keeps the original's audience, so it never
reveals that a private entry existed.

### Key layout

```
p:<personId>                    { displayName, wrappedDataKey, creds[] }
c:rk:<sha256(loginSecret)>      → personId
c:g:<hmac(googleSub)>           → personId
pf:<personId>                   → [forecastId, ...]
s:<sessionId>                   session (TTL)
i:<token>                       invite (TTL)
f:<fid>:meta                    nicknames, key check, sealed settings
f:<fid>:m:<personId>            membership
f:<fid>:k:<personId>            that member's wrapped forecast key
f:<fid>:e:<ts13>:<o|s>:<uuid>   entry, write-once, sealed
f:<fid>:eid:<uuid>              idempotency index
f:<fid>:last                    latest write, for cheap polls
```

The `o|s` tag records the author's role, so "erase what I shared" is a list
and delete with no reads. `f:<fid>:last` lets an idle poll cost a single
read.

### Files

```
index.html          shell
css/app.css         design system, light and dark
js/core.js          worker client, dates, cycle math, estimates and trends
js/vault.js         all cryptography and device key storage
js/advisory.js      the advisory, her outlook, phase and hormone notes
js/charts.js        hormone and pattern charts
js/insights.js      life-stage tailoring
js/models.js        Model Guidance: agreement, accuracy, discussion
js/app.js           views, sign-up, invites, settings
worker/worker.js    Cloudflare Worker
```

---

## Sources

- Harlow SD et al. *Executive summary of the Stages of Reproductive Aging
  Workshop + 10.* Menopause, 2012. The STRAW+10 bleeding criteria used on
  the Patterns panel.
- SWAN, the Study of Women's Health Across the Nation. Background for the
  perimenopause notes on hot flashes, sleep, mood and brain fog.

The projected meter values are broad tendencies, kept deliberately mild.
Individual variation is large, and every projection is replaced by her own
history as she logs.

---

## Before a public launch

- Write a short privacy policy that matches the *What the server can see*
  section.
- Consumer health data rules can apply to an app like this even when it
  stores very little, including the FTC's Health Breach Notification Rule
  and state laws such as Washington's My Health My Data Act.
- Check Turnstile and Google sign-in on the live domain.

---

## Credits

Accounts, sessions, invites, rate limiting and the write-once entry model are
adapted from [Retrograde](https://github.com/badbox29/retrograde).

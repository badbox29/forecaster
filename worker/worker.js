/**
 * ============================================================
 * worker.js — Forecast sync worker
 * ============================================================
 *
 * Auth, sessions, invites, Google linking and rate limiting are carried
 * over from Retrograde (the care log) with the same guarantees:
 *   - opaque 256-bit session tokens, never Google ID tokens
 *   - Google `sub` is the join key, never email
 *   - one access predicate, fails closed
 *   - entries are write-once; edits supersede, deletes are tombstones
 *
 * What is different here is the shape of a "log". Each forecast has
 * exactly two people: the OWNER who created it and invited someone, and
 * the SUBJECT who accepted. One owner can have many forecasts (one per
 * person they invite), and each subject only ever sees her own.
 *
 * ── SETUP ────────────────────────────────────────────────────
 *
 * 1. KV NAMESPACE — create one, bind it as: FORECAST
 *
 * 2. VARS:
 *      ALLOWED_ORIGINS   https://you.github.io,http://localhost:8788
 *      GOOGLE_CLIENT_ID  xxxx.apps.googleusercontent.com   (optional)
 *
 * 3. SECRET:
 *      SIGNUP_TOKEN      long random string. Required to create an
 *                        OWNER account. Invited people never need it.
 *
 * ── KEY LAYOUT ───────────────────────────────────────────────
 *
 *   p:<personId>                    person record
 *   c:google:<sub>                  → personId
 *   pf:<personId>                   → [forecastId, ...]
 *   s:<sessionId>                   session (TTL)
 *   i:<inviteToken>                 invite  (TTL)
 *
 *   f:<fid>:meta                    forecast record
 *   f:<fid>:m:<personId>            membership { role, status }
 *   f:<fid>:e:<ts13>:<o|s>:<uuid>   entry — WRITE ONCE. The o/s tag is the
 *                                   author's role, so "delete everything
 *                                   I shared" is a list + delete with no
 *                                   reads.
 *   f:<fid>:eid:<uuid>              → full entry key (idempotency index)
 *   f:<fid>:last                    ts13 of the latest write (cheap poll)
 *
 * ── VISIBILITY ───────────────────────────────────────────────
 *   shared   both people on the forecast see it
 *   private  only the author sees it
 *
 * That rule is symmetric on purpose. The owner can keep notes she never
 * sees, and she can keep notes he never sees.
 * ============================================================
 */

const KV_BINDING = 'FORECAST';

const SESSION_TTL     = 60 * 60 * 24 * 180;
const INVITE_TTL      = 60 * 60 * 24 * 14;
const AUTH_RATE_LIMIT = 30;
const AUTH_RATE_WIN   = 60 * 15;
const WRITE_RATE_LIMIT= 200;
const WRITE_RATE_WIN  = 60 * 5;
const MAX_BODY        = 256 * 1024;
const MAX_ENTRY_TEXT  = 6000;
const MAX_FIELDS_JSON = 4000;
const SYNC_PAGE       = 400;

const KINDS        = ['reading', 'note', 'period'];
const VISIBILITIES = ['shared', 'private'];
const RELATIONS    = ['partner', 'family', 'friend'];

// ── Response helpers ───────────────────────────────────────────────────────

function respond(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json', ...extra } });
}
const err = (msg, status, cors, extra = {}) => respond(JSON.stringify({ error: msg }), status, { ...cors, ...extra });
const ok  = (obj, cors) => respond(JSON.stringify(obj), 200, cors);

function buildCors(origin) {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',
  };
}

function getAllowedOrigin(request, env) {
  const origin  = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

// ── Ids ────────────────────────────────────────────────────────────────────

function randomId(bytes = 16) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const ts13 = (ms = Date.now()) => String(ms).padStart(13, '0');
const isId = (s, min = 8, max = 128) =>
  typeof s === 'string' && new RegExp(`^[A-Za-z0-9_-]{${min},${max}}$`).test(s);
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

// Constant-time-ish comparison for the signup secret.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ── Rate limiting ──────────────────────────────────────────────────────────

async function rateLimit(env, bucket, limit, windowSecs) {
  const kv    = env[KV_BINDING];
  const key   = `rl:${bucket}`;
  const count = parseInt((await kv.get(key)) || '0', 10);
  if (count >= limit) return false;
  await kv.put(key, String(count + 1), { expirationTtl: Math.max(60, windowSecs) });
  return true;
}

// ── Google JWT (RS256) — unchanged from Retrograde ─────────────────────────

let _jwksCache = { keys: null, fetchedAt: 0 };

async function getJwks() {
  const now = Date.now();
  if (_jwksCache.keys && now - _jwksCache.fetchedAt < 60 * 60 * 1000) return _jwksCache.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!res.ok) return _jwksCache.keys;
  const jwks = await res.json();
  _jwksCache = { keys: jwks.keys || [], fetchedAt: now };
  return _jwksCache.keys;
}

const b64urlJson = part => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));

async function verifyGoogleJWT(idToken, clientId) {
  if (!clientId || typeof idToken !== 'string') return null;
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const header  = b64urlJson(parts[0]);
    const payload = b64urlJson(parts[1]);
    const now     = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) return null;
    if (payload.aud !== clientId) return null;
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) return null;
    if (!payload.sub) return null;

    const jwk = (await getJwks())?.find(k => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const sig = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return null;
    return { sub: payload.sub, email: payload.email || null, picture: payload.picture || null };
  } catch (e) {
    console.error('[auth] verifyGoogleJWT:', e);
    return null;
  }
}

// ── Sessions ───────────────────────────────────────────────────────────────

async function createSession(env, personId, request) {
  const id = randomId(32);
  await env[KV_BINDING].put(`s:${id}`, JSON.stringify({
    personId, createdAt: Date.now(),
    userAgent: (request.headers.get('User-Agent') || '').slice(0, 200),
  }), { expirationTtl: SESSION_TTL });
  return id;
}

async function resolveSession(request, env) {
  const hdr = request.headers.get('Authorization') || '';
  const sid = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  if (!isId(sid, 16, 128)) return null;
  const raw = await env[KV_BINDING].get(`s:${sid}`, { type: 'json' });
  if (!raw?.personId) return null;
  const person = await env[KV_BINDING].get(`p:${raw.personId}`, { type: 'json' });
  if (!person || person.active === false) return null;
  return { sessionId: sid, personId: raw.personId, person };
}

async function createPerson(env, displayName, extra = {}) {
  const person = {
    id: randomId(16),
    displayName: String(displayName || 'Someone').trim().slice(0, 60) || 'Someone',
    canOwn: !!extra.canOwn,
    createdAt: Date.now(),
    active: true,
  };
  await env[KV_BINDING].put(`p:${person.id}`, JSON.stringify(person));
  return person;
}

async function addForecastToPerson(env, personId, fid) {
  const key  = `pf:${personId}`;
  const list = (await env[KV_BINDING].get(key, { type: 'json' })) || [];
  if (!list.includes(fid)) {
    list.push(fid);
    await env[KV_BINDING].put(key, JSON.stringify(list));
  }
}

// ── Membership and the access predicate ────────────────────────────────────

async function getMembership(env, fid, personId) {
  const m = await env[KV_BINDING].get(`f:${fid}:m:${personId}`, { type: 'json' });
  return m && m.status === 'active' ? m : null;
}

async function requireAccess(request, env, fid, cors, needRole = null) {
  const sess = await resolveSession(request, env);
  if (!sess) return { ok: false, res: err('Sign in required', 401, cors) };
  const m = await getMembership(env, fid, sess.personId);
  if (!m) return { ok: false, res: err('No access to this forecast', 403, cors) };
  if (needRole && m.role !== needRole) return { ok: false, res: err('Not permitted', 403, cors) };
  return { ok: true, sess, role: m.role };
}

// ONE predicate decides what anyone may read. Default denies.
// Shared entries go to both people; private entries go to their author only.
function canReceive(personId, entry) {
  if (entry.authorId === personId) return true;
  return entry.visibility === 'shared';
}

// What the other person may learn about the forecast record itself.
function metaFor(meta, role) {
  if (role === 'owner') {
    const { inviteToken, ...rest } = meta;
    return { ...rest, hasPendingInvite: !!inviteToken };
  }
  // The subject never sees the owner's private label for her, or the
  // relation category. She sees who is on the other end, and the cycle
  // settings that drive her own predictions.
  return {
    id: meta.id, ownerName: meta.ownerName, subjectName: meta.subjectName,
    cycleLength: meta.cycleLength, periodLength: meta.periodLength, createdAt: meta.createdAt,
    // Whether to offer the desire reading on her check-in. Only partners.
    asksDesire: meta.relation === 'partner',
  };
}

// ── Entry writes ───────────────────────────────────────────────────────────

function validateEntry(e) {
  if (!e || typeof e !== 'object') return 'entry must be an object';
  if (!isId(e.id, 8, 64)) return 'entry id must be a client-generated uuid';
  if (!KINDS.includes(e.kind)) return 'invalid kind';
  if (!isDate(e.date)) return 'date must be YYYY-MM-DD';
  if (e.body != null && (typeof e.body !== 'string' || e.body.length > MAX_ENTRY_TEXT)) return 'body too long';
  if (e.visibility != null && !VISIBILITIES.includes(e.visibility)) return 'invalid visibility';
  if (e.fields != null) {
    if (typeof e.fields !== 'object' || Array.isArray(e.fields)) return 'fields must be an object';
    if (JSON.stringify(e.fields).length > MAX_FIELDS_JSON) return 'fields too large';
  }
  if (e.supersedes != null && !isId(e.supersedes, 8, 64)) return 'invalid supersedes';
  return null;
}

async function handleWriteEntries(request, env, fid, cors, access) {
  const kv = env[KV_BINDING];
  if (!(await rateLimit(env, `w:${access.sess.sessionId}`, WRITE_RATE_LIMIT, WRITE_RATE_WIN))) {
    return err('Too many writes. Slow down.', 429, cors);
  }

  const body = await readJson(request);
  const list = body?.entries;
  if (!Array.isArray(list) || !list.length) return err('entries[] required', 400, cors);
  if (list.length > 50) return err('Too many entries in one batch (max 50)', 400, cors);

  const tag = access.role === 'owner' ? 'o' : 's';
  const written = [], skipped = [];

  for (const raw of list) {
    const problem = validateEntry(raw);
    if (problem) return err(`Entry ${raw?.id || '?'}: ${problem}`, 400, cors);

    const idxKey = `f:${fid}:eid:${raw.id}`;
    if (await kv.get(idxKey)) { skipped.push(raw.id); continue; }

    // Period starts are cycle data, which both people need. Never private.
    let visibility = raw.kind === 'period' ? 'shared' : (raw.visibility || 'shared');

    // Editing or deleting: you may only supersede your own entry, and the
    // replacement keeps the original's audience so a tombstone never
    // tells someone about a note they were never shown.
    if (raw.supersedes) {
      const prevKey = await kv.get(`f:${fid}:eid:${raw.supersedes}`);
      const prev    = prevKey ? await kv.get(prevKey, { type: 'json' }) : null;
      if (!prev) return err('Cannot edit an entry that does not exist', 404, cors);
      if (prev.authorId !== access.sess.personId) return err('You can only change your own entries', 403, cors);
      if (raw.deleted) visibility = prev.visibility;
    }

    const cursor   = ts13();
    const entryKey = `f:${fid}:e:${cursor}:${tag}:${raw.id}`;
    const entry = {
      id:         raw.id,
      authorId:   access.sess.personId,
      authorName: access.sess.person.displayName,
      authorRole: access.role,
      kind:       raw.kind,
      date:       raw.date,
      createdAt:  Date.now(),
      cursor,
      body:       raw.body ?? null,
      fields:     raw.fields ?? {},
      visibility,
      supersedes: raw.supersedes ?? null,
      deleted:    raw.deleted ? 1 : 0,
    };
    await kv.put(entryKey, JSON.stringify(entry));
    await kv.put(idxKey, entryKey);
    written.push(entry);
  }
  if (written.length) await kv.put(`f:${fid}:last`, ts13());
  return ok({ written, skipped }, cors);
}

// GET /f/:fid/sync?since=<ts13>
//
// KV list() pages with an opaque cursor and cannot seek to a key, so this
// walks key NAMES (cheap: one list op per 1,000 keys) and only reads the
// values whose receipt time is at or after `since`. A single "last write"
// marker lets an idle poll answer with one read and no listing at all.
async function handleSync(request, env, fid, cors, access) {
  const kv     = env[KV_BINDING];
  const since  = new URL(request.url).searchParams.get('since') || '';
  const valid  = /^\d{13}$/.test(since);
  if (valid) {
    const last = await kv.get(`f:${fid}:last`);
    if (last && last < since) return ok({ entries: [], cursor: since, more: false }, cors);
  }

  const prefix = `f:${fid}:e:`;
  const entries = [];
  let listCursor, cursor = since, more = false, reads = 0;
  outer: do {
    const page = await kv.list({ prefix, limit: 1000, ...(listCursor ? { cursor: listCursor } : {}) });
    for (const k of page.keys) {
      const ts = k.name.split(':')[3];
      if (valid && ts < since) continue;
      if (reads >= SYNC_PAGE) { more = true; break outer; }
      reads++;
      const v = await kv.get(k.name, { type: 'json' });
      if (v && canReceive(access.sess.personId, v)) entries.push(v);
      cursor = ts;
    }
    listCursor = page.list_complete ? null : page.cursor;
  } while (listCursor);

  return ok({ entries, cursor, more }, cors);
}

// Delete every entry one role wrote ('o' or 's'), or all of them (null).
// Paged with KV's own cursor, because list() is eventually consistent and
// may keep showing keys that were just deleted; re-listing from the start
// could spin on the same page. The client passes `cursor` back while more.
async function purgeByTag(env, fid, tag, listCursor) {
  const kv = env[KV_BINDING];
  const page = await kv.list({ prefix: `f:${fid}:e:`, limit: 300, ...(listCursor ? { cursor: listCursor } : {}) });
  for (const k of page.keys) {
    const parts = k.name.split(':');              // f fid e ts tag uuid
    if (tag && parts[4] !== tag) continue;
    await kv.delete(k.name);
    await kv.delete(`f:${fid}:eid:${parts[5]}`);
  }
  await kv.put(`f:${fid}:last`, ts13());
  return page.list_complete ? { more: false } : { more: true, cursor: page.cursor };
}

// ── Auth routes ────────────────────────────────────────────────────────────

async function handleAuth(url, method, request, env, cors, ip) {
  const kv   = env[KV_BINDING];
  const path = url.pathname;

  if (path === '/auth/config' && method === 'GET') {
    const gid = (env.GOOGLE_CLIENT_ID || '').trim();
    return ok({ googleClientId: gid, googleEnabled: !!gid }, cors);
  }

  if (!(await rateLimit(env, `ip:${ip}`, AUTH_RATE_LIMIT, AUTH_RATE_WIN))) {
    return err('Too many attempts. Try again in a few minutes.', 429, cors,
      { 'Retry-After': String(AUTH_RATE_WIN) });
  }

  // POST /auth/signup — create an account that can own forecasts
  if (path === '/auth/signup' && method === 'POST') {
    if (!env.SIGNUP_TOKEN) return err('Sign-up is not configured', 403, cors);
    const body = await readJson(request);
    if (!body?.displayName) return err('displayName required', 400, cors);
    if (!safeEqual(String(body.signupToken || ''), env.SIGNUP_TOKEN)) {
      return err('That sign-up code is not right', 403, cors);
    }
    const person = await createPerson(env, body.displayName, { canOwn: true });
    const sid = await createSession(env, person.id, request);
    return ok({ sessionId: sid, person }, cors);
  }

  // GET /auth/invite/<token> — who is inviting me? Shown before accepting.
  if (path.startsWith('/auth/invite/') && method === 'GET') {
    const token  = path.slice('/auth/invite/'.length);
    if (!isId(token, 16, 128)) return err('Invalid invite', 400, cors);
    const invite = await kv.get(`i:${token}`, { type: 'json' });
    if (!invite || invite.redeemedAt) return err('This invite has expired or was already used', 404, cors);
    return ok({ ownerName: invite.ownerName, expiresAt: invite.expiresAt }, cors);
  }

  // POST /auth/invite/redeem — accept. Works signed out (creates a person)
  // or signed in (attaches this forecast to the existing person, so one
  // woman invited by two people still has one account).
  if (path === '/auth/invite/redeem' && method === 'POST') {
    const body = await readJson(request);
    if (!isId(body?.inviteToken, 16, 128)) return err('Invalid invite', 400, cors);
    if (body.periodStart != null && !isDate(body.periodStart)) return err('periodStart must be YYYY-MM-DD', 400, cors);

    const invite = await kv.get(`i:${body.inviteToken}`, { type: 'json' });
    if (!invite || invite.redeemedAt) return err('This invite has expired or was already used', 404, cors);

    const meta = await kv.get(`f:${invite.forecastId}:meta`, { type: 'json' });
    if (!meta || meta.inviteToken !== body.inviteToken) return err('This invite is no longer valid', 410, cors);
    if (meta.subjectId) return err('Someone has already accepted this invite', 409, cors);

    let sess = await resolveSession(request, env);
    let person;
    if (sess) {
      if (sess.personId === meta.ownerId) return err('You cannot accept your own invite', 400, cors);
      person = sess.person;
    } else {
      if (!body.displayName) return err('displayName required', 400, cors);
      person = await createPerson(env, body.displayName);
    }

    const now = Date.now();
    await kv.put(`f:${meta.id}:m:${person.id}`, JSON.stringify({
      personId: person.id, forecastId: meta.id, role: 'subject', status: 'active', createdAt: now,
    }));
    await addForecastToPerson(env, person.id, meta.id);

    meta.subjectId   = person.id;
    meta.subjectName = person.displayName;
    meta.acceptedAt  = now;
    delete meta.inviteToken;
    await kv.put(`f:${meta.id}:meta`, JSON.stringify(meta));
    await kv.put(`i:${body.inviteToken}`, JSON.stringify({ ...invite, redeemedAt: now }),
      { expirationTtl: 60 * 60 * 24 * 7 });

    if (body.periodStart) {
      const eid = randomId(12);
      const cursor = ts13();
      const key = `f:${meta.id}:e:${cursor}:s:${eid}`;
      await kv.put(key, JSON.stringify({
        id: eid, authorId: person.id, authorName: person.displayName, authorRole: 'subject',
        kind: 'period', date: body.periodStart, createdAt: now, cursor,
        body: null, fields: {}, visibility: 'shared', supersedes: null, deleted: 0,
      }));
      await kv.put(`f:${meta.id}:eid:${eid}`, key);
    }

    const sid = sess ? sess.sessionId : await createSession(env, person.id, request);
    return ok({ sessionId: sid, person, forecastId: meta.id }, cors);
  }

  if (path === '/auth/google' && method === 'POST') {
    const body = await readJson(request);
    const p = await verifyGoogleJWT(body?.idToken, (env.GOOGLE_CLIENT_ID || '').trim());
    if (!p) return err('Invalid or expired Google token', 401, cors);
    const personId = await kv.get(`c:google:${p.sub}`);
    if (!personId) return err('No account is linked to that Google login yet.', 404, cors);
    const person = await kv.get(`p:${personId}`, { type: 'json' });
    if (!person || person.active === false) return err('Account is inactive', 403, cors);
    return ok({ sessionId: await createSession(env, personId, request), person }, cors);
  }

  if (path === '/auth/google/link' && method === 'POST') {
    const sess = await resolveSession(request, env);
    if (!sess) return err('Sign in required', 401, cors);
    const body = await readJson(request);
    const p = await verifyGoogleJWT(body?.idToken, (env.GOOGLE_CLIENT_ID || '').trim());
    if (!p) return err('Invalid or expired Google token', 401, cors);
    const existing = await kv.get(`c:google:${p.sub}`);
    if (existing && existing !== sess.personId) return err('That Google account is linked to someone else', 409, cors);
    await kv.put(`c:google:${p.sub}`, sess.personId);
    const person = { ...sess.person, googleSub: p.sub, email: p.email || sess.person.email || null };
    await kv.put(`p:${sess.personId}`, JSON.stringify(person));
    return ok({ ok: true, person }, cors);
  }

  if (path === '/auth/signout' && method === 'POST') {
    const hdr = request.headers.get('Authorization') || '';
    const sid = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
    if (isId(sid, 16, 128)) await kv.delete(`s:${sid}`);
    return ok({ ok: true }, cors);
  }

  if (path === '/auth/me' && method === 'GET') {
    const sess = await resolveSession(request, env);
    if (!sess) return err('Not signed in', 401, cors);
    const fids = (await kv.get(`pf:${sess.personId}`, { type: 'json' })) || [];
    const forecasts = [];
    for (const fid of fids) {
      const m = await getMembership(env, fid, sess.personId);
      if (!m) continue;
      const meta = await kv.get(`f:${fid}:meta`, { type: 'json' });
      if (meta) forecasts.push({ ...metaFor(meta, m.role), role: m.role });
    }
    const { googleSub, ...person } = sess.person;
    return ok({ person, forecasts, hasGoogle: !!googleSub }, cors);
  }

  return null;
}

// ── Router ─────────────────────────────────────────────────────────────────

async function readJson(request) {
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return null;
    return JSON.parse(text);
  } catch { return null; }
}

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const method = request.method;
    const cors   = buildCors(getAllowedOrigin(request, env));
    const ip     = request.headers.get('CF-Connecting-IP') || 'unknown';

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/ping')) {
      return ok({ ok: true, service: 'forecast', time: Date.now() }, cors);
    }
    if (!env[KV_BINDING]) return err('KV namespace not bound', 500, cors);
    const kv = env[KV_BINDING];

    try {
      if (url.pathname.startsWith('/auth/')) {
        return (await handleAuth(url, method, request, env, cors, ip)) || err('Not found', 404, cors);
      }

      // POST /forecasts — create a new forecast (one per person you invite)
      if (url.pathname === '/forecasts' && method === 'POST') {
        const sess = await resolveSession(request, env);
        if (!sess) return err('Sign in required', 401, cors);
        if (!sess.person.canOwn) return err('This account can only receive invites', 403, cors);
        const body = await readJson(request);
        const label = String(body?.label || '').trim().slice(0, 40);
        if (!label) return err('label required', 400, cors);
        const fid = randomId(12);
        const now = Date.now();
        const meta = {
          id: fid, label,
          relation: RELATIONS.includes(body.relation) ? body.relation : 'partner',
          ownerId: sess.personId, ownerName: sess.person.displayName,
          subjectId: null, subjectName: null,
          cycleLength: 28, periodLength: 5, createdAt: now,
        };
        await kv.put(`f:${fid}:meta`, JSON.stringify(meta));
        await kv.put(`f:${fid}:m:${sess.personId}`, JSON.stringify({
          personId: sess.personId, forecastId: fid, role: 'owner', status: 'active', createdAt: now,
        }));
        await addForecastToPerson(env, sess.personId, fid);
        return ok({ forecast: { ...metaFor(meta, 'owner'), role: 'owner' } }, cors);
      }

      if (!url.pathname.startsWith('/f/')) return err('Not found', 404, cors);

      const [, fid, ...tail] = url.pathname.split('/').filter(Boolean);
      if (!isId(fid, 8, 64)) return err('Invalid forecast id', 400, cors);

      const access = await requireAccess(request, env, fid, cors);
      if (!access.ok) return access.res;
      const meta = await kv.get(`f:${fid}:meta`, { type: 'json' });
      if (!meta) return err('Not found', 404, cors);
      const isOwner = access.role === 'owner';
      const op = tail.join('/');

      if (op === '' && method === 'GET') return ok({ forecast: { ...metaFor(meta, access.role), role: access.role } }, cors);
      if (op === 'entries' && method === 'POST') return await handleWriteEntries(request, env, fid, cors, access);
      if (op === 'sync' && method === 'GET') return await handleSync(request, env, fid, cors, access);

      // PUT /f/:fid/settings — owner renames the tab; either person can set
      // cycle and period length, since she knows her own body best.
      if (op === 'settings' && method === 'PUT') {
        const body = await readJson(request) || {};
        if (isOwner && body.label) meta.label = String(body.label).trim().slice(0, 40) || meta.label;
        if (isOwner && RELATIONS.includes(body.relation)) meta.relation = body.relation;
        const cl = parseInt(body.cycleLength, 10), pl = parseInt(body.periodLength, 10);
        if (cl >= 18 && cl <= 60) meta.cycleLength = cl;
        if (pl >= 1 && pl <= 12)  meta.periodLength = pl;
        meta.updatedAt = Date.now();
        await kv.put(`f:${fid}:meta`, JSON.stringify(meta));
        return ok({ forecast: { ...metaFor(meta, access.role), role: access.role } }, cors);
      }

      // POST /f/:fid/invite — owner, only while nobody has accepted.
      // Making a new link kills the old one.
      if (op === 'invite' && method === 'POST') {
        if (!isOwner) return err('Not permitted', 403, cors);
        if (meta.subjectId) return err('Someone has already joined this forecast', 409, cors);
        if (meta.inviteToken) await kv.delete(`i:${meta.inviteToken}`);
        const token = randomId(24);
        const invite = {
          token, forecastId: fid, ownerName: meta.ownerName,
          createdAt: Date.now(), expiresAt: Date.now() + INVITE_TTL * 1000,
        };
        await kv.put(`i:${token}`, JSON.stringify(invite), { expirationTtl: INVITE_TTL });
        meta.inviteToken = token;
        await kv.put(`f:${fid}:meta`, JSON.stringify(meta));
        return ok({ token, expiresAt: invite.expiresAt }, cors);
      }

      if (op === 'invite/cancel' && method === 'POST') {
        if (!isOwner) return err('Not permitted', 403, cors);
        if (meta.inviteToken) await kv.delete(`i:${meta.inviteToken}`);
        delete meta.inviteToken;
        await kv.put(`f:${fid}:meta`, JSON.stringify(meta));
        return ok({ ok: true }, cors);
      }

      // POST /f/:fid/remove — owner ends sharing with her.
      if (op === 'remove' && method === 'POST') {
        if (!isOwner) return err('Not permitted', 403, cors);
        if (meta.subjectId) {
          await kv.put(`f:${fid}:m:${meta.subjectId}`, JSON.stringify({
            personId: meta.subjectId, forecastId: fid, role: 'subject', status: 'removed', endedAt: Date.now(),
          }));
        }
        meta.subjectId = null; meta.subjectName = null;
        await kv.put(`f:${fid}:meta`, JSON.stringify(meta));
        return ok({ ok: true }, cors);
      }

      // POST /f/:fid/leave  { erase: bool } — she stops sharing. With erase,
      // everything she wrote is deleted first; call repeatedly while more.
      if (op === 'leave' && method === 'POST') {
        if (isOwner) return err('Owners delete the forecast instead', 400, cors);
        const body = await readJson(request) || {};
        if (body.erase) {
          const r = await purgeByTag(env, fid, 's', body.cursor);
          if (r.more) return ok({ ok: true, more: true, cursor: r.cursor }, cors);
        }
        await kv.put(`f:${fid}:m:${access.sess.personId}`, JSON.stringify({
          personId: access.sess.personId, forecastId: fid, role: 'subject', status: 'left', endedAt: Date.now(),
        }));
        meta.subjectId = null; meta.subjectName = null;
        await kv.put(`f:${fid}:meta`, JSON.stringify(meta));
        return ok({ ok: true, more: false }, cors);
      }

      // POST /f/:fid/delete — owner deletes the whole forecast. Paged.
      if (op === 'delete' && method === 'POST') {
        if (!isOwner) return err('Not permitted', 403, cors);
        const body = await readJson(request) || {};
        const r = await purgeByTag(env, fid, null, body.cursor);
        if (r.more) return ok({ ok: true, more: true, cursor: r.cursor }, cors);
        if (meta.subjectId) await kv.delete(`f:${fid}:m:${meta.subjectId}`);
        if (meta.inviteToken) await kv.delete(`i:${meta.inviteToken}`);
        await kv.delete(`f:${fid}:m:${meta.ownerId}`);
        await kv.delete(`f:${fid}:meta`);
        await kv.delete(`f:${fid}:last`);
        return ok({ ok: true, more: false }, cors);
      }

      return err('Not found', 404, cors);
    } catch (e) {
      console.error('[worker]', e);
      return err('Server error', 500, cors);
    }
  },
};

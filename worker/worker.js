/**
 * ============================================================
 * worker.js — Forecast sync worker (end-to-end encrypted)
 * ============================================================
 *
 * This worker is built to know as little as possible.
 *
 *   - Every entry is encrypted in the browser. The worker stores an
 *     opaque blob plus the minimum it needs to route it: who wrote it,
 *     who may receive it, and what it replaces. It never sees whether an
 *     entry is a period start, a reading or a note, or what date it is for.
 *   - Accounts are a nickname. No email, no full name, no avatar.
 *   - Sign-in is a recovery key, or optionally Google. The worker stores a
 *     hash of the login secret and a keyed hash of the Google subject id,
 *     never the raw values.
 *   - IP addresses appear only as short keyed hashes inside rate-limit
 *     counters that expire within minutes. Sessions store no user agent.
 *
 * Auth shape, invites, the single access predicate and write-once
 * entries are carried over from Retrograde.
 *
 * ── SETUP ────────────────────────────────────────────────────
 *   KV binding        FORECAST
 *   Vars              ALLOWED_ORIGINS     https://you.github.io
 *                     GOOGLE_CLIENT_ID    (optional)
 *                     TURNSTILE_SITE_KEY  (optional, recommended)
 *   Secrets           ID_PEPPER           long random string (required)
 *                     TURNSTILE_SECRET    (optional, pairs with site key)
 *
 * ── KEY LAYOUT ───────────────────────────────────────────────
 *   p:<personId>                    { id, displayName, wrappedDataKey, creds[], createdAt }
 *   c:rk:<sha256(loginSecret)>      → personId
 *   c:g:<hmac(googleSub)>           → personId
 *   pf:<personId>                   → [forecastId, ...]
 *   s:<sessionId>                   { personId, createdAt }            (TTL)
 *   i:<inviteToken>                 invite                             (TTL)
 *   rl:<bucket>                     counter                            (TTL)
 *
 *   f:<fid>:meta                    { id, ownerId, ownerName, subjectId, subjectName,
 *                                     kcv, sharedEnc, ownerEnc, inviteToken, createdAt }
 *   f:<fid>:m:<personId>            membership { role, status }
 *   f:<fid>:k:<personId>            that member's wrapped forecast key
 *   f:<fid>:e:<ts13>:<o|s>:<uuid>   entry, write-once, encrypted
 *   f:<fid>:eid:<uuid>              → entry key
 *   f:<fid>:last                    ts13 of latest write
 * ============================================================
 */

const KV_BINDING = 'FORECAST';

const SESSION_TTL      = 60 * 60 * 24 * 180;
const INVITE_TTL       = 60 * 60 * 24 * 14;
const AUTH_RATE_LIMIT  = 30;
const AUTH_RATE_WIN    = 60 * 15;
const WRITE_RATE_LIMIT = 200;
const WRITE_RATE_WIN   = 60 * 5;
const INVITE_DAY_LIMIT = 20;
const SIGNUP_IP_LIMIT  = 5;                  // new accounts per IP per hour
const MAX_FORECASTS    = 12;                 // per owner
const MAX_BODY         = 256 * 1024;
const MAX_CT           = 16 * 1024;          // one encrypted entry
const MAX_BLOB         = 2048;               // wrapped keys, kcv, settings blobs
const SYNC_PAGE        = 400;

// ── responses ──────────────────────────────────────────────────────────────

function respond(body, status, extra = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json', ...extra } });
}
const err = (msg, status, cors, extra = {}) => respond(JSON.stringify({ error: msg }), status, { ...cors, ...extra });
const ok  = (obj, cors) => respond(JSON.stringify(obj), 200, cors);

function buildCors(origin) {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',
  };
}
function getAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  return (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).includes(origin) ? origin : null;
}

// ── small helpers ──────────────────────────────────────────────────────────

const enc = new TextEncoder();
function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomId(bytes = 16) { return b64url(crypto.getRandomValues(new Uint8Array(bytes))); }
const ts13 = (ms = Date.now()) => String(ms).padStart(13, '0');
const isId = (s, min = 8, max = 128) => typeof s === 'string' && new RegExp(`^[A-Za-z0-9_-]{${min},${max}}$`).test(s);
const isBlob = (s, max = MAX_BLOB) => typeof s === 'string' && s.length >= 16 && s.length <= max && /^[A-Za-z0-9_-]+$/.test(s);

async function sha256(s) { return b64url(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function hmac(env, s) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.ID_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(s)));
}

// Nicknames only. Short, single line, no addresses or links.
function cleanNick(v) {
  const s = String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!s) return null;
  if (/@|https?:|www\./i.test(s)) return null;
  return s;
}

async function rateLimit(env, bucket, limit, windowSecs) {
  const kv = env[KV_BINDING];
  const key = `rl:${bucket}`;
  const n = parseInt((await kv.get(key)) || '0', 10);
  if (n >= limit) return false;
  await kv.put(key, String(n + 1), { expirationTtl: Math.max(60, windowSecs) });
  return true;
}

// ── Turnstile ──────────────────────────────────────────────────────────────

async function turnstileOk(env, token, ipHash) {
  if (!env.TURNSTILE_SECRET) return true;      // not configured: dev or private use
  if (typeof token !== 'string' || !token) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  form.append('idempotency_key', crypto.randomUUID());
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const j = await r.json();
    return j.success === true;
  } catch { return false; }
}

// ── Google (RS256), unchanged verification ─────────────────────────────────

let _jwks = { keys: null, at: 0 };
async function getJwks() {
  if (_jwks.keys && Date.now() - _jwks.at < 3600e3) return _jwks.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) return _jwks.keys;
  _jwks = { keys: (await r.json()).keys || [], at: Date.now() };
  return _jwks.keys;
}
const b64urlJson = p => JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
async function verifyGoogleSub(idToken, clientId) {
  if (!clientId || typeof idToken !== 'string') return null;
  try {
    const [h, p, s] = idToken.split('.');
    const header = b64urlJson(h), payload = b64urlJson(p);
    if (!payload.exp || payload.exp < Date.now() / 1000) return null;
    if (payload.aud !== clientId) return null;
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) return null;
    const jwk = (await getJwks())?.find(k => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const sig = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, enc.encode(`${h}.${p}`));
    // Only the subject id is used, and only to compute a keyed hash.
    // Email, name and picture in the token are ignored.
    return valid && payload.sub ? payload.sub : null;
  } catch { return null; }
}

// ── sessions and people ────────────────────────────────────────────────────

async function createSession(env, personId) {
  const id = randomId(32);
  await env[KV_BINDING].put(`s:${id}`, JSON.stringify({ personId, createdAt: Date.now() }), { expirationTtl: SESSION_TTL });
  return id;
}
function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  const sid = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return isId(sid, 16, 128) ? sid : null;
}
async function resolveSession(request, env) {
  const sid = bearer(request);
  if (!sid) return null;
  const s = await env[KV_BINDING].get(`s:${sid}`, { type: 'json' });
  if (!s?.personId) return null;
  const person = await env[KV_BINDING].get(`p:${s.personId}`, { type: 'json' });
  if (!person) return null;
  return { sessionId: sid, personId: s.personId, person };
}
const publicPerson = p => ({ id: p.id, displayName: p.displayName, wrappedDataKey: p.wrappedDataKey, hasGoogle: (p.creds || []).some(c => c.startsWith('c:g:')) });

async function addForecastToPerson(env, personId, fid) {
  const key = `pf:${personId}`;
  const list = (await env[KV_BINDING].get(key, { type: 'json' })) || [];
  if (!list.includes(fid)) { list.push(fid); await env[KV_BINDING].put(key, JSON.stringify(list)); }
}

/**
 * New person from a validated sign-up body. `loginSecret` is derived in the
 * browser from the recovery key and is all the worker ever sees of it;
 * it stores only the hash. `wrappedDataKey` is the person's data key,
 * encrypted under a second key derived from the same recovery key, so a
 * new device can recover it and the worker can never open it.
 */
async function createPerson(env, body, extraCred = null) {
  const kv = env[KV_BINDING];
  const nick = cleanNick(body.displayName);
  if (!nick) return { error: 'Choose a nickname (no email addresses or links)' };
  if (!isBlob(body.loginSecret, 64)) return { error: 'Missing login secret' };
  if (!isBlob(body.wrappedDataKey)) return { error: 'Missing data key' };

  const rkKey = `c:rk:${await sha256(body.loginSecret)}`;
  if (await kv.get(rkKey)) return { error: 'Please try again' };   // astronomically unlikely
  const person = { id: randomId(16), displayName: nick, wrappedDataKey: body.wrappedDataKey, creds: [rkKey], createdAt: Date.now() };
  if (extraCred) person.creds.push(extraCred);
  await kv.put(`p:${person.id}`, JSON.stringify(person));
  await kv.put(rkKey, person.id);
  if (extraCred) await kv.put(extraCred, person.id);
  return { person };
}

// ── forecasts ──────────────────────────────────────────────────────────────

async function getMembership(env, fid, personId) {
  const m = await env[KV_BINDING].get(`f:${fid}:m:${personId}`, { type: 'json' });
  return m && m.status === 'active' ? m : null;
}

// What each person may learn about a forecast record.
async function forecastFor(env, meta, role, personId) {
  const wrappedKey = await env[KV_BINDING].get(`f:${meta.id}:k:${personId}`);
  const base = {
    id: meta.id, role, ownerName: meta.ownerName, subjectName: meta.subjectName,
    kcv: meta.kcv, sharedEnc: meta.sharedEnc || null, wrappedKey, createdAt: meta.createdAt,
  };
  if (role === 'owner') {
    Object.assign(base, { subjectId: meta.subjectId, ownerEnc: meta.ownerEnc || null, hasPendingInvite: !!meta.inviteToken });
  }
  return base;
}

// ONE predicate for reads. Default denies.
function canReceive(personId, entry) {
  return entry.authorId === personId || entry.visibility === 'shared';
}

// ── entries ────────────────────────────────────────────────────────────────

function validateEntry(e) {
  if (!e || typeof e !== 'object') return 'entry must be an object';
  if (!isId(e.id, 8, 64)) return 'invalid id';
  if (!['shared', 'private'].includes(e.visibility)) return 'invalid visibility';
  if (e.supersedes != null && !isId(e.supersedes, 8, 64)) return 'invalid supersedes';
  if (e.deleted) return e.ct == null ? null : 'a deletion carries no content';
  if (!isBlob(e.ct, MAX_CT)) return 'invalid ciphertext';
  if (!['f', 'a'].includes(e.keyRef)) return 'invalid keyRef';
  // Private content must be sealed with the author's own key, so the other
  // member could not read it even with direct access to this database.
  if (e.visibility === 'private' && e.keyRef !== 'a') return 'private entries use the author key';
  return null;
}

async function handleWriteEntries(request, env, fid, cors, access) {
  const kv = env[KV_BINDING];
  if (!(await rateLimit(env, `w:${access.sess.sessionId}`, WRITE_RATE_LIMIT, WRITE_RATE_WIN))) {
    return err('Too many writes. Slow down.', 429, cors);
  }
  const list = (await readJson(request))?.entries;
  if (!Array.isArray(list) || !list.length || list.length > 50) return err('entries[] (1 to 50) required', 400, cors);

  const tag = access.role === 'owner' ? 'o' : 's';
  const written = [], skipped = [];
  for (const raw of list) {
    const problem = validateEntry(raw);
    if (problem) return err(problem, 400, cors);
    const idxKey = `f:${fid}:eid:${raw.id}`;
    if (await kv.get(idxKey)) { skipped.push(raw.id); continue; }

    let visibility = raw.visibility;
    if (raw.supersedes) {
      const prevKey = await kv.get(`f:${fid}:eid:${raw.supersedes}`);
      const prev = prevKey ? await kv.get(prevKey, { type: 'json' }) : null;
      if (!prev) return err('That entry does not exist', 404, cors);
      if (prev.authorId !== access.sess.personId) return err('You can only change your own entries', 403, cors);
      // A tombstone keeps the original's audience, so it never reveals that
      // a private entry existed.
      if (raw.deleted) visibility = prev.visibility;
    } else if (raw.deleted) {
      return err('A deletion must reference an entry', 400, cors);
    }

    const cursor = ts13();
    const entry = {
      id: raw.id, authorId: access.sess.personId, authorRole: access.role,
      createdAt: Date.now(), cursor, visibility,
      keyRef: raw.deleted ? null : raw.keyRef, ct: raw.deleted ? null : raw.ct,
      supersedes: raw.supersedes || null, deleted: raw.deleted ? 1 : 0,
    };
    const key = `f:${fid}:e:${cursor}:${tag}:${raw.id}`;
    await kv.put(key, JSON.stringify(entry));
    await kv.put(idxKey, key);
    written.push(entry);
  }
  if (written.length) await kv.put(`f:${fid}:last`, ts13());
  return ok({ written, skipped }, cors);
}

// Walks key NAMES with KV's cursor (list() cannot seek), and reads only the
// values at or after `since`. Idle polls cost one read via f:<fid>:last.
async function handleSync(request, env, fid, cors, access) {
  const kv = env[KV_BINDING];
  const since = new URL(request.url).searchParams.get('since') || '';
  const valid = /^\d{13}$/.test(since);
  if (valid) {
    const last = await kv.get(`f:${fid}:last`);
    if (last && last < since) return ok({ entries: [], cursor: since, more: false }, cors);
  }
  const entries = [];
  let lc, cursor = since, more = false, reads = 0;
  outer: do {
    const page = await kv.list({ prefix: `f:${fid}:e:`, limit: 1000, ...(lc ? { cursor: lc } : {}) });
    for (const k of page.keys) {
      const ts = k.name.split(':')[3];
      if (valid && ts < since) continue;
      if (reads >= SYNC_PAGE) { more = true; break outer; }
      reads++;
      const v = await kv.get(k.name, { type: 'json' });
      if (v && canReceive(access.sess.personId, v)) entries.push(v);
      cursor = ts;
    }
    lc = page.list_complete ? null : page.cursor;
  } while (lc);
  return ok({ entries, cursor, more }, cors);
}

async function purgeByTag(env, fid, tag, lc) {
  const kv = env[KV_BINDING];
  const page = await kv.list({ prefix: `f:${fid}:e:`, limit: 300, ...(lc ? { cursor: lc } : {}) });
  for (const k of page.keys) {
    const parts = k.name.split(':');
    if (tag && parts[4] !== tag) continue;
    await kv.delete(k.name);
    await kv.delete(`f:${fid}:eid:${parts[5]}`);
  }
  await kv.put(`f:${fid}:last`, ts13());
  return page.list_complete ? { more: false } : { more: true, cursor: page.cursor };
}

// Ends a subject's membership. Deliberately silent: nothing is sent to the
// owner, and the owner's view simply returns to the invite state.
async function endSubject(env, fid, meta, personId, status) {
  const kv = env[KV_BINDING];
  await kv.put(`f:${fid}:m:${personId}`, JSON.stringify({ personId, forecastId: fid, role: 'subject', status, endedAt: Date.now() }));
  await kv.delete(`f:${fid}:k:${personId}`);
  meta.subjectId = null; meta.subjectName = null;
  await kv.put(`f:${fid}:meta`, JSON.stringify(meta));
}

async function deleteForecastRecords(env, fid, meta) {
  const kv = env[KV_BINDING];
  for (const pid of [meta.ownerId, meta.subjectId].filter(Boolean)) {
    await kv.delete(`f:${fid}:m:${pid}`);
    await kv.delete(`f:${fid}:k:${pid}`);
  }
  if (meta.inviteToken) await kv.delete(`i:${meta.inviteToken}`);
  await kv.delete(`f:${fid}:meta`);
  await kv.delete(`f:${fid}:last`);
}

// ── auth routes ────────────────────────────────────────────────────────────

async function handleAuth(url, method, request, env, cors, ipHash) {
  const kv = env[KV_BINDING];
  const path = url.pathname;

  if (path === '/auth/config' && method === 'GET') {
    const gid = (env.GOOGLE_CLIENT_ID || '').trim();
    return ok({
      googleEnabled: !!gid, googleClientId: gid,
      turnstileSiteKey: env.TURNSTILE_SECRET ? (env.TURNSTILE_SITE_KEY || '').trim() : '',
    }, cors);
  }

  if (!(await rateLimit(env, `ip:${ipHash}`, AUTH_RATE_LIMIT, AUTH_RATE_WIN))) {
    return err('Too many attempts. Try again in a few minutes.', 429, cors, { 'Retry-After': String(AUTH_RATE_WIN) });
  }

  // POST /auth/signup { displayName, loginSecret, wrappedDataKey, adult, turnstileToken, idToken? }
  if (path === '/auth/signup' && method === 'POST') {
    const body = await readJson(request);
    if (!body) return err('Invalid body', 400, cors);
    if (body.adult !== true) return err('You must be 18 or older to use Forecast', 400, cors);
    if (!(await turnstileOk(env, body.turnstileToken, ipHash))) return err('Verification failed. Try again.', 403, cors);
    if (!(await rateLimit(env, `su:${ipHash}`, SIGNUP_IP_LIMIT, 3600))) return err('Too many new accounts from this network. Try later.', 429, cors);

    let gCred = null;
    if (body.idToken) {
      const sub = await verifyGoogleSub(body.idToken, (env.GOOGLE_CLIENT_ID || '').trim());
      if (!sub) return err('Google sign-in expired. Try again.', 401, cors);
      gCred = `c:g:${await hmac(env, 'google:' + sub)}`;
      if (await kv.get(gCred)) return err('That Google account already has a Forecast account', 409, cors);
    }
    const r = await createPerson(env, body, gCred);
    if (r.error) return err(r.error, 400, cors);
    return ok({ sessionId: await createSession(env, r.person.id), person: publicPerson(r.person) }, cors);
  }

  // POST /auth/recover { loginSecret } — sign in with a recovery key
  if (path === '/auth/recover' && method === 'POST') {
    const body = await readJson(request);
    if (!isBlob(body?.loginSecret, 64)) return err('Invalid recovery key', 400, cors);
    const pid = await kv.get(`c:rk:${await sha256(body.loginSecret)}`);
    const person = pid && await kv.get(`p:${pid}`, { type: 'json' });
    if (!person) return err('That recovery key doesn\u2019t match an account', 404, cors);
    return ok({ sessionId: await createSession(env, pid), person: publicPerson(person) }, cors);
  }

  if (path === '/auth/google' && method === 'POST') {
    const body = await readJson(request);
    const sub = await verifyGoogleSub(body?.idToken, (env.GOOGLE_CLIENT_ID || '').trim());
    if (!sub) return err('Invalid or expired Google sign-in', 401, cors);
    const pid = await kv.get(`c:g:${await hmac(env, 'google:' + sub)}`);
    const person = pid && await kv.get(`p:${pid}`, { type: 'json' });
    if (!person) return err('No Forecast account uses that Google login yet', 404, cors);
    return ok({ sessionId: await createSession(env, pid), person: publicPerson(person) }, cors);
  }

  if (path === '/auth/google/link' && method === 'POST') {
    const sess = await resolveSession(request, env);
    if (!sess) return err('Sign in required', 401, cors);
    const body = await readJson(request);
    const sub = await verifyGoogleSub(body?.idToken, (env.GOOGLE_CLIENT_ID || '').trim());
    if (!sub) return err('Invalid or expired Google sign-in', 401, cors);
    const cred = `c:g:${await hmac(env, 'google:' + sub)}`;
    const existing = await kv.get(cred);
    if (existing && existing !== sess.personId) return err('That Google account belongs to another Forecast account', 409, cors);
    await kv.put(cred, sess.personId);
    const p = sess.person;
    p.creds = [...new Set([...(p.creds || []), cred])];
    await kv.put(`p:${p.id}`, JSON.stringify(p));
    return ok({ person: publicPerson(p) }, cors);
  }

  // POST /auth/rekey { loginSecret, wrappedDataKey } — new recovery key.
  // The old recovery key stops working immediately. The data key inside is
  // usually the same one rewrapped; after a lost key it is a fresh one.
  if (path === '/auth/rekey' && method === 'POST') {
    const sess = await resolveSession(request, env);
    if (!sess) return err('Sign in required', 401, cors);
    const body = await readJson(request);
    if (!isBlob(body?.loginSecret, 64) || !isBlob(body?.wrappedDataKey)) return err('Invalid body', 400, cors);
    const p = sess.person;
    for (const c of (p.creds || []).filter(c => c.startsWith('c:rk:'))) await kv.delete(c);
    const rk = `c:rk:${await sha256(body.loginSecret)}`;
    await kv.put(rk, p.id);
    p.creds = [...(p.creds || []).filter(c => !c.startsWith('c:rk:')), rk];
    p.wrappedDataKey = body.wrappedDataKey;
    await kv.put(`p:${p.id}`, JSON.stringify(p));
    return ok({ person: publicPerson(p) }, cors);
  }

  if (path.startsWith('/auth/invite/') && method === 'GET') {
    const token = path.slice('/auth/invite/'.length);
    if (!isId(token, 16, 128)) return err('Invalid invite', 400, cors);
    const inv = await kv.get(`i:${token}`, { type: 'json' });
    if (!inv || inv.redeemedAt) return err('This invite has expired or was already used', 404, cors);
    const meta = await kv.get(`f:${inv.forecastId}:meta`, { type: 'json' });
    if (!meta || meta.inviteToken !== token) return err('This invite is no longer valid', 410, cors);
    return ok({ ownerName: meta.ownerName, forecastId: meta.id, kcv: meta.kcv, sharedEnc: meta.sharedEnc, expiresAt: inv.expiresAt }, cors);
  }

  // POST /auth/invite/redeem { inviteToken, adult, wrappedKey, signup? }
  // Signed out: `signup` carries the same fields as /auth/signup.
  // Signed in: attaches to the existing account.
  if (path === '/auth/invite/redeem' && method === 'POST') {
    const body = await readJson(request);
    if (!isId(body?.inviteToken, 16, 128)) return err('Invalid invite', 400, cors);
    if (body.adult !== true) return err('You must be 18 or older to use Forecast', 400, cors);
    const inv = await kv.get(`i:${body.inviteToken}`, { type: 'json' });
    if (!inv || inv.redeemedAt) return err('This invite has expired or was already used', 404, cors);
    const meta = await kv.get(`f:${inv.forecastId}:meta`, { type: 'json' });
    if (!meta || meta.inviteToken !== body.inviteToken) return err('This invite is no longer valid', 410, cors);
    if (meta.subjectId) return err('Someone has already accepted this invite', 409, cors);

    let sess = await resolveSession(request, env), person;
    if (sess) {
      if (sess.personId === meta.ownerId) return err('You can\u2019t accept your own invite', 400, cors);
      person = sess.person;
    } else {
      const r = await createPerson(env, { ...(body.signup || {}) });
      if (r.error) return err(r.error, 400, cors);
      person = r.person;
    }

    const now = Date.now();
    await kv.put(`f:${meta.id}:m:${person.id}`, JSON.stringify({ personId: person.id, forecastId: meta.id, role: 'subject', status: 'active', createdAt: now }));
    if (isBlob(body.wrappedKey)) await kv.put(`f:${meta.id}:k:${person.id}`, body.wrappedKey);
    await addForecastToPerson(env, person.id, meta.id);
    meta.subjectId = person.id; meta.subjectName = person.displayName; meta.acceptedAt = now;
    delete meta.inviteToken;
    await kv.put(`f:${meta.id}:meta`, JSON.stringify(meta));
    await kv.delete(`i:${body.inviteToken}`);

    const sid = sess ? sess.sessionId : await createSession(env, person.id);
    return ok({ sessionId: sid, person: publicPerson(person), forecastId: meta.id }, cors);
  }

  if (path === '/auth/signout' && method === 'POST') {
    const sid = bearer(request);
    if (sid) await kv.delete(`s:${sid}`);
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
      if (meta) forecasts.push(await forecastFor(env, meta, m.role, sess.personId));
    }
    return ok({ person: publicPerson(sess.person), forecasts }, cors);
  }

  // POST /auth/delete — final step of account deletion. The client first
  // deletes every forecast it owns and leaves every one it was invited to
  // (both paged); this refuses until that is done, then removes the person,
  // every credential, and this session.
  if (path === '/auth/delete' && method === 'POST') {
    const sess = await resolveSession(request, env);
    if (!sess) return err('Sign in required', 401, cors);
    const fids = (await kv.get(`pf:${sess.personId}`, { type: 'json' })) || [];
    for (const fid of fids) {
      if (await getMembership(env, fid, sess.personId)) return err('Delete or leave every forecast first', 409, cors);
    }
    for (const c of sess.person.creds || []) await kv.delete(c);
    await kv.delete(`pf:${sess.personId}`);
    await kv.delete(`p:${sess.personId}`);
    await kv.delete(`s:${sess.sessionId}`);
    return ok({ ok: true }, cors);
  }

  return null;
}

// ── router ─────────────────────────────────────────────────────────────────

async function readJson(request) {
  try {
    const t = await request.text();
    return t.length > MAX_BODY ? null : JSON.parse(t);
  } catch { return null; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const cors = buildCors(getAllowedOrigin(request, env));

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/ping')) {
      return ok({ ok: true, service: 'forecast', e2e: true, time: Date.now() }, cors);
    }
    if (!env[KV_BINDING]) return err('KV namespace not bound', 500, cors);
    if (!env.ID_PEPPER || env.ID_PEPPER.length < 16) return err('ID_PEPPER secret not set', 500, cors);
    const kv = env[KV_BINDING];

    // Short keyed hash, used only inside expiring rate-limit counters.
    const ipHash = (await hmac(env, 'ip:' + (request.headers.get('CF-Connecting-IP') || 'unknown'))).slice(0, 16);

    try {
      if (url.pathname.startsWith('/auth/')) {
        return (await handleAuth(url, method, request, env, cors, ipHash)) || err('Not found', 404, cors);
      }

      // POST /forecasts { id, kcv, wrappedKey, sharedEnc, ownerEnc }
      // The browser chooses the id so it can bind ciphertext to it before
      // the forecast exists here.
      if (url.pathname === '/forecasts' && method === 'POST') {
        const sess = await resolveSession(request, env);
        if (!sess) return err('Sign in required', 401, cors);
        const body = await readJson(request);
        if (!isId(body?.id, 16, 32)) return err('Invalid id', 400, cors);
        for (const f of ['kcv', 'wrappedKey', 'sharedEnc', 'ownerEnc']) if (!isBlob(body[f])) return err(`Invalid ${f}`, 400, cors);
        if (await kv.get(`f:${body.id}:meta`)) return err('Try again', 409, cors);

        const fids = (await kv.get(`pf:${sess.personId}`, { type: 'json' })) || [];
        let owned = 0;
        for (const fid of fids) if ((await getMembership(env, fid, sess.personId))?.role === 'owner') owned++;
        if (owned >= MAX_FORECASTS) return err(`You can have up to ${MAX_FORECASTS} forecasts`, 403, cors);

        const meta = {
          id: body.id, ownerId: sess.personId, ownerName: sess.person.displayName,
          subjectId: null, subjectName: null,
          kcv: body.kcv, sharedEnc: body.sharedEnc, ownerEnc: body.ownerEnc, createdAt: Date.now(),
        };
        await kv.put(`f:${meta.id}:meta`, JSON.stringify(meta));
        await kv.put(`f:${meta.id}:m:${sess.personId}`, JSON.stringify({ personId: sess.personId, forecastId: meta.id, role: 'owner', status: 'active', createdAt: meta.createdAt }));
        await kv.put(`f:${meta.id}:k:${sess.personId}`, body.wrappedKey);
        await addForecastToPerson(env, sess.personId, meta.id);
        return ok({ forecast: await forecastFor(env, meta, 'owner', sess.personId) }, cors);
      }

      if (!url.pathname.startsWith('/f/')) return err('Not found', 404, cors);
      const [, fid, ...tail] = url.pathname.split('/').filter(Boolean);
      if (!isId(fid, 8, 64)) return err('Invalid forecast id', 400, cors);

      const sess = await resolveSession(request, env);
      if (!sess) return err('Sign in required', 401, cors);
      const m = await getMembership(env, fid, sess.personId);
      if (!m) return err('No access to this forecast', 403, cors);
      const meta = await kv.get(`f:${fid}:meta`, { type: 'json' });
      if (!meta) return err('Not found', 404, cors);
      const access = { sess, role: m.role };
      const isOwner = m.role === 'owner';
      const op = tail.join('/');

      if (op === 'entries' && method === 'POST') return await handleWriteEntries(request, env, fid, cors, access);
      if (op === 'sync' && method === 'GET') return await handleSync(request, env, fid, cors, access);

      // Your own wrapped copy of the forecast key (after a recovery-key reset
      // or opening a key link on a new device).
      if (op === 'key' && method === 'PUT') {
        const body = await readJson(request);
        if (!isBlob(body?.wrappedKey)) return err('Invalid key', 400, cors);
        await kv.put(`f:${fid}:k:${sess.personId}`, body.wrappedKey);
        return ok({ ok: true }, cors);
      }

      // Opaque settings blobs. Either member may update the shared one
      // (cycle length is hers to correct); only the owner has an owner blob.
      if (op === 'settings' && method === 'PUT') {
        const body = await readJson(request) || {};
        if (body.sharedEnc != null) { if (!isBlob(body.sharedEnc)) return err('Invalid sharedEnc', 400, cors); meta.sharedEnc = body.sharedEnc; }
        if (body.ownerEnc != null) { if (!isOwner || !isBlob(body.ownerEnc)) return err('Not permitted', 403, cors); meta.ownerEnc = body.ownerEnc; }
        await kv.put(`f:${fid}:meta`, JSON.stringify(meta));
        return ok({ forecast: await forecastFor(env, meta, m.role, sess.personId) }, cors);
      }

      if (op === 'invite' && method === 'POST') {
        if (!isOwner) return err('Not permitted', 403, cors);
        if (meta.subjectId) return err('Someone has already joined this forecast', 409, cors);
        if (!(await rateLimit(env, `inv:${sess.personId}`, INVITE_DAY_LIMIT, 86400))) return err('Invite limit reached for today', 429, cors);
        if (meta.inviteToken) await kv.delete(`i:${meta.inviteToken}`);
        const token = randomId(24);
        const inv = { forecastId: fid, createdAt: Date.now(), expiresAt: Date.now() + INVITE_TTL * 1000 };
        await kv.put(`i:${token}`, JSON.stringify(inv), { expirationTtl: INVITE_TTL });
        meta.inviteToken = token;
        await kv.put(`f:${fid}:meta`, JSON.stringify(meta));
        return ok({ token, expiresAt: inv.expiresAt }, cors);
      }

      if (op === 'invite/cancel' && method === 'POST') {
        if (!isOwner) return err('Not permitted', 403, cors);
        if (meta.inviteToken) await kv.delete(`i:${meta.inviteToken}`);
        delete meta.inviteToken;
        await kv.put(`f:${fid}:meta`, JSON.stringify(meta));
        return ok({ ok: true }, cors);
      }

      if (op === 'remove' && method === 'POST') {
        if (!isOwner) return err('Not permitted', 403, cors);
        if (meta.subjectId) await endSubject(env, fid, meta, meta.subjectId, 'removed');
        return ok({ ok: true }, cors);
      }

      if (op === 'leave' && method === 'POST') {
        if (isOwner) return err('Owners delete the forecast instead', 400, cors);
        const body = await readJson(request) || {};
        if (body.erase) {
          const r = await purgeByTag(env, fid, 's', body.cursor);
          if (r.more) return ok({ more: true, cursor: r.cursor }, cors);
        }
        await endSubject(env, fid, meta, sess.personId, 'left');
        return ok({ more: false }, cors);
      }

      if (op === 'delete' && method === 'POST') {
        if (!isOwner) return err('Not permitted', 403, cors);
        const body = await readJson(request) || {};
        const r = await purgeByTag(env, fid, null, body.cursor);
        if (r.more) return ok({ more: true, cursor: r.cursor }, cors);
        await deleteForecastRecords(env, fid, meta);
        return ok({ more: false }, cors);
      }

      return err('Not found', 404, cors);
    } catch (e) {
      console.error('[worker]', e?.message);
      return err('Server error', 500, cors);
    }
  },
};

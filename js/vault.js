/**
 * vault.js — all the cryptography, in one place.
 *
 * Three kinds of key:
 *
 *   recovery key   32 random bytes, shown to the person once as 52 letters
 *                  and digits. Never leaves the browser. Two things are
 *                  derived from it with HKDF:
 *                    login secret → sent to the worker, which stores a hash
 *                    wrap key     → encrypts the data key
 *
 *   data key       32 random bytes per person. Seals the person's private
 *                  entries and private settings. Stored on the worker only
 *                  wrapped under the recovery key, and on this device in
 *                  IndexedDB. Changing the recovery key just rewraps it, so
 *                  nothing has to be re-encrypted.
 *
 *   forecast key   32 random bytes per forecast, made by the owner. Seals
 *                  everything both people can see. Each member keeps a copy
 *                  wrapped under their own data key. It reaches the invitee
 *                  in the invite link's #fragment, which browsers never send
 *                  to any server.
 *
 * Everything is AES-256-GCM with a random 96-bit IV, and every ciphertext
 * is bound by additional data to where it belongs (forecast id plus entry
 * id), so the worker cannot move a sealed blob from one place to another
 * and have it open.
 */
const Vault = (() => {
  const te = new TextEncoder(), td = new TextDecoder();
  const SALT = te.encode('forecast/v1');

  // ── encodings ────────────────────────────────────────────────────────
  const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  function unb64u(s) {
    const p = s.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(p + '='.repeat((4 - p.length % 4) % 4)), c => c.charCodeAt(0));
  }

  // Base32 for the recovery key: no lookalike punctuation, case-insensitive,
  // and easy to read aloud or copy by hand.
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  function toB32(bytes) {
    let bits = 0, val = 0, out = '';
    for (const b of bytes) {
      val = (val << 8) | b; bits += 8;
      while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits) out += B32[(val << (5 - bits)) & 31];
    return out;
  }
  function fromB32(s) {
    const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0, val = 0; const out = [];
    for (const c of clean) {
      val = (val << 5) | B32.indexOf(c); bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    return new Uint8Array(out);
  }
  const formatRecovery = raw => toB32(raw).match(/.{1,4}/g).join('-');
  function parseRecovery(s) {
    const raw = fromB32(s || '');
    return raw.length === 32 ? raw : null;
  }

  const random = n => crypto.getRandomValues(new Uint8Array(n));
  const aes = (raw, extractable = false) =>
    crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);

  // ── sealing ──────────────────────────────────────────────────────────
  async function seal(key, value, aad) {
    const iv = random(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) },
      key, te.encode(JSON.stringify(value)));
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv); out.set(new Uint8Array(ct), 12);
    return b64u(out);
  }
  async function open(key, blob, aad) {
    const bytes = unb64u(blob);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: te.encode(aad) },
      key, bytes.slice(12));
    return JSON.parse(td.decode(pt));
  }

  // ── recovery key ─────────────────────────────────────────────────────
  async function deriveFromRecovery(raw) {
    const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']);
    const loginBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: te.encode('login') }, base, 256);
    const wrapKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: te.encode('wrap') },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return { loginSecret: b64u(loginBits), wrapKey };
  }

  /** A brand-new identity: recovery key plus a fresh data key. */
  async function newIdentity() {
    const recovery = random(32);
    const dataRaw = random(32);
    const { loginSecret, wrapKey } = await deriveFromRecovery(recovery);
    const wrappedDataKey = await seal(wrapKey, b64u(dataRaw), 'datakey');
    return { recoveryText: formatRecovery(recovery), loginSecret, wrappedDataKey, dataKey: await aes(dataRaw, true) };
  }

  /** New recovery key around an EXISTING data key. Nothing else changes. */
  async function rewrapIdentity(dataKey) {
    const recovery = random(32);
    const dataRaw = new Uint8Array(await crypto.subtle.exportKey('raw', dataKey));
    const { loginSecret, wrapKey } = await deriveFromRecovery(recovery);
    return { recoveryText: formatRecovery(recovery), loginSecret, wrappedDataKey: await seal(wrapKey, b64u(dataRaw), 'datakey') };
  }

  /** Typed recovery key → login secret and, given the wrapped blob, the data key. */
  async function fromRecoveryText(text) {
    const raw = parseRecovery(text);
    if (!raw) return null;
    const d = await deriveFromRecovery(raw);
    return {
      loginSecret: d.loginSecret,
      async unwrap(wrappedDataKey) {
        try { return await aes(unb64u(await open(d.wrapKey, wrappedDataKey, 'datakey')), true); }
        catch { return null; }
      },
    };
  }

  // ── forecast keys ────────────────────────────────────────────────────
  async function newForecast(fid, dataKey) {
    const raw = random(32);
    const key = await aes(raw);
    return {
      raw, key,
      kcv: await seal(key, 'ok', `kcv:${fid}`),
      wrappedKey: await seal(dataKey, b64u(raw), `wrap:${fid}`),
    };
  }
  async function forecastFromRaw(raw, fid, kcv) {
    const key = await aes(raw);
    try { if (await open(key, kcv, `kcv:${fid}`) !== 'ok') return null; }
    catch { return null; }
    return { raw, key };
  }
  async function unwrapForecast(dataKey, wrappedKey, fid, kcv) {
    try { return await forecastFromRaw(unb64u(await open(dataKey, wrappedKey, `wrap:${fid}`)), fid, kcv); }
    catch { return null; }
  }
  const wrapForecast = (dataKey, raw, fid) => seal(dataKey, b64u(raw), `wrap:${fid}`);
  const fragmentKey = raw => b64u(raw);
  function parseFragmentKey(s) {
    try { const r = unb64u(s || ''); return r.length === 32 ? r : null; } catch { return null; }
  }

  // ── device storage ───────────────────────────────────────────────────
  // The data key lives in IndexedDB as a CryptoKey object, keyed by person,
  // so several accounts can share a browser. It is extractable only so a
  // new recovery key can be made later without re-encrypting anything.
  let _db;
  function db() {
    return _db ||= new Promise((res, rej) => {
      const r = indexedDB.open('forecast', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('keys');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function store(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction('keys', mode);
      const req = fn(t.objectStore('keys'));
      t.oncomplete = () => res(req?.result ?? null);     // resolve on COMMIT
      t.onerror = () => rej(t.error);
    });
  }
  const saveDataKey  = (pid, key) => store('readwrite', s => s.put(key, pid));
  const loadDataKey  = pid => store('readonly', s => s.get(pid)).catch(() => null);
  const forgetDataKey = pid => store('readwrite', s => s.delete(pid));

  return {
    seal, open, newIdentity, rewrapIdentity, fromRecoveryText,
    newForecast, forecastFromRaw, unwrapForecast, wrapForecast, fragmentKey, parseFragmentKey,
    saveDataKey, loadDataKey, forgetDataKey,
  };
})();

// Enkripsi AES-GCM untuk op/snapshot, dan vault lokal (PBKDF2 + AES-GCM).
export const b64 = {
  enc(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  },
  dec: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};
export const b64u = {
  enc: u8 => b64.enc(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => b64.dec(s.replace(/-/g, '+').replace(/_/g, '/')),
};

export const randomKeyBytes = () => crypto.getRandomValues(new Uint8Array(32));
export const importKey = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

export async function encrypt(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}
export async function decrypt(key, bytes) {
  const u8 = new Uint8Array(bytes);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.subarray(0, 12) }, key, u8.subarray(12)));
}

/* ── identitas ECDH per anggota + pembungkusan kunci (rotasi kunci) ── */
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
export async function genIdentity() {
  const kp = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
  return { priv: kp.privateKey, pub: b64.enc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))),
    jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
}
export async function loadIdentity({ jwk, pub }) {
  return { priv: await crypto.subtle.importKey('jwk', jwk, ECDH, true, ['deriveKey']), pub, jwk };
}
async function shared(priv, pubRaw) {
  const pub = await crypto.subtle.importKey('raw', pubRaw, ECDH, false, []);
  return crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
/** Bungkus bytes agar hanya pemilik kunci privat untuk pubB64 yang bisa membukanya. */
export async function wrapFor(pubB64, bytes) {
  const eph = await crypto.subtle.generateKey(ECDH, false, ['deriveKey']);
  const e = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  return { e: b64.enc(e), c: b64.enc(await encrypt(await shared(eph.privateKey, b64.dec(pubB64)), bytes)) };
}
export async function unwrap(priv, w) { return decrypt(await shared(priv, b64.dec(w.e)), b64.dec(w.c)); }

/* ── vault: data sensitif lokal (session Telegram + kunci database) dienkripsi passphrase ── */
const VAULT_KEY = 'tgpg:vault';
const ITER = 250000;
async function derive(pass, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export const hasVault = () => !!localStorage.getItem(VAULT_KEY);
export const deleteVault = () => localStorage.removeItem(VAULT_KEY);
export async function saveVault(pass, obj) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = await encrypt(await derive(pass, salt), new TextEncoder().encode(JSON.stringify(obj)));
  localStorage.setItem(VAULT_KEY, JSON.stringify({ s: b64.enc(salt), d: b64.enc(enc) }));
}
export async function loadVault(pass) {
  const { s, d } = JSON.parse(localStorage.getItem(VAULT_KEY));
  try {
    return JSON.parse(new TextDecoder().decode(await decrypt(await derive(pass, b64.dec(s)), b64.dec(d))));
  } catch { throw new Error('Passphrase salah'); }
}

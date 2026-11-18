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
export const deleteVault = () => { localStorage.removeItem(VAULT_KEY); return forgetDevice().catch(() => {}); };

/** vk = { key: CryptoKey (tidak bisa diekspor), salt } — dipertahankan agar vault bisa ditulis ulang tanpa passphrase. */
export async function newVaultKey(pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { key: await derive(pass, salt), salt };
}
export async function saveVault(vk, obj) {
  const enc = await encrypt(vk.key, new TextEncoder().encode(JSON.stringify(obj)));
  localStorage.setItem(VAULT_KEY, JSON.stringify({ s: b64.enc(vk.salt), d: b64.enc(enc) }));
}
async function open(vk, d) {
  return JSON.parse(new TextDecoder().decode(await decrypt(vk.key, b64.dec(d))));
}
export async function loadVault(pass) {
  const { s, d } = JSON.parse(localStorage.getItem(VAULT_KEY));
  const salt = b64.dec(s), vk = { key: await derive(pass, salt), salt };
  try { return { data: await open(vk, d), vk }; } catch { throw new Error('Passphrase salah'); }
}

/* ── "ingat di perangkat ini": kunci vault (non-extractable) disimpan di IndexedDB agar refresh tidak minta passphrase ── */
const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open('tgpg-device', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('k');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const tx = async (mode, fn) => { const db = await idb(); return new Promise((res, rej) => {
  const t = db.transaction('k', mode), q = fn(t.objectStore('k'));
  t.oncomplete = () => { db.close(); res(q.result); }; t.onerror = () => { db.close(); rej(t.error); }; }); };
export const rememberDevice = vk => tx('readwrite', st => st.put({ key: vk.key, salt: vk.salt }, 'vault'));
export const forgetDevice = () => tx('readwrite', st => st.delete('vault'));
/** Coba buka vault dengan kunci perangkat; null bila tidak ada / gagal. */
export async function unlockWithDevice() {
  try {
    const vk = await tx('readonly', st => st.get('vault'));
    if (!vk || !hasVault()) return null;
    return { data: await open(vk, JSON.parse(localStorage.getItem(VAULT_KEY)).d), vk };
  } catch { return null; }
}

/* ── cadangan terenkripsi passphrase (sinkron antar perangkat) ── */
export async function sealBlob(pass, obj) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = await encrypt(await derive(pass, salt), new TextEncoder().encode(JSON.stringify(obj)));
  const out = new Uint8Array(16 + enc.length); out.set(salt); out.set(enc, 16); return out;
}
export async function openBlob(pass, bytes) {
  const u8 = new Uint8Array(bytes);
  try { return JSON.parse(new TextDecoder().decode(await decrypt(await derive(pass, u8.slice(0, 16)), u8.slice(16)))); }
  catch { throw new Error('Passphrase sinkron salah (atau cadangan rusak)'); }
}

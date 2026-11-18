// Sinkron daftar database + kunci antar perangkat (payload murni; enkripsi di crypto.js, transport di telegram.js).
/** Isi yang disinkronkan: database tersimpan (+ kunci), identitas penulis, dan penanda "dilupakan". Tanpa session Telegram. */
export function buildPayload(V) {
  const dbs = {};
  for (const [id, d] of Object.entries(V.dbs || {})) dbs[id] = { conn: d.conn, title: d.title, keys: d.keys, addedAt: d.addedAt || 0 };
  return { v: 1, dbs, identity: V.identity || null, gone: V.gone || {} };
}

/** Gabungkan payload dari perangkat lain ke V (tanpa menimpa data lokal). Mengembalikan true bila V berubah. */
export function mergePayload(V, p) {
  if (!p || p.v !== 1) throw new Error('Format cadangan tidak dikenal');
  let changed = false;
  V.dbs = V.dbs || {}; V.gone = V.gone || {};
  for (const [id, ts] of Object.entries(p.gone || {})) {
    if (!(V.gone[id] >= ts)) { V.gone[id] = ts; changed = true; }
    if (V.dbs[id] && ts > (V.dbs[id].addedAt || 0)) { delete V.dbs[id]; changed = true; }
  }
  for (const [id, r] of Object.entries(p.dbs || {})) {
    if (V.gone[id] && V.gone[id] > (r.addedAt || 0)) continue;
    const l = V.dbs[id];
    if (!l) { V.dbs[id] = { ...r }; changed = true; continue; }
    const keys = { ...(r.keys || {}), ...(l.keys || {}) };
    if (Object.keys(keys).length !== Object.keys(l.keys || {}).length) { l.keys = keys; changed = true; }
  }
  if (!V.identity && p.identity) { V.identity = p.identity; changed = true; }
  return changed;
}

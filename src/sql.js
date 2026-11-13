// Pembantu SQL: membuat write deterministik di semua klien & mengklasifikasi read/write.
// Token yang dilewati saat rewrite: string, identifier, komentar, dollar-quote.
const QUOTED = /'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\/|\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g;

const sub = s => s
  .replace(/\bgen_random_uuid\s*\(\s*\)/gi, 'tg_uuid()')
  .replace(/\b(?:now|clock_timestamp|statement_timestamp|transaction_timestamp)\s*\(\s*\)/gi, 'tg_now()')
  .replace(/\bcurrent_timestamp\b(?!\s*\()/gi, 'tg_now()')
  .replace(/\brandom\s*\(\s*\)/gi, 'tg_random()');

/** Ganti fungsi non-deterministik dengan tg_*() (nilainya diturunkan dari op, sama di semua klien). */
export function rewrite(sql) {
  let out = '', last = 0;
  for (const m of sql.matchAll(QUOTED)) {
    out += sub(sql.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + sub(sql.slice(last));
}

/** true bila statement tunggal yang hanya membaca (dijalankan lokal, tidak masuk log). */
export function isRead(sql) {
  const s = sql.replace(QUOTED, "''").trim();
  if (/;\s*\S/.test(s)) return false;
  if (/^(select|show|values|explain)\b/i.test(s)) return true;
  return /^with\b/i.test(s) && !/\b(insert|update|delete|merge|into)\b/i.test(s);
}

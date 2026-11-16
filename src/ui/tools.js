// Dump SQL (struktur + data), parser CSV/JSON, dan pembuat INSERT untuk import.
import { qi, qname, ql } from './catalog.js';
import { loadStructure, tableDDL } from './ddl.js';

/* ───────── CSV ───────── */
export function detectDelimiter(text) {
  const head = text.slice(0, 4096).split(/\r?\n/)[0] || '';
  const score = d => head.split(d).length;
  return [',', ';', '\t', '|'].sort((a, b) => score(b) - score(a))[0];
}

/** -> array of array string. Mendukung kutip ganda, "" sebagai escape, CRLF, BOM, dan baris kosong di akhir. */
export function parseCSV(text, delimiter = null) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const d = delimiter || detectDelimiter(text);
  const rows = []; let row = [], cur = '', q = false, i = 0, any = false;
  while (i < text.length) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i += 2; continue; } q = false; i++; continue; }
      cur += ch; i++; continue;
    }
    if (ch === '"' && cur === '') { q = true; any = true; i++; continue; }
    if (ch === d) { row.push(cur); cur = ''; any = true; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
      if (any || cur !== '' || row.length) { row.push(cur); rows.push(row); }
      row = []; cur = ''; any = false; continue;
    }
    cur += ch; any = true; i++;
  }
  if (q) throw new Error('CSV tidak valid: tanda kutip tidak ditutup');
  if (any || cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/** JSON array of object -> {header, rows} (nilai non-string di-JSON-kan; null tetap null). */
export function parseJSONRows(text) {
  let data; try { data = JSON.parse(text); } catch (e) { throw new Error(`JSON tidak valid: ${e.message}`); }
  if (!Array.isArray(data) || data.some(x => x === null || typeof x !== 'object' || Array.isArray(x))) throw new Error('JSON harus berupa array objek');
  const header = [...new Set(data.flatMap(o => Object.keys(o)))];
  const val = v => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return { header, rows: data.map(o => header.map(k => val(o[k]))) };
}

/* ───────── import ───────── */
/**
 * mapping: [{from: indeks kolom sumber, to: nama kolom tabel}]
 * opsi: emptyAsNull (default true), nullToken (mis. 'NULL', opsional)
 * -> array SQL INSERT (satu per chunk), masing-masing aman < ~maxBytes.
 */
export function buildImport(schema, name, mapping, rows, { emptyAsNull = true, nullToken = null, maxBytes = 1_000_000, maxRows = 500 } = {}) {
  if (!mapping.length) throw new Error('Pilih minimal satu kolom untuk diimpor');
  const to = new Set(); for (const m of mapping) { if (to.has(m.to)) throw new Error(`Kolom tujuan ganda: ${m.to}`); to.add(m.to); }
  const head = `insert into ${qname(schema, name)} (${mapping.map(m => qi(m.to)).join(', ')}) values `;
  const lit = v => (v === null || v === undefined || (emptyAsNull && v === '') || (nullToken !== null && v === nullToken) ? 'NULL' : ql(v));
  const out = []; let buf = [], size = head.length;
  const flush = () => { if (buf.length) out.push(head + buf.join(',\n')); buf = []; size = head.length; };
  for (const r of rows) {
    const t = '(' + mapping.map(m => lit(r[m.from])).join(', ') + ')';
    if (buf.length >= maxRows || size + t.length > maxBytes) flush();
    buf.push(t); size += t.length + 2;
  }
  flush();
  return out;
}

/** Tebak pemetaan header -> kolom tabel (nama sama, tak peka huruf). */
export function guessMapping(header, cols) {
  const by = new Map(cols.map(c => [c.name.toLowerCase(), c.name]));
  return header.map((h, i) => ({ from: i, to: by.get(String(h).trim().toLowerCase()) || null })).filter(m => m.to);
}

/* ───────── dump ───────── */
/** Urutan tabel: yang dirujuk FK lebih dulu (siklus dibiarkan urutan asal). */
export function orderTables(names, fks) {
  const key = (s, t) => `${s}.${t}`;
  const deps = new Map(names.map(n => [key(n.schema, n.name), new Set()]));
  for (const f of fks) { const a = key(f.schema, f.table), b = key(f.refSchema, f.refTable); if (a !== b && deps.has(a) && deps.has(b)) deps.get(a).add(b); }
  const out = [], done = new Set(), visiting = new Set();
  const visit = n => {
    const k = key(n.schema, n.name); if (done.has(k)) return;
    if (visiting.has(k)) return; visiting.add(k);
    for (const d of deps.get(k)) visit(names.find(x => key(x.schema, x.name) === d));
    visiting.delete(k); done.add(k); out.push(n);
  };
  names.forEach(visit);
  return out;
}

/** SQL dump satu tabel. {data:true, structure:true}. engine: read-only. */
export async function dumpTable(engine, schema, name, { structure = true, data = true, batch = 200 } = {}) {
  const st = await loadStructure(engine, schema, name);
  const parts = [];
  if (structure) parts.push(`-- ${schema}.${name}\n${tableDDL(st)}`);
  if (data && (st.kind === 'r' || st.kind === 'p')) {
    const cols = st.cols.filter(c => c.generated !== 's');
    if (cols.length) {
      const sel = cols.map(c => `${qi(c.name)}::text as ${qi(c.name)}`).join(', ');
      const [r] = await engine.read(`select ${sel} from ${qname(schema, name)}`);
      const override = cols.some(c => c.identity === 'a') ? ' OVERRIDING SYSTEM VALUE' : '';
      const head = `INSERT INTO ${qname(schema, name)} (${cols.map(c => qi(c.name)).join(', ')})${override} VALUES `;
      for (let i = 0; i < r.rows.length; i += batch) {
        parts.push(head + r.rows.slice(i, i + batch).map(row => '(' + cols.map(c => ql(row[c.name])).join(', ') + ')').join(',\n') + ';');
      }
      for (const c of cols) if (c.identity || /^nextval\(/.test(c.def || '')) {
        const full = qname(schema, name);
        parts.push(`SELECT setval(pg_get_serial_sequence('${full.replace(/'/g, "''")}', '${c.name.replace(/'/g, "''")}'), COALESCE(MAX(${qi(c.name)}), 1), MAX(${qi(c.name)}) IS NOT NULL) FROM ${full};`);
      }
    }
  }
  return parts.join('\n');
}

/** Dump seluruh database (semua schema non-sistem): CREATE SCHEMA + tabel berurutan FK + data. */
export async function dumpAll(engine, catalog, fks, opts = {}) {
  const list = [];
  const schemas = [];
  for (const [schema, { tables }] of catalog) {
    if (schema !== 'public' && tables.length) schemas.push(schema);
    for (const t of tables) if (t.kind === 'r' || t.kind === 'p') list.push({ schema, name: t.name });
  }
  const ordered = orderTables(list, fks);
  const body = [];
  for (const s of schemas) body.push(`CREATE SCHEMA IF NOT EXISTS ${qi(s)};`);
  for (const t of ordered) body.push(await dumpTable(engine, t.schema, t.name, opts));
  return `-- TGPG dump ${new Date().toISOString()}\nBEGIN;\n${body.join('\n\n')}\nCOMMIT;\n`;
}

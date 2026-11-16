// Struktur tabel (kolom, constraint, FK, index, trigger), pembuat DDL, dan pembuat SQL ubah-skema.
// Semua pembuat mengembalikan string SQL; tidak ada yang dijalankan di sini.
import { qi, qname } from './catalog.js';

const SYS = String.raw`n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg\_toast%'`;

export const COMMON_TYPES = ['text', 'integer', 'bigint', 'smallint', 'serial', 'bigserial', 'boolean', 'numeric(12,2)', 'double precision', 'real',
  'varchar(255)', 'char(1)', 'uuid', 'date', 'time', 'timestamp', 'timestamptz', 'interval', 'json', 'jsonb', 'bytea', 'inet', 'text[]'];

const ACTION = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
export const FK_ACTIONS = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];

/* ───────── validasi masukan bebas ───────── */
const TYPE_RE = /^[A-Za-z_][A-Za-z0-9_ ,()."\[\]]*$/;
export function checkType(t) {
  const s = String(t || '').trim();
  if (!s || !TYPE_RE.test(s)) throw new Error(`Tipe data tidak valid: ${t}`);
  return s;
}
export function checkExpr(e) {
  const s = String(e ?? '').trim();
  if (/;|--|\/\*/.test(s)) throw new Error('Ekspresi tidak boleh mengandung ";" atau komentar');
  return s;
}
const ident = n => { const s = String(n ?? '').trim(); if (!s) throw new Error('Nama tidak boleh kosong'); return qi(s); };

/** Fungsi deterministik internal TGPG -> fungsi Postgres asli (agar DDL/dump portabel; rewrite() memetakannya kembali saat dijalankan di TGPG). */
export const unrewrite = e => (e == null ? e : String(e).split(/('(?:[^']|'')*')/).map((part, i) => (i % 2 ? part
  : part.replace(/\btg_now\(\)/g, 'now()').replace(/\btg_uuid\(\)/g, 'gen_random_uuid()').replace(/\btg_random\(\)/g, 'random()'))).join(''));

/* ───────── pemuat struktur ───────── */
/** -> {cols, constraints, fks, indexes, triggers, kind, comment, rowEstimate, size} */
export async function loadStructure(engine, schema, name) {
  const rel = `(select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2)`;
  const q = (sql) => engine.query(sql, [schema, name]).then(r => r.rows);
  const [cols, cons, idx, trg, meta] = await Promise.all([
    q(`select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull, pg_get_expr(d.adbin, d.adrelid) as def,
         a.attidentity::text as identity, a.attgenerated::text as generated, col_description(a.attrelid, a.attnum) as comment
       from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where a.attrelid = ${rel} and a.attnum > 0 and not a.attisdropped order by a.attnum`),
    q(`select con.conname as name, con.contype::text as type, pg_get_constraintdef(con.oid) as def,
         (select coalesce(array_agg(a.attname order by k.ord), '{}') from unnest(con.conkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as cols,
         fn.nspname as ref_schema, fc.relname as ref_table,
         (select coalesce(array_agg(a.attname order by k.ord), '{}') from unnest(con.confkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as ref_cols,
         con.confupdtype::text as on_update, con.confdeltype::text as on_delete
       from pg_constraint con left join pg_class fc on fc.oid = con.confrelid left join pg_namespace fn on fn.oid = fc.relnamespace
       where con.conrelid = ${rel} order by con.contype desc, con.conname`),
    q(`select i.relname as name, pg_get_indexdef(i.oid) as def, x.indisunique as "unique", x.indisprimary as "primary",
         (select count(*) from pg_constraint k where k.conindid = i.oid)::int as constraint_count,
         (select coalesce(array_agg(a.attname order by k.ord), '{}') from unnest(x.indkey::int2[]) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = x.indrelid and a.attnum = k.attnum) as cols
       from pg_index x join pg_class i on i.oid = x.indexrelid where x.indrelid = ${rel} order by i.relname`),
    q(`select t.tgname as name, pg_get_triggerdef(t.oid) as def from pg_trigger t where t.tgrelid = ${rel} and not t.tgisinternal order by 1`),
    q(`select c.relkind::text as kind, obj_description(c.oid) as comment, c.reltuples::bigint as estimate, pg_total_relation_size(c.oid)::bigint as size,
         case when c.relkind in ('v','m') then pg_get_viewdef(c.oid, true) end as viewdef
       from pg_class c where c.oid = ${rel}`),
  ]);
  if (!meta.length) throw new Error(`Objek ${schema}.${name} tidak ditemukan`);
  const m = meta[0];
  const fks = cons.filter(c => c.type === 'f').map(c => ({
    name: c.name, cols: c.cols, refSchema: c.ref_schema, refTable: c.ref_table, refCols: c.ref_cols,
    onUpdate: ACTION[c.on_update] || 'NO ACTION', onDelete: ACTION[c.on_delete] || 'NO ACTION',
  }));
  return {
    schema, name, kind: m.kind, comment: m.comment, estimate: Number(m.estimate), size: Number(m.size), viewdef: m.viewdef,
    cols: cols.map(c => ({ ...c, def: unrewrite(c.def), pk: cons.some(k => k.type === 'p' && k.cols.includes(c.name)) })),
    constraints: cons.map(c => ({ name: c.name, type: c.type, def: unrewrite(c.def), cols: c.cols })),
    fks,
    indexes: idx.map(i => ({ name: i.name, def: unrewrite(i.def), unique: i.unique, primary: i.primary, cols: i.cols, viaConstraint: i.constraint_count > 0 })),
    triggers: trg.map(t => ({ ...t, def: unrewrite(t.def) })),
  };
}

/** Semua FK di database (untuk ERD): [{name, schema, table, cols, refSchema, refTable, refCols}] */
export async function loadAllFks(engine) {
  const r = await engine.query(`select con.conname as name, n.nspname as schema, c.relname as "table",
      (select array_agg(a.attname order by k.ord) from unnest(con.conkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as cols,
      fn.nspname as ref_schema, fc.relname as ref_table,
      (select array_agg(a.attname order by k.ord) from unnest(con.confkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as ref_cols
    from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_class fc on fc.oid = con.confrelid join pg_namespace fn on fn.oid = fc.relnamespace
    where con.contype = 'f' and ${SYS} and c.relname not like '\\_tgpg%' order by 2, 3, 1`, []);
  return r.rows.map(x => ({ name: x.name, schema: x.schema, table: x.table, cols: x.cols, refSchema: x.ref_schema, refTable: x.ref_table, refCols: x.ref_cols }));
}

/* ───────── DDL (teks CREATE TABLE) ───────── */
function colDef(c) {
  let s = `${qi(c.name)} ${c.type}`;
  if (c.generated === 's') return `${s} GENERATED ALWAYS AS (${c.def}) STORED${c.notnull ? ' NOT NULL' : ''}`;
  const serial = /^nextval\('.+'::regclass\)$/.test(c.def || '') && { integer: 'serial', bigint: 'bigserial', smallint: 'smallserial' }[c.type];
  if (serial) return `${qi(c.name)} ${serial}${c.notnull ? ' NOT NULL' : ''}`;
  if (c.identity === 'a') s += ' GENERATED ALWAYS AS IDENTITY';
  else if (c.identity === 'd') s += ' GENERATED BY DEFAULT AS IDENTITY';
  else if (c.def != null) s += ` DEFAULT ${c.def}`;
  if (c.notnull) s += ' NOT NULL';
  return s;
}

/** DDL lengkap tabel dari hasil loadStructure(): CREATE TABLE + index non-constraint + trigger + komentar. */
export function tableDDL(st) {
  const full = qname(st.schema, st.name);
  if (st.kind === 'v') return `CREATE OR REPLACE VIEW ${full} AS\n${st.viewdef.trim()}`;
  if (st.kind === 'm') return `CREATE MATERIALIZED VIEW ${full} AS\n${st.viewdef.trim()}`;
  const lines = st.cols.map(c => '  ' + colDef(c));
  const order = { p: 0, u: 1, c: 2, x: 3, f: 4 };
  for (const k of [...st.constraints].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || a.name.localeCompare(b.name))) {
    if (k.type === 'n') continue;   // NOT NULL sudah di definisi kolom
    lines.push(`  CONSTRAINT ${qi(k.name)} ${k.def}`);
  }
  const out = [`CREATE TABLE ${full} (\n${lines.join(',\n')}\n);`];
  for (const i of st.indexes) if (!i.viaConstraint && !i.primary) out.push(i.def + ';');
  for (const t of st.triggers) out.push(t.def + ';');
  if (st.comment) out.push(`COMMENT ON TABLE ${full} IS '${st.comment.replace(/'/g, "''")}';`);
  for (const c of st.cols) if (c.comment) out.push(`COMMENT ON COLUMN ${full}.${qi(c.name)} IS '${c.comment.replace(/'/g, "''")}';`);
  return out.join('\n');
}

/* ───────── pembuat SQL ubah skema ───────── */
const ALTER = (schema, name) => `ALTER TABLE ${qname(schema, name)}`;

/** spec: {schema, name, cols:[{name,type,notnull,def,unique}], pk:[nama kolom]} */
export function createTable({ schema = 'public', name, cols, pk = [] }) {
  if (!cols?.length) throw new Error('Tabel butuh minimal satu kolom');
  const seen = new Set();
  const lines = cols.map(c => {
    const n = String(c.name || '').trim(); if (!n) throw new Error('Nama kolom tidak boleh kosong');
    if (seen.has(n)) throw new Error(`Nama kolom ganda: ${n}`); seen.add(n);
    let s = `  ${qi(n)} ${checkType(c.type)}`;
    const d = checkExpr(c.def); if (d) s += ` DEFAULT ${d}`;
    if (c.notnull) s += ' NOT NULL';
    if (c.unique) s += ' UNIQUE';
    return s;
  });
  for (const p of pk) if (!seen.has(p)) throw new Error(`Kolom PK tidak ada: ${p}`);
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.map(qi).join(', ')})`);
  if (!String(name || '').trim()) throw new Error('Nama tabel tidak boleh kosong');
  return `CREATE TABLE ${qname(schema, String(name).trim())} (\n${lines.join(',\n')}\n)`;
}

export const addColumn = (schema, name, c) => {
  let s = `${ALTER(schema, name)} ADD COLUMN ${ident(c.name)} ${checkType(c.type)}`;
  const d = checkExpr(c.def); if (d) s += ` DEFAULT ${d}`;
  if (c.notnull) s += ' NOT NULL';
  return s;
};
export const dropColumn = (schema, name, col, cascade = false) => `${ALTER(schema, name)} DROP COLUMN ${ident(col)}${cascade ? ' CASCADE' : ''}`;
export const renameColumn = (schema, name, from, to) => `${ALTER(schema, name)} RENAME COLUMN ${ident(from)} TO ${ident(to)}`;
export const alterColumnType = (schema, name, col, type, using = '') => {
  const u = checkExpr(using);
  return `${ALTER(schema, name)} ALTER COLUMN ${ident(col)} TYPE ${checkType(type)}${u ? ` USING ${u}` : ''}`;
};
export const setDefault = (schema, name, col, expr) => {
  const e = checkExpr(expr);
  return e ? `${ALTER(schema, name)} ALTER COLUMN ${ident(col)} SET DEFAULT ${e}` : `${ALTER(schema, name)} ALTER COLUMN ${ident(col)} DROP DEFAULT`;
};
export const setNotNull = (schema, name, col, on) => `${ALTER(schema, name)} ALTER COLUMN ${ident(col)} ${on ? 'SET' : 'DROP'} NOT NULL`;

export const renameTable = (schema, name, to) => `${ALTER(schema, name)} RENAME TO ${ident(to)}`;
export const dropTable = (schema, name, { cascade = false, kind = 'r' } = {}) =>
  `DROP ${kind === 'v' ? 'VIEW' : kind === 'm' ? 'MATERIALIZED VIEW' : 'TABLE'} ${qname(schema, name)}${cascade ? ' CASCADE' : ''}`;
export const truncateTable = (schema, name, { restart = true, cascade = false } = {}) =>
  `TRUNCATE TABLE ${qname(schema, name)}${restart ? ' RESTART IDENTITY' : ''}${cascade ? ' CASCADE' : ''}`;
export const setTableComment = (schema, name, text) => `COMMENT ON TABLE ${qname(schema, name)} IS ${text ? `'${String(text).replace(/'/g, "''")}'` : 'NULL'}`;

export const createSchema = name => `CREATE SCHEMA ${ident(name)}`;
export const dropSchema = (name, cascade = false) => `DROP SCHEMA ${ident(name)}${cascade ? ' CASCADE' : ''}`;

export function createIndex(schema, name, { cols, unique = false, method = 'btree', indexName = '' }) {
  if (!cols?.length) throw new Error('Pilih minimal satu kolom');
  if (!['btree', 'hash', 'gin', 'gist', 'brin'].includes(method)) throw new Error('Metode index tidak dikenal');
  const iname = indexName.trim() ? `${ident(indexName)} ` : '';
  return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${iname}ON ${qname(schema, name)} USING ${method} (${cols.map(qi).join(', ')})`;
}
export const dropIndex = (schema, idxName) => `DROP INDEX ${qname(schema, idxName)}`;
export const dropConstraint = (schema, name, con) => `${ALTER(schema, name)} DROP CONSTRAINT ${ident(con)}`;
export const addPrimaryKey = (schema, name, cols) => {
  if (!cols?.length) throw new Error('Pilih kolom PK');
  return `${ALTER(schema, name)} ADD PRIMARY KEY (${cols.map(qi).join(', ')})`;
};
export const addUnique = (schema, name, cols, conName = '') => {
  if (!cols?.length) throw new Error('Pilih kolom');
  return `${ALTER(schema, name)} ADD ${conName.trim() ? `CONSTRAINT ${ident(conName)} ` : ''}UNIQUE (${cols.map(qi).join(', ')})`;
};
export const addCheck = (schema, name, expr, conName = '') => {
  const e = checkExpr(expr); if (!e) throw new Error('Ekspresi CHECK kosong');
  return `${ALTER(schema, name)} ADD ${conName.trim() ? `CONSTRAINT ${ident(conName)} ` : ''}CHECK (${e})`;
};
export function addForeignKey(schema, name, { cols, refSchema = 'public', refTable, refCols, onUpdate = 'NO ACTION', onDelete = 'NO ACTION', conName = '' }) {
  if (!cols?.length || !refCols?.length || cols.length !== refCols.length) throw new Error('Kolom FK dan kolom rujukan harus sama banyak');
  if (!FK_ACTIONS.includes(onUpdate) || !FK_ACTIONS.includes(onDelete)) throw new Error('Aksi FK tidak dikenal');
  return `${ALTER(schema, name)} ADD ${conName.trim() ? `CONSTRAINT ${ident(conName)} ` : ''}FOREIGN KEY (${cols.map(qi).join(', ')}) REFERENCES ${qname(refSchema, refTable)} (${refCols.map(qi).join(', ')}) ON UPDATE ${onUpdate} ON DELETE ${onDelete}`;
}

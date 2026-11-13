// Katalog objek database (schema/tabel/kolom), paginasi data, dan helper export.
export const qi = s => '"' + String(s).replace(/"/g, '""') + '"';
export const qname = (schema, name) => `${qi(schema)}.${qi(name)}`;

const NOT_SYS = String.raw`n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg\_toast%'`;

const TABLES_SQL = String.raw`select n.nspname as schema, c.relname as name, c.relkind::text as kind
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r','p','v','m') and ${NOT_SYS} and c.relname not like '\_tgpg%'
order by 1, 2`;

const COLS_SQL = String.raw`select n.nspname as schema, c.relname as tbl, a.attname as name,
  format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull,
  coalesce(i.indisprimary, false) as pk, pg_get_expr(d.adbin, d.adrelid) as def
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
left join pg_index i on i.indrelid = c.oid and i.indisprimary and a.attnum = any(i.indkey)
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where a.attnum > 0 and not a.attisdropped and c.relkind in ('r','p','v','m') and ${NOT_SYS} and c.relname not like '\_tgpg%'
order by n.nspname, c.relname, a.attnum`;

const FUNCS_SQL = String.raw`select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where ${NOT_SYS} and p.proname not like 'tg\_%' and p.prokind in ('f','p')
order by 1, 2`;

export const KIND_LABEL = { r: 'tabel', p: 'tabel', v: 'view', m: 'matview' };

/** -> Map(schema -> {tables:[{schema,name,kind,cols:[{name,type,notnull,pk,def}]}], funcs:[{name,args}]}) */
export async function loadCatalog(engine) {
  const [tables, cols, funcs] = await engine.read(`${TABLES_SQL};\n${COLS_SQL};\n${FUNCS_SQL}`);
  const schemas = new Map([['public', { tables: [], funcs: [] }]]);
  const get = s => { if (!schemas.has(s)) schemas.set(s, { tables: [], funcs: [] }); return schemas.get(s); };
  const byKey = new Map();
  for (const r of tables.rows) {
    const t = { schema: r.schema, name: r.name, kind: r.kind, cols: [] };
    get(r.schema).tables.push(t); byKey.set(`${r.schema}.${r.name}`, t);
  }
  for (const r of cols.rows) byKey.get(`${r.schema}.${r.tbl}`)?.cols.push({ name: r.name, type: r.type, notnull: r.notnull, pk: r.pk, def: r.def });
  for (const r of funcs.rows) get(r.schema).funcs.push({ name: r.name, args: r.args });
  return schemas;
}

export async function loadIndexes(engine, schema, name) {
  const r = await engine.query('select indexname, indexdef from pg_indexes where schemaname = $1 and tablename = $2 order by 1', [schema, name]);
  return r.rows;
}

function cond(where) {
  const w = (where || '').trim();
  if (!w) return '';
  if (w.includes(';')) throw new Error('Filter tidak boleh mengandung ";"');
  return ` where ${w}`;
}

/** Satu halaman data tabel + total baris. */
export async function fetchPage(engine, { schema, name, where = '', orderBy = null, dir = 'asc', limit = 50, offset = 0 }) {
  const from = qname(schema, name), w = cond(where);
  const o = orderBy ? ` order by ${qi(orderBy)} ${dir === 'desc' ? 'desc' : 'asc'}` : '';
  const [cnt, data] = await engine.read(`select count(*)::int as n from ${from}${w};\nselect * from ${from}${w}${o} limit ${limit | 0} offset ${offset | 0}`);
  return { total: cnt.rows[0].n, fields: data.fields, rows: data.rows };
}

/** Semua baris (untuk export), dengan filter/urutan yang sama. */
export async function fetchAll(engine, { schema, name, where = '', orderBy = null, dir = 'asc' }) {
  const o = orderBy ? ` order by ${qi(orderBy)} ${dir === 'desc' ? 'desc' : 'asc'}` : '';
  const [data] = await engine.read(`select * from ${qname(schema, name)}${cond(where)}${o}`);
  return { fields: data.fields, rows: data.rows };
}

/** Nilai sel -> string (null tetap null). */
export function fmt(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return '\\x' + [...v].map(b => b.toString(16).padStart(2, '0')).join('');
  if (typeof v === 'object') return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x));
  return String(v);
}

const csvCell = v => {
  const s = fmt(v);
  if (s === null) return '';
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export const toCSV = (fields, rows) =>
  [fields.map(f => csvCell(f.name)).join(','), ...rows.map(r => fields.map(f => csvCell(r[f.name])).join(','))].join('\r\n');

export const toJSON = (fields, rows) =>
  JSON.stringify(rows.map(r => Object.fromEntries(fields.map(f => [f.name, r[f.name]]))), (k, x) =>
    typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? fmt(x) : x, 2);

export function download(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

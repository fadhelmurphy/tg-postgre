// Panel struktur tabel ala DBeaver/phpMyAdmin: kolom, constraint, FK, index, trigger, DDL, dan aksi ubah skema.
import { h } from './dom.js';
import { qname } from './catalog.js';
import * as D from './ddl.js';
import { formDialog, confirmBox } from './dialogs.js';

const errMsg = e => e?.message || String(e);
const bytes = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function table(head, rows) {
  return h('div', { class: 'grid' }, h('table', null, h('thead', null, h('tr', null, ...head.map(x => h('th', null, x)))), h('tbody', null, ...rows)));
}
const act = (label, fn, cls = 'sec tiny') => h('button', { class: cls, onClick: fn }, label);

export async function renderStructure(ws, tab) {
  const { schema, name } = tab;
  let st;
  try { st = await D.loadStructure(ws.engine, schema, name); }
  catch (e) { tab.struct.replaceChildren(h('div', { class: 'er' }, errMsg(e))); return; }
  tab.structure = st;
  const isTable = st.kind === 'r' || st.kind === 'p';
  const refresh = () => ws.refreshCatalog().then(() => renderStructure(ws, tab));
  const colNames = st.cols.map(c => c.name);
  const tableOpts = []; for (const [s, { tables: ts }] of ws.catalog) for (const t of ts) tableOpts.push({ value: `${s}\u0001${t.name}`, label: `${s}.${t.name}` });
  const colsOf = v => { const [s, n] = v.split('\u0001'); return ws.catalog.get(s)?.tables.find(t => t.name === n)?.cols.map(c => c.name) || []; };

  /* ── ringkasan + aksi tabel ── */
  const info = h('div', { class: 'row tools' },
    h('span', { class: 'mu' }, `${{ r: 'Tabel', p: 'Tabel (partisi)', v: 'View', m: 'Materialized view' }[st.kind] || st.kind} · ±${st.estimate < 0 ? '?' : st.estimate} baris · ${bytes(st.size)}`),
    h('span', { class: 'spacer' }),
    isTable ? act('Ubah nama', () => formDialog(ws, { title: `Ubah nama ${name}`, fields: [{ key: 'to', label: 'Nama baru', value: name }], build: v => [D.renameTable(schema, name, v.to)],
      onDone: v => { ws.dropTab(tab); ws.addTableTab(schema, v.to.trim()); } })) : null,
    isTable ? act('Komentar', () => formDialog(ws, { title: 'Komentar tabel', fields: [{ key: 't', label: 'Komentar', type: 'area', value: st.comment || '' }], build: v => [D.setTableComment(schema, name, v.t)], onDone: refresh })) : null,
    isTable ? act('Kosongkan', () => formDialog(ws, { title: `Kosongkan ${name}`, note: 'Semua baris dihapus. Tindakan ini tercatat di log dan berlaku untuk semua anggota.',
      fields: [{ key: 'restart', label: 'Reset counter identity/serial', type: 'check', value: true }, { key: 'cascade', label: 'CASCADE (kosongkan juga tabel yang merujuk)', type: 'check' }],
      build: v => [D.truncateTable(schema, name, { restart: v.restart, cascade: v.cascade })], submit: 'Kosongkan', onDone: () => ws.loadTable(tab) }), 'sec tiny danger') : null,
    act('Hapus', () => formDialog(ws, { title: `Hapus ${name}`, note: 'Objek dihapus permanen untuk semua anggota.', fields: [{ key: 'cascade', label: 'CASCADE (hapus juga objek yang bergantung)', type: 'check' }],
      build: v => [D.dropTable(schema, name, { cascade: v.cascade, kind: st.kind })], submit: 'Hapus', onDone: () => ws.dropTab(tab) }), 'sec tiny danger'));

  /* ── kolom ── */
  const typeList = h('datalist', { id: 'tgpg-types2' }, ...D.COMMON_TYPES.map(t => h('option', { value: t })));
  const editCol = c => formDialog(ws, { title: `Ubah kolom ${c.name}`, wide: true,
    note: 'Hanya perubahan yang dijalankan. Mengubah tipe yang tidak kompatibel butuh ekspresi USING (mis. kolom::integer).',
    fields: [{ key: 'name', label: 'Nama', value: c.name }, { key: 'type', label: 'Tipe', value: c.type, list: 'tgpg-types2' }, { key: 'using', label: 'USING (opsional, saat ganti tipe)', value: '' },
      { key: 'def', label: 'Default (kosong = tanpa default)', value: c.identity || c.generated ? '' : c.def || '' }, { key: 'notnull', label: 'NOT NULL', type: 'check', value: c.notnull },
      { key: 'comment', label: 'Komentar kolom', value: c.comment || '' }],
    build: v => {
      const q = [];
      if (v.type.trim() !== c.type) q.push(D.alterColumnType(schema, name, c.name, v.type, v.using));
      if (!c.identity && !c.generated && v.def.trim() !== (c.def || '')) q.push(D.setDefault(schema, name, c.name, v.def));
      if (v.notnull !== c.notnull) q.push(D.setNotNull(schema, name, c.name, v.notnull));
      if (v.comment !== (c.comment || '')) q.push(`COMMENT ON COLUMN ${qname(schema, name)}.${'"' + c.name.replace(/"/g, '""') + '"'} IS ${v.comment ? `'${v.comment.replace(/'/g, "''")}'` : 'NULL'}`);
      if (v.name.trim() !== c.name) q.push(D.renameColumn(schema, name, c.name, v.name));
      if (!q.length) throw new Error('Belum ada perubahan.');
      return q;
    }, onDone: refresh });
  const addCol = () => formDialog(ws, { title: 'Tambah kolom', fields: [{ key: 'name', label: 'Nama' }, { key: 'type', label: 'Tipe', value: 'text', list: 'tgpg-types2' }, { key: 'def', label: 'Default' }, { key: 'notnull', label: 'NOT NULL', type: 'check' }],
    build: v => [D.addColumn(schema, name, { name: v.name, type: v.type, def: v.def, notnull: v.notnull })], onDone: refresh });
  const colRows = st.cols.map(c => h('tr', null,
    h('td', null, c.pk ? '🔑 ' : '', c.name), h('td', null, c.type), h('td', null, c.notnull ? 'tidak' : 'ya'),
    h('td', { class: c.def != null ? '' : 'null' }, c.generated === 's' ? `GENERATED: ${c.def}` : c.identity ? (c.identity === 'a' ? 'IDENTITY (always)' : 'IDENTITY (by default)') : c.def ?? '—'),
    h('td', { class: 'mu' }, c.comment || ''),
    isTable ? h('td', { class: 'act' }, h('span', { class: 'acts' }, act('✎', () => editCol(c), 'sec tiny'),
      act('🗑', () => formDialog(ws, { title: `Hapus kolom ${c.name}`, note: 'Data di kolom ini hilang permanen.', fields: [{ key: 'cascade', label: 'CASCADE', type: 'check' }],
        build: v => [D.dropColumn(schema, name, c.name, v.cascade)], submit: 'Hapus', onDone: refresh }), 'sec tiny danger'))) : null));

  /* ── constraint & FK ── */
  const conRows = st.constraints.filter(k => k.type !== 'f' && k.type !== 'n').map(k => h('tr', null, h('td', null, k.name), h('td', null, { p: 'PRIMARY KEY', u: 'UNIQUE', c: 'CHECK', x: 'EXCLUDE' }[k.type] || k.type), h('td', { class: 'mono' }, k.def),
    isTable ? h('td', { class: 'act' }, act('🗑', () => formDialog(ws, { title: `Hapus constraint ${k.name}`, fields: [], build: () => [D.dropConstraint(schema, name, k.name)], submit: 'Hapus', onDone: refresh }), 'sec tiny danger')) : null));
  const fkRows = st.fks.map(f => h('tr', null, h('td', null, f.name), h('td', null, f.cols.join(', ')),
    h('td', null, h('a', { href: '#', onClick: e => { e.preventDefault(); ws.addTableTab(f.refSchema, f.refTable); } }, `${f.refSchema === 'public' ? '' : f.refSchema + '.'}${f.refTable}`), ` (${f.refCols.join(', ')})`),
    h('td', { class: 'mu' }, `UPDATE ${f.onUpdate} · DELETE ${f.onDelete}`),
    isTable ? h('td', { class: 'act' }, act('🗑', () => formDialog(ws, { title: `Hapus foreign key ${f.name}`, fields: [], build: () => [D.dropConstraint(schema, name, f.name)], submit: 'Hapus', onDone: refresh }), 'sec tiny danger')) : null));
  const addFk = () => formDialog(ws, { title: 'Tambah foreign key', wide: true,
    fields: [{ key: 'conName', label: 'Nama constraint (opsional)' }, { key: 'cols', label: 'Kolom di tabel ini', type: 'multi', options: colNames },
      { key: 'ref', label: 'Tabel rujukan', type: 'select', options: tableOpts, value: tableOpts[0]?.value }, { key: 'refCols', label: 'Kolom rujukan', hint: 'jumlah & urutan daftar harus sama dengan kolom di atas', type: 'multi', options: colsOf(tableOpts[0]?.value || ''), optionsFn: v => colsOf(v.ref) },
      { key: 'onDelete', label: 'ON DELETE', type: 'select', options: D.FK_ACTIONS, value: 'NO ACTION' }, { key: 'onUpdate', label: 'ON UPDATE', type: 'select', options: D.FK_ACTIONS, value: 'NO ACTION' }],
    build: v => { const [rs, rt] = v.ref.split('\u0001'); return [D.addForeignKey(schema, name, { cols: v.cols, refSchema: rs, refTable: rt, refCols: v.refCols, onDelete: v.onDelete, onUpdate: v.onUpdate, conName: v.conName })]; }, onDone: refresh });
  const addCon = kind => formDialog(ws, { title: { pk: 'Tambah primary key', uq: 'Tambah UNIQUE', ck: 'Tambah CHECK' }[kind],
    fields: [...(kind !== 'pk' ? [{ key: 'conName', label: 'Nama (opsional)' }] : []), kind === 'ck' ? { key: 'expr', label: 'Ekspresi', placeholder: 'qty > 0' } : { key: 'cols', label: 'Kolom', type: 'multi', options: colNames }],
    build: v => [kind === 'pk' ? D.addPrimaryKey(schema, name, v.cols) : kind === 'uq' ? D.addUnique(schema, name, v.cols, v.conName) : D.addCheck(schema, name, v.expr, v.conName)], onDone: refresh });

  /* ── index ── */
  const addIdx = () => formDialog(ws, { title: 'Buat index', fields: [{ key: 'indexName', label: 'Nama (opsional)' }, { key: 'cols', label: 'Kolom', type: 'multi', options: colNames },
    { key: 'method', label: 'Metode', type: 'select', options: ['btree', 'hash', 'gin', 'gist', 'brin'], value: 'btree' }, { key: 'unique', label: 'UNIQUE', type: 'check' }],
    build: v => [D.createIndex(schema, name, { cols: v.cols, unique: v.unique, method: v.method, indexName: v.indexName })], onDone: refresh });
  const idxRows = st.indexes.map(i => h('tr', null, h('td', null, i.name), h('td', null, i.primary ? 'PRIMARY' : i.unique ? 'UNIQUE' : 'INDEX'), h('td', null, i.cols.join(', ')), h('td', { class: 'mono' }, i.def.replace(/^CREATE (UNIQUE )?INDEX \S+ ON /, '')),
    isTable ? h('td', { class: 'act' }, i.viaConstraint ? h('span', { class: 'mu', title: 'Dikelola oleh constraint' }, '—') : act('🗑', () => formDialog(ws, { title: `Hapus index ${i.name}`, fields: [], build: () => [D.dropIndex(schema, i.name)], submit: 'Hapus', onDone: refresh }), 'sec tiny danger')) : null));

  const ddlText = D.tableDDL(st);
  const sec = (title, node, ...btns) => [h('h3', { class: 'sechead' }, title, h('span', { class: 'spacer' }), ...btns), node];
  const th = (...x) => [...x, isTable ? '' : null].filter(v => v !== null);
  tab.struct.replaceChildren(typeList, info,
    ...sec('Kolom', table(th('Kolom', 'Tipe', 'Null?', 'Default', 'Komentar'), colRows), isTable ? act('+ Kolom', addCol, 'small') : null),
    ...(isTable ? [
      ...sec('Constraint', conRows.length ? table(th('Nama', 'Jenis', 'Definisi'), conRows) : h('div', { class: 'mu pad' }, 'Tidak ada.'), act('+ PK', () => addCon('pk'), 'sec small'), act('+ UNIQUE', () => addCon('uq'), 'sec small'), act('+ CHECK', () => addCon('ck'), 'sec small')),
      ...sec('Foreign key', fkRows.length ? table(th('Nama', 'Kolom', 'Merujuk ke', 'Aksi'), fkRows) : h('div', { class: 'mu pad' }, 'Tidak ada.'), act('+ FK', addFk, 'sec small')),
      ...sec('Index', idxRows.length ? table(th('Nama', 'Jenis', 'Kolom', 'Definisi'), idxRows) : h('div', { class: 'mu pad' }, 'Tidak ada.'), act('+ Index', addIdx, 'sec small')),
      ...(st.triggers.length ? sec('Trigger', table(['Nama', 'Definisi'], st.triggers.map(t => h('tr', null, h('td', null, t.name), h('td', { class: 'mono' }, t.def))))) : []),
    ] : []),
    ...sec('DDL', h('pre', { class: 'sqlprev' }, ddlText), act('Salin', () => navigator.clipboard?.writeText(ddlText), 'sec small'),
      act('Buka di editor', () => ws.addQueryTab(ddlText, true), 'sec small')));
}

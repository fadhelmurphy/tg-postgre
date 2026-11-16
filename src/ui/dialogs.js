// Dialog form generik (dengan pratinjau SQL langsung), buat tabel, dan import.
import { h } from './dom.js';
import { qname } from './catalog.js';
import * as D from './ddl.js';
import { parseCSV, parseJSONRows, buildImport, guessMapping } from './tools.js';

const errMsg = e => e?.message || String(e);

export function modal({ title, body, actions, wide = false }) {
  const err = h('div', { class: 'er', hidden: true, role: 'alert' });
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const bar = h('div', { class: 'row' });
  const api = { close, setErr: m => { err.textContent = m || ''; err.hidden = !m; }, buttons: [] };
  for (const a of actions) {
    const b = h('button', { class: a.primary ? '' : 'sec', onClick: () => a.onClick(api, b) }, a.label);
    api.buttons.push(b); bar.append(b);
  }
  const dlg = h('div', { class: `dialog${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h3', null, title), body, err, bar);
  const back = h('div', { class: 'backdrop', onClick: e => { if (e.target === back) close(); } }, dlg);
  document.addEventListener('keydown', onKey); document.body.append(back);
  return api;
}

export function confirmBox(message, { danger = true, ok = 'Ya, lanjutkan' } = {}) {
  return new Promise(res => {
    let done = false; const fin = v => { if (!done) { done = true; res(v); } };
    const m = modal({ title: 'Konfirmasi', body: h('div', { class: 'pad' }, message), actions: [
      { label: ok, primary: true, onClick: a => { fin(true); a.close(); } }, { label: 'Batal', onClick: a => { fin(false); a.close(); } }] });
    if (danger) m.buttons[0].classList.add('danger-btn');
    new MutationObserver((_, o) => { if (!document.body.contains(m.buttons[0])) { fin(false); o.disconnect(); } }).observe(document.body, { childList: true });
  });
}

/**
 * fields: [{key,label,type:'text'|'select'|'multi'|'check'|'area',value,options,placeholder,hint}]
 * build(values) -> string[] (SQL) ; melempar error untuk masukan tidak valid (ditampilkan di pratinjau).
 */
export function formDialog(ws, { title, fields, build, submit = 'Jalankan', wide = false, note = '', onDone = null }) {
  const inputs = {}; const prev = h('pre', { class: 'sqlprev' });
  const read = () => Object.fromEntries(fields.map(f => {
    const i = inputs[f.key];
    return [f.key, f.type === 'check' ? i.checked : f.type === 'multi' ? [...i.selectedOptions].map(o => o.value) : i.value];
  }));
  let lastSql = [];
  const update = () => {
    for (const f of fields) if (f.optionsFn) {
      const el = inputs[f.key], opts = f.optionsFn(read()), sig = JSON.stringify(opts);
      if (el._sig !== sig) { el._sig = sig; el.replaceChildren(...opts.map(o => h('option', { value: o.value ?? o }, o.label ?? o))); }
    }
    try { lastSql = build(read()); prev.className = 'sqlprev'; prev.textContent = lastSql.map(s => s + ';').join('\n'); }
    catch (e) { lastSql = null; prev.className = 'sqlprev er'; prev.textContent = errMsg(e); }
  };
  const nodes = fields.map(f => {
    let el;
    if (f.type === 'select') el = h('select', null, ...(f.options || []).map(o => h('option', { value: o.value ?? o, selected: (o.value ?? o) === f.value }, o.label ?? o)));
    else if (f.type === 'multi') el = h('select', { multiple: true, size: Math.min(6, Math.max(3, (f.options || []).length)) }, ...(f.options || []).map(o => h('option', { value: o.value ?? o, selected: (f.value || []).includes(o.value ?? o) }, o.label ?? o)));
    else if (f.type === 'check') el = h('input', { type: 'checkbox', checked: !!f.value });
    else if (f.type === 'area') el = h('textarea', { rows: 3, value: f.value ?? '', placeholder: f.placeholder || '', spellcheck: false });
    else el = h('input', { type: 'text', value: f.value ?? '', placeholder: f.placeholder || '', autocomplete: 'off', spellcheck: false, list: f.list || null });
    el.addEventListener('input', update); el.addEventListener('change', update);
    inputs[f.key] = el;
    return h('label', { class: f.type === 'check' ? 'frow chk' : 'frow' }, h('span', { class: 'fname' }, f.label, f.hint ? h('span', { class: 'mu' }, ` · ${f.hint}`) : ''), el);
  });
  update();
  const m = modal({ title, wide, body: h('div', null, note ? h('div', { class: 'mu pad' }, note) : null, h('div', { class: 'fields' }, nodes), h('div', { class: 'mu' }, 'SQL yang akan dijalankan (satu op atomik):'), prev), actions: [
    { label: submit, primary: true, onClick: async (a, btn) => {
      update(); if (!lastSql) return a.setErr('Perbaiki isian dulu.');
      a.setErr(''); btn.disabled = true; const t = btn.textContent; btn.textContent = 'Menjalankan…';
      try { const vals = read(); await ws.execMany(lastSql); a.close(); await ws.refreshCatalog(); onDone?.(vals); }
      catch (e) { a.setErr(errMsg(e)); btn.disabled = false; btn.textContent = t; }
    } },
    { label: 'Batal', onClick: a => a.close() }] });
  return m;
}

/* ───────── buat tabel ───────── */
export function createTableDialog(ws, { schema = 'public', onDone = null } = {}) {
  const schemas = [...ws.catalog.keys()];
  const sch = h('select', null, ...schemas.map(s => h('option', { value: s, selected: s === schema }, s)));
  const name = h('input', { type: 'text', placeholder: 'nama_tabel', autocomplete: 'off', spellcheck: false });
  const list = h('datalist', { id: 'tgpg-types' }, ...D.COMMON_TYPES.map(t => h('option', { value: t })));
  const rowsBox = h('div', { class: 'ctcols' }); const prev = h('pre', { class: 'sqlprev' });
  let lastSql = null;
  const rows = [];
  const update = () => {
    try {
      const cols = rows.map(r => ({ name: r.n.value, type: r.t.value, notnull: r.nn.checked, def: r.d.value, unique: r.u.checked }));
      const pk = rows.filter(r => r.pk.checked).map(r => r.n.value);
      lastSql = D.createTable({ schema: sch.value, name: name.value, cols, pk }); prev.className = 'sqlprev'; prev.textContent = lastSql + ';';
    } catch (e) { lastSql = null; prev.className = 'sqlprev er'; prev.textContent = errMsg(e); }
  };
  const addRow = (v = {}) => {
    const r = { n: h('input', { type: 'text', placeholder: 'kolom', value: v.n || '', spellcheck: false }), t: h('input', { type: 'text', list: 'tgpg-types', value: v.t || 'text', spellcheck: false }),
      nn: h('input', { type: 'checkbox', checked: !!v.nn, title: 'NOT NULL' }), u: h('input', { type: 'checkbox', title: 'UNIQUE' }), pk: h('input', { type: 'checkbox', checked: !!v.pk, title: 'Primary key' }),
      d: h('input', { type: 'text', placeholder: 'default', value: v.d || '', spellcheck: false }) };
    r.row = h('div', { class: 'ctrow' }, r.n, r.t, h('label', { class: 'mu' }, r.pk, 'PK'), h('label', { class: 'mu' }, r.nn, 'NN'), h('label', { class: 'mu' }, r.u, 'UQ'), r.d,
      h('button', { class: 'sec tiny', title: 'Hapus kolom', onClick: () => { rows.splice(rows.indexOf(r), 1); r.row.remove(); update(); } }, '×'));
    r.row.addEventListener('input', update); r.row.addEventListener('change', update);
    rows.push(r); rowsBox.append(r.row);
  };
  addRow({ n: 'id', t: 'bigserial', pk: true, nn: true }); addRow({ n: 'nama', t: 'text' });
  name.addEventListener('input', update); sch.addEventListener('change', update); update();
  modal({ title: 'Buat tabel', wide: true, body: h('div', null, list,
    h('div', { class: 'row' }, sch, name), rowsBox, h('div', { class: 'row' }, h('button', { class: 'sec small', onClick: () => { addRow(); update(); } }, '+ Kolom')),
    h('div', { class: 'mu' }, 'SQL yang akan dijalankan:'), prev), actions: [
    { label: 'Buat tabel', primary: true, onClick: async (a, btn) => {
      update(); if (!lastSql) return a.setErr('Perbaiki isian dulu.');
      btn.disabled = true; a.setErr('');
      try { await ws.execMany([lastSql]); a.close(); await ws.refreshCatalog(); ws.addTableTab(sch.value, name.value.trim()); onDone?.(); }
      catch (e) { a.setErr(errMsg(e)); btn.disabled = false; }
    } }, { label: 'Batal', onClick: a => a.close() }] });
}

/* ───────── import CSV / JSON ───────── */
export function importDialog(ws, { schema = null, name = null } = {}) {
  const tables = []; for (const [s, { tables: ts }] of ws.catalog) for (const t of ts) if (t.kind === 'r' || t.kind === 'p') tables.push({ s, ...t });
  const NEW = '__new__';
  const target = h('select', null, h('option', { value: NEW }, '(tabel baru dari file)'), ...tables.map(t => h('option', { value: `${t.s}\u0001${t.name}`, selected: t.s === schema && t.name === name }, `${t.s}.${t.name}`)));
  const newName = h('input', { type: 'text', placeholder: 'nama tabel baru', spellcheck: false });
  const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.json,text/csv,application/json' });
  const paste = h('textarea', { rows: 4, placeholder: 'atau tempel CSV/JSON di sini…', spellcheck: false });
  const delim = h('select', null, ...[['', 'delimiter otomatis'], [',', 'koma ,'], [';', 'titik koma ;'], ['\t', 'tab'], ['|', 'pipa |']].map(([v, l]) => h('option', { value: v }, l)));
  const hdr = h('input', { type: 'checkbox', checked: true }); const emp = h('input', { type: 'checkbox', checked: true });
  const mapBox = h('div', { class: 'mapbox' }); const info = h('div', { class: 'mu' }); const sample = h('div', { class: 'importprev' });
  let data = null;   // {header, rows}
  const tgt = () => (target.value === NEW ? null : (([s, n]) => ({ s, n, cols: ws.catalog.get(s).tables.find(t => t.name === n).cols }))(target.value.split('\u0001')));
  const safeName = s => String(s).trim().replace(/\s+/g, '_').toLowerCase().replace(/[^\w]/g, '') || 'kolom';
  const parse = () => {
    const text = paste.value.trim() ? paste.value : (file._text || '');
    if (!text.trim()) { data = null; info.textContent = ''; mapBox.replaceChildren(); sample.replaceChildren(); return; }
    try {
      if (/^\s*[\[{]/.test(text)) data = parseJSONRows(text);
      else { const all = parseCSV(text, delim.value || null); if (!all.length) throw new Error('File kosong'); data = hdr.checked ? { header: all[0].map(String), rows: all.slice(1) } : { header: all[0].map((_, i) => `kolom${i + 1}`), rows: all }; }
      data.rows = data.rows.filter(r => r.some(v => v !== '' && v !== null));
      info.className = 'mu'; info.textContent = `${data.rows.length} baris, ${data.header.length} kolom terdeteksi.`;
    } catch (e) { data = null; info.className = 'er'; info.textContent = errMsg(e); mapBox.replaceChildren(); sample.replaceChildren(); return; }
    renderMap();
  };
  let selects = [];
  const renderMap = () => {
    if (!data) return; const t = tgt(); selects = [];
    const g = t ? guessMapping(data.header, t.cols) : null;
    mapBox.replaceChildren(h('div', { class: 'mu' }, t ? 'Pemetaan kolom file → kolom tabel:' : 'Kolom tabel baru (semua bertipe text; ubah nama bila perlu):'),
      ...data.header.map((hd, i) => {
        const sel = t ? h('select', null, h('option', { value: '' }, '(lewati)'), ...t.cols.map(c => h('option', { value: c.name, selected: g.some(m => m.from === i && m.to === c.name) }, `${c.name} (${c.type})`)))
          : h('input', { type: 'text', value: safeName(hd), spellcheck: false });
        selects.push(sel); return h('div', { class: 'maprow' }, h('span', { class: 'mono' }, hd || '(kosong)'), '→', sel);
      }));
    const first = data.rows.slice(0, 5);
    sample.replaceChildren(h('div', { class: 'grid' }, h('table', null, h('thead', null, h('tr', null, ...data.header.map(x => h('th', null, x)))), h('tbody', null, ...first.map(r => h('tr', null, ...data.header.map((_, i) => h('td', { class: r[i] === null ? 'null' : '' }, r[i] === null ? 'NULL' : String(r[i])))))))));
  };
  file.addEventListener('change', async () => { const f = file.files[0]; if (!f) return; if (f.size > 30e6) { info.className = 'er'; info.textContent = 'File terlalu besar (maks 30 MB).'; return; } file._text = await f.text(); if (target.value === NEW && !newName.value) newName.value = safeName(f.name.replace(/\.[^.]+$/, '')); parse(); });
  for (const e of [paste, delim, hdr]) e.addEventListener('input', parse); target.addEventListener('change', renderMap);
  const m = modal({ title: 'Import data', wide: true, body: h('div', null,
    h('div', { class: 'row' }, target, newName), h('div', { class: 'row' }, file), paste,
    h('div', { class: 'row' }, delim, h('label', { class: 'mu' }, hdr, ' baris pertama = header'), h('label', { class: 'mu' }, emp, ' string kosong → NULL')),
    info, mapBox, sample), actions: [
    { label: 'Impor', primary: true, onClick: async (a, btn) => {
      a.setErr(''); if (!data) return a.setErr('Pilih file atau tempel data dulu.');
      btn.disabled = true; const t = tgt(); const stmts = []; let done = 0, created = false;
      try {
        let sch, nm, mapping;
        if (t) { sch = t.s; nm = t.n; mapping = data.header.map((_, i) => ({ from: i, to: selects[i].value })).filter(x => x.to); }
        else {
          sch = 'public'; nm = newName.value.trim(); if (!nm) throw new Error('Isi nama tabel baru.');
          mapping = data.header.map((_, i) => ({ from: i, to: selects[i].value.trim() })).filter(x => x.to);
          stmts.push(D.createTable({ schema: sch, name: nm, cols: mapping.map(x => ({ name: x.to, type: 'text' })) }));
        }
        const inserts = buildImport(sch, nm, mapping, data.rows, { emptyAsNull: emp.checked });
        if (stmts.length) { btn.textContent = 'Membuat tabel…'; await ws.execMany(stmts); created = true; }
        for (const q of inserts) { btn.textContent = `Mengimpor… ${done}/${data.rows.length}`; await ws.execMany([q]); done += (q.match(/\n/g) || []).length + 1; }
        a.close(); await ws.refreshCatalog(); ws.addTableTab(sch, nm);
      } catch (e) { a.setErr(errMsg(e) + (done || created ? ` — ${created ? 'tabel sudah dibuat; ' : ''}${done} baris sudah terimpor sebelum error (impor dikirim per bagian).` : '')); btn.disabled = false; btn.textContent = 'Impor'; if (done || created) ws.refreshCatalog(); }
    } }, { label: 'Batal', onClick: a => a.close() }] });
  return m;
}

/** Prompt teks sederhana -> string | null */
export function promptBox(title, label, value = '') {
  return new Promise(res => {
    let done = false; const fin = v => { if (!done) { done = true; res(v); } };
    const inp = h('input', { type: 'text', value, spellcheck: false, 'aria-label': label });
    const m = modal({ title, body: h('div', null, h('div', { class: 'mu pad' }, label), inp), actions: [
      { label: 'OK', primary: true, onClick: a => { fin(inp.value.trim() || null); a.close(); } }, { label: 'Batal', onClick: a => { fin(null); a.close(); } }] });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') m.buttons[0].click(); });
    inp.focus();
    new MutationObserver((_, o) => { if (!document.body.contains(m.buttons[0])) { fin(null); o.disconnect(); } }).observe(document.body, { childList: true });
  });
}

/** Menu popup kecil di dekat elemen. items: [{label, onClick, danger}] */
export function popMenu(anchor, items) {
  document.querySelectorAll('.popmenu').forEach(x => x.remove());
  const r = anchor.getBoundingClientRect();
  const menu = h('div', { class: 'popmenu', role: 'menu' }, ...items.map(it => h('button', { class: `sec${it.danger ? ' danger' : ''}`, role: 'menuitem', onClick: () => { menu.remove(); it.onClick(); } }, it.label)));
  menu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 220)) + 'px'; menu.style.top = Math.min(r.bottom + 2, window.innerHeight - 40) + 'px';
  const off = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off, true); } };
  document.addEventListener('mousedown', off, true); document.body.append(menu);
}

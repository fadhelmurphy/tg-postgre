// Workspace ala pgAdmin: sidebar objek, tab query & tab tabel (data grid + struktur), riwayat, export.
import { h } from './dom.js';
import { KIND_LABEL, loadCatalog, loadIndexes, fetchPage, fetchAll, fmt, qname, toCSV, toJSON, download, buildInsert, buildUpdate, buildDelete } from './catalog.js';

const STARTER = `create table if not exists notes(
  id uuid primary key default gen_random_uuid(),
  body text,
  created_at timestamptz default now()
);
insert into notes(body) values ('halo dari tgpg');`;
const HISTORY_MAX = 50;
const errMsg = e => e?.message || String(e);

/** Render tabel hasil/data. onSort(col) opsional, onCell(col, value) opsional. */
function renderGrid(fields, rows, { startIndex = 0, sort = null, onSort = null, onCell = null, actions = null } = {}) {
  const head = h('tr', null, h('th', { class: 'rn' }, '#'));
  for (const f of fields) {
    head.append(h('th', { class: onSort ? 'sortable' : '', onClick: onSort ? () => onSort(f.name) : null },
      f.name, sort && sort.col === f.name ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : ''));
  }
  if (actions) head.append(h('th', { class: 'act' }, ''));
  const body = h('tbody');
  rows.forEach((r, i) => {
    const tr = h('tr', null, h('td', { class: 'rn' }, startIndex + i + 1));
    for (const f of fields) {
      const v = fmt(r[f.name]);
      tr.append(h('td', { class: v === null ? 'null' : '', title: v === null ? 'NULL' : v.slice(0, 200), onClick: onCell ? () => onCell(f.name, v) : null }, v === null ? 'NULL' : v));
    }
    if (actions) tr.append(h('td', { class: 'act' }, actions(r)));
    body.append(tr);
  });
  return h('div', { class: 'grid' }, h('table', null, h('thead', null, head), body));
}

export class Workspace {
  /** cb: {onSync, onSnapshot, onReset, onClose, getConn} */
  constructor(root, cb) {
    this.root = root; this.cb = cb;
    this.engine = null; this.dbId = null;
    this.tabs = []; this.active = null; this.seq = 0;
    this.catalog = new Map(); this.openTables = new Set();
    this.history = []; this.lastSeen = -1; this.refreshTimer = null; this.saveTimer = null;
    this.build();
  }

  build() {
    this.titleEl = h('b', { class: 'ws-title' });
    this.statEl = h('span', { class: 'mu' });
    this.netEl = h('span', { class: 'net', role: 'status' });
    this.syncState = { ok: null, at: 0, err: '' };
    this.sideBtn = h('button', { class: 'sec small side-toggle', title: 'Objek', onClick: () => this.side.classList.toggle('open') }, '☰');
    this.shareStr = h('span', { class: 'mono' });
    this.sharePanel = h('div', { class: 'ws-share', hidden: true },
      h('div', { class: 'mu' }, 'Connection string (berisi kunci enkripsi, bagikan hanya ke orang tepercaya):'), this.shareStr,
      h('button', { class: 'sec small', onClick: () => navigator.clipboard.writeText(this.shareStr.textContent) }, 'Salin'));
    const bar = h('div', { class: 'ws-bar' }, this.sideBtn, this.titleEl, this.statEl, this.netEl, h('span', { class: 'spacer' }),
      h('button', { class: 'sec small', onClick: () => this.cb.onSync() }, 'Sinkron'),
      h('button', { class: 'sec small', onClick: () => this.cb.onSnapshot() }, 'Snapshot'),
      h('button', { class: 'sec small', onClick: () => { this.shareStr.textContent = this.cb.getConn(); this.sharePanel.hidden = !this.sharePanel.hidden; } }, 'Bagikan'),
      h('button', { class: 'sec small', onClick: () => this.cb.onReset() }, 'Reset lokal'),
      h('button', { class: 'sec small', onClick: () => this.cb.onClose() }, 'Tutup'));

    this.tree = h('div', { class: 'tree' });
    this.side = h('aside', { class: 'ws-side' },
      h('div', { class: 'side-head' }, h('span', null, 'Objek'), h('button', { class: 'sec small', title: 'Muat ulang', onClick: () => this.refreshCatalog() }, '↻')),
      this.tree);
    this.tabbar = h('div', { class: 'tabbar' });
    this.panes = h('div', { class: 'panes' });
    const main = h('div', { class: 'ws-main' }, this.tabbar, this.panes);
    window.addEventListener('online', () => this.renderNet());
    window.addEventListener('offline', () => this.renderNet());
    this.root.replaceChildren(bar, this.sharePanel, h('div', { class: 'ws-body' }, this.side, main));
    // di HP: sentuh di luar drawer menutupnya
    this.root.addEventListener('click', e => {
      if (this.side.classList.contains('open') && !this.side.contains(e.target) && !this.sideBtn.contains(e.target)) this.side.classList.remove('open');
    });
  }

  /* ───────── lifecycle ───────── */
  async open({ engine, dbId, title }) {
    this.engine = engine; this.dbId = dbId; this.titleEl.textContent = title;
    this.sharePanel.hidden = true; this.openTables.clear(); this.lastSeen = -1;
    for (const t of [...this.tabs]) this.dropTab(t, false);
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('tgpg:ws:' + dbId)); } catch {}
    this.history = Array.isArray(saved?.history) ? saved.history.slice(0, HISTORY_MAX) : [];
    const qs = Array.isArray(saved?.tabs) && saved.tabs.length ? saved.tabs : [{ sql: STARTER }];
    for (const q of qs) this.addQueryTab(q.sql);
    this.root.hidden = false;
    await this.refreshCatalog();
  }

  close() {
    this.save();
    clearTimeout(this.refreshTimer); clearTimeout(this.saveTimer);
    for (const t of [...this.tabs]) this.dropTab(t, false);
    this.engine = null; this.root.hidden = true;
  }

  save() {
    if (!this.dbId) return;
    try {
      localStorage.setItem('tgpg:ws:' + this.dbId, JSON.stringify({
        tabs: this.tabs.filter(t => t.kind === 'query').map(t => ({ sql: t.ta.value })), history: this.history,
      }));
    } catch {}
  }
  saveSoon() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.save(), 800); }

  /** Dipanggil setelah tiap sinkron (ok=true/false). */
  setSyncState(ok, err) {
    this.syncState = { ok, at: ok ? Date.now() : this.syncState.at, err: err ? (err.message || String(err)) : '' };
    this.renderNet();
  }

  renderNet() {
    const el = this.netEl, st = this.syncState;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { el.className = 'net er'; el.textContent = '⚠ offline'; el.title = 'Tidak ada koneksi. Perubahan tidak bisa dikirim; data lokal tetap bisa dibaca.'; return; }
    if (st.ok === false) { el.className = 'net er'; el.textContent = '⚠ gagal sinkron'; el.title = st.err; return; }
    if (st.ok === true) { el.className = 'net ok'; el.textContent = '✓ ' + new Date(st.at).toLocaleTimeString(); el.title = 'Tersinkron dengan Telegram'; return; }
    el.className = 'net mu'; el.textContent = ''; el.title = '';
  }

  /** Dipanggil engine tiap kali sinkron: segarkan sidebar & tabel aktif bila log berubah. */
  notifyApplied(n) {
    this.statEl.textContent = `· log #${n}`;
    if (n === this.lastSeen || !this.engine) return;
    const first = this.lastSeen === -1;
    this.lastSeen = n;
    if (first) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshCatalog();
      if (this.active?.kind === 'table' && this.active.view === 'data') this.loadTable(this.active);
    }, 400);
  }

  /* ───────── sidebar ───────── */
  async refreshCatalog() {
    if (!this.engine) return;
    try { this.catalog = await loadCatalog(this.engine); } catch (e) { this.tree.replaceChildren(h('div', { class: 'er' }, errMsg(e))); return; }
    this.renderTree();
  }

  renderTree() {
    const out = [];
    for (const [schema, { tables, funcs }] of [...this.catalog].sort(([a], [b]) => (a === 'public' ? -1 : b === 'public' ? 1 : a.localeCompare(b)))) {
      const sd = h('details', { class: 'schema', open: true }, h('summary', null, h('span', { class: 'ico' }, '◈'), schema));
      if (!tables.length && !funcs.length) sd.append(h('div', { class: 'mu pad' }, 'kosong'));
      for (const t of tables) {
        const key = `${schema}.${t.name}`;
        const td = h('details', { class: 'tbl', open: this.openTables.has(key), onToggle: e => { e.target.open ? this.openTables.add(key) : this.openTables.delete(key); } },
          h('summary', null,
            h('span', { class: 'tname', onClick: e => { e.preventDefault(); this.addTableTab(schema, t.name); this.side.classList.remove('open'); } },
              t.name, t.kind === 'v' || t.kind === 'm' ? h('em', null, ` ${KIND_LABEL[t.kind]}`) : ''),
            h('button', { class: 'sec tiny', title: 'Buka di tab query', onClick: e => { e.preventDefault(); e.stopPropagation(); this.addQueryTab(`select * from ${qname(schema, t.name)} limit 100;`, true); this.side.classList.remove('open'); } }, 'SQL')),
          ...t.cols.map(c => h('div', { class: 'col' }, h('span', { class: c.pk ? 'pk' : '' }, c.pk ? '🔑 ' : '', c.name), h('span', { class: 'mu' }, c.type))));
        sd.append(td);
      }
      if (funcs.length) sd.append(h('details', { class: 'fn' }, h('summary', null, `Fungsi (${funcs.length})`),
        ...funcs.map(f => h('div', { class: 'col' }, h('span', null, `${f.name}(${f.args})`)))));
      out.push(sd);
    }
    this.tree.replaceChildren(...out);
  }

  /* ───────── tab ───────── */
  activate(tab) {
    this.active = tab;
    for (const t of this.tabs) { t.pane.hidden = t !== tab; t.btn.classList.toggle('on', t === tab); }
    tab.btn.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  makeTab(kind, title, pane, extra = {}) {
    const tab = { id: ++this.seq, kind, title, pane, ...extra };
    tab.btn = h('div', { class: 'tab' },
      h('span', { class: 'tt', onClick: () => this.activate(tab) }, title),
      h('span', { class: 'x', title: 'Tutup', onClick: () => this.dropTab(tab) }, '×'));
    this.tabs.push(tab); this.tabbar.insertBefore(tab.btn, this.plusBtn?.parentNode === this.tabbar ? this.plusBtn : null);
    this.panes.append(pane);
    return tab;
  }

  ensurePlus() {
    if (!this.plusBtn) this.plusBtn = h('button', { class: 'sec small plus', title: 'Tab query baru', onClick: () => this.addQueryTab('', true) }, '+');
    this.tabbar.append(this.plusBtn);   // selalu di ujung kanan
  }

  dropTab(tab, activateNext = true) {
    const i = this.tabs.indexOf(tab); if (i < 0) return;
    this.tabs.splice(i, 1); tab.btn.remove(); tab.pane.remove();
    if (!activateNext) return;
    this.save();
    if (!this.tabs.length) this.addQueryTab('', true);
    else if (this.active === tab) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)]);
  }

  /* ───────── tab query ───────── */
  addQueryTab(sql = '', focus = false) {
    const n = this.tabs.filter(t => t.kind === 'query').length + 1;
    const ta = h('textarea', { class: 'editor', spellcheck: false, placeholder: 'SQL… (Ctrl+Enter menjalankan; blok teks untuk menjalankan sebagian)', value: sql });
    const status = h('span', { class: 'mu' });
    const result = h('div', { class: 'result' });
    const insp = h('div', { class: 'inspector', hidden: true });
    const histBox = h('div', { class: 'history', hidden: true });
    const tab = this.makeTab('query', `Query ${this.seqQuery = (this.seqQuery || 0) + 1}`, h('div', { class: 'pane' }), { ta, status, result, insp, histBox, last: null, n });
    const runBtn = h('button', { onClick: () => this.runQuery(tab) }, 'Run');
    tab.runBtn = runBtn;
    tab.pane.append(ta,
      h('div', { class: 'row tools' }, runBtn,
        h('button', { class: 'sec', onClick: () => { this.renderHistory(tab); histBox.hidden = !histBox.hidden; } }, 'Riwayat'),
        h('button', { class: 'sec', onClick: () => this.exportResult(tab, 'csv') }, 'CSV'),
        h('button', { class: 'sec', onClick: () => this.exportResult(tab, 'json') }, 'JSON'), status),
      histBox, result, insp);
    ta.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this.runQuery(tab); } });
    ta.addEventListener('input', () => this.saveSoon());
    this.ensurePlus();
    this.activate(tab);
    if (focus) ta.focus();
    return tab;
  }

  renderHistory(tab) {
    tab.histBox.replaceChildren(...(this.history.length ? this.history.map(q =>
      h('div', { class: 'hitem', title: q, onClick: () => { tab.ta.value = q; tab.histBox.hidden = true; this.saveSoon(); } }, q.replace(/\s+/g, ' ').slice(0, 140)))
      : [h('div', { class: 'mu pad' }, 'Belum ada riwayat.')]));
  }

  pushHistory(sql) {
    this.history = [sql, ...this.history.filter(x => x !== sql)].slice(0, HISTORY_MAX);
    this.save();
  }

  async runQuery(tab) {
    if (!this.engine || tab.runBtn.disabled) return;
    const sel = tab.ta.value.slice(tab.ta.selectionStart, tab.ta.selectionEnd).trim();
    const sql = sel || tab.ta.value.trim();
    if (!sql) return;
    tab.runBtn.disabled = true; tab.status.textContent = 'Menjalankan…'; tab.insp.hidden = true;
    const t0 = performance.now();
    try {
      const r = await this.engine.run(sql);
      const ms = Math.round(performance.now() - t0);
      const sets = Array.isArray(r.result) ? r.result : [r.result];
      tab.last = sets.filter(x => x && x.fields && x.fields.length).pop() || null;
      this.renderResult(tab, sets);
      const rowInfo = tab.last ? `${tab.last.rows.length} baris · ` : '';
      tab.status.textContent = `${r.kind === 'write' ? `ditulis sebagai #${r.id} · ` : ''}${rowInfo}${ms} ms`;
      this.pushHistory(sql);
      if (r.kind === 'write') this.refreshCatalog();
    } catch (e) {
      tab.last = null; tab.result.replaceChildren(h('div', { class: 'er' }, errMsg(e))); tab.status.textContent = '';
    }
    tab.runBtn.disabled = false;
  }

  renderResult(tab, sets) {
    const out = [];
    for (const x of sets) {
      if (!x) continue;
      if (x.error) { out.push(h('div', { class: 'er' }, x.error)); continue; }
      if (!x.fields || !x.fields.length) { out.push(h('div', { class: 'mu pad' }, `OK${x.affectedRows != null ? ` · ${x.affectedRows} baris` : ''}`)); continue; }
      out.push(renderGrid(x.fields, x.rows.slice(0, 1000), { onCell: (c, v) => this.inspect(tab, c, v) }));
      if (x.rows.length > 1000) out.push(h('div', { class: 'mu pad' }, `Menampilkan 1000 dari ${x.rows.length} baris (export berisi semua).`));
    }
    tab.result.replaceChildren(...out);
  }

  inspect(tab, col, v) {
    tab.insp.hidden = false;
    tab.insp.replaceChildren(h('b', null, col + ': '), v === null ? h('em', null, 'NULL') : v);
  }

  exportResult(tab, type) {
    if (!tab.last) return;
    const { fields, rows } = tab.last, stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    if (type === 'csv') download(`query-${stamp}.csv`, toCSV(fields, rows), 'text/csv');
    else download(`query-${stamp}.json`, toJSON(fields, rows), 'application/json');
  }

  /* ───────── tab tabel ───────── */
  addTableTab(schema, name) {
    const existing = this.tabs.find(t => t.kind === 'table' && t.schema === schema && t.name === name);
    if (existing) { this.activate(existing); this.loadTable(existing); return existing; }
    const filter = h('input', { class: 'filter', placeholder: `Filter, mis.  id > 10 and body like '%a%'`, onKeydown: e => { if (e.key === 'Enter') apply(); } });
    const gridBox = h('div', { class: 'gridbox' });
    const struct = h('div', { class: 'struct', hidden: true });
    const insp = h('div', { class: 'inspector', hidden: true });
    const status = h('span', { class: 'mu' });
    const pageInfo = h('span', { class: 'mu pageinfo' });
    const size = h('select', { onChange: () => { tab.size = +size.value; tab.page = 0; this.loadTable(tab); } },
      ...[25, 50, 100, 500].map(n => h('option', { value: n, selected: n === 50 }, `${n}/hal`)));
    const mk = (label, fn, title) => h('button', { class: 'sec small', title, onClick: fn }, label);
    const tab = this.makeTab('table', name, h('div', { class: 'pane' }), {
      ws: this, schema, name, page: 0, size: 50, sort: null, where: '', view: 'data', total: 0, fields: [], rows: [], gridBox, struct, insp, status, pageInfo,
    });
    const apply = () => { tab.where = filter.value; tab.page = 0; this.loadTable(tab); };
    const maxPage = () => Math.max(0, Math.ceil(tab.total / tab.size) - 1);
    const go = p => { tab.page = Math.min(Math.max(0, p), maxPage()); this.loadTable(tab); };
    const dataBtn = mk('Data', () => this.setView(tab, 'data')), structBtn = mk('Struktur', () => this.setView(tab, 'struct'));
    tab.dataBtn = dataBtn; tab.structBtn = structBtn; dataBtn.classList.add('on');
    tab.pager = h('span', { class: 'pager' }, mk('«', () => go(0)), mk('‹', () => go(tab.page - 1)), pageInfo, mk('›', () => go(tab.page + 1)), mk('»', () => go(maxPage())));
    tab.addBtn = mk('+ Baris', () => this.openRowDialog(tab, 'insert', null), 'Tambah baris');
    tab.dataTools = h('div', { class: 'row tools' }, filter, mk('Terapkan', apply), mk('↻', () => this.loadTable(tab), 'Muat ulang'), size, tab.pager, tab.addBtn,
      mk('CSV', () => this.exportTable(tab, 'csv')), mk('JSON', () => this.exportTable(tab, 'json')));
    tab.pane.append(
      h('div', { class: 'row tools' }, h('b', null, `${schema}.${name}`), h('span', { class: 'spacer' }), dataBtn, structBtn, status),
      tab.dataTools, gridBox, insp, struct);
    this.ensurePlus();
    this.activate(tab);
    this.loadTable(tab);
    return tab;
  }

  setView(tab, view) {
    tab.view = view;
    tab.dataBtn.classList.toggle('on', view === 'data'); tab.structBtn.classList.toggle('on', view === 'struct');
    tab.dataTools.hidden = view !== 'data'; tab.gridBox.hidden = view !== 'data'; tab.insp.hidden = true; tab.struct.hidden = view !== 'struct';
    if (view === 'struct') this.renderStruct(tab); else this.loadTable(tab);
  }

  tableMeta(tab) {
    const t = this.catalog.get(tab.schema)?.tables.find(x => x.name === tab.name);
    const cols = t?.cols || [];
    const pkCols = cols.filter(c => c.pk).map(c => c.name);
    return { t, cols, pkCols, editable: !!t && (t.kind === 'r' || t.kind === 'p') && pkCols.length > 0 };
  }

  async loadTable(tab) {
    if (!this.engine || tab.view !== 'data') return;
    tab.status.textContent = 'Memuat…';
    try {
      const meta = this.tableMeta(tab);
      const q = () => ({ schema: tab.schema, name: tab.name, where: tab.where, orderBy: tab.sort?.col, dir: tab.sort?.dir, limit: tab.size, offset: tab.page * tab.size, pkCols: meta.editable ? meta.pkCols : [] });
      let r = await fetchPage(this.engine, q());
      const last = Math.max(0, Math.ceil(r.total / tab.size) - 1);
      if (tab.page > last) { tab.page = last; r = await fetchPage(this.engine, q()); }
      tab.addBtn.disabled = !meta.editable;
      tab.addBtn.title = meta.editable ? 'Tambah baris' : (meta.t && meta.t.kind !== 'r' && meta.t.kind !== 'p' ? 'View: hanya-baca' : 'Tabel tanpa primary key: hanya-baca');
      Object.assign(tab, { total: r.total, fields: r.fields, rows: r.rows });
      tab.gridBox.replaceChildren(r.fields.length
        ? renderGrid(r.fields, r.rows, {
          startIndex: tab.page * tab.size, sort: tab.sort,
          onSort: col => { tab.sort = tab.sort?.col === col ? (tab.sort.dir === 'asc' ? { col, dir: 'desc' } : null) : { col, dir: 'asc' }; tab.page = 0; this.loadTable(tab); },
          onCell: (c, v) => { tab.insp.hidden = false; tab.insp.replaceChildren(h('b', null, c + ': '), v === null ? h('em', null, 'NULL') : v); },
          actions: meta.editable ? row => h('span', { class: 'acts' },
            h('button', { class: 'sec tiny', title: 'Edit baris', 'aria-label': 'Edit baris', onClick: () => this.openRowDialog(tab, 'edit', row) }, '✎'),
            h('button', { class: 'sec tiny danger', title: 'Hapus baris', 'aria-label': 'Hapus baris', onClick: () => this.deleteRow(tab, row) }, '🗑')) : null,
        })
        : h('div', { class: 'mu pad' }, 'Tabel tidak punya kolom.'));
      if (!r.rows.length) tab.gridBox.append(h('div', { class: 'mu pad' }, tab.where ? 'Tidak ada baris yang cocok dengan filter.' : 'Tabel kosong.'));
      tab.pageInfo.textContent = `${tab.page + 1} / ${last + 1}`;
      tab.status.textContent = `${r.total} baris${meta.editable ? '' : ' · hanya-baca'}`;
    } catch (e) {
      tab.gridBox.replaceChildren(h('div', { class: 'er' }, errMsg(e)));
      tab.status.textContent = '';
    }
  }

  /* ───────── edit baris ───────── */
  async deleteRow(tab, row) {
    const { cols, pkCols } = this.tableMeta(tab);
    const pkVals = pkCols.map((c, i) => row['__pk' + i]);
    if (!confirm(`Hapus baris ini dari ${tab.schema}.${tab.name}?\n${pkCols.map((c, i) => `${c} = ${pkVals[i]}`).join(', ')}`)) return;
    try {
      const { result } = await this.engine.write(buildDelete(tab.schema, tab.name, cols, pkCols, pkVals));
      const r = Array.isArray(result) ? result[0] : result;
      if (r?.error) tab.status.textContent = r.error;
      else if (r?.affectedRows === 0) tab.status.textContent = 'Baris sudah tidak ada (dihapus pengguna lain?)';
      await this.loadTable(tab);
    } catch (e) { tab.status.textContent = errMsg(e); }
  }

  openRowDialog(tab, mode, row) {
    const { cols, pkCols } = this.tableMeta(tab);
    if (!cols.length) return;
    const fields = cols.map(c => {
      const orig = mode === 'edit' ? fmt(row[c.name]) : null;
      const input = h('textarea', { class: 'fld', rows: 1, spellcheck: false, value: orig ?? '', 'aria-label': c.name,
        placeholder: mode === 'insert' ? (c.def ? `default: ${c.def}` : c.notnull ? 'wajib diisi' : 'kosong = default/NULL') : '' });
      const nul = h('input', { type: 'checkbox', checked: mode === 'edit' && orig === null, 'aria-label': `NULL untuk ${c.name}` });
      nul.addEventListener('change', () => { input.disabled = nul.checked; });
      input.disabled = nul.checked;
      const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight + 2) + 'px'; };   // auto-tinggi (CSSOM, aman dari CSP)
      input.addEventListener('input', grow); setTimeout(grow, 0);
      return { c, orig, input, nul, node: h('label', { class: 'frow' },
        h('span', { class: 'fname' }, h('b', null, c.name), c.pk ? ' 🔑' : '', h('span', { class: 'mu' }, ` ${c.type}${c.notnull ? ' · wajib' : ''}`)),
        input, h('span', { class: 'nullbox' }, nul, ' NULL')) };
    });
    const err = h('div', { class: 'er', hidden: true });
    const save = h('button', { onClick: submit }, mode === 'insert' ? 'Tambah' : 'Simpan');
    const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    const dlg = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': mode === 'insert' ? 'Tambah baris' : 'Edit baris' },
      h('h3', null, `${mode === 'insert' ? 'Tambah baris' : 'Edit baris'} · ${tab.schema}.${tab.name}`),
      h('div', { class: 'fields' }, fields.map(f => f.node)), err,
      h('div', { class: 'row' }, save, h('button', { class: 'sec', onClick: close }, 'Batal')));
    const backdrop = h('div', { class: 'backdrop', onClick: e => { if (e.target === backdrop) close(); } }, dlg);
    document.addEventListener('keydown', onKey);
    document.body.append(backdrop);
    fields[0].input.focus();

    const showErr = m => { err.textContent = m; err.hidden = !m; };
    async function submit() {
      showErr('');
      let sql;
      try {
        if (mode === 'insert') {
          const values = {};
          for (const f of fields) {
            if (f.nul.checked) values[f.c.name] = { mode: 'null' };
            else if (f.input.value !== '') values[f.c.name] = { mode: 'value', v: f.input.value };
            else values[f.c.name] = { mode: 'default' };
          }
          sql = buildInsert(tab.schema, tab.name, cols, values);
        } else {
          const changes = {};
          for (const f of fields) {
            const nowV = f.nul.checked ? null : f.input.value;
            if (nowV !== f.orig) changes[f.c.name] = nowV === null ? { mode: 'null' } : { mode: 'value', v: nowV };
          }
          if (!Object.keys(changes).length) { close(); return; }
          sql = buildUpdate(tab.schema, tab.name, cols, pkCols, pkCols.map((c, i) => row['__pk' + i]), changes);
        }
      } catch (e) { showErr(errMsg(e)); return; }
      save.disabled = true; save.textContent = 'Menyimpan…';
      try {
        const { result } = await tab.ws.engine.write(sql);
        const r = Array.isArray(result) ? result[0] : result;
        if (r?.error) { showErr(r.error); save.disabled = false; save.textContent = mode === 'insert' ? 'Tambah' : 'Simpan'; return; }
        if (mode === 'edit' && r?.affectedRows === 0) { showErr('Baris sudah tidak ada (dihapus pengguna lain?).'); save.disabled = false; save.textContent = 'Simpan'; return; }
        close(); tab.ws.loadTable(tab);
      } catch (e) { showErr(errMsg(e)); save.disabled = false; save.textContent = mode === 'insert' ? 'Tambah' : 'Simpan'; }
    }
  }

  async renderStruct(tab) {
    const t = this.catalog.get(tab.schema)?.tables.find(x => x.name === tab.name);
    const cols = t?.cols || [];
    const box = [h('div', { class: 'grid' }, h('table', null,
      h('thead', null, h('tr', null, ...['Kolom', 'Tipe', 'Null?', 'Default', 'PK'].map(x => h('th', null, x)))),
      h('tbody', null, ...cols.map(c => h('tr', null, h('td', null, c.name), h('td', null, c.type), h('td', null, c.notnull ? 'tidak' : 'ya'),
        h('td', { class: c.def ? '' : 'null' }, c.def || '—'), h('td', null, c.pk ? '🔑' : '')))))) ];
    try {
      const idx = await loadIndexes(this.engine, tab.schema, tab.name);
      box.push(h('h3', null, 'Index'), idx.length ? h('div', { class: 'idxlist' }, ...idx.map(i => h('div', { class: 'mono' }, i.indexdef))) : h('div', { class: 'mu pad' }, 'Tidak ada index.'));
    } catch (e) { box.push(h('div', { class: 'er' }, errMsg(e))); }
    tab.struct.replaceChildren(...box);
  }

  async exportTable(tab, type) {
    try {
      const { fields, rows } = await fetchAll(this.engine, { schema: tab.schema, name: tab.name, where: tab.where, orderBy: tab.sort?.col, dir: tab.sort?.dir });
      if (type === 'csv') download(`${tab.name}.csv`, toCSV(fields, rows), 'text/csv');
      else download(`${tab.name}.json`, toJSON(fields, rows), 'application/json');
    } catch (e) { tab.status.textContent = errMsg(e); }
  }
}

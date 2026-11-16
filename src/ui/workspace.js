// Workspace ala pgAdmin: sidebar objek, tab query & tab tabel (data grid + struktur), riwayat, export.
import { h } from './dom.js';
import { KIND_LABEL, loadCatalog, fetchPage, fetchAll, fmt, qi, ql, qname, toCSV, toJSON, download, buildInsert, buildUpdate, buildDelete } from './catalog.js';
import { loadStructure, loadAllFks, tableDDL, createSchema, dropSchema } from './ddl.js';
import { renderStructure } from './structure.js';
import { createTableDialog, importDialog, formDialog, confirmBox, promptBox, popMenu } from './dialogs.js';
import { dumpTable, dumpAll } from './tools.js';
import { renderERD, erdToSVGString } from './erd.js';
import { formatSQL, suggest, wordAt } from './editor.js';

const STARTER = `create table if not exists notes(
  id uuid primary key default gen_random_uuid(),
  body text,
  created_at timestamptz default now()
);
insert into notes(body) values ('halo dari tgpg');`;
const HISTORY_MAX = 50;
const errMsg = e => e?.message || String(e);
/** Statement pertama (sampai ';' tingkat atas) — dipakai untuk EXPLAIN. */
function split1(sql) { const m = /^((?:'(?:[^']|'')*'|"(?:[^"]|"")*"|[^;'"])*)/.exec(sql); return (m ? m[1] : sql).trim(); }
/** Kursor sedang di dalam string '…'? (hitung kutip tunggal sebelum kursor) */
function ta_inString(ta) { return ((ta.value.slice(0, ta.selectionStart).match(/'/g) || []).length % 2) === 1; }

/** Render tabel hasil/data. onSort(col) opsional, onCell(col, value) opsional. */
function renderGrid(fields, rows, { startIndex = 0, sort = null, onSort = null, onCell = null, actions = null, select = null, fk = null, onEdit = null } = {}) {
  const head = h('tr', null, select ? h('th', { class: 'sel' }, h('input', { type: 'checkbox', 'aria-label': 'Pilih semua', checked: rows.length > 0 && rows.every(r => select.has(r)), onChange: e => select.toggleAll(e.target.checked) })) : null, h('th', { class: 'rn' }, '#'));
  for (const f of fields) {
    head.append(h('th', { class: onSort ? 'sortable' : '', onClick: onSort ? () => onSort(f.name) : null },
      f.name, sort && sort.col === f.name ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : ''));
  }
  if (actions) head.append(h('th', { class: 'act' }, ''));
  const body = h('tbody');
  rows.forEach((r, i) => {
    const tr = h('tr', { class: select?.has(r) ? 'picked' : '' }, select ? h('td', { class: 'sel' }, h('input', { type: 'checkbox', 'aria-label': `Pilih baris ${startIndex + i + 1}`, checked: select.has(r), onChange: e => { select.toggle(r, e.target.checked); tr.classList.toggle('picked', e.target.checked); } })) : null, h('td', { class: 'rn' }, startIndex + i + 1));
    for (const f of fields) {
      const v = fmt(r[f.name]);
      const td = h('td', { class: v === null ? 'null' : '', title: v === null ? 'NULL' : v.slice(0, 200), onClick: onCell ? () => onCell(f.name, v) : null, onDblclick: onEdit ? () => onEdit(r, f.name, td, v) : null }, v === null ? 'NULL' : v);
      if (fk && v !== null && fk.has(f.name)) td.append(' ', h('a', { class: 'fklink', href: '#', title: `Buka baris terkait di ${fk.get(f.name).refTable}`, onClick: e => { e.preventDefault(); e.stopPropagation(); fk.open(f.name, v); } }, '↗'));
      tr.append(td);
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
    this.invUser = h('input', { type: 'text', placeholder: '@username', 'aria-label': 'Username Telegram', autocomplete: 'off' });
    this.invSend = h('input', { type: 'checkbox', id: 'inv-send' });
    this.invMsg = h('div', { class: 'mu', role: 'status' });
    this.memList = h('div', { class: 'members' });
    this.memMsg = h('div', { class: 'mu', role: 'status' });
    this.memPanel = h('div', { class: 'ws-share', hidden: true },
      h('div', { class: 'mu' }, 'Anggota database. Owner bisa menyetujui anggota baru dan mencabut akses (kunci enkripsi diganti; yang dicabut tidak bisa membaca/menulis data baru, tapi tetap menyimpan apa yang pernah ia lihat).'),
      this.memList, this.memMsg);
    this.diagOut = h('div', { class: 'diag' });
    this.diagPanel = h('div', { class: 'ws-share', hidden: true },
      h('div', { class: 'mu' }, 'Menguji asumsi TGPG terhadap Telegram sungguhan (mengirim beberapa pesan uji ke grup ini, lalu menghapusnya).'),
      h('button', { class: 'small', onClick: () => this.diagnose() }, 'Jalankan diagnostik'), this.diagOut);
    this.blockedEl = null;
    this.sharePanel = h('div', { class: 'ws-share', hidden: true },
      h('div', { class: 'mu' }, 'Connection string (berisi kunci enkripsi, bagikan hanya ke orang tepercaya):'), this.shareStr,
      h('button', { class: 'sec small', onClick: () => navigator.clipboard.writeText(this.shareStr.textContent) }, 'Salin'),
      h('div', { class: 'invite' },
        this.invUser, this.invSend, h('label', { for: 'inv-send', class: 'mu' }, 'Kirim juga connection string via DM'),
        h('button', { class: 'small', onClick: () => this.invite() }, 'Undang'),
        this.invMsg,
        h('div', { class: 'mu' }, 'Menambahkan ke grup saja tidak cukup: orang itu butuh kunci. Mengirim kunci via DM berarti Telegram bisa melihatnya; jika tidak mau, kirim lewat jalur lain.')));
    const bar = h('div', { class: 'ws-bar' }, this.sideBtn, this.titleEl, this.statEl, this.netEl, h('span', { class: 'spacer' }),
      h('button', { class: 'sec small', onClick: () => this.cb.onSync() }, 'Sinkron'),
      h('button', { class: 'sec small', onClick: () => this.cb.onSnapshot() }, 'Snapshot'),
      h('button', { class: 'sec small', onClick: () => this.backup() }, 'Backup'),
      h('button', { class: 'sec small', onClick: () => { this.diagPanel.hidden = !this.diagPanel.hidden; } }, 'Diagnostik'),
      h('button', { class: 'sec small', onClick: () => { this.renderMembers(); this.memPanel.hidden = !this.memPanel.hidden; } }, 'Anggota'),
      h('button', { class: 'sec small', onClick: () => { this.shareStr.textContent = this.cb.getConn(); this.sharePanel.hidden = !this.sharePanel.hidden; } }, 'Bagikan'),
      h('button', { class: 'sec small', onClick: () => this.cb.onReset() }, 'Reset lokal'),
      h('button', { class: 'sec small', onClick: () => this.cb.onClose() }, 'Tutup'));

    this.tree = h('div', { class: 'tree' });
    this.side = h('aside', { class: 'ws-side' },
      h('div', { class: 'side-head' }, h('span', null, 'Objek'), h('button', { class: 'sec small', title: 'Muat ulang', onClick: () => this.refreshCatalog() }, '↻')),
      h('div', { class: 'side-tools' },
        h('button', { class: 'sec small', title: 'Buat tabel baru', onClick: () => createTableDialog(this) }, '+ Tabel'),
        h('button', { class: 'sec small', title: 'Buat schema baru', onClick: () => this.newSchema() }, '+ Schema'),
        h('button', { class: 'sec small', title: 'Impor CSV/JSON', onClick: () => importDialog(this) }, 'Impor'),
        h('button', { class: 'sec small', title: 'Diagram relasi', onClick: () => this.addErdTab() }, 'ERD'),
        h('button', { class: 'sec small', title: 'Ekspor seluruh database sebagai SQL', onClick: () => this.dumpDb() }, 'Dump')),
      this.tree);
    this.tabbar = h('div', { class: 'tabbar' });
    this.panes = h('div', { class: 'panes' });
    const main = h('div', { class: 'ws-main' }, this.tabbar, this.panes);
    window.addEventListener('online', () => this.renderNet());
    window.addEventListener('offline', () => this.renderNet());
    this.root.replaceChildren(bar, this.sharePanel, this.memPanel, this.diagPanel, h('div', { class: 'ws-body' }, this.side, main));
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

  async invite() {
    const u = this.invUser.value.trim(); if (!u) return;
    this.invMsg.className = 'mu'; this.invMsg.textContent = 'Mengundang…';
    try {
      const r = await this.cb.onInvite(u, this.invSend.checked);
      this.invMsg.className = 'ok';
      this.invMsg.textContent = '@' + r.username + ' ditambahkan ke grup' + (r.dm ? ' dan connection string dikirim via DM.' : '. Kirimkan connection string secara terpisah.');
      this.invUser.value = '';
    } catch (e) { this.invMsg.className = 'er'; this.invMsg.textContent = e.message || String(e); }
  }

  async backup() {
    try {
      const blob = await this.cb.onBackup();
      const name = `tgpg-${this.titleEl.textContent || 'db'}-${new Date().toISOString().slice(0, 10)}.tar.gz`.replace(/[^\w.-]+/g, '_');
      download(name, blob, 'application/gzip');
    } catch (e) { this.statEl.textContent = 'Backup gagal: ' + (e.message || e); }
  }

  async diagnose() {
    this.diagOut.replaceChildren(h('div', { class: 'mu' }, 'Menjalankan… (±10 detik)'));
    try {
      const res = await this.cb.onDiagnose();
      this.diagOut.replaceChildren(...res.map(r => h('div', { class: r.ok ? 'ok' : 'er' }, (r.ok ? '✓ ' : '✗ ') + r.name + (r.detail ? ' — ' + r.detail : ''))));
    } catch (e) { this.diagOut.replaceChildren(h('div', { class: 'er' }, e.message || String(e))); }
  }

  setBlocked(b) { this.blocked = b; this.renderNet(); this.renderMembers(); }

  renderMembers() {
    const eng = this.engine; if (!eng) return;
    const owner = eng.isOwner, out = [];
    for (const m of eng.memberList()) {
      const st = m.owner ? 'owner' : ({ active: 'aktif', pending: 'menunggu persetujuan', removed: 'dicabut' }[m.status] || m.status);
      const row = h('div', { class: 'mrow' },
        h('span', { class: 'mname' }, (m.name || 'anggota') + (m.me ? ' (Anda)' : '') + ' · id ' + m.sid),
        h('span', { class: 'mst ' + m.status }, st));
      if (owner && !m.owner && m.status === 'pending') row.append(h('button', { class: 'small', onClick: () => this.memAct(() => this.cb.onApprove(m.sid), 'Disetujui.') }, 'Setujui'));
      if (owner && !m.owner && m.status !== 'removed') {
        const b = h('button', { class: 'small danger', onClick: () => {
          if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Yakin? Klik lagi'; return; }
          this.memAct(() => this.cb.onRevoke(m.sid), 'Akses dicabut, kunci dirotasi.');
        } }, 'Cabut');
        row.append(b);
      }
      out.push(row);
    }
    if (!out.length) out.push(h('div', { class: 'mu' }, 'Belum ada anggota terdaftar.'));
    if (!owner) out.push(h('div', { class: 'mu' }, 'Hanya owner database yang bisa mengelola anggota.'));
    this.memList.replaceChildren(...out);
  }

  async memAct(fn, okMsg) {
    this.memMsg.className = 'mu'; this.memMsg.textContent = 'Memproses…';
    try { await fn(); this.memMsg.className = 'ok'; this.memMsg.textContent = okMsg; }
    catch (e) { this.memMsg.className = 'er'; this.memMsg.textContent = e.message || String(e); }
    this.renderMembers();
  }

  renderNet() {
    const el = this.netEl, st = this.syncState;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { el.className = 'net er'; el.textContent = '⚠ offline'; el.title = 'Tidak ada koneksi. Perubahan tidak bisa dikirim; data lokal tetap bisa dibaca.'; return; }
    if (this.blocked) { el.className = 'net er'; el.textContent = '⏳ menunggu persetujuan owner'; el.title = 'Anda belum punya kunci terbaru. Minta owner membuka Anggota → Setujui.'; return; }
    if (st.ok === false) { el.className = 'net er'; el.textContent = '⚠ gagal sinkron'; el.title = st.err; return; }
    if (st.ok === true) { el.className = 'net ok'; el.textContent = '✓ ' + new Date(st.at).toLocaleTimeString(); el.title = 'Tersinkron dengan Telegram'; return; }
    el.className = 'net mu'; el.textContent = ''; el.title = '';
  }

  /** Dipanggil engine tiap kali sinkron: segarkan sidebar & tabel aktif bila log berubah. */
  notifyApplied(n) {
    this.statEl.textContent = `· log #${n}`;
    if (!this.memPanel.hidden) this.renderMembers();
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

  /** Jalankan DDL/DML sebagai satu op (error Postgres dilempar). */
  async exec(sql) {
    const { result } = await this.engine.write(sql);
    const rs = Array.isArray(result) ? result : [result];
    const bad = rs.find(r => r?.error);
    if (bad) throw new Error(bad.error);
    return rs;
  }
  execMany(sqls) { return this.exec(sqls.join(';\n')); }

  /* ───────── sidebar ───────── */
  async refreshCatalog() {
    if (!this.engine) return;
    for (const t of this.tabs) if (t.kind === 'table') t.fks = null;
    try { this.catalog = await loadCatalog(this.engine); } catch (e) { this.tree.replaceChildren(h('div', { class: 'er' }, errMsg(e))); return; }
    this.renderTree();
  }

  renderTree() {
    const out = [];
    for (const [schema, { tables, funcs }] of [...this.catalog].sort(([a], [b]) => (a === 'public' ? -1 : b === 'public' ? 1 : a.localeCompare(b)))) {
      const sd = h('details', { class: 'schema', open: true }, h('summary', null, h('span', { class: 'ico' }, '◈'), h('span', { class: 'tname' }, schema),
        h('button', { class: 'sec tiny', title: 'Menu schema', 'aria-label': `Menu schema ${schema}`, onClick: e => { e.preventDefault(); e.stopPropagation(); popMenu(e.currentTarget, [
          { label: 'Buat tabel di sini', onClick: () => createTableDialog(this, { schema }) },
          ...(schema !== 'public' ? [{ label: 'Hapus schema…', danger: true, onClick: () => formDialog(this, { title: `Hapus schema ${schema}`, note: 'Semua objek di dalamnya ikut hilang bila CASCADE dicentang.', fields: [{ key: 'cascade', label: 'CASCADE', type: 'check' }], build: v => [dropSchema(schema, v.cascade)], submit: 'Hapus' }) }] : [])]); } }, '⋯')));
      if (!tables.length && !funcs.length) sd.append(h('div', { class: 'mu pad' }, 'kosong'));
      for (const t of tables) {
        const key = `${schema}.${t.name}`;
        const td = h('details', { class: 'tbl', open: this.openTables.has(key), onToggle: e => { e.target.open ? this.openTables.add(key) : this.openTables.delete(key); } },
          h('summary', null,
            h('span', { class: 'tname', onClick: e => { e.preventDefault(); this.addTableTab(schema, t.name); this.side.classList.remove('open'); } },
              t.name, t.kind === 'v' || t.kind === 'm' ? h('em', null, ` ${KIND_LABEL[t.kind]}`) : ''),
            h('button', { class: 'sec tiny', title: 'Buka di tab query', onClick: e => { e.preventDefault(); e.stopPropagation(); this.addQueryTab(`select * from ${qname(schema, t.name)} limit 100;`, true); this.side.classList.remove('open'); } }, 'SQL'),
            h('button', { class: 'sec tiny', title: 'Menu tabel', 'aria-label': `Menu ${t.name}`, onClick: e => { e.preventDefault(); e.stopPropagation(); this.tableMenu(e.currentTarget, schema, t); } }, '⋯')),
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
    const sugBox = h('div', { class: 'sugbar', hidden: true, 'aria-label': 'Saran' });
    const tab = this.makeTab('query', `Query ${this.seqQuery = (this.seqQuery || 0) + 1}`, h('div', { class: 'pane' }), { ta, status, result, insp, histBox, sugBox, sug: [], last: null, n });
    const runBtn = h('button', { onClick: () => this.runQuery(tab) }, 'Run');
    tab.runBtn = runBtn;
    tab.pane.append(ta,
      h('div', { class: 'row tools' }, runBtn,
        h('button', { class: 'sec', title: 'Rencana eksekusi (EXPLAIN)', onClick: () => this.runQuery(tab, 'explain ') }, 'Explain'),
        h('button', { class: 'sec', title: 'EXPLAIN ANALYZE: menjalankan query baca-saja dan mengukur waktu', onClick: () => this.runQuery(tab, 'explain (analyze, buffers) ') }, 'Analyze'),
        h('button', { class: 'sec', title: 'Rapikan SQL (Ctrl+Shift+F)', onClick: () => this.formatEditor(tab) }, 'Format'),
        h('button', { class: 'sec', title: 'Simpan query ini', onClick: () => this.saveSnippet(tab) }, 'Simpan'),
        h('button', { class: 'sec', onClick: () => { this.renderHistory(tab); histBox.hidden = !histBox.hidden; } }, 'Riwayat'),
        h('button', { class: 'sec', onClick: () => this.exportResult(tab, 'csv') }, 'CSV'),
        h('button', { class: 'sec', onClick: () => this.exportResult(tab, 'json') }, 'JSON'), status),
      tab.sugBox, histBox, result, insp);
    ta.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this.runQuery(tab); }
      else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); this.formatEditor(tab); }
      else if (e.key === 'Tab' && !e.shiftKey && tab.sug?.length) { e.preventDefault(); this.applySuggestion(tab, tab.sug[0]); }
      else if (e.key === 'Escape' && tab.sug?.length) { tab.sug = []; this.renderSuggestions(tab); }
    });
    ta.addEventListener('input', () => this.updateSuggestions(tab));
    ta.addEventListener('click', () => this.updateSuggestions(tab));
    ta.addEventListener('input', () => this.saveSoon());
    this.ensurePlus();
    this.activate(tab);
    if (focus) ta.focus();
    return tab;
  }

  formatEditor(tab) {
    const ta = tab.ta, hasSel = ta.selectionStart !== ta.selectionEnd;
    const a = hasSel ? ta.selectionStart : 0, b = hasSel ? ta.selectionEnd : ta.value.length;
    ta.setRangeText(formatSQL(ta.value.slice(a, b)), a, b, 'end'); ta.focus(); this.saveSoon();
  }

  updateSuggestions(tab) {
    const { word } = wordAt(tab.ta.value, tab.ta.selectionStart);
    tab.sug = ta_inString(tab.ta) ? [] : suggest(word, this.catalog);
    this.renderSuggestions(tab);
  }

  renderSuggestions(tab) {
    tab.sugBox.hidden = !tab.sug.length;
    tab.sugBox.replaceChildren(h('span', { class: 'mu' }, 'Tab ⇥ '), ...tab.sug.map(x => h('button', { class: 'sec tiny', title: x.kind, onMousedown: e => { e.preventDefault(); this.applySuggestion(tab, x); } }, x.text)));
  }

  applySuggestion(tab, x) {
    const ta = tab.ta, pos = ta.selectionStart, { start } = wordAt(ta.value, pos);
    ta.setRangeText(x.text, start, pos, 'end'); tab.sug = []; this.renderSuggestions(tab); ta.focus(); this.saveSoon();
  }

  get snippets() { try { return JSON.parse(localStorage.getItem('tgpg:snip:' + this.dbId)) || []; } catch { return []; } }
  set snippets(v) { try { localStorage.setItem('tgpg:snip:' + this.dbId, JSON.stringify(v.slice(0, 100))); } catch {} }

  async saveSnippet(tab) {
    const sql = tab.ta.value.trim(); if (!sql) return;
    const name = await promptBox('Simpan query', 'Nama query:', sql.replace(/\s+/g, ' ').slice(0, 40));
    if (!name) return;
    this.snippets = [{ name, sql }, ...this.snippets.filter(x => x.name !== name)];
    tab.status.textContent = `Tersimpan: ${name}`;
  }

  renderHistory(tab) {
    const snips = this.snippets;
    tab.histBox.replaceChildren(...(snips.length ? [h('div', { class: 'mu pad' }, 'Tersimpan'), ...snips.map(x => h('div', { class: 'hitem snip', title: x.sql, onClick: () => { tab.ta.value = x.sql; tab.histBox.hidden = true; this.saveSoon(); } },
      h('b', null, x.name), h('button', { class: 'sec tiny danger', title: 'Hapus', onClick: e => { e.stopPropagation(); this.snippets = this.snippets.filter(y => y.name !== x.name); this.renderHistory(tab); } }, '×')))] : []),
      ...(snips.length ? [h('div', { class: 'mu pad' }, 'Riwayat')] : []),
      ...(this.history.length ? this.history.map(q =>
      h('div', { class: 'hitem', title: q, onClick: () => { tab.ta.value = q; tab.histBox.hidden = true; this.saveSoon(); } }, q.replace(/\s+/g, ' ').slice(0, 140)))
      : [h('div', { class: 'mu pad' }, 'Belum ada riwayat.')]));
  }

  pushHistory(sql) {
    this.history = [sql, ...this.history.filter(x => x !== sql)].slice(0, HISTORY_MAX);
    this.save();
  }

  async runQuery(tab, prefix = '') {
    if (!this.engine || tab.runBtn.disabled) return;
    const sel = tab.ta.value.slice(tab.ta.selectionStart, tab.ta.selectionEnd).trim();
    let sql = sel || tab.ta.value.trim();
    if (!sql) return;
    if (prefix) { const first = split1(sql); sql = prefix + first; }
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
      if (!prefix) this.pushHistory(sql);
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
    const filter = h('input', { class: 'filter', placeholder: `Filter SQL, mis.  id > 10 and body like '%a%'`, 'aria-label': 'Filter SQL', onKeydown: e => { if (e.key === 'Enter') apply(); } });
    const search = h('input', { class: 'filter', placeholder: 'Cari di semua kolom…', 'aria-label': 'Cari di semua kolom', onKeydown: e => { if (e.key === 'Enter') apply(); } });
    const selBar = h('div', { class: 'row tools selbar', hidden: true });
    const gridBox = h('div', { class: 'gridbox' });
    const struct = h('div', { class: 'struct', hidden: true });
    const insp = h('div', { class: 'inspector', hidden: true });
    const status = h('span', { class: 'mu' });
    const pageInfo = h('span', { class: 'mu pageinfo' });
    const size = h('select', { onChange: () => { tab.size = +size.value; tab.page = 0; this.loadTable(tab); } },
      ...[25, 50, 100, 500].map(n => h('option', { value: n, selected: n === 50 }, `${n}/hal`)));
    const mk = (label, fn, title) => h('button', { class: 'sec small', title, onClick: fn }, label);
    const tab = this.makeTab('table', name, h('div', { class: 'pane' }), {
      ws: this, schema, name, page: 0, size: 50, sort: null, where: '', search: '', view: 'data', total: 0, fields: [], rows: [], gridBox, struct, insp, status, pageInfo, filterEl: filter, searchEl: search, selBar, sel: new Map(), fks: null,
    });
    const apply = () => { tab.where = filter.value; tab.search = search.value; tab.page = 0; this.loadTable(tab); };
    const maxPage = () => Math.max(0, Math.ceil(tab.total / tab.size) - 1);
    const go = p => { tab.page = Math.min(Math.max(0, p), maxPage()); this.loadTable(tab); };
    const dataBtn = mk('Data', () => this.setView(tab, 'data')), structBtn = mk('Struktur', () => this.setView(tab, 'struct'));
    tab.dataBtn = dataBtn; tab.selBar = selBar; tab.structBtn = structBtn; dataBtn.classList.add('on');
    tab.pager = h('span', { class: 'pager' }, mk('«', () => go(0)), mk('‹', () => go(tab.page - 1)), pageInfo, mk('›', () => go(tab.page + 1)), mk('»', () => go(maxPage())));
    tab.addBtn = mk('+ Baris', () => this.openRowDialog(tab, 'insert', null), 'Tambah baris');
    tab.dataTools = h('div', { class: 'row tools' }, filter, search, mk('Terapkan', apply), mk('↻', () => this.loadTable(tab), 'Muat ulang'), size, tab.pager, tab.addBtn,
      mk('Impor', () => importDialog(this, { schema, name }), 'Impor CSV/JSON ke tabel ini'),
      mk('CSV', () => this.exportTable(tab, 'csv')), mk('JSON', () => this.exportTable(tab, 'json')), mk('SQL', () => this.exportTable(tab, 'sql'), 'Ekspor struktur + data sebagai SQL'));
    tab.pane.append(
      h('div', { class: 'row tools' }, h('b', null, `${schema}.${name}`), h('span', { class: 'spacer' }), dataBtn, structBtn, status),
      tab.dataTools, selBar, gridBox, insp, struct);
    this.ensurePlus();
    this.activate(tab);
    this.loadTable(tab);
    return tab;
  }

  setView(tab, view) {
    tab.view = view;
    tab.dataBtn.classList.toggle('on', view === 'data'); tab.structBtn.classList.toggle('on', view === 'struct');
    tab.dataTools.hidden = view !== 'data'; tab.selBar.hidden = view !== 'data' || !tab.sel.size; tab.gridBox.hidden = view !== 'data'; tab.insp.hidden = true; tab.struct.hidden = view !== 'struct';
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
      if (!tab.fks) { try { tab.fks = (await loadStructure(this.engine, tab.schema, tab.name)).fks.filter(f => f.cols.length === 1); } catch { tab.fks = []; } }
      const q = () => ({ schema: tab.schema, name: tab.name, where: tab.where, search: tab.search, searchCols: meta.cols.map(c => c.name), orderBy: tab.sort?.col, dir: tab.sort?.dir, limit: tab.size, offset: tab.page * tab.size, pkCols: meta.editable ? meta.pkCols : [] });
      let r = await fetchPage(this.engine, q());
      const last = Math.max(0, Math.ceil(r.total / tab.size) - 1);
      if (tab.page > last) { tab.page = last; r = await fetchPage(this.engine, q()); }
      tab.addBtn.disabled = !meta.editable;
      tab.addBtn.title = meta.editable ? 'Tambah baris' : (meta.t && meta.t.kind !== 'r' && meta.t.kind !== 'p' ? 'View: hanya-baca' : 'Tabel tanpa primary key: hanya-baca');
      Object.assign(tab, { total: r.total, fields: r.fields, rows: r.rows });
      tab.sel.clear(); this.renderSelBar(tab, meta);
      const fkMap = new Map(tab.fks.map(f => [f.cols[0], f]));
      const select = meta.editable ? {
        has: r => tab.sel.has(r), toggle: (r, on) => { on ? tab.sel.set(r, true) : tab.sel.delete(r); this.renderSelBar(tab, meta); },
        toggleAll: on => { tab.sel.clear(); if (on) r.rows.forEach(x => tab.sel.set(x, true)); this.renderSelBar(tab, meta); this.syncChecks(tab); },
      } : null;
      tab.gridBox.replaceChildren(r.fields.length
        ? renderGrid(r.fields, r.rows, {
          select, fk: fkMap.size ? { has: c => fkMap.has(c), get: c => fkMap.get(c), open: (c, v) => this.openRelated(fkMap.get(c), v) } : null,
          onEdit: meta.editable ? (row, col, td, v) => this.editCell(tab, meta, row, col, td, v) : null,
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

  syncChecks(tab) {
    [...tab.gridBox.querySelectorAll('tbody tr')].forEach((tr, i) => {
      const on = tab.sel.has(tab.rows[i]); tr.classList.toggle('picked', on);
      const cb = tr.querySelector('td.sel input'); if (cb) cb.checked = on;
    });
  }

  renderSelBar(tab, meta) {
    const n = tab.sel.size; tab.selBar.hidden = !n || tab.view !== 'data';
    if (!n) return;
    const rows = [...tab.sel.keys()];
    tab.selBar.replaceChildren(h('b', null, `${n} baris dipilih`),
      h('button', { class: 'sec small', onClick: () => this.copyRows(tab, rows) }, 'Salin (TSV)'),
      n === 1 ? h('button', { class: 'sec small', onClick: () => this.openRowDialog(tab, 'insert', rows[0]) }, 'Duplikat') : null,
      h('button', { class: 'sec small danger', onClick: () => this.deleteRows(tab, rows) }, 'Hapus terpilih'),
      h('button', { class: 'sec small', onClick: () => { tab.sel.clear(); this.renderSelBar(tab, meta); this.syncChecks(tab); } }, 'Batal pilih'));
  }

  async copyRows(tab, rows) {
    const tsv = [tab.fields.map(f => f.name).join('\t'), ...rows.map(r => tab.fields.map(f => (fmt(r[f.name]) ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t'))].join('\n');
    try { await navigator.clipboard.writeText(tsv); tab.status.textContent = `${rows.length} baris disalin`; } catch { tab.status.textContent = 'Gagal menyalin (izin clipboard).'; }
  }

  async deleteRows(tab, rows) {
    const { cols, pkCols } = this.tableMeta(tab);
    if (!await confirmBox(`Hapus ${rows.length} baris dari ${tab.schema}.${tab.name}? Berlaku untuk semua anggota.`)) return;
    try {
      const rs = await this.execMany(rows.map(r => buildDelete(tab.schema, tab.name, cols, pkCols, pkCols.map((c, i) => r['__pk' + i]))));
      const n = rs.reduce((a, r) => a + (r?.affectedRows || 0), 0);
      tab.status.textContent = `${n} baris dihapus`;
      await this.loadTable(tab);
    } catch (e) { tab.status.textContent = errMsg(e); }
  }

  /** Edit sel langsung (klik ganda): Enter simpan, Esc batal, ∅ = NULL. */
  editCell(tab, meta, row, col, td, cur) {
    if (td.querySelector('input.cell')) return;
    const c = meta.cols.find(x => x.name === col);
    if (!c || c.generated === 's') { tab.status.textContent = 'Kolom ini dihitung otomatis (read-only).'; return; }
    const prev = td.textContent, wasNull = cur === null;
    const inp = h('input', { class: 'cell', type: 'text', value: cur ?? '', spellcheck: false, 'aria-label': `Edit ${col}` });
    let done = false;
    const restore = () => { td.replaceChildren(document.createTextNode(prev)); };
    const commit = async nul => {
      if (done) return; done = true;
      const nv = nul ? null : inp.value;
      if ((nv === null && wasNull) || nv === cur) { restore(); return; }
      td.classList.add('saving');
      try {
        const r = (await this.execMany([buildUpdate(tab.schema, tab.name, meta.cols, meta.pkCols, meta.pkCols.map((p, i) => row['__pk' + i]), { [col]: nv === null ? { mode: 'null' } : { mode: 'value', v: nv } })]))[0];
        if (r?.affectedRows === 0) tab.status.textContent = 'Baris sudah tidak ada (dihapus pengguna lain?)';
        await this.loadTable(tab);
      } catch (e) { tab.status.textContent = errMsg(e); td.classList.remove('saving'); restore(); }
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(false); } else if (e.key === 'Escape') { done = true; restore(); } });
    inp.addEventListener('blur', () => { setTimeout(() => { if (!done) { done = true; restore(); } }, 120); });
    td.replaceChildren(inp, h('button', { class: 'sec tiny', title: 'Set NULL', onMousedown: e => { e.preventDefault(); commit(true); } }, '∅'));
    inp.focus(); inp.select();
  }

  /** Buka tabel rujukan FK dengan filter pada nilai ini. */
  openRelated(fk, value) {
    const tab = this.addTableTab(fk.refSchema, fk.refTable);
    tab.where = `${qi(fk.refCols[0])} = ${ql(value)}`; tab.filterEl.value = tab.where; tab.page = 0;
    this.loadTable(tab);
  }

  async newSchema() {
    formDialog(this, { title: 'Buat schema', fields: [{ key: 'name', label: 'Nama schema' }], build: v => [createSchema(v.name)] });
  }

  tableMenu(anchor, schema, t) {
    const full = qname(schema, t.name);
    popMenu(anchor, [
      { label: 'Buka data', onClick: () => { this.addTableTab(schema, t.name); this.side.classList.remove('open'); } },
      { label: 'Lihat struktur', onClick: () => { const tab = this.addTableTab(schema, t.name); this.setView(tab, 'struct'); this.side.classList.remove('open'); } },
      { label: 'Impor ke tabel ini', onClick: () => importDialog(this, { schema, name: t.name }) },
      { label: 'Ekspor SQL', onClick: async () => { try { download(`${t.name}.sql`, await dumpTable(this.engine, schema, t.name), 'text/plain'); } catch (e) { this.statEl.textContent = errMsg(e); } } },
      { label: 'Salin DDL', onClick: async () => { try { await navigator.clipboard.writeText(tableDDL(await loadStructure(this.engine, schema, t.name))); } catch (e) { this.statEl.textContent = errMsg(e); } } },
      { label: 'Salin nama', onClick: () => navigator.clipboard?.writeText(full) },
    ]);
  }

  async dumpDb() {
    try {
      const sql = await dumpAll(this.engine, this.catalog, await loadAllFks(this.engine));
      download(`${(this.titleEl.textContent || 'db').replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.sql`, sql, 'text/plain');
    } catch (e) { this.statEl.textContent = 'Dump gagal: ' + errMsg(e); }
  }

  /* ───────── tab ERD ───────── */
  async addErdTab() {
    const existing = this.tabs.find(t => t.kind === 'erd');
    if (existing) { this.activate(existing); this.loadErd(existing); return existing; }
    const box = h('div', { class: 'erdbox' }), status = h('span', { class: 'mu' });
    const tab = this.makeTab('erd', 'ERD', h('div', { class: 'pane' }), { box, status });
    tab.pane.append(h('div', { class: 'row tools' }, h('b', null, 'Diagram relasi'), h('span', { class: 'spacer' }),
      h('button', { class: 'sec small', onClick: () => this.loadErd(tab) }, '↻'),
      h('button', { class: 'sec small', onClick: () => tab.svg && download(`erd-${new Date().toISOString().slice(0, 10)}.svg`, erdToSVGString(tab.svg), 'image/svg+xml') }, 'Unduh SVG'), status),
      h('div', { class: 'mu pad' }, 'Klik ganda tabel untuk membuka datanya.'), box);
    this.ensurePlus(); this.activate(tab); this.loadErd(tab);
    return tab;
  }

  async loadErd(tab) {
    tab.status.textContent = 'Memuat…';
    try {
      const fks = await loadAllFks(this.engine);
      const tables = [];
      for (const [schema, { tables: ts }] of this.catalog) for (const t of ts) if (t.kind === 'r' || t.kind === 'p') tables.push({ schema, name: t.name, cols: t.cols });
      if (!tables.length) { tab.box.replaceChildren(h('div', { class: 'mu pad' }, 'Belum ada tabel.')); tab.svg = null; tab.status.textContent = ''; return; }
      tab.svg = renderERD(tables, fks, { onOpen: (s, n) => this.addTableTab(s, n) });
      tab.box.replaceChildren(tab.svg); tab.status.textContent = `${tables.length} tabel · ${fks.length} relasi`;
    } catch (e) { tab.box.replaceChildren(h('div', { class: 'er' }, errMsg(e))); tab.status.textContent = ''; }
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
    const { cols: allCols, pkCols } = this.tableMeta(tab);
    const cols = allCols.filter(c => c.generated !== 's');   // kolom hasil hitung tidak bisa diisi
    if (!cols.length) return;
    const dup = mode === 'insert' && row;
    const fields = cols.map(c => {
      const orig = mode === 'edit' ? fmt(row[c.name]) : null;
      const auto = /^nextval\(/.test(c.def || '') || !!c.identity;
      const start = dup ? (auto ? '' : fmt(row[c.name])) : orig;
      const input = h('textarea', { class: 'fld', rows: 1, spellcheck: false, value: start ?? '', 'aria-label': c.name,
        placeholder: mode === 'insert' ? (c.def ? `default: ${c.def}` : c.notnull ? 'wajib diisi' : 'kosong = default/NULL') : '' });
      const nul = h('input', { type: 'checkbox', checked: (mode === 'edit' && orig === null) || (dup && !auto && start === null), 'aria-label': `NULL untuk ${c.name}` });
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
      h('h3', null, `${dup ? 'Duplikat baris' : mode === 'insert' ? 'Tambah baris' : 'Edit baris'} · ${tab.schema}.${tab.name}`),
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

  renderStruct(tab) { return renderStructure(this, tab); }

  async exportTable(tab, type) {
    try {
      if (type === 'sql') { download(`${tab.name}.sql`, await dumpTable(this.engine, tab.schema, tab.name), 'text/plain'); return; }
      const { fields, rows } = await fetchAll(this.engine, { schema: tab.schema, name: tab.name, where: tab.where, search: tab.search, searchCols: this.tableMeta(tab).cols.map(c => c.name), orderBy: tab.sort?.col, dir: tab.sort?.dir });
      if (type === 'csv') download(`${tab.name}.csv`, toCSV(fields, rows), 'text/csv');
      else download(`${tab.name}.json`, toJSON(fields, rows), 'application/json');
    } catch (e) { tab.status.textContent = errMsg(e); }
  }
}

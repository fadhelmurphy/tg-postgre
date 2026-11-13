import './style.css';
import { PGlite } from '@electric-sql/pglite';
import { b64u, importKey, randomKeyBytes, hasVault, saveVault, loadVault, deleteVault } from './crypto.js';
import { Engine } from './engine.js';
import { connectClient, createChannel, resolveInvite, TelegramTransport } from './telegram.js';

const $ = id => document.getElementById(id);
const show = (id, on = true) => { $(id).hidden = !on; };
const LS = { get: k => localStorage.getItem('tgpg:' + k), set: (k, v) => localStorage.setItem('tgpg:' + k, v), del: k => localStorage.removeItem('tgpg:' + k) };
const CONN_RE = /^tgpg:\/\/([^#\s]+)#([A-Za-z0-9_-]{43})$/;

function log(msg, cls = '') {
  const el = $('log'), d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = new Date().toLocaleTimeString() + '  ' + msg;
  el.appendChild(d);
  while (el.childElementCount > 500) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
}
const errMsg = e => e?.errorMessage || e?.message || String(e);

/* ───────── state ───────── */
let V = null;            // isi vault: {apiId, apiHash, name, session, dbs}
let PASS = null;
let client = null;
let engine = null, current = null, syncTimer = null;
const heldLocks = new Set();

const persist = () => saveVault(PASS, V);

function ask(label) {
  return new Promise(res => {
    show('askRow'); $('askInput').value = ''; $('askInput').placeholder = label; $('askInput').focus();
    const done = () => { $('askBtn').onclick = null; $('askInput').onkeydown = null; show('askRow', false); res($('askInput').value.trim()); };
    $('askBtn').onclick = done;
    $('askInput').onkeydown = e => { if (e.key === 'Enter') done(); };
  });
}

/* ───────── unlock / login ───────── */
async function unlock() {
  try { V = await loadVault($('unlockPass').value); PASS = $('unlockPass').value; }
  catch (e) { return log(errMsg(e), 'er'); }
  show('c-unlock', false);
  await startClient();
}

async function login() {
  const apiId = parseInt($('apiId').value, 10), apiHash = $('apiHash').value.trim(), pass = $('newPass').value;
  if (!apiId || !apiHash) return log('Isi api_id dan api_hash.', 'er');
  if (pass.length < 8) return log('Passphrase minimal 8 karakter.', 'er');
  V = { apiId, apiHash, name: $('name').value.trim() || 'anon', session: '', dbs: {} };
  PASS = pass;
  $('btnLogin').disabled = true;
  try { await startClient(); } finally { $('btnLogin').disabled = false; }
}

async function startClient() {
  try {
    const r = await connectClient({ apiId: V.apiId, apiHash: V.apiHash, session: V.session, ask, log });
    client = r.client; V.session = r.session; await persist();
    const me = await client.getMe();
    $('who').textContent = 'Login sebagai ' + (me.username ? '@' + me.username : me.firstName || me.id);
    show('c-login', false); show('c-db'); renderSaved();
    log('Terhubung ke Telegram.', 'ok');
  } catch (e) {
    log('Login gagal: ' + errMsg(e), 'er');
    if (hasVault() && !V.session) show('c-login');
  }
}

function renderSaved() {
  const box = $('saved'); box.replaceChildren();
  for (const [id, d] of Object.entries(V.dbs || {})) {
    const row = document.createElement('div'); row.className = 'saved-item';
    const label = document.createElement('span'); label.textContent = d.title || id;
    const open = document.createElement('button'); open.className = 'sec small'; open.textContent = 'Buka';
    open.onclick = () => connectString(d.conn).catch(e => log('Gagal: ' + errMsg(e), 'er'));
    const del = document.createElement('button'); del.className = 'sec small'; del.textContent = 'Lupakan';
    del.onclick = async () => { delete V.dbs[id]; await persist(); renderSaved(); };
    row.append(label, open, del); box.appendChild(row);
  }
}

/* ───────── database ───────── */
function acquireLock(name) {
  if (heldLocks.has(name) || !navigator.locks) return Promise.resolve(true);
  return new Promise(res => navigator.locks.request(name, { ifAvailable: true }, lock => {
    if (!lock) { res(false); return; }
    heldLocks.add(name); res(true);
    return new Promise(() => {});   // tahan lock selama tab terbuka
  }));
}

async function createDatabase() {
  const name = $('dbName').value.trim() || 'database';
  const key = randomKeyBytes();
  const { chat, hash } = await createChannel(client, name);
  log('Grup Telegram dibuat: ' + name, 'ok');
  await openDatabase(chat, key, `tgpg://${hash}#${b64u.enc(key)}`);
}

async function connectString(str) {
  const m = CONN_RE.exec(str.trim());
  if (!m) throw new Error('Format harus tgpg://INVITE#KUNCI');
  const chat = await resolveInvite(client, m[1]);
  await openDatabase(chat, b64u.dec(m[2]), `tgpg://${m[1]}#${m[2]}`);
}

async function openDatabase(chat, rawKey, conn) {
  const dbId = String(chat.id);
  if (!(await acquireLock('tgpg-db-' + dbId))) return log('Database ini sedang terbuka di tab lain.', 'er');
  await closeEngine();
  const key = await importKey(rawKey);
  const initKey = 'init:' + dbId;
  const createDb = async blob => {
    const db = new PGlite('idb://tgpg-' + dbId, blob ? { loadDataDir: blob } : undefined);
    await db.waitReady; return db;
  };
  log('Membuka database…');
  engine = await Engine.open({
    transport: new TelegramTransport(client, chat), key, createDb, hasLocal: !!LS.get(initKey),
    author: V.name, log,
  });
  LS.set(initKey, '1');
  current = { chat, rawKey, conn, dbId };
  engine.onApplied = n => { $('stat').textContent = `· log #${n}`; };
  engine.onApplied(engine.lastApplied);
  syncTimer = setInterval(() => engine.sync(), 15000);   // jaga-jaga bila ada update yang terlewat

  V.dbs = V.dbs || {}; V.dbs[dbId] = { conn, title: (chat.title || '').replace(/^TGPG · /, '') || dbId };
  await persist(); renderSaved();
  $('shareStr').textContent = conn; show('shareBox'); show('c-sql');
  if (!$('sql').value) $('sql').value = `create table if not exists notes(\n  id uuid primary key default gen_random_uuid(),\n  body text,\n  created_at timestamptz default now()\n);\ninsert into notes(body) values ('halo dari tgpg');`;
  log('Database siap. Posisi log #' + engine.lastApplied, 'ok');
}

async function closeEngine() {
  clearInterval(syncTimer);
  if (engine) { try { await engine.close(); } catch {} engine = null; }
}

async function resetLocal() {
  if (!current || !confirm('Hapus salinan lokal dan bangun ulang dari Telegram?')) return;
  const { chat, rawKey, conn, dbId } = current;
  await closeEngine();
  await deleteIdb('tgpg-' + dbId);
  LS.del('init:' + dbId);
  await openDatabase(chat, rawKey, conn);
}

async function deleteIdb(fragment) {
  const dbs = (indexedDB.databases ? await indexedDB.databases() : []).filter(d => d.name && d.name.includes(fragment));
  await Promise.all(dbs.map(d => new Promise(res => { const r = indexedDB.deleteDatabase(d.name); r.onsuccess = r.onerror = r.onblocked = () => res(); })));
}

async function wipeAll() {
  if (!confirm('Hapus vault, session, dan semua salinan database lokal?')) return;
  await deleteIdb('tgpg-');
  Object.keys(localStorage).filter(k => k.startsWith('tgpg:')).forEach(k => localStorage.removeItem(k));
  deleteVault(); location.reload();
}

/* ───────── SQL ───────── */
function renderResults(res) {
  const out = $('out'); out.replaceChildren();
  for (const x of Array.isArray(res) ? res : [res]) {
    if (!x) continue;
    if (x.error) { const d = document.createElement('div'); d.className = 'er'; d.textContent = x.error; out.appendChild(d); continue; }
    if (!x.fields || !x.fields.length) {
      const d = document.createElement('div'); d.className = 'mu';
      d.textContent = 'OK' + (x.affectedRows != null ? ` · ${x.affectedRows} baris` : ''); out.appendChild(d); continue;
    }
    const t = document.createElement('table'), head = t.insertRow();
    for (const f of x.fields) { const th = document.createElement('th'); th.textContent = f.name; head.appendChild(th); }
    for (const r of x.rows.slice(0, 1000)) {
      const tr = t.insertRow();
      for (const f of x.fields) {
        const v = r[f.name];
        tr.insertCell().textContent = v == null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      }
    }
    out.appendChild(t);
    if (x.rows.length > 1000) { const d = document.createElement('div'); d.className = 'mu'; d.textContent = `Menampilkan 1000 dari ${x.rows.length} baris.`; out.appendChild(d); }
  }
}

async function run() {
  const sql = $('sql').value.trim();
  if (!sql || !engine) return;
  $('btnRun').disabled = true;
  try {
    const r = await engine.run(sql);
    if (r.kind === 'write') log(`Write diterapkan sebagai #${r.id}`, 'ok');
    renderResults(r.result);
  } catch (e) { renderResults({ error: errMsg(e) }); }
  $('btnRun').disabled = false;
}

/* ───────── wiring ───────── */
const guard = fn => () => fn().catch(e => log('Gagal: ' + errMsg(e), 'er'));
$('btnUnlock').onclick = unlock;
$('unlockPass').onkeydown = e => { if (e.key === 'Enter') unlock(); };
$('btnWipe').onclick = wipeAll;
$('btnLogin').onclick = login;
$('btnCreate').onclick = guard(createDatabase);
$('btnConnect').onclick = guard(() => connectString($('connStr').value));
$('btnRun').onclick = run;
$('btnSync').onclick = guard(async () => { await engine?.sync(); });
$('btnSnap').onclick = guard(async () => { const s = await engine?.snapshot(); if (!s) log('Tidak ada perubahan sejak snapshot terakhir.'); });
$('btnReset').onclick = guard(resetLocal);
$('btnCopy').onclick = () => navigator.clipboard.writeText($('shareStr').textContent).then(() => log('Disalin.', 'ok'));
$('sql').addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(); });

if (hasVault()) show('c-unlock'); else show('c-login');
if (!window.isSecureContext) log('Halaman harus dibuka lewat HTTPS (atau localhost).', 'er');

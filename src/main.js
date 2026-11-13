import './style.css';
import { PGlite } from '@electric-sql/pglite';
import { PGliteWorker } from '@electric-sql/pglite/worker';
import { b64u, importKey, randomKeyBytes, hasVault, saveVault, loadVault, deleteVault } from './crypto.js';
import { Engine } from './engine.js';
import { connectClient, createChannel, resolveInvite, TelegramTransport } from './telegram.js';
import { Workspace } from './ui/workspace.js';

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

const ws = new Workspace($('c-work'), {
  onSync: () => engine?.sync(),
  onSnapshot: async () => {
    try { const r = await engine?.snapshot(); if (!r) log('Tidak ada perubahan sejak snapshot terakhir.'); }
    catch (e) { log('Snapshot gagal: ' + errMsg(e), 'er'); }
  },
  onReset: () => resetLocal().catch(e => log('Gagal: ' + errMsg(e), 'er')),
  onClose: () => closeDatabase(),
  getConn: () => current?.conn || '',
});

function showHome(on) {
  show('c-db', on); show('c-work', !on);
  document.querySelector('main').classList.toggle('wide', !on);
}
async function closeDatabase() {
  ws.close(); await closeEngine(); current = null; showHome(true);
}

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
    const dataDir = 'idb://tgpg-' + dbId, opts = blob ? { loadDataDir: blob } : {};
    try {   // utama: PGlite di Web Worker (UI tidak beku)
      const db = new PGliteWorker(new Worker(new URL('./pg.worker.js', import.meta.url), { type: 'module' }), { dataDir, ...opts });
      await db.waitReady; return db;
    } catch (e) {
      log('Worker gagal (' + errMsg(e) + '), memakai mode utas utama.', 'er');
      const db = new PGlite(dataDir, blob ? { loadDataDir: blob } : undefined);
      await db.waitReady; return db;
    }
  };
  log('Membuka database…');
  engine = await Engine.open({
    transport: new TelegramTransport(client, chat), key, createDb, hasLocal: !!LS.get(initKey),
    author: V.name, log,
  });
  LS.set(initKey, '1');
  current = { chat, rawKey, conn, dbId };
  engine.onApplied = n => ws.notifyApplied(n);
  engine.onSync = (ok, err) => ws.setSyncState(ok, err);
  syncTimer = setInterval(() => engine.sync(), 15000);   // jaga-jaga bila ada update yang terlewat

  V.dbs = V.dbs || {}; V.dbs[dbId] = { conn, title: (chat.title || '').replace(/^TGPG · /, '') || dbId };
  await persist(); renderSaved();
  await ws.open({ engine, dbId, title: V.dbs[dbId].title });
  engine.onApplied(engine.lastApplied);
  showHome(false);
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

/* ───────── ketahanan: koneksi & error global ───────── */
const resync = () => { if (engine && navigator.onLine !== false) engine.sync(); };
window.addEventListener('online', () => { log('Kembali online, sinkron…', 'ok'); resync(); });
window.addEventListener('offline', () => log('Offline. Data lokal tetap bisa dibaca; write ditunda sampai online.', 'er'));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resync(); });
window.addEventListener('error', e => log('Error: ' + (e.message || e.error), 'er'));
window.addEventListener('unhandledrejection', e => log('Error: ' + errMsg(e.reason), 'er'));

/* ───────── wiring ───────── */
const guard = fn => () => fn().catch(e => log('Gagal: ' + errMsg(e), 'er'));
$('btnUnlock').onclick = unlock;
$('unlockPass').onkeydown = e => { if (e.key === 'Enter') unlock(); };
$('btnWipe').onclick = wipeAll;
$('btnLogin').onclick = login;
$('btnCreate').onclick = guard(createDatabase);
$('btnConnect').onclick = guard(() => connectString($('connStr').value));

if (hasVault()) show('c-unlock'); else show('c-login');
if (!window.isSecureContext) log('Halaman harus dibuka lewat HTTPS (atau localhost).', 'er');

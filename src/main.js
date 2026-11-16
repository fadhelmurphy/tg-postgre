import './style.css';
import { PGlite } from '@electric-sql/pglite';
import { PGliteWorker } from '@electric-sql/pglite/worker';
import { b64u, genIdentity, loadIdentity, importKey, randomKeyBytes, hasVault, saveVault, loadVault, deleteVault, newVaultKey, rememberDevice, forgetDevice, unlockWithDevice } from './crypto.js';
import { Engine } from './engine.js';
import { connectClient, createChannel, resolveInvite, findChat, exportInvite, inviteUser, kickUser, runDiagnostics, TelegramTransport } from './telegram.js';
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
let VK = null;           // kunci vault (CryptoKey)
let client = null;
const sessions = new Map();   // dbId -> {dbId, chat, rawKey, conn, engine, ws, root, syncTimer}
let activeId = null;
const heldLocks = new Set();

function makeWs(sess, root) {
  const eng = () => sess.engine;
  return new Workspace(root, {
    onSync: () => eng()?.sync(),
    onSnapshot: async () => {
      try { const r = await eng()?.snapshot(); if (!r) log('Tidak ada perubahan sejak snapshot terakhir.'); }
      catch (e) { log('Snapshot gagal: ' + errMsg(e), 'er'); }
    },
    onReset: () => resetLocal(sess).catch(e => log('Gagal: ' + errMsg(e), 'er')),
    onClose: () => closeSession(sess.dbId),
    getConn: () => sess.conn || '',
    onNewInvite: async () => {
      const hash = await exportInvite(client, sess.chat);
      sess.conn = `tgpg://${hash}#${b64u.enc(sess.rawKey)}`;
      if (V.dbs?.[sess.dbId]) { V.dbs[sess.dbId].conn = sess.conn; await persist(); }
      return sess.conn;
    },
    onDiagnose: () => runDiagnostics(client, sess.chat),
    onBackup: async () => eng().backup(),
    onApprove: sid => eng().approve(sid),
    onRevoke: async sid => {
      const r = await eng().rotate({ remove: [sid] });
      try { await kickUser(client, sess.chat, sid); } catch (e) { log('Tidak bisa mengeluarkan dari grup Telegram (' + errMsg(e) + '); kunci tetap sudah dirotasi.', 'er'); }
      return r;
    },
    onInvite: async (username, sendKey) => inviteUser(client, sess.chat, username, { connStr: sess.conn, sendKey }),
  });
}

function showHome(on) {
  show('c-db', on); show('c-work', !on);
  document.querySelector('main').classList.toggle('wide', !on);
}
/** Tampilkan database terbuka `id`, atau beranda bila null. */
function view(id) {
  activeId = id && sessions.has(id) ? id : null;
  for (const [sid, x] of sessions) x.root.hidden = sid !== activeId;
  showHome(!activeId); renderBar();
}
function renderBar() {
  const bar = $('dbbar'); bar.replaceChildren(); bar.hidden = sessions.size === 0;
  for (const [id, x] of sessions) {
    const t = document.createElement('button'); t.className = 'dbtab' + (id === activeId ? ' on' : '');
    t.textContent = '🗄 ' + (V.dbs?.[id]?.title || id); t.onclick = () => view(id);
    const c = document.createElement('span'); c.className = 'x'; c.textContent = '×'; c.title = 'Tutup database ini';
    c.onclick = e => { e.stopPropagation(); closeSession(id); }; t.appendChild(c); bar.appendChild(t);
  }
  const add = document.createElement('button'); add.className = 'dbtab add' + (!activeId ? ' on' : ''); add.textContent = '＋ Database';
  add.onclick = () => view(null); bar.appendChild(add);
  if (V) renderSaved();
}
async function closeSession(id) {
  const x = sessions.get(id); if (!x) return;
  clearInterval(x.syncTimer);
  try { x.ws.close(); } catch {}
  if (x.engine) { try { await x.engine.close(); } catch {} x.engine = null; }
  x.root.remove(); sessions.delete(id);
  if (activeId === id) view([...sessions.keys()].pop() || null); else renderBar();
}

const persist = () => saveVault(VK, V);

function ask(label, secret = false) {
  return new Promise(res => {
    const inp = $('askInput');
    show('askRow'); inp.type = secret ? 'password' : 'text'; inp.autocomplete = secret ? 'current-password' : 'one-time-code';
    inp.value = ''; inp.placeholder = label; inp.focus();
    const done = () => { const v = inp.value; $('askBtn').onclick = null; inp.onkeydown = null; inp.value = ''; inp.type = 'text'; show('askRow', false); res(secret ? v : v.trim()); };
    $('askBtn').onclick = done;
    $('askInput').onkeydown = e => { if (e.key === 'Enter') done(); };
  });
}

/* ───────── unlock / login ───────── */
async function unlock() {
  try { const r = await loadVault($('unlockPass').value); V = r.data; VK = r.vk; }
  catch (e) { return log(errMsg(e), 'er'); }
  if ($('rememberUnlock').checked) await rememberDevice(VK).catch(() => {}); else await forgetDevice().catch(() => {});
  show('c-unlock', false);
  await startClient();
}

async function login() {
  const apiId = parseInt($('apiId').value, 10), apiHash = $('apiHash').value.trim(), pass = $('newPass').value;
  if (!apiId || !apiHash) return log('Isi api_id dan api_hash.', 'er');
  if (pass.length < 8) return log('Passphrase minimal 8 karakter.', 'er');
  V = { apiId, apiHash, name: $('name').value.trim() || 'anon', session: '', dbs: {} };
  VK = await newVaultKey(pass);
  $('btnLogin').disabled = true;
  try { await startClient(); if (client && $('rememberLogin').checked) await rememberDevice(VK).catch(() => {}); } finally { $('btnLogin').disabled = false; }
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
    const label = document.createElement('span'); label.textContent = (sessions.has(id) ? '● ' : '') + (d.title || id);
    const open = document.createElement('button'); open.className = 'sec small'; open.textContent = sessions.has(id) ? 'Lihat' : 'Buka';
    open.onclick = () => connectString(d.conn, id).catch(e => log('Gagal: ' + errMsg(e), 'er'));
    const del = document.createElement('button'); del.className = 'sec small'; del.textContent = 'Lupakan';
    del.onclick = async () => { await closeSession(id); delete V.dbs[id]; await persist(); renderSaved(); };
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

async function connectString(str, savedId = null) {
  const m = CONN_RE.exec(str.trim());
  if (!m) throw new Error('Format harus tgpg://INVITE#KUNCI');
  let chat = null;
  if (savedId) {   // sudah anggota: tak perlu link undangan
    try {
      const r = await findChat(client, savedId, V.dbs?.[savedId]?.title);
      chat = r.chat;
      if (!chat) log('Grup tidak ada di daftar chat akun ini. Grup TGPG yang terlihat: ' + (r.titles.join(', ') || '(tidak ada)'), 'er');
    } catch (e) { log('Gagal membaca daftar chat: ' + errMsg(e), 'er'); }
  }
  if (!chat) {
    try { chat = await resolveInvite(client, m[1]); }
    catch (e) {
      if (/INVITE_HASH_(EXPIRED|INVALID)/.test(errMsg(e)))
        throw new Error('Link undangan sudah kedaluwarsa/dicabut dan grup ini tidak ada di akun ini. Minta connection string baru dari pemilik database.');
      throw e;
    }
  }
  await openDatabase(chat, b64u.dec(m[2]), `tgpg://${m[1]}#${m[2]}`);
}

async function openDatabase(chat, rawKey, conn) {
  const dbId = String(chat.id);
  if (sessions.has(dbId)) return view(dbId);
  if (!(await acquireLock('tgpg-db-' + dbId))) return log('Database ini sedang terbuka di tab lain.', 'er');
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
  if (!V.identity) { const id = await genIdentity(); V.identity = { jwk: id.jwk, pub: id.pub }; await persist(); }
  const identity = await loadIdentity(V.identity);
  V.dbs = V.dbs || {};
  const rec = V.dbs[dbId] = { ...(V.dbs[dbId] || {}), conn, title: (chat.title || '').replace(/^TGPG · /, '') || dbId };
  log('Membuka database ' + rec.title + '…');
  const root = document.createElement('div'); $('c-work').appendChild(root);
  const sess = { dbId, chat, rawKey, conn, engine: null, root, syncTimer: null };
  sess.ws = makeWs(sess, root);
  try {
    sess.engine = await Engine.open({
      transport: new TelegramTransport(client, chat), key, createDb, hasLocal: !!LS.get(initKey),
      author: V.name, log, identity, keys: rec.keys, onKeys: k => { rec.keys = k; persist().catch(() => {}); },
    });
    LS.set(initKey, '1');
    const { engine, ws } = sess;
    engine.onApplied = n => ws.notifyApplied(n);
    engine.onSync = (ok, err) => ws.setSyncState(ok, err);
    engine.onBlocked = b => ws.setBlocked(b);
    ws.setBlocked(engine.blocked);
    sess.syncTimer = setInterval(() => engine.sync(), 15000);   // jaga-jaga bila ada update yang terlewat
    sessions.set(dbId, sess);
    await persist();
    await ws.open({ engine, dbId, title: rec.title });
    engine.onApplied(engine.lastApplied);
    view(dbId);
    log('Database ' + rec.title + ' siap. Posisi log #' + engine.lastApplied, 'ok');
  } catch (e) {
    clearInterval(sess.syncTimer); sessions.delete(dbId); root.remove();
    if (sess.engine) { try { await sess.engine.close(); } catch {} }
    throw e;
  }
}

async function resetLocal(sess) {
  if (!confirm('Hapus salinan lokal dan bangun ulang dari Telegram?')) return;
  const { chat, rawKey, conn, dbId } = sess;
  await closeSession(dbId);
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
const resync = () => { if (navigator.onLine !== false) for (const x of sessions.values()) x.engine?.sync(); };
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

if (hasVault()) {
  unlockWithDevice().then(async r => {
    if (r) { V = r.data; VK = r.vk; await startClient(); } else show('c-unlock');
  });
} else show('c-login');
if (!window.isSecureContext) log('Halaman harus dibuka lewat HTTPS (atau localhost).', 'er');

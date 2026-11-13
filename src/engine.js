// Engine: PGlite lokal + log op terenkripsi yang disimpan di sebuah "transport" (Telegram, atau memori untuk tes).
//
// Transport:
//   listAfter(id, limit) -> [{id, text, hasFile, download(): Uint8Array}]  (urut naik, semua pesan dengan id > id)
//   sendText(text) -> id          sendFile(bytes, caption) -> id
//   findSnapshot() -> {id, text, download} | null
//   subscribe(cb) -> unsubscribe  (cb dipanggil saat ada pesan baru)
import { encrypt, decrypt, b64, importKey, randomKeyBytes, wrapFor, unwrap } from './crypto.js';
import { rewrite, isRead } from './sql.js';

export const OP_PREFIX = 'TGPG1 ';   // legacy (epoch 0)
export const OP2 = 'TGPG2 ';          // TGPG2 <epoch> <base64>
export const CTL = 'TGPG-CTL';        // pesan kontrol: hello (daftar anggota) & keys (rotasi/persetujuan)
export const OP_FILE = 'TGPG-OP';
export const SNAP = 'TGPG-SNAP';
const TEXT_LIMIT = 2800;            // plaintext maks sebagai pesan teks (base64 + overhead < 4096)
const MAX_OP = 8 * 1024 * 1024;     // batas ukuran satu op
const BATCH = 100;
const SEEN_KEEP = 5000;              // op lama (selisih id pesan) dilupakan dari tabel dedupe
const SEND_TRIES = 3;

// Fungsi deterministik: nilainya diturunkan dari (timestamp op, id pesan, counter) sehingga sama di semua klien.
export const INIT_SQL = `
create table if not exists _tgpg_meta(k text primary key, v bigint not null);
insert into _tgpg_meta values ('last', 0) on conflict do nothing;
create table if not exists _tgpg_seen(oid text primary key, msg bigint not null);   -- dedupe op (retry kirim)
create table if not exists _tgpg_ctl(k text primary key, v text not null);            -- owner, epoch
create table if not exists _tgpg_member(sid text primary key, pub text not null default '', name text not null default '', status text not null);
create or replace function tg_now() returns timestamptz language sql volatile as
$$ select coalesce(nullif(current_setting('tgpg.ts', true), '')::timestamptz, now()) $$;
create or replace function tg_uuid() returns uuid language plpgsql volatile as
$$ declare n int; s text;
begin
  s := current_setting('tgpg.seed', true);
  if s is null or s = '' then return gen_random_uuid(); end if;
  n := coalesce(nullif(current_setting('tgpg.n', true), ''), '0')::int + 1;
  perform set_config('tgpg.n', n::text, true);
  return md5(s || ':' || n::text)::uuid;
end $$;
create or replace function tg_random() returns double precision language plpgsql volatile as
$$ declare n int; s text;
begin
  s := current_setting('tgpg.seed', true);
  if s is null or s = '' then return random(); end if;
  n := coalesce(nullif(current_setting('tgpg.n', true), ''), '0')::int + 1;
  perform set_config('tgpg.n', n::text, true);
  return (('x' || substr(md5(s || ':r:' || n::text), 1, 8))::bit(32)::bigint)::double precision / 4294967296.0;
end $$;
`;

class Blocked extends Error { constructor(epoch) { super('butuh kunci epoch ' + epoch); this.epoch = epoch; } }

export class Engine {
  constructor({ transport, key, db, author, cid, log, snapshotEvery, identity, selfId, onKeys }) {
    this.transport = transport; this.key = key; this.db = db;
    this.identity = identity || null; this.selfId = selfId || ''; this.onKeys = onKeys || null;
    this.ring = new Map();        // epoch (>=1) -> CryptoKey; epoch 0 = this.key (dari connection string)
    this.ringRaw = {};            // epoch -> base64 kunci mentah (untuk disimpan di vault)
    this.myEpoch = 0; this.dbEpoch = 0; this.owner = ''; this.members = new Map();
    this.blocked = null; this.scanPos = undefined; this.onBlocked = null;
    this.author = author || 'anon'; this.cid = cid || crypto.randomUUID();
    this.log = log || (() => {}); this.snapshotEvery = snapshotEvery ?? 50;
    this.chain = Promise.resolve();
    this.results = new Map();     // id pesan -> hasil op milik sendiri
    this.waiters = new Map();     // id pesan -> resolve
    this.lastApplied = 0; this.lastOp = 0; this.lastSnapOp = 0; this.myWrites = 0;   // lastOp = id op terakhir (pesan snapshot tidak dihitung)
    this.decryptErrors = 0;
    this.byOid = new Map();       // oid -> hasil penerapan pertama op milik sendiri
    this.onSync = null;           // callback(ok, error) setelah tiap sinkron
    this.warnedEdited = new Set();
    this.onApplied = null;        // callback(lastApplied)
  }

  /** createDb(blob|null) -> PGlite. hasLocal: sudah ada salinan lokal yang valid (jangan restore snapshot).
   *  identity: {priv,pub} ECDH anggota (untuk rotasi kunci); keys: {epoch: base64} kunci hasil rotasi yang sudah dimiliki. */
  static async open({ transport, key, createDb, hasLocal, author, cid, log = () => {}, snapshotEvery, identity, keys, onKeys }) {
    const selfId = transport.selfId ? await transport.selfId() : '';
    const e = new Engine({ transport, key, db: null, author, cid, log, snapshotEvery, identity, selfId, onKeys });
    for (const [ep, k] of Object.entries(keys || {})) await e._addKey(Number(ep), k, false);
    let db = null;
    if (!hasLocal) {
      const snap = await transport.findSnapshot();
      if (snap) {
        try {
          const se = Number(/\be=(\d+)/.exec(snap.text || '')?.[1] ?? 0);
          if (se > 0 && !e._keyFor(se)) await e._scanKeys(0);
          const k = e._keyFor(se);
          if (!k) throw new Error('belum punya kunci epoch ' + se);
          const raw = await decrypt(k, await snap.download());
          db = await createDb(new Blob([raw]));
          log(`Snapshot #${snap.id} dipulihkan.`, 'ok');
        } catch (err) { log(`Snapshot tidak bisa dipakai (${err.message}); replay dari awal.`, 'er'); db = null; }
      }
    }
    if (!db) db = await createDb(null);
    e.db = db;
    await db.exec(INIT_SQL);
    e.lastApplied = Number((await db.query(`select v from _tgpg_meta where k='last'`)).rows[0].v);
    e.lastOp = e.lastApplied;
    await e._loadCtl();
    if (e.dbEpoch > e.myEpoch) await e._scanKeys(0);      // kunci hasil rotasi hilang dari vault: ambil ulang dari log
    await e.sync();
    await e._ensureHello();
    e.unsub = transport.subscribe(() => { e.sync(); });
    return e;
  }

  serial(fn) {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => {});
    return p;
  }

  sync() {
    return this.serial(() => this._catchUp()).then(
      () => { if (this.onSync) this.onSync(true); },
      e => { this.log('Sync gagal: ' + (e.message || e), 'er'); if (this.onSync) this.onSync(false, e); });
  }

  async _catchUp() {
    for (;;) {
      const msgs = (await this.transport.listAfter(this.lastApplied, BATCH))
        .filter(m => m.id > this.lastApplied).sort((a, b) => a.id - b.id);
      if (!msgs.length) break;
      for (const m of msgs) {
        try { await this._apply(m); }
        catch (err) {
          if (err instanceof Blocked) {   // belum punya kunci epoch ini: berhenti di sini, coba lagi nanti
            if (!this.blocked || this.blocked.epoch !== err.epoch) this.log(`Menunggu persetujuan owner (butuh kunci epoch ${err.epoch}).`, 'er');
            this.blocked = { epoch: err.epoch, at: m.id };
            if (this.onBlocked) this.onBlocked(this.blocked);
            if (this.onApplied) this.onApplied(this.lastApplied);
            return;
          }
          throw err;
        }
      }
      if (msgs.length < BATCH) break;
    }
    if (this.blocked) { this.blocked = null; this.scanPos = undefined; if (this.onBlocked) this.onBlocked(null); }
    if (this.onApplied) this.onApplied(this.lastApplied);
  }

  /* ───────── kunci, anggota, rotasi ───────── */

  _keyFor(epoch) { return epoch === 0 ? this.key : (this.ring.get(epoch) || null); }

  async _addKey(epoch, b64key, persist = true) {
    if (!(epoch >= 1) || this.ring.has(epoch)) return false;
    this.ring.set(epoch, await importKey(b64.dec(b64key)));
    this.ringRaw[epoch] = b64key; this.myEpoch = Math.max(this.myEpoch, epoch);
    if (persist && this.onKeys) this.onKeys({ ...this.ringRaw });
    return true;
  }

  async _loadCtl() {
    const c = new Map((await this.db.query('select k, v from _tgpg_ctl')).rows.map(r => [r.k, r.v]));
    this.owner = c.get('owner') || ''; this.dbEpoch = Number(c.get('epoch') || 0);
    this.members = new Map((await this.db.query('select sid, pub, name, status from _tgpg_member')).rows.map(r => [r.sid, r]));
  }

  async _readCtl(m) {
    try {
      const txt = m.hasFile ? new TextDecoder().decode(await m.download()) : (m.text || '').slice(CTL.length + 1);
      const o = JSON.parse(txt); return o && typeof o === 'object' ? o : null;
    } catch { return null; }
  }

  /** Buka pembungkus kunci untuk diri sendiri dari pesan 'keys' milik owner. true bila dapat kunci baru. */
  async _takeKeys(ctl) {
    const w = ctl.wraps && ctl.wraps[this.selfId];
    if (!w || !this.identity) return false;
    let got = false;
    try {
      const ring = JSON.parse(new TextDecoder().decode(await unwrap(this.identity.priv, w)));
      for (const [ep, k] of Object.entries(ring)) got = (await this._addKey(Number(ep), k)) || got;
    } catch (err) { this.log('Gagal membuka kunci rotasi: ' + err.message, 'er'); }
    return got;
  }

  /** Pindai log ke depan mencari pesan 'keys' untuk diri sendiri (tidak menerapkan op). */
  async _scanKeys(from) {
    if (!this.identity) return false;
    let pos = from ?? this.scanPos ?? this.lastApplied, owner = this.owner, got = false;
    for (;;) {
      const msgs = (await this.transport.listAfter(pos, BATCH)).filter(m => m.id > pos).sort((a, b) => a.id - b.id);
      if (!msgs.length) break;
      for (const m of msgs) {
        pos = m.id; const t = m.text || '';
        if (!owner && t.startsWith('TGPG')) owner = m.sender || '';
        if (t.startsWith(CTL) && (m.sender || '') === owner) {
          const ctl = await this._readCtl(m);
          if (ctl && ctl.t === 'keys') got = (await this._takeKeys(ctl)) || got;
        }
      }
      if (msgs.length < BATCH) break;
    }
    this.scanPos = pos; return got;
  }

  get isOwner() { return !!this.selfId && this.selfId === this.owner; }

  /** Boleh menulis? (setelah rotasi: hanya owner & anggota aktif yang memegang kunci terbaru) */
  _senderOk(sid) {
    if (this.dbEpoch === 0 || sid === this.owner) return true;
    return this.members.get(sid)?.status === 'active';
  }

  memberList() {
    const list = [...this.members.values()].map(m => ({ ...m, owner: m.sid === this.owner, me: m.sid === this.selfId }));
    if (this.owner && !this.members.has(this.owner)) list.unshift({ sid: this.owner, pub: '', name: '', status: 'active', owner: true, me: this.owner === this.selfId });
    return list;
  }

  async _ensureHello() {
    if (!this.identity || !this.selfId) return;
    const me = this.members.get(this.selfId);
    if (me && (me.pub === this.identity.pub || me.status === 'removed')) return;
    try { await this._sendCtl({ t: 'hello', pub: this.identity.pub, name: this.author }); }
    catch (err) { this.log('Gagal mendaftarkan identitas: ' + err.message, 'er'); }
  }

  async _sendCtl(obj) {
    const json = JSON.stringify(obj);
    const id = await this._send(() => json.length <= 3500
      ? this.transport.sendText(CTL + ' ' + json)
      : this.transport.sendFile(new TextEncoder().encode(json), CTL));
    await this._waitApplied(id, 30000);
    return id;
  }

  /** Owner: beri anggota 'pending' akses ke seluruh kunci yang ada. */
  async approve(sid) {
    if (!this.isOwner) throw new Error('Hanya owner yang bisa menyetujui anggota.');
    const m = this.members.get(sid);
    if (!m || m.status !== 'pending') throw new Error('Anggota tidak sedang menunggu persetujuan.');
    if (!m.pub) throw new Error('Anggota belum mendaftarkan kunci publik.');
    const wraps = { [sid]: await wrapFor(m.pub, new TextEncoder().encode(JSON.stringify(this.ringRaw))) };
    await this._sendCtl({ t: 'keys', n: this.dbEpoch, wraps, remove: [] });
  }

  /** Owner: ganti kunci database; anggota di `remove` tidak menerima kunci baru dan op-nya ditolak seterusnya. */
  async rotate({ remove = [] } = {}) {
    if (!this.isOwner || !this.identity) throw new Error('Hanya owner yang bisa merotasi kunci.');
    if (this.myEpoch < this.dbEpoch) throw new Error('Owner belum memegang kunci terbaru.');
    if (remove.includes(this.owner)) throw new Error('Owner tidak bisa mencabut dirinya sendiri.');
    const n = this.dbEpoch + 1, fresh = b64.enc(randomKeyBytes());
    const ringJson = new TextEncoder().encode(JSON.stringify({ ...this.ringRaw, [n]: fresh }));
    const wraps = { [this.selfId]: await wrapFor(this.identity.pub, ringJson) };
    const skipped = [];
    for (const m of this.members.values()) {
      if (m.sid === this.selfId || m.status !== 'active' || remove.includes(m.sid)) continue;
      if (!m.pub) { skipped.push(m.sid); continue; }
      wraps[m.sid] = await wrapFor(m.pub, ringJson);
    }
    await this._sendCtl({ t: 'keys', n, wraps, remove });
    await this.snapshot({ force: true }).catch(err => this.log('Snapshot setelah rotasi gagal: ' + err.message, 'er'));
    return { epoch: n, kept: Object.keys(wraps).length, skipped };
  }

  async _decode(key, bytes) {
    return JSON.parse(new TextDecoder().decode(await decrypt(key, bytes)));
  }

  async _setLast(id) { await this.db.query(`update _tgpg_meta set v=$1 where k='last'`, [id]); }

  async _apply(m) {
    const text = m.text || '', sender = m.sender || '';
    if (!this.owner && text.startsWith('TGPG')) {           // pengirim pesan TGPG pertama di log = owner
      this.owner = sender;
      await this.db.query(`insert into _tgpg_ctl values ('owner', $1) on conflict do nothing`, [sender]);
    }
    if (text.startsWith(CTL)) { await this._applyCtl(m); this.lastApplied = m.id; return; }

    let op = null, epoch = 0, enc = null, skip = null;
    if (!m.hasFile && text.startsWith(OP2)) {
      const rest = text.slice(OP2.length), sp = rest.indexOf(' ');
      epoch = Number(rest.slice(0, sp)); enc = () => b64.dec(rest.slice(sp + 1));
    } else if (!m.hasFile && text.startsWith(OP_PREFIX)) enc = () => b64.dec(text.slice(OP_PREFIX.length));
    else if (m.hasFile && text.startsWith(OP_FILE)) { epoch = Number(/\be=(\d+)/.exec(text)?.[1] ?? 0); enc = () => m.download(); }

    if (enc) {
      if (!this._senderOk(sender)) skip = 'pengirim tidak berwenang (belum disetujui / dicabut)';
      else {
        let key = this._keyFor(epoch);
        if (!key && epoch > 0 && await this._scanKeys()) key = this._keyFor(epoch);
        if (!key) throw new Blocked(epoch);
        try { op = await this._decode(key, await enc()); }
        catch (e) {
          this.decryptErrors++;
          this.log(`#${m.id}: op tidak bisa dibuka (kunci salah / pesan rusak)`, 'er');
        }
      }
    }
    if (skip) this.log(`#${m.id} dilewati: ${skip}`, 'er');

    if (m.edited && !this.warnedEdited.has(m.id)) {
      this.warnedEdited.add(m.id);
      this.log(`#${m.id} pernah diedit di Telegram; salinan lain bisa berbeda. Gunakan "Reset lokal" bila data tampak tidak sama.`, 'er');
    }

    if (op && op.v === 1 && typeof op.sql === 'string') {
      const t = Number.isNaN(Date.parse(op.t)) ? '1970-01-01T00:00:00Z' : new Date(op.t).toISOString();
      let res;
      try {
        await this.db.transaction(async tx => {
          if (op.oid) {   // op yang sama bisa terkirim dua kali (retry setelah respons hilang): terapkan sekali saja
            const ins = await tx.query('insert into _tgpg_seen(oid, msg) values ($1, $2) on conflict do nothing returning oid', [op.oid, m.id]);
            if (!ins.rows.length) { res = { duplicate: true }; await tx.query(`update _tgpg_meta set v=$1 where k='last'`, [m.id]); return; }
          }
          await tx.query(`select set_config('tgpg.ts',$1,true), set_config('tgpg.seed',$2,true), set_config('tgpg.n','0',true)`, [t, String(m.id)]);
          res = await tx.exec(op.sql);
          if (m.id % 100 === 0) await tx.query('delete from _tgpg_seen where msg < $1', [m.id - SEEN_KEEP]);
          await tx.query(`update _tgpg_meta set v=$1 where k='last'`, [m.id]);
        });
      } catch (e) {
        // Error deterministik (mis. unique violation): semua klien gagal sama, aman dilewati.
        res = { error: e.message };
        await this._setLast(m.id);
        this.log(`#${m.id} ditolak: ${e.message}`, 'er');
      }
      this.lastOp = m.id;
      if (op.cid === this.cid) {
        this.results.set(m.id, res);
        if (op.oid && !res.duplicate) this.byOid.set(op.oid, res);
      }
      else if (!res.duplicate) this.log(`#${m.id} ${op.a || '?'}: ${op.sql.slice(0, 80).replace(/\s+/g, ' ')}`, 'mu');
    } else {
      await this._setLast(m.id);   // snapshot / pesan layanan / pesan lain
    }
    this.lastApplied = m.id;
    for (const [id, w] of this.waiters) if (id <= m.id) { this.waiters.delete(id); w.resolve(); }
  }

  async _applyCtl(m) {
    const sender = m.sender || '', ctl = await this._readCtl(m);
    let keysForMe = false;
    await this.db.transaction(async tx => {
      if (ctl && ctl.t === 'hello' && typeof ctl.pub === 'string') {
        const ex = this.members.get(sender), auto = this.dbEpoch === 0 || sender === this.owner;
        if (!(ex && (ex.status === 'removed' || ex.pub === ctl.pub)))
          await tx.query(`insert into _tgpg_member values ($1,$2,$3,$4) on conflict (sid) do update set pub=$2, name=$3, status=$4`,
            [sender, ctl.pub, String(ctl.name || '').slice(0, 60), auto ? 'active' : 'pending']);
      } else if (ctl && ctl.t === 'keys' && sender === this.owner && (ctl.n === this.dbEpoch || ctl.n === this.dbEpoch + 1)) {
        const wraps = ctl.wraps && typeof ctl.wraps === 'object' ? ctl.wraps : {};
        if (ctl.n === this.dbEpoch + 1) {
          await tx.query(`update _tgpg_member set status='pending' where status='active' and sid <> $1`, [this.owner]);
          await tx.query(`insert into _tgpg_ctl values ('epoch', $1) on conflict (k) do update set v=$1`, [String(ctl.n)]);
        }
        for (const sid of Object.keys(wraps))
          await tx.query(`insert into _tgpg_member values ($1,'','','active') on conflict (sid) do update set status='active' where _tgpg_member.status <> 'removed'`, [sid]);
        for (const sid of Array.isArray(ctl.remove) ? ctl.remove : [])
          await tx.query(`insert into _tgpg_member values ($1,'','','removed') on conflict (sid) do update set status='removed'`, [String(sid)]);
        keysForMe = true;
      }
      await tx.query(`update _tgpg_meta set v=$1 where k='last'`, [m.id]);
    });
    await this._loadCtl();
    if (keysForMe) await this._takeKeys(ctl);
    for (const [id, w] of this.waiters) if (id <= m.id) { this.waiters.delete(id); w.resolve(); }
  }

  /** Jalankan SQL: SELECT lokal (read-only), selain itu masuk log. */
  async run(sql) {
    if (isRead(sql)) return { kind: 'read', result: await this.read(sql) };
    return { kind: 'write', ...(await this.write(sql)) };
  }

  read(sql) {
    return this.serial(() => this.db.transaction(async tx => {
      await tx.exec('set transaction read only');
      return tx.exec(sql);
    }));
  }

  /** Query read-only berparameter (untuk UI: katalog, paginasi). */
  query(sql, params = []) {
    return this.serial(() => this.db.transaction(async tx => {
      await tx.exec('set transaction read only');
      return tx.query(sql, params);
    }));
  }

  async write(sql, { timeoutMs = 30000 } = {}) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Sedang offline: perubahan tidak dapat dikirim ke Telegram.');
    if (!(this._senderOk(this.selfId) && this.myEpoch >= this.dbEpoch)) throw new Error('Belum punya akses tulis: menunggu persetujuan owner database.');
    const op = { v: 1, sql: rewrite(sql), a: this.author, t: new Date().toISOString(), cid: this.cid, oid: crypto.randomUUID() };
    const plain = new TextEncoder().encode(JSON.stringify(op));
    if (plain.length > MAX_OP) throw new Error('Statement terlalu besar (maks 8 MB).');
    const epoch = this.myEpoch;
    const enc = await encrypt(this._keyFor(epoch), plain);
    const id = await this._send(() => plain.length <= TEXT_LIMIT
      ? this.transport.sendText(OP2 + epoch + ' ' + b64.enc(enc))
      : this.transport.sendFile(enc, `${OP_FILE} e=${epoch}`));
    await this._waitApplied(id, timeoutMs);
    const result = this.byOid.get(op.oid) ?? this.results.get(id);
    this.results.delete(id); this.byOid.delete(op.oid);
    if (++this.myWrites % this.snapshotEvery === 0) this.snapshot().catch(e => this.log('Snapshot otomatis gagal: ' + e.message, 'er'));
    return { id, result };
  }

  /** Kirim dengan retry untuk error jaringan sementara (aman: op punya oid, duplikat diabaikan saat diterapkan). */
  async _send(fn) {
    for (let i = 1; ; i++) {
      try { return await fn(); } catch (e) {
        const msg = `${e?.errorMessage || ''} ${e?.message || ''}`;
        const transient = !e?.errorMessage || /TIMEOUT|FLOOD|INTERNAL|RPC_CALL_FAIL|MSG_WAIT|Not connected|Connection/i.test(msg);
        if (!transient || i >= SEND_TRIES) throw e;
        this.log(`Kirim gagal (${msg.trim().slice(0, 60)}), mencoba lagi ${i}/${SEND_TRIES - 1}…`, 'er');
        await new Promise(r => setTimeout(r, 800 * i));
      }
    }
  }

  _waitApplied(id, timeoutMs) {
    if (this.lastApplied >= id) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(`Terkirim sebagai #${id} tapi belum terkonfirmasi; akan diterapkan saat sinkron.`)); }, timeoutMs);
      this.waiters.set(id, { resolve: () => { clearTimeout(timer); resolve(); } });
      this.sync();
    });
  }

  snapshot({ force = false } = {}) {
    return this.serial(async () => {
      if (!force && this.lastOp === this.lastSnapOp) return null;   // tidak ada op baru sejak snapshot terakhir
      if (this.myEpoch < this.dbEpoch) return null;                  // belum memegang kunci terbaru
      const blob = await this.db.dumpDataDir('gzip');
      const epoch = this.myEpoch;
      const enc = await encrypt(this._keyFor(epoch), new Uint8Array(await blob.arrayBuffer()));
      const last = this.lastApplied;
      const id = await this.transport.sendFile(enc, `${SNAP} last=${last} e=${epoch}`);
      this.lastSnapOp = this.lastOp;
      this.log(`Snapshot terkirim (log #${last}, ${(enc.length / 1024).toFixed(0)} KB).`, 'ok');
      return { id, last, bytes: enc.length };
    });
  }

  async close() {
    if (this.unsub) this.unsub();
    await this.chain;
    await this.db.close();
  }
}

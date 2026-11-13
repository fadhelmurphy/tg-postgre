// Engine: PGlite lokal + log op terenkripsi yang disimpan di sebuah "transport" (Telegram, atau memori untuk tes).
//
// Transport:
//   listAfter(id, limit) -> [{id, text, hasFile, download(): Uint8Array}]  (urut naik, semua pesan dengan id > id)
//   sendText(text) -> id          sendFile(bytes, caption) -> id
//   findSnapshot() -> {id, text, download} | null
//   subscribe(cb) -> unsubscribe  (cb dipanggil saat ada pesan baru)
import { encrypt, decrypt, b64 } from './crypto.js';
import { rewrite, isRead } from './sql.js';

export const OP_PREFIX = 'TGPG1 ';
export const OP_FILE = 'TGPG-OP';
export const SNAP = 'TGPG-SNAP';
const TEXT_LIMIT = 2800;            // plaintext maks sebagai pesan teks (base64 + overhead < 4096)
const MAX_OP = 8 * 1024 * 1024;     // batas ukuran satu op
const BATCH = 100;

// Fungsi deterministik: nilainya diturunkan dari (timestamp op, id pesan, counter) sehingga sama di semua klien.
export const INIT_SQL = `
create table if not exists _tgpg_meta(k text primary key, v bigint not null);
insert into _tgpg_meta values ('last', 0) on conflict do nothing;
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

export class Engine {
  constructor({ transport, key, db, author, cid, log, snapshotEvery }) {
    this.transport = transport; this.key = key; this.db = db;
    this.author = author || 'anon'; this.cid = cid || crypto.randomUUID();
    this.log = log || (() => {}); this.snapshotEvery = snapshotEvery ?? 50;
    this.chain = Promise.resolve();
    this.results = new Map();     // id pesan -> hasil op milik sendiri
    this.waiters = new Map();     // id pesan -> resolve
    this.lastApplied = 0; this.lastOp = 0; this.lastSnapOp = 0; this.myWrites = 0;   // lastOp = id op terakhir (pesan snapshot tidak dihitung)
    this.decryptErrors = 0;
    this.onApplied = null;        // callback(lastApplied)
  }

  /** createDb(blob|null) -> PGlite. hasLocal: sudah ada salinan lokal yang valid (jangan restore snapshot). */
  static async open({ transport, key, createDb, hasLocal, author, cid, log = () => {}, snapshotEvery }) {
    let db = null;
    if (!hasLocal) {
      const snap = await transport.findSnapshot();
      if (snap) {
        try {
          const raw = await decrypt(key, await snap.download());
          db = await createDb(new Blob([raw]));
          log(`Snapshot #${snap.id} dipulihkan.`, 'ok');
        } catch (e) { log(`Snapshot tidak bisa dipakai (${e.message}); replay dari awal.`, 'er'); db = null; }
      }
    }
    if (!db) db = await createDb(null);
    await db.exec(INIT_SQL);
    const e = new Engine({ transport, key, db, author, cid, log, snapshotEvery });
    e.lastApplied = Number((await db.query(`select v from _tgpg_meta where k='last'`)).rows[0].v);
    e.lastOp = e.lastApplied;
    await e.sync();
    e.unsub = transport.subscribe(() => { e.sync(); });
    return e;
  }

  serial(fn) {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => {});
    return p;
  }

  sync() {
    return this.serial(() => this._catchUp()).catch(e => this.log('Sync gagal: ' + (e.message || e), 'er'));
  }

  async _catchUp() {
    for (;;) {
      const msgs = (await this.transport.listAfter(this.lastApplied, BATCH))
        .filter(m => m.id > this.lastApplied).sort((a, b) => a.id - b.id);
      if (!msgs.length) break;
      for (const m of msgs) await this._apply(m);
      if (msgs.length < BATCH) break;
    }
    if (this.onApplied) this.onApplied(this.lastApplied);
  }

  async _decode(bytes) {
    return JSON.parse(new TextDecoder().decode(await decrypt(this.key, bytes)));
  }

  async _setLast(id) { await this.db.query(`update _tgpg_meta set v=$1 where k='last'`, [id]); }

  async _apply(m) {
    const text = m.text || '';
    let op = null;
    try {
      if (!m.hasFile && text.startsWith(OP_PREFIX)) op = await this._decode(b64.dec(text.slice(OP_PREFIX.length)));
      else if (m.hasFile && text.startsWith(OP_FILE)) op = await this._decode(await m.download());
    } catch (e) {
      this.decryptErrors++;
      this.log(`#${m.id}: op tidak bisa dibuka (kunci salah / pesan rusak)`, 'er');
    }

    if (op && op.v === 1 && typeof op.sql === 'string') {
      const t = Number.isNaN(Date.parse(op.t)) ? '1970-01-01T00:00:00Z' : new Date(op.t).toISOString();
      let res;
      try {
        await this.db.transaction(async tx => {
          await tx.query(`select set_config('tgpg.ts',$1,true), set_config('tgpg.seed',$2,true), set_config('tgpg.n','0',true)`, [t, String(m.id)]);
          res = await tx.exec(op.sql);
          await tx.query(`update _tgpg_meta set v=$1 where k='last'`, [m.id]);
        });
      } catch (e) {
        // Error deterministik (mis. unique violation): semua klien gagal sama, aman dilewati.
        res = { error: e.message };
        await this._setLast(m.id);
        this.log(`#${m.id} ditolak: ${e.message}`, 'er');
      }
      this.lastOp = m.id;
      if (op.cid === this.cid) this.results.set(m.id, res);
      else this.log(`#${m.id} ${op.a || '?'}: ${op.sql.slice(0, 80).replace(/\s+/g, ' ')}`, 'mu');
    } else {
      await this._setLast(m.id);   // snapshot / pesan layanan / pesan lain
    }
    this.lastApplied = m.id;
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

  async write(sql, { timeoutMs = 30000 } = {}) {
    const op = { v: 1, sql: rewrite(sql), a: this.author, t: new Date().toISOString(), cid: this.cid };
    const plain = new TextEncoder().encode(JSON.stringify(op));
    if (plain.length > MAX_OP) throw new Error('Statement terlalu besar (maks 8 MB).');
    const enc = await encrypt(this.key, plain);
    const id = plain.length <= TEXT_LIMIT
      ? await this.transport.sendText(OP_PREFIX + b64.enc(enc))
      : await this.transport.sendFile(enc, OP_FILE);
    await this._waitApplied(id, timeoutMs);
    const result = this.results.get(id); this.results.delete(id);
    if (++this.myWrites % this.snapshotEvery === 0) this.snapshot().catch(e => this.log('Snapshot otomatis gagal: ' + e.message, 'er'));
    return { id, result };
  }

  _waitApplied(id, timeoutMs) {
    if (this.lastApplied >= id) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(`Terkirim sebagai #${id} tapi belum terkonfirmasi; akan diterapkan saat sinkron.`)); }, timeoutMs);
      this.waiters.set(id, { resolve: () => { clearTimeout(timer); resolve(); } });
      this.sync();
    });
  }

  snapshot() {
    return this.serial(async () => {
      if (this.lastOp === this.lastSnapOp) return null;   // tidak ada op baru sejak snapshot terakhir
      const blob = await this.db.dumpDataDir('gzip');
      const enc = await encrypt(this.key, new Uint8Array(await blob.arrayBuffer()));
      const last = this.lastApplied;
      const id = await this.transport.sendFile(enc, `${SNAP} last=${last}`);
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

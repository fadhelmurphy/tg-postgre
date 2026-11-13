// Menguji TelegramTransport + Engine terhadap klien GramJS TIRUAN (tanpa jaringan).
// Semantik meniru perilaku yang diverifikasi dari source GramJS/Telethon:
//  - getMessages biasa: terbaru dulu; {reverse:true, offsetId:N}: id > N, urut naik
//  - {search:q}: terbaru dulu, filter teks/caption
//  - sendFile(CustomFile{buffer}) -> dokumen; downloadMedia(msg) -> Buffer
//  - NewMessage(chats:[entity]) dipicu untuk semua klien (termasuk pengirim)
import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { PGlite } from '@electric-sql/pglite';
import { CustomFile } from 'telegram/client/uploads';
import { Engine } from '../src/engine.js';
import { TelegramTransport } from '../src/telegram.js';
import { importKey, randomKeyBytes } from '../src/crypto.js';

class FakeServer {
  constructor() { this.msgs = []; this.next = 1; this.clients = new Set(); this.files = new Map(); }
  add(m) { const msg = { id: this.next++, message: '', media: null, ...m }; this.msgs.push(msg); return msg; }
  broadcast(msg) { for (const c of this.clients) for (const h of c.handlers) h.cb({ message: msg }); }
}
class FakeClient {
  constructor(server) { this.s = server; this.handlers = []; server.clients.add(this); }
  async getMessages(entity, o = {}) {
    let list = [...this.s.msgs];
    if (o.search) list = list.filter(m => m.message.includes(o.search));
    if (o.reverse) { list = list.filter(m => m.id > (o.offsetId || 0)).sort((a, b) => a.id - b.id); }
    else list = list.sort((a, b) => b.id - a.id);
    return list.slice(0, o.limit ?? 1);
  }
  async sendMessage(entity, { message }) { const m = this.s.add({ message }); queueMicrotask(() => this.s.broadcast(m)); return m; }
  async sendFile(entity, { file, caption }) {
    if (!(file instanceof CustomFile) || !Buffer.isBuffer(file.buffer) || file.size !== file.buffer.length) throw new Error('CustomFile tidak valid');
    const m = this.s.add({ message: caption, media: { document: true } });
    this.s.files.set(m.id, Buffer.from(file.buffer));
    queueMicrotask(() => this.s.broadcast(m)); return m;
  }
  async downloadMedia(m) { return Buffer.from(this.s.files.get(m.id)); }
  addEventHandler(cb, event) { this.handlers.push({ cb, event }); }
  removeEventHandler(cb) { this.handlers = this.handlers.filter(h => h.cb !== cb); }
}

const memDb = blob => new PGlite(blob ? { loadDataDir: blob } : undefined);
const open = (server, key, author, extra = {}) =>
  Engine.open({ transport: new TelegramTransport(new FakeClient(server), { id: 1 }), key, createDb: memDb, hasLocal: false, author, ...extra });
const rows = async (e, q) => (await e.read(q))[0].rows;

describe('TelegramTransport + Engine (klien GramJS tiruan)', () => {
  it('dua akun konvergen lewat event realtime, termasuk pesan layanan & op file', async () => {
    const s = new FakeServer(); s.add({ message: '' });            // pesan layanan "channel created"
    const key = await importKey(randomKeyBytes());
    const a = await open(s, key, 'A'), b = await open(s, key, 'B');
    await a.write(`create table t(id uuid primary key default gen_random_uuid(), v text, at timestamptz default now())`);
    s.add({ message: '' });                                          // user joined
    await Promise.all([b.write(`insert into t(v) values ('b1')`), a.write(`insert into t(v) values ('a1')`)]);
    await a.write(`insert into t(v) values ('${'z'.repeat(9000)}')`); // > batas teks → file
    await b.sync();                                                   // event + sync tidak boleh menerapkan dua kali
    const qa = await rows(a, 'select id, length(v) n, at from t order by n'), qb = await rows(b, 'select id, length(v) n, at from t order by n');
    expect(qa).toHaveLength(3);
    expect(qb).toEqual(qa);
    expect(a.lastApplied).toBe(b.lastApplied);
    expect(s.msgs.some(m => m.media && m.message === 'TGPG-OP')).toBe(true);
    await a.close(); await b.close();
  });

  it('paginasi >100 pesan saat klien baru bergabung', async () => {
    const s = new FakeServer(); const key = await importKey(randomKeyBytes());
    const a = await open(s, key, 'A', { snapshotEvery: 100000 });
    await a.write('create table n(i int)');
    await a.write(Array.from({ length: 150 }, (_, i) => `insert into n values (${i})`).join(';'));   // 1 op multi-statement
    for (let i = 0; i < 120; i++) await a.write(`insert into n values (${1000 + i})`);
    const b = await open(s, key, 'B');                                // replay 122 pesan → butuh 2 batch
    expect((await rows(b, 'select count(*)::int c from n'))[0].c).toBe(270);
    expect(b.lastApplied).toBe(a.lastApplied);
    await a.close(); await b.close();
  });

  it('snapshot ditemukan lewat search, dipulihkan, sisa log direplay', async () => {
    const s = new FakeServer(); const key = await importKey(randomKeyBytes());
    const a = await open(s, key, 'A');
    await a.write('create table k(v int)'); await a.write('insert into k values (1)');
    const snap = await a.snapshot(); expect(snap).toBeTruthy();
    expect(await a.snapshot()).toBeNull();                            // tak ada perubahan → tidak kirim lagi
    await a.write('insert into k values (2)');
    const logs = []; const b = await open(s, key, 'B', { log: m => logs.push(m) });
    expect(logs.join('\n')).toMatch(/dipulihkan/);
    expect((await rows(b, 'select v from k order by v')).map(r => r.v)).toEqual([1, 2]);
    await a.close(); await b.close();
  });

  it('unsubscribe saat close melepas handler', async () => {
    const s = new FakeServer(); const key = await importKey(randomKeyBytes());
    const a = await open(s, key, 'A'); const c = [...s.clients][0];
    expect(c.handlers).toHaveLength(1);
    await a.close(); expect(c.handlers).toHaveLength(0);
  });
});

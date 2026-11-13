import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Engine } from '../src/engine.js';
import { importKey, randomKeyBytes } from '../src/crypto.js';
import { rewrite, isRead } from '../src/sql.js';
import { Channel } from './memory-transport.js';

const createDb = blob => new PGlite(blob ? { loadDataDir: blob } : undefined);
const open = async (ch, key, author, extra = {}) =>
  Engine.open({ transport: ch.handle(), key, createDb, hasLocal: false, author, ...extra });
const rows = async (e, sql) => (await e.read(sql))[0].rows;

describe('sql helpers', () => {
  it('rewrite mengganti fungsi non-deterministik tapi tidak menyentuh string/komentar', () => {
    const out = rewrite(`insert into t values (now(), gen_random_uuid(), 'now()', "now()") -- now()\n, random(), current_timestamp`);
    expect(out).toContain('tg_now()');
    expect(out).toContain('tg_uuid()');
    expect(out).toContain("'now()'");
    expect(out).toContain('-- now()');
    expect(out).toContain('tg_random()');
    expect(out).not.toMatch(/\bgen_random_uuid\b/);
  });
  it('isRead', () => {
    expect(isRead('select 1')).toBe(true);
    expect(isRead(" SELECT 'a;b' ")).toBe(true);
    expect(isRead('select 1; drop table x')).toBe(false);
    expect(isRead('insert into t values (1)')).toBe(false);
    expect(isRead('with a as (select 1) select * from a')).toBe(true);
    expect(isRead('with a as (insert into t values(1) returning *) select * from a')).toBe(false);
  });
});

describe('engine multi-klien', () => {
  it('dua klien konvergen, termasuk default now()/gen_random_uuid() dan pesan layanan', async () => {
    const ch = new Channel(); ch.service();
    const key = await importKey(randomKeyBytes());
    const a = await open(ch, key, 'A'), b = await open(ch, key, 'B');
    await a.write(`create table notes(id uuid primary key default gen_random_uuid(), body text, at timestamptz default now(), r double precision default random())`);
    ch.service();
    await Promise.all([
      a.write(`insert into notes(body) values ('dari A')`),
      b.write(`insert into notes(body) values ('dari B')`),
      a.write(`insert into notes(body) values ('A lagi')`),
    ]);
    await Promise.all([a.sync(), b.sync()]);
    const qa = await rows(a, 'select id, body, at, r from notes order by body');
    const qb = await rows(b, 'select id, body, at, r from notes order by body');
    expect(qa).toHaveLength(3);
    expect(qb).toEqual(qa);
    expect(new Set(qa.map(r => r.id)).size).toBe(3);   // uuid unik
    expect(a.lastApplied).toBe(b.lastApplied);
    await a.close(); await b.close();
  });

  it('error deterministik ditolak di semua klien dan log tetap lanjut', async () => {
    const ch = new Channel(); const key = await importKey(randomKeyBytes());
    const a = await open(ch, key, 'A'), b = await open(ch, key, 'B');
    await a.write('create table u(id int primary key)');
    await a.write('insert into u values (1)');
    const dup = await b.write('insert into u values (1)');
    expect(dup.result.error).toMatch(/duplicate key/);
    await b.write('insert into u values (2)');
    await a.sync();
    expect(await rows(a, 'select id from u order by id')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await rows(b, 'select id from u order by id')).toEqual([{ id: 1 }, { id: 2 }]);
    await a.close(); await b.close();
  });

  it('snapshot: klien baru memulihkan snapshot lalu replay sisa log', async () => {
    const ch = new Channel(); const key = await importKey(randomKeyBytes());
    const a = await open(ch, key, 'A');
    await a.write('create table s(n int)');
    for (let i = 0; i < 5; i++) await a.write(`insert into s values (${i})`);
    const snap = await a.snapshot();
    expect(snap.last).toBe(a.lastApplied);
    await a.write('insert into s values (100)');
    await a.write('insert into s values (101)');
    const logs = [];
    const c = await open(ch, key, 'C', { log: m => logs.push(m) });
    expect(logs.join('\n')).toMatch(/Snapshot #\d+ dipulihkan/);
    expect(await rows(c, 'select n from s order by n')).toEqual([0, 1, 2, 3, 4, 100, 101].map(n => ({ n })));
    expect(c.lastApplied).toBe(a.lastApplied);
    await a.close(); await c.close();
  });

  it('op besar dikirim sebagai file', async () => {
    const ch = new Channel(); const key = await importKey(randomKeyBytes());
    const a = await open(ch, key, 'A'), b = await open(ch, key, 'B');
    await a.write('create table big(v text)');
    const big = 'x'.repeat(20000);
    await a.write(`insert into big values ('${big}')`);
    expect(ch.msgs.some(m => m.file && m.text.startsWith('TGPG-OP'))).toBe(true);
    await b.sync();
    expect((await rows(b, 'select length(v) as n from big'))[0].n).toBe(20000);
    await a.close(); await b.close();
  });

  it('kunci salah tidak crash dan tidak mengubah data', async () => {
    const ch = new Channel();
    const k1 = await importKey(randomKeyBytes()), k2 = await importKey(randomKeyBytes());
    const a = await open(ch, k1, 'A');
    await a.write('create table w(n int)');
    const logs = [];
    const bad = await open(ch, k2, 'X', { log: m => logs.push(m) });
    expect(bad.decryptErrors).toBeGreaterThan(0);
    await expect(rows(bad, 'select * from w')).rejects.toThrow();
    await a.close(); await bad.close();
  });

  it('read tidak bisa menulis (read-only transaction)', async () => {
    const ch = new Channel(); const key = await importKey(randomKeyBytes());
    const a = await open(ch, key, 'A');
    await a.write('create table r(n int)');
    await expect(a.read('insert into r values (1)')).rejects.toThrow(/read-only/);
    await expect(a.read(`select nextval('nonexistent')`)).rejects.toThrow();
    await a.close();
  });

  it('run() mengarahkan SELECT ke lokal dan lainnya ke log', async () => {
    const ch = new Channel(); const key = await importKey(randomKeyBytes());
    const a = await open(ch, key, 'A');
    const w = await a.run('create table q(n int)');
    expect(w.kind).toBe('write');
    const before = ch.msgs.length;
    const r = await a.run('select 1 as x');
    expect(r.kind).toBe('read');
    expect(ch.msgs.length).toBe(before);   // read tidak mengirim apa pun
    await a.close();
  });
});

describe('idempotensi & ketahanan', () => {
  it('retry setelah respons hilang tidak menggandakan data (op yang sama terkirim dua kali)', async () => {
    const ch = new Channel(); const key = await importKey(randomKeyBytes());
    const a = await open(ch, key, 'A'), b = await open(ch, key, 'B');
    await a.write('create table dup(id serial primary key, v text)');
    const real = a.transport.sendText.bind(a.transport);
    let fail = true;
    a.transport.sendText = async text => { const id = await real(text); if (fail) { fail = false; throw new Error('Connection lost (respons hilang)'); } return id; };
    const r = await a.write(`insert into dup(v) values ('sekali')`);   // pesan terkirim, respons error → engine retry → pesan ke-2
    expect(ch.msgs.filter(m => m.text.startsWith('TGPG2 ')).length).toBeGreaterThanOrEqual(3);
    await Promise.all([a.sync(), b.sync()]);
    expect(await rows(a, 'select v from dup')).toEqual([{ v: 'sekali' }]);
    expect(await rows(b, 'select v from dup')).toEqual([{ v: 'sekali' }]);
    expect(r.result[0].affectedRows).toBe(1);               // hasil op pertama dikembalikan, bukan "duplicate"
    await a.close(); await b.close();
  });

  it('error permanen (mis. tidak boleh menulis) tidak di-retry', async () => {
    const ch = new Channel(); const key = await importKey(randomKeyBytes());
    const a = await open(ch, key, 'A');
    let calls = 0;
    a.transport.sendText = async () => { calls++; const e = new Error('x'); e.errorMessage = 'CHAT_WRITE_FORBIDDEN'; throw e; };
    await expect(a.write('select 1 into z')).rejects.toThrow();
    expect(calls).toBe(1);
    await a.close();
  });

  it('tabel dedupe ikut snapshot dan klien hasil restore tetap konvergen', async () => {
    const ch = new Channel(); const key = await importKey(randomKeyBytes());
    const a = await open(ch, key, 'A');
    await a.write('create table s(v int)'); await a.write('insert into s values (1)');
    await a.snapshot();
    const c = await open(ch, key, 'C');
    expect((await rows(c, 'select count(*)::int n from _tgpg_seen'))[0].n).toBeGreaterThanOrEqual(2);
    await c.write('insert into s values (2)'); await a.sync();
    expect(await rows(a, 'select v from s order by v')).toEqual(await rows(c, 'select v from s order by v'));
    await a.close(); await c.close();
  });

  it('pesan yang diedit memunculkan peringatan sekali', async () => {
    const ch = new Channel(); const key = await importKey(randomKeyBytes());
    const logs = [];
    const a = await open(ch, key, 'A', { log: m => logs.push(m) });
    await a.write('create table e(i int)');
    ch.msgs[ch.msgs.length - 1].edited = true;
    const b = await open(ch, key, 'B', { log: m => logs.push(m) });
    expect(logs.filter(l => /pernah diedit/.test(l))).toHaveLength(1);
    await a.close(); await b.close();
  });
});

describe('callback sinkron', () => {
  it('onSync(true) setelah sukses dan onSync(false, err) bila transport gagal', async () => {
    const ch = new Channel(); const key = await importKey(randomKeyBytes());
    const a = await open(ch, key, 'A'); const calls = [];
    a.onSync = (ok, err) => calls.push([ok, err?.message]);
    await a.sync();
    const real = a.transport.listAfter.bind(a.transport);
    a.transport.listAfter = async () => { throw new Error('jaringan putus'); };
    await a.sync();
    a.transport.listAfter = real; await a.sync();
    expect(calls).toEqual([[true, undefined], [false, 'jaringan putus'], [true, undefined]]);
    await a.close();
  });
});

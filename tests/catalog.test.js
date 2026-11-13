import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Engine } from '../src/engine.js';
import { importKey, randomKeyBytes } from '../src/crypto.js';
import { loadCatalog, loadIndexes, fetchPage, fetchAll, toCSV, toJSON, fmt, qi, ql, buildInsert, buildUpdate, buildDelete } from '../src/ui/catalog.js';
import { Channel } from './memory-transport.js';

const open = async () => {
  const ch = new Channel(); const key = await importKey(randomKeyBytes());
  return Engine.open({ transport: ch.handle(), key, createDb: b => new PGlite(b ? { loadDataDir: b } : undefined), hasLocal: false, author: 'T' });
};

describe('catalog', () => {
  it('daftar schema/tabel/kolom/PK/default, menyembunyikan objek internal TGPG', async () => {
    const e = await open();
    await e.write(`create table notes(id uuid primary key default gen_random_uuid(), body text not null, n int default 5)`);
    await e.write(`create schema app; create table app.items(a int, b text); create view app.v as select * from app.items`);
    await e.write(`create function plus1(x int) returns int language sql as $$ select x+1 $$`);
    const cat = await loadCatalog(e);
    expect([...cat.keys()].sort()).toEqual(['app', 'public']);
    const names = cat.get('public').tables.map(t => t.name);
    expect(names).toEqual(['notes']);                          // _tgpg_meta tersembunyi
    const notes = cat.get('public').tables[0];
    expect(notes.cols.map(c => c.name)).toEqual(['id', 'body', 'n']);
    expect(notes.cols[0].pk).toBe(true);
    expect(notes.cols[1].pk).toBe(false);
    expect(notes.cols[1].notnull).toBe(true);
    expect(notes.cols[0].def).toContain('tg_uuid');            // default sudah deterministik
    expect(cat.get('app').tables.map(t => `${t.name}:${t.kind}`).sort()).toEqual(['items:r', 'v:v']);
    expect(cat.get('public').funcs.map(f => f.name)).toEqual(['plus1']);   // tg_* tersembunyi
    const idx = await loadIndexes(e, 'public', 'notes');
    expect(idx.map(i => i.indexname)).toEqual(['notes_pkey']);
    await e.close();
  });

  it('fetchPage: paginasi, sort, filter, error filter', async () => {
    const e = await open();
    await e.write('create table "Weird Name"(id int primary key, v text)');
    await e.write(`insert into "Weird Name" select g, 'v' || g from generate_series(1, 120) g`);
    const p0 = await fetchPage(e, { schema: 'public', name: 'Weird Name', limit: 50, offset: 0, orderBy: 'id' });
    expect(p0.total).toBe(120); expect(p0.rows).toHaveLength(50); expect(p0.rows[0].id).toBe(1);
    const p2 = await fetchPage(e, { schema: 'public', name: 'Weird Name', limit: 50, offset: 100, orderBy: 'id', dir: 'desc' });
    expect(p2.rows).toHaveLength(20); expect(p2.rows[0].id).toBe(20);
    const f = await fetchPage(e, { schema: 'public', name: 'Weird Name', where: 'id > 100' });
    expect(f.total).toBe(20);
    await expect(fetchPage(e, { schema: 'public', name: 'Weird Name', where: 'id > 1; drop table x' })).rejects.toThrow(/;/);
    await expect(fetchPage(e, { schema: 'public', name: 'Weird Name', where: 'nope = 1' })).rejects.toThrow();
    const all = await fetchAll(e, { schema: 'public', name: 'Weird Name', where: 'id <= 3', orderBy: 'id' });
    expect(all.rows.map(r => r.id)).toEqual([1, 2, 3]);
    await e.close();
  });

  it('CSV/JSON/fmt menangani null, quote, newline, tanggal, bigint', () => {
    const fields = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    const rows = [{ a: 1, b: 'x,"y"\nz', c: null }, { a: 10n, b: new Date('2026-01-02T03:04:05Z'), c: { k: 1 } }];
    expect(toCSV(fields, rows)).toBe('a,b,c\r\n1,"x,""y""\nz",\r\n10,2026-01-02T03:04:05.000Z,"{""k"":1}"');
    expect(JSON.parse(toJSON(fields, rows))[1].a).toBe('10');
    expect(fmt(new Uint8Array([1, 255]))).toBe('\\x01ff');
    expect(qi('a"b')).toBe('"a""b"');
  });

  it('engine.query berparameter & read-only', async () => {
    const e = await open();
    const r = await e.query('select $1::int + 1 as x', [41]);
    expect(r.rows[0].x).toBe(42);
    await expect(e.query('create table z(i int)')).rejects.toThrow(/read-only/);
    await e.close();
  });
});

describe('builder edit baris', () => {
  const rowsOf = async (e, q) => (await e.read(q))[0].rows;
  const tableOf = async (e, name) => (await loadCatalog(e)).get('public').tables.find(t => t.name === name);

  it('insert/update/delete dengan PK uuid, kutip, NULL, dan default DB', async () => {
    const e = await open();
    await e.write(`create table people(id uuid primary key default gen_random_uuid(), name text not null, note text, age int default 18, born timestamptz default now())`);
    const t = await tableOf(e, 'people'); const cols = t.cols;
    expect(ql("O'Reilly")).toBe("'O''Reilly'");
    const ins = buildInsert('public', 'people', cols, { name: { mode: 'value', v: "O'Reilly; drop table people;--" }, note: { mode: 'null' }, age: { mode: 'default' } });
    const r1 = await e.write(ins); expect(r1.result[0].affectedRows).toBe(1);
    const page = await fetchPage(e, { schema: 'public', name: 'people', pkCols: ['id'] });
    expect(page.fields.map(f => f.name)).toEqual(['id', 'name', 'note', 'age', 'born']);   // __pk0 disembunyikan
    const row = page.rows[0];
    expect(row.name).toBe("O'Reilly; drop table people;--"); expect(row.note).toBeNull(); expect(row.age).toBe(18);
    const upd = buildUpdate('public', 'people', cols, ['id'], [row.__pk0], { note: { mode: 'value', v: 'baru' }, age: { mode: 'value', v: '30' } });
    const r2 = await e.write(upd); expect(r2.result[0].affectedRows).toBe(1);
    expect((await rowsOf(e, 'select note, age from people'))[0]).toEqual({ note: 'baru', age: 30 });
    const r3 = await e.write(buildDelete('public', 'people', cols, ['id'], [row.__pk0]));
    expect(r3.result[0].affectedRows).toBe(1);
    expect(await rowsOf(e, 'select count(*)::int n from people')).toEqual([{ n: 0 }]);
    await e.close();
  });

  it('PK komposit dan timestamp mikrodetik (presisi tidak hilang lewat JS Date)', async () => {
    const e = await open();
    await e.write(`create table ev(tenant int, at timestamptz, v text, primary key (tenant, at))`);
    await e.write(`insert into ev values (1, '2026-01-02 03:04:05.123456+00', 'a'), (1, '2026-01-02 03:04:05.123457+00', 'b'), (2, '2026-01-02 03:04:05.123456+00', 'c')`);
    const t = await tableOf(e, 'ev');
    const page = await fetchPage(e, { schema: 'public', name: 'ev', pkCols: ['tenant', 'at'], orderBy: 'v' });
    const b = page.rows.find(r => r.v === 'b');
    await e.write(buildUpdate('public', 'ev', t.cols, ['tenant', 'at'], [b.__pk0, b.__pk1], { v: { mode: 'value', v: 'B2' } }));
    expect((await rowsOf(e, 'select v from ev order by v')).map(r => r.v)).toEqual(['B2', 'a', 'c']);   // hanya baris b yang berubah
    await e.write(buildDelete('public', 'ev', t.cols, ['tenant', 'at'], [b.__pk0, b.__pk1]));
    expect((await rowsOf(e, 'select v from ev order by v')).map(r => r.v)).toEqual(['a', 'c']);
    await e.close();
  });

  it('kesalahan tampil sebagai error hasil (bukan crash) dan tanpa PK ditolak builder', async () => {
    const e = await open();
    await e.write('create table nopk(a int)'); await e.write('create table k(id int primary key, n int not null)');
    const t = await tableOf(e, 'k');
    const bad = await e.write(buildInsert('public', 'k', t.cols, { id: { mode: 'value', v: '1' }, n: { mode: 'null' } }));
    expect(bad.result.error).toMatch(/not-null/);
    const nan = await e.write(buildInsert('public', 'k', t.cols, { id: { mode: 'value', v: 'abc' }, n: { mode: 'value', v: '1' } }));
    expect(nan.result.error).toMatch(/invalid input syntax/);
    const np = await tableOf(e, 'nopk');
    expect(() => buildDelete('public', 'nopk', np.cols, [], [])).toThrow(/primary key/);
    expect(() => buildUpdate('public', 'k', t.cols, ['id'], ['1'], {})).toThrow(/Tidak ada perubahan/);
    expect(buildInsert('public', 'k', t.cols, {})).toBe('insert into "public"."k" default values');
    await e.close();
  });

  it('dua klien mengedit baris berbeda secara bersamaan tanpa saling menimpa', async () => {
    const ch = new Channel(); const key = await importKey(randomKeyBytes());
    const mk = a => Engine.open({ transport: ch.handle(), key, createDb: b => new PGlite(b ? { loadDataDir: b } : undefined), hasLocal: false, author: a });
    const a = await mk('A'), b = await mk('B');
    await a.write('create table r(id int primary key, x text, y text)'); await a.write(`insert into r values (1,'x0','y0')`);
    const t = await tableOf(a, 'r');
    await Promise.all([
      a.write(buildUpdate('public', 'r', t.cols, ['id'], ['1'], { x: { mode: 'value', v: 'dari A' } })),
      b.write(buildUpdate('public', 'r', t.cols, ['id'], ['1'], { y: { mode: 'value', v: 'dari B' } })),
    ]);
    await Promise.all([a.sync(), b.sync()]);
    expect(await rowsOf(a, 'select x, y from r')).toEqual([{ x: 'dari A', y: 'dari B' }]);   // update per-kolom: tidak ada lost update antar kolom
    expect(await rowsOf(b, 'select x, y from r')).toEqual(await rowsOf(a, 'select x, y from r'));
    await a.close(); await b.close();
  });
});

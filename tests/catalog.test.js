import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Engine } from '../src/engine.js';
import { importKey, randomKeyBytes } from '../src/crypto.js';
import { loadCatalog, loadIndexes, fetchPage, fetchAll, toCSV, toJSON, fmt, qi } from '../src/ui/catalog.js';
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

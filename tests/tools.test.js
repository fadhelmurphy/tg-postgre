import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { parseCSV, parseJSONRows, buildImport, guessMapping, dumpTable, dumpAll, orderTables } from '../src/ui/tools.js';
import { loadAllFks } from '../src/ui/ddl.js';
import { loadCatalog } from '../src/ui/catalog.js';

const wrap = db => ({ query: (s, p) => db.query(s, p), read: s => db.exec(s) });

describe('csv/json', () => {
  it('parseCSV: kutip, escape, CRLF, BOM, delimiter otomatis', () => {
    expect(parseCSV('﻿a,b\r\n1,"x,y"\r\n"he said ""hi""",\n')).toEqual([['a', 'b'], ['1', 'x,y'], ['he said "hi"', '']]);
    expect(parseCSV('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCSV('a\tb\n"l1\nl2"\t2')).toEqual([['a', 'b'], ['l1\nl2', '2']]);
    expect(() => parseCSV('a,"b')).toThrow(/kutip/);
    expect(parseCSV('')).toEqual([]);
  });
  it('parseJSONRows', () => {
    const r = parseJSONRows('[{"a":1,"b":{"x":1}},{"a":null,"c":"z"}]');
    expect(r.header).toEqual(['a', 'b', 'c']);
    expect(r.rows).toEqual([['1', '{"x":1}', null], [null, null, 'z']]);
    expect(() => parseJSONRows('{"a":1}')).toThrow(/array/);
    expect(() => parseJSONRows('x')).toThrow(/JSON/);
  });
});

describe('import & dump', () => {
  it('import CSV lalu dump → restore identik (termasuk tipe sulit)', async () => {
    const db = new PGlite(); const e = wrap(db);
    await db.exec(`create table p(id serial primary key, name text);
      create table t(id bigint generated always as identity primary key, p int references p(id), n numeric(10,2), j jsonb, a text[], b bytea, ts timestamptz, note text default 'd')`);
    const csv = parseCSV('name\nana\n"b,b"\n');
    for (const q of buildImport('public', 'p', guessMapping(csv[0], [{ name: 'id' }, { name: 'name' }]), csv.slice(1))) await db.exec(q);
    await db.exec(`insert into t(p,n,j,a,b,ts,note) values (1, 1.50, '{"k":[1,2]}', '{"x y","z\\"q"}', '\\xdeadbeef', '2020-01-02 03:04:05+00', null), (2, null, null, null, null, null, 'it''s')`);

    const sql = await dumpAll(e, await loadCatalog(e), await loadAllFks(e));
    expect(sql.indexOf('CREATE TABLE "public"."p"')).toBeLessThan(sql.indexOf('CREATE TABLE "public"."t"'));
    const db2 = new PGlite(); await db2.exec(sql);
    const snap = async d => JSON.stringify([(await d.query('select id::text, name from p order by id')).rows, (await d.query('select id::text, p, n::text, j::text, a::text, encode(b,\'hex\') h, ts::text, note from t order by id')).rows]);
    expect(await snap(db2)).toBe(await snap(db));
    await db2.exec("insert into p(name) values ('baru')");   // sequence ikut dipulihkan
    expect((await db2.query("select id from p where name='baru'")).rows[0].id).toBe(3);
    await db2.exec('insert into t(p) values (1)');
    expect((await db2.query('select max(id)::int m from t')).rows[0].m).toBe(3);

    const only = await dumpTable(e, 'public', 'p', { structure: false });
    expect(only).not.toContain('CREATE TABLE'); expect(only).toContain("'b,b'");
  });

  it('buildImport: chunk, NULL, validasi', () => {
    const rows = Array.from({ length: 1201 }, (_, i) => [String(i), i % 2 ? '' : 'x']);
    const q = buildImport('public', 't', [{ from: 0, to: 'a' }, { from: 1, to: 'b' }], rows);
    expect(q.length).toBe(3); expect(q[0]).toContain("(1, NULL)".replace('1', "'1'"));
    expect(() => buildImport('public', 't', [], rows)).toThrow();
    expect(() => buildImport('public', 't', [{ from: 0, to: 'a' }, { from: 1, to: 'a' }], rows)).toThrow(/ganda/);
    expect(orderTables([{ schema: 'public', name: 'c' }, { schema: 'public', name: 'p' }], [{ schema: 'public', table: 'c', refSchema: 'public', refTable: 'p' }]).map(x => x.name)).toEqual(['p', 'c']);
  });
});

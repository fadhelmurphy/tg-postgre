import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as D from '../src/ui/ddl.js';

const wrap = db => ({ query: (s, p) => db.query(s, p), read: s => db.exec(s) });

describe('ddl', () => {
  it('struktur, DDL bolak-balik, dan perubahan skema', async () => {
    const db = new PGlite(); const e = wrap(db);
    await db.exec(`create table parent(id serial primary key, name text not null unique);
      create table child(id bigint generated always as identity primary key, pid int not null references parent(id) on delete cascade on update set null,
        qty int check (qty > 0) default 1, tags text[], total numeric(12,2) generated always as (qty * 2) stored);
      create index child_qty_idx on child(qty);
      comment on table child is 'anak''s'; comment on column child.qty is 'jumlah';`);
    const st = await D.loadStructure(e, 'public', 'child');
    expect(st.cols.map(c => c.name)).toEqual(['id', 'pid', 'qty', 'tags', 'total']);
    expect(st.cols[0]).toMatchObject({ pk: true, identity: 'a' });
    expect(st.fks).toEqual([expect.objectContaining({ cols: ['pid'], refTable: 'parent', refCols: ['id'], onDelete: 'CASCADE', onUpdate: 'SET NULL' })]);
    expect(st.indexes.find(i => i.name === 'child_qty_idx')).toMatchObject({ unique: false, primary: false, viaConstraint: false });
    expect(st.indexes.find(i => i.primary).viaConstraint).toBe(true);

    const ddl = D.tableDDL(st);
    expect(ddl).toContain('CREATE TABLE "public"."child"');
    expect(ddl).toContain('GENERATED ALWAYS AS IDENTITY');
    expect(ddl).toContain('GENERATED ALWAYS AS (');
    // DDL harus bisa dijalankan ulang di schema lain dan menghasilkan struktur sama
    await db.exec('create schema s2; create table s2.parent(id serial primary key, name text not null unique)');
    await db.exec(ddl.replace(/"public"\."child"/g, '"s2"."child"').replace(/ON public\.child/, 'ON s2.child').replace(/child_qty_idx/g, 'child_qty_idx2').replace(/REFERENCES "?public"?\.?"?parent"?/, 'REFERENCES s2.parent'));
    const st2 = await D.loadStructure(e, 's2', 'child');
    expect(st2.cols.map(c => [c.name, c.type, c.notnull, c.identity, c.generated])).toEqual(st.cols.map(c => [c.name, c.type, c.notnull, c.identity, c.generated]));
    expect(st2.cols.find(c => c.name === 'qty').comment).toBe('jumlah');
    expect(st2.comment).toBe("anak's");

    const fks = await D.loadAllFks(e);
    expect(fks.find(f => f.table === 'child' && f.schema === 'public')).toMatchObject({ cols: ['pid'], refTable: 'parent' });

    await db.exec(D.addColumn('public', 'parent', { name: 'note', type: 'varchar(20)', def: "'x'", notnull: true }));
    await db.exec(D.renameColumn('public', 'parent', 'note', 'memo'));
    await db.exec(D.alterColumnType('public', 'parent', 'memo', 'text'));
    await db.exec(D.setDefault('public', 'parent', 'memo', ''));
    await db.exec(D.setNotNull('public', 'parent', 'memo', false));
    await db.exec(D.createIndex('public', 'parent', { cols: ['memo'], unique: true, indexName: 'parent_memo_u' }));
    await db.exec(D.addCheck('public', 'parent', "length(name) < 50", 'name_len'));
    await db.exec(D.addForeignKey('public', 'child', { cols: ['qty'], refTable: 'parent', refCols: ['id'], conName: 'child_qty_fk' }));
    const p2 = await D.loadStructure(e, 'public', 'parent');
    expect(p2.cols.find(c => c.name === 'memo')).toMatchObject({ type: 'text', notnull: false, def: null });
    expect(p2.indexes.some(i => i.name === 'parent_memo_u' && i.unique)).toBe(true);
    await db.exec(D.dropConstraint('public', 'child', 'child_qty_fk'));
    await db.exec(D.dropIndex('public', 'parent_memo_u'));
    await db.exec(D.dropColumn('public', 'parent', 'memo'));
    await db.exec(D.renameTable('public', 'parent', 'ortu'));
    await db.exec("insert into ortu(name) values ('a')");
    await db.exec(D.truncateTable('public', 'ortu', { cascade: true }));
    await db.exec(D.dropTable('public', 'ortu', { cascade: true }));
    await db.exec(D.createSchema('tmp')); await db.exec(D.dropSchema('tmp'));
  });

  it('createTable dan validasi masukan', async () => {
    const db = new PGlite();
    await db.exec(D.createTable({ name: 'x y', cols: [{ name: 'id', type: 'serial' }, { name: 'a', type: 'numeric(10,2)', def: '0', notnull: true, unique: true }], pk: ['id'] }));
    expect((await db.query(`select count(*)::int n from information_schema.columns where table_name = 'x y'`)).rows[0].n).toBe(2);
    expect(() => D.createTable({ name: 't', cols: [{ name: 'a', type: 'int; drop table x' }] })).toThrow(/Tipe/);
    expect(() => D.createTable({ name: 't', cols: [{ name: 'a', type: 'int', def: '1; drop' }] })).toThrow(/Ekspresi/);
    expect(() => D.createTable({ name: 't', cols: [{ name: 'a', type: 'int' }, { name: 'a', type: 'int' }] })).toThrow(/ganda/);
    expect(() => D.createTable({ name: 't', cols: [{ name: 'a', type: 'int' }], pk: ['b'] })).toThrow(/PK/);
    expect(() => D.addForeignKey('public', 't', { cols: ['a'], refTable: 'p', refCols: [] })).toThrow();
    expect(D.createIndex('public', 't', { cols: ['a"b'] })).toContain('"a""b"');
  });
});

describe('unrewrite', () => {
  it('fungsi internal dipetakan balik ke fungsi Postgres', () => {
    expect(D.unrewrite("tg_now()")).toBe('now()');
    expect(D.unrewrite("tg_uuid() || tg_random()::text")).toBe('gen_random_uuid() || random()::text');
    expect(D.unrewrite("'tg_now()' || tg_now()::text")).toBe("'tg_now()' || now()::text");   // string literal tidak disentuh
    expect(D.unrewrite(null)).toBe(null);
  });
});

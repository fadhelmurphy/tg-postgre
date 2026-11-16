import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { formatSQL, suggest, wordAt } from '../src/ui/editor.js';

describe('editor', () => {
  it('formatSQL: rapi, melindungi string/komentar/dollar-quote, dan hasilnya setara', async () => {
    const q = `select a.id,"Weird Col", 'x from y; -- not comment' as s from t a left join u on u.id=a.id and u.k = 'AND' where a.n>1 and (a.m in (select m from z where q=1) or a.o is null) group by 1 order by 2 desc limit 5 -- akhir`;
    const f = formatSQL(q);
    expect(f).toContain("'x from y; -- not comment'");
    expect(f).toContain('"Weird Col"');
    expect(f.split('\n').some(l => /^SELECT\b/.test(l))).toBe(true);
    expect(f).toMatch(/\nFROM t a/);
    expect(f).toMatch(/\nLEFT JOIN u ON/);
    expect(f).toMatch(/\nWHERE a\.n>1/);
    expect(f).toMatch(/\n\s+AND \(/);
    expect(formatSQL(f)).toBe(f);   // idempoten
    expect(formatSQL('select $$a;b$$; select 2')).toBe('SELECT $$a;b$$;\n\nSELECT 2');
    expect(formatSQL('select 1 union all select 2')).toBe('SELECT 1\nUNION ALL\nSELECT 2');
    const db = new PGlite();
    await db.exec('create table t(id int, n int, m int, o int); create table u(id int, k text); create table z(m int, q int); insert into t values (1,2,1,null),(2,0,5,3); insert into u values (1,\'AND\'); insert into z values (1,1)');
    const s1 = `select t.id, u.k from t left join u on u.id=t.id and u.k='AND' where t.n>=0 and (t.m in (select m from z where q=1) or t.o is null) order by 1`;
    expect((await db.query(formatSQL(s1))).rows).toEqual((await db.query(s1)).rows);
  });
  it('suggest & wordAt', () => {
    const cat = new Map([['public', { tables: [{ name: 'users', cols: [{ name: 'email' }, { name: 'Full Name' }] }] }], ['app', { tables: [{ name: 'logs', cols: [] }] }]]);
    expect(suggest('us', cat)[0]).toMatchObject({ text: 'users', kind: 'tabel' });
    expect(suggest('em', cat).map(x => x.text)).toContain('email');
    expect(suggest('users.em', cat).map(x => x.text)).toContain('users.email');
    expect(suggest('app.lo', cat)[0].text).toBe('app.logs');
    expect(suggest('full', cat).map(x => x.text)).toContain('"Full Name"');
    expect(suggest('x', cat)).toEqual([]);
    expect(suggest('sel', cat)[0].text).toBe('SELECT');
    expect(wordAt('select * from us', 16)).toEqual({ word: 'us', start: 14 });
    expect(wordAt('a', 0)).toEqual({ word: '', start: 0 });
  });
});

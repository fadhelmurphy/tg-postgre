// Interop log: log buatan klien JS direplay klien Rust (native/tgpg-core/tests/interop_log.rs) dan sebaliknya.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { Engine } from '../src/engine.js';
import { importKey, randomKeyBytes, genIdentity, loadIdentity, b64, b64u } from '../src/crypto.js';
import { Channel } from './memory-transport.js';

const dir = 'native/tgpg-core/tests/vectors/';
const mem = blob => new PGlite(blob ? { loadDataDir: blob } : undefined);
const Q1 = `select id::text, left(v,5), to_char(at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS'), r::text from t order by id`;
const Q2 = `select id::text from u order by id`;
const norm = rows => rows.map(r => Object.values(r).map(v => (v === null ? 'NULL' : String(v))));
const q = async (e, sql) => norm((await e.read(sql))[0].rows);

describe('interop log JS ↔ Rust', () => {
  it('membuat log dari klien JS untuk direplay Rust', async () => {
    const ch = new Channel(), raw = randomKeyBytes(), key = await importKey(raw);
    const ids = {};
    const join = async sid => { ids[sid] = await genIdentity(); return Engine.open({ transport: ch.handle(sid), key, createDb: mem, hasLocal: false, author: 'js' + sid, identity: ids[sid] }); };
    const A = await join('A'), B = await join('B'), C = await join('C');
    await A.write(`create table t(id uuid primary key default gen_random_uuid(), v text, at timestamptz default now(), r float8 default random())`);
    await Promise.all([B.write(`insert into t(v) values ('b1')`), A.write(`insert into t(v) values ('a1')`)]);
    await A.write(`insert into t(v) values ('${'z'.repeat(9000)}')`);
    await A.rotate({ remove: ['C'] }); await B.sync();
    await B.write(`insert into t(v) values ('b-ep1')`);
    await A.write(`create table u(id int primary key); insert into u values (1)`);
    await B.write(`insert into u values (1)`);   // error deterministik
    await A.write(`insert into u values (2)`); await B.sync(); await A.sync();
    const expect1 = await q(A, Q1), expect2 = await q(A, Q2);
    expect(expect1.length).toBe(4); expect(await q(B, Q1)).toEqual(expect1);
    writeFileSync(dir + 'jslog.json', JSON.stringify({
      key: b64.enc(raw), channel: ch.dump(), q1: Q1, q2: Q2, expect1, expect2,
      members: { B: { d: ids.B.jwk.d, pub: ids.B.pub } },
    }));
  }, 120000);

  it('klien JS mereplay log buatan Rust dengan data identik', async () => {
    const r = JSON.parse(readFileSync(dir + 'rustlog.json', 'utf8'));
    const ch = Channel.load(r.channel), key = await importKey(b64.dec(r.key));
    const { x, y, d } = (() => { const p = b64.dec(r.members.B.pub); return { x: b64u.enc(p.slice(1, 33)), y: b64u.enc(p.slice(33, 65)), d: r.members.B.d }; })();
    const id = await loadIdentity({ jwk: { kty: 'EC', crv: 'P-256', x, y, d, ext: true, key_ops: ['deriveKey'] }, pub: r.members.B.pub });
    const B = await Engine.open({ transport: ch.handle('B'), key, createDb: mem, hasLocal: false, author: 'jsB', identity: id });
    expect(B.myEpoch).toBe(1);
    expect(await q(B, r.q1)).toEqual(r.expect1);
    expect(await q(B, r.q2)).toEqual(r.expect2);
  }, 120000);
});

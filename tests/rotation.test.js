import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Engine, OP2 } from '../src/engine.js';
import { importKey, randomKeyBytes, genIdentity, encrypt, b64 } from '../src/crypto.js';
import { Channel } from './memory-transport.js';

const mem = blob => new PGlite(blob ? { loadDataDir: blob } : undefined);
const setup = async () => {
  const ch = new Channel(), raw = randomKeyBytes(), key = await importKey(raw);
  const join = async (sid, extra = {}) => {
    const id = extra.identity || await genIdentity(), saved = {};
    const e = await Engine.open({ transport: ch.handle(sid), key, createDb: mem, hasLocal: false, author: 'user' + sid,
      identity: id, keys: extra.keys, onKeys: k => Object.assign(saved, k) });
    e.saved = saved; e.identity0 = id; return e;
  };
  return { ch, key, join };
};
const rows = async (e, q) => (await e.read(q))[0].rows;
const sync = (...es) => Promise.all(es.map(e => e.sync()));

describe('rotasi kunci & pencabutan akses', () => {
  it('anggota yang dicabut tidak bisa menulis/membaca data baru; anggota lain lanjut', async () => {
    const { ch, join } = await setup();
    const A = await join('A'), B = await join('B'), C = await join('C');
    await sync(A, B, C);
    expect(A.isOwner).toBe(true); expect(B.isOwner).toBe(false);
    await A.write('create table t(v text)'); await B.write(`insert into t values ('b-sebelum')`); await sync(C);
    expect(await rows(C, 'select v from t')).toEqual([{ v: 'b-sebelum' }]);

    const r = await A.rotate({ remove: ['C'] });
    expect(r.epoch).toBe(1); await sync(B, C);
    expect(B.myEpoch).toBe(1); expect(C.myEpoch).toBe(0);

    await B.write(`insert into t values ('b-sesudah')`); await A.write(`insert into t values ('a-sesudah')`); await sync(C);
    expect(C.blocked).toBeTruthy();                                              // C tidak punya kunci epoch 1
    expect(await rows(C, 'select count(*)::int n from t')).toEqual([{ n: 1 }]); // tidak melihat data baru
    await expect(C.write(`insert into t values ('c')`)).rejects.toThrow(/akses tulis/);
    expect((await rows(A, 'select v from t order by v')).map(x => x.v)).toEqual(['a-sesudah', 'b-sebelum', 'b-sesudah']);
    expect(await rows(B, 'select count(*)::int n from t')).toEqual([{ n: 3 }]);
    expect(C.memberList().find(m => m.sid === 'C').status).toBe('removed');
  });

  it('op palsu dari anggota yang dicabut (pakai kunci lama) ditolak semua klien', async () => {
    const { ch, key, join } = await setup();
    const A = await join('A'), B = await join('B'), C = await join('C');
    await A.write('create table t(v text)'); await A.rotate({ remove: ['C'] }); await sync(B);
    const op = { v: 1, sql: `insert into t values ('PALSU')`, a: 'C', t: new Date().toISOString(), cid: 'x', oid: 'o1' };
    const enc = await encrypt(key, new TextEncoder().encode(JSON.stringify(op)));
    await ch.handle('C').sendText(OP2 + '0 ' + b64.enc(enc));
    await sync(A, B);
    expect(await rows(A, 'select count(*)::int n from t')).toEqual([{ n: 0 }]);
    expect(await rows(B, 'select count(*)::int n from t')).toEqual([{ n: 0 }]);
  });

  it('anggota baru setelah rotasi menunggu persetujuan owner, lalu replay penuh', async () => {
    const { join } = await setup();
    const A = await join('A'), B = await join('B');
    await A.write('create table t(v text)'); await A.rotate({ remove: [] }); await B.sync();
    await A.write(`insert into t values ('rahasia-epoch1')`);
    const D = await join('D'); await D.sync();
    expect(D.blocked).toBeTruthy();
    await expect(D.write(`insert into t values ('d')`)).rejects.toThrow(/akses tulis/);
    expect(A.memberList().find(m => m.sid === 'D').status).toBe('pending');
    await A.approve('D'); await D.sync();
    expect(D.blocked).toBeNull(); expect(D.myEpoch).toBe(1);
    expect(await rows(D, 'select v from t')).toEqual([{ v: 'rahasia-epoch1' }]);
    await D.write(`insert into t values ('dari-d')`); await A.sync();
    expect(await rows(A, 'select count(*)::int n from t')).toEqual([{ n: 2 }]);
  });

  it('perangkat baru memulihkan snapshot epoch>0 dengan mengambil kunci dari log; vault hilang pun pulih', async () => {
    const { join } = await setup();
    const A = await join('A'), B = await join('B');
    await A.write('create table t(v text)'); await A.rotate({ remove: [] });          // rotasi memicu snapshot di epoch 1
    await A.write(`insert into t values ('x')`);
    const B2 = await join('B', { identity: B.identity0 });                            // B login di perangkat baru, kunci ring kosong
    await B2.sync();
    expect(B2.myEpoch).toBe(1); expect(await rows(B2, 'select v from t')).toEqual([{ v: 'x' }]);
    expect(B2.saved[1]).toBeTruthy();                                                 // callback onKeys menyimpan kunci
  });

  it('hanya owner yang bisa rotasi/menyetujui; pesan keys dari non-owner diabaikan', async () => {
    const { ch, join } = await setup();
    const A = await join('A'), B = await join('B');
    await expect(B.rotate({ remove: ['A'] })).rejects.toThrow(/owner/);
    await ch.handle('B').sendText('TGPG-CTL ' + JSON.stringify({ t: 'keys', n: 1, wraps: {}, remove: ['A'] }));
    await sync(A, B);
    expect(A.dbEpoch).toBe(0); expect(A.memberList().find(m => m.sid === 'A').status).toBe('active');
  });
});

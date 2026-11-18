import { describe, it, expect } from 'vitest';
import { sealBlob, openBlob } from '../src/crypto.js';
import { buildPayload, mergePayload } from '../src/sync.js';
import { pushSyncBlob, pullSyncBlob, deleteSyncBlob } from '../src/telegram.js';

describe('cadangan terenkripsi', () => {
  it('bolak-balik dengan passphrase benar, gagal dengan yang salah, tak berisi plaintext', async () => {
    const obj = { v: 1, dbs: { 1: { conn: 'tgpg://x#KUNCIRAHASIA' } } };
    const blob = await sealBlob('passphrase-sinkron', obj);
    expect(await openBlob('passphrase-sinkron', blob)).toEqual(obj);
    await expect(openBlob('salah-salah', blob)).rejects.toThrow(/salah/);
    expect(new TextDecoder().decode(blob)).not.toContain('KUNCIRAHASIA');
  }, 30000);
});

describe('mergePayload', () => {
  const dev = { dbs: { 1: { conn: 'c1', title: 'a', keys: { 0: 'k0' }, addedAt: 10 } }, identity: { pub: 'P' }, gone: {} };
  it('perangkat baru menerima database, kunci, dan identitas', () => {
    const V = {}; expect(mergePayload(V, buildPayload(dev))).toBe(true);
    expect(V.dbs[1].conn).toBe('c1'); expect(V.identity.pub).toBe('P');
  });
  it('tidak menimpa data lokal, hanya menambah kunci epoch baru', () => {
    const V = { dbs: { 1: { conn: 'lokal', title: 'a', keys: { 0: 'k0' }, addedAt: 10 } }, identity: { pub: 'LOKAL' } };
    const r = buildPayload(dev); r.dbs[1].keys = { 0: 'k0', 1: 'k1' };
    mergePayload(V, r); expect(V.dbs[1].conn).toBe('lokal'); expect(V.dbs[1].keys).toEqual({ 0: 'k0', 1: 'k1' }); expect(V.identity.pub).toBe('LOKAL');
  });
  it('database yang dilupakan (lebih baru) dihapus; yang ditambahkan ulang setelahnya tetap', () => {
    const V = { dbs: { 1: { conn: 'c', addedAt: 10 }, 2: { conn: 'd', addedAt: 50 } } };
    mergePayload(V, { v: 1, dbs: {}, gone: { 1: 20, 2: 20 } });
    expect(V.dbs[1]).toBeUndefined(); expect(V.dbs[2]).toBeDefined();
    mergePayload(V, { v: 1, dbs: { 1: { conn: 'c', addedAt: 10 } }, gone: {} });   // tidak muncul lagi
    expect(V.dbs[1]).toBeUndefined();
  });
});

describe('Saved Messages', () => {
  it('push mengganti cadangan lama; pull mengambil yang terbaru', async () => {
    const msgs = []; let id = 0;
    const client = {
      getMessages: async () => [...msgs].reverse(),
      sendFile: async (_p, { file, caption }) => { const m = { id: ++id, message: caption, media: true, data: new Uint8Array(file.buffer ?? file.file ?? []) }; msgs.push(m); return m; },
      deleteMessages: async (_p, ids) => { for (const i of ids) msgs.splice(msgs.findIndex(m => m.id === i), 1); },
      downloadMedia: async m => m.data,
    };
    await pushSyncBlob(client, new Uint8Array([1])); await pushSyncBlob(client, new Uint8Array([2]));
    expect(msgs.length).toBe(1); expect(msgs[0].id).toBe(2);
    expect(await pullSyncBlob(client)).toBeInstanceOf(Uint8Array);
    await deleteSyncBlob(client); expect(msgs.length).toBe(0); expect(await pullSyncBlob(client)).toBe(null);
  });
});

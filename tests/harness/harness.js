import { PGlite } from '@electric-sql/pglite';
import { Engine } from '../../src/engine.js';
import { importKey, randomKeyBytes } from '../../src/crypto.js';
import { Channel } from '../memory-transport.js';

const out = [];
const ok = (name, cond, extra = '') => out.push({ name, pass: !!cond, extra });
try {
  const ch = new Channel(); const key = await importKey(randomKeyBytes());
  const name = 'tgpg-harness-' + Date.now();
  const createDb = async blob => { const d = new PGlite('idb://' + name, blob ? { loadDataDir: blob } : undefined); await d.waitReady; return d; };
  const a = await Engine.open({ transport: ch.handle(), key, createDb, hasLocal: false, author: 'A' });
  await a.write(`create table n(id uuid primary key default gen_random_uuid(), at timestamptz default now(), body text)`);
  await a.write(`insert into n(body) values ('satu'), ('dua')`);
  const before = (await a.read('select id, body from n order by body'))[0].rows;
  ok('write+read di browser', before.length === 2);
  await a.close();
  // buka ulang dari IndexedDB (hasLocal = true) tanpa replay
  const a2 = await Engine.open({ transport: ch.handle(), key, createDb, hasLocal: true, author: 'A' });
  const after = (await a2.read('select id, body from n order by body'))[0].rows;
  ok('persisten di IndexedDB', JSON.stringify(before) === JSON.stringify(after));
  ok('lastApplied dipulihkan dari meta', a2.lastApplied === 3 || a2.lastApplied === 2, 'last=' + a2.lastApplied);
  // snapshot + klien baru (in-memory db)
  const snap = await a2.snapshot();
  await a2.write(`insert into n(body) values ('tiga')`);
  const mem = blob => new PGlite(blob ? { loadDataDir: blob } : undefined);
  const b = await Engine.open({ transport: ch.handle(), key, createDb: mem, hasLocal: false, author: 'B' });
  const rb = (await b.read('select body from n order by body'))[0].rows.map(r => r.body);
  ok('klien B restore snapshot + replay', rb.join(',') === 'dua,satu,tiga', rb.join(','));
  const ids = JSON.stringify((await b.read('select id from n order by body'))[0].rows);
  const ids2 = JSON.stringify((await a2.read('select id from n order by body'))[0].rows);
  ok('uuid sama di A dan B', ids === ids2);
  const dbs = indexedDB.databases ? (await indexedDB.databases()).map(d => d.name) : [];
  out.push({ name: 'idb names', pass: true, extra: dbs.join(' | ') });
} catch (e) { out.push({ name: 'EXCEPTION', pass: false, extra: String(e && e.stack || e) }); }
window.__result = out;
document.getElementById('o').textContent = JSON.stringify(out, null, 1);

import '../../src/style.css';
import { PGlite } from '@electric-sql/pglite';
import { Engine } from '../../src/engine.js';
import { importKey, randomKeyBytes } from '../../src/crypto.js';
import { Workspace } from '../../src/ui/workspace.js';
import { Channel } from '../memory-transport.js';

localStorage.clear();
const ch = new Channel(); const key = await importKey(randomKeyBytes());
const engine = await Engine.open({ transport: ch.handle(), key, createDb: b => new PGlite(b ? { loadDataDir: b } : undefined), hasLocal: false, author: 'H' });
await engine.write(`create table notes(id int primary key, body text, n int, created_at timestamptz default now())`);
await engine.write(`insert into notes(id, body, n) select g, 'catatan ke-' || g, (g * 7) % 13 from generate_series(1, 120) g`);
await engine.write(`create schema app; create table app.users(id serial primary key, name text not null, email text unique); create view app.v_users as select name from app.users`);
await engine.write(`insert into app.users(name, email) values ('Budi', 'budi@x.id'), ('Sari', null)`);
await engine.write(`create index notes_n_idx on notes(n)`);
await engine.write(`create table nopk(a int); insert into nopk values (1)`);
const ws = new Workspace(document.getElementById('c-work'), {
  onSync: () => engine.sync(), onSnapshot: () => engine.snapshot(), onReset: () => {}, onClose: () => {}, getConn: () => 'tgpg://CONTOH#KUNCI',
});
engine.onApplied = n => ws.notifyApplied(n);
engine.onSync = (ok, err) => ws.setSyncState(ok, err);
window.__engine = engine;
await ws.open({ engine, dbId: 'harness', title: 'josjis' });
engine.onApplied(engine.lastApplied);
window.__ready = true;

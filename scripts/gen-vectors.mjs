// Membuat vektor uji interop untuk klien Rust: node scripts/gen-vectors.mjs
import { writeFileSync } from 'node:fs';
import { b64, b64u, randomKeyBytes, importKey, encrypt, genIdentity, wrapFor } from '../src/crypto.js';
import { rewrite, isRead } from '../src/sql.js';

const raw = randomKeyBytes(), key = await importKey(raw), plain = 'halo dunia ✓ {"a":1}';
const id = await genIdentity();
const wrapPlain = JSON.stringify({ 1: b64.enc(randomKeyBytes()), 2: b64.enc(randomKeyBytes()) });
const sqls = [
  "insert into t values (now(), gen_random_uuid(), 'now()', \"now()\") -- now()\n, random(), current_timestamp",
  "select $f$ now() $f$, now ( )", "select current_timestamp(3), my_now()", "select 'unterminated now()",
  "select /* now() */ 1 -- random()", "select 'é' || now()", "update t set a = clock_timestamp() where b = statement_timestamp()",
];
const reads = ['select 1', " SELECT 'a;b' ", 'select 1; drop table x', 'insert into t values (1)', 'with a as (select 1) select * from a',
  'with a as (insert into t values(1) returning *) select * from a', 'select * into t2 from t', 'show all', 'explain select 1', 'values (1)', 'create table x(a int)'];
writeFileSync('native/tgpg-core/tests/vectors/js.json', JSON.stringify({
  aesKey: b64.enc(raw), plain, cipher: b64.enc(await encrypt(key, new TextEncoder().encode(plain))),
  identity: { jwk: id.jwk, pub: id.pub }, wrapPlain, wrap: await wrapFor(id.pub, new TextEncoder().encode(wrapPlain)),
  rewrite: sqls.map(s => ({ in: s, out: rewrite(s) })), isRead: reads.map(s => ({ sql: s, read: isRead(s) })),
}, null, 1));
console.log('ok');

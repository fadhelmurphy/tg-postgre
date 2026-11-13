import { PGliteWorker } from '@electric-sql/pglite/worker';
const out = m => { document.getElementById('out').textContent += '\n' + m; };
try {
  const mk = (opts) => new PGliteWorker(new Worker(new URL('../../src/pg.worker.js', import.meta.url), { type: 'module' }), opts);
  const a = mk({ dataDir: 'idb://wtest' }); await a.waitReady;
  await a.exec('create table if not exists t(a int)');
  await a.transaction(async tx => { await tx.query('insert into t values ($1)', [7]); });
  const r = await a.query('select count(*)::int c from t');
  const blob = await a.dumpDataDir('gzip');
  await a.close();
  const b = mk({ loadDataDir: blob }); await b.waitReady;
  const r2 = await b.query('select a from t');
  out('RESULT ok count=' + r.rows[0].c + ' restored=' + r2.rows.map(x => x.a).join(',') + ' blob=' + (blob.size || blob.byteLength));
  await b.close();
} catch (e) { out('RESULT fail ' + (e.stack || e)); }

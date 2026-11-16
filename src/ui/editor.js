// Pembantu editor SQL: format, autocomplete, kata kunci.
export const KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN',
  'ON', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS', 'DISTINCT', 'UNION', 'UNION ALL', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM',
  'RETURNING', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'CREATE INDEX', 'WITH', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'COALESCE', 'CAST', 'EXPLAIN', 'EXPLAIN ANALYZE', 'TRUNCATE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'PRIMARY KEY', 'REFERENCES', 'DEFAULT', 'UNIQUE', 'CHECK'];

const UP = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'FULL', 'OUTER', 'CROSS', 'ON', 'AS', 'AND', 'OR', 'NOT', 'NULL',
  'IS', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS', 'DISTINCT', 'UNION', 'ALL', 'INTERSECT', 'EXCEPT', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'RETURNING', 'WITH', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'ASC', 'DESC', 'USING', 'DEFAULT', 'TRUE', 'FALSE']);
const BREAK_BEFORE = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT', 'VALUES', 'SET', 'RETURNING', 'LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'JOIN']);
const JOIN_MODS = new Set(['LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'OUTER', 'NATURAL']);

function lex(sql) {
  const out = []; let i = 0;
  const push = (t, v) => out.push({ t, v });
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) { while (i < sql.length && /\s/.test(sql[i])) i++; push('ws', ' '); continue; }
    if (c === '-' && sql[i + 1] === '-') { let j = sql.indexOf('\n', i); if (j < 0) j = sql.length; push('cmt', sql.slice(i, j)); i = j; continue; }
    if (c === '/' && sql[i + 1] === '*') { let j = sql.indexOf('*/', i + 2); j = j < 0 ? sql.length : j + 2; push('cmt', sql.slice(i, j)); i = j; continue; }
    if (c === "'" || c === '"') { let j = i + 1; while (j < sql.length) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j++; } push('str', sql.slice(i, j + 1)); i = j + 1; continue; }
    if (c === '$') { const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i)); if (m) { let j = sql.indexOf(m[0], i + m[0].length); j = j < 0 ? sql.length : j + m[0].length; push('str', sql.slice(i, j)); i = j; continue; } }
    if (/[A-Za-z_]/.test(c)) { let j = i + 1; while (j < sql.length && /[\w$]/.test(sql[j])) j++; push('word', sql.slice(i, j)); i = j; continue; }
    push('sym', c); i++;
  }
  return out;
}

/** Format sederhana: baris baru per klausa, indent subquery, huruf besar untuk kata kunci. Tidak mengubah string/komentar/identifier. */
export function formatSQL(sql) {
  const toks = lex(sql).filter((t, i, a) => !(t.t === 'ws' && (i === 0 || i === a.length - 1)));
  const out = []; const stack = [];   // stack: true bila kurung membuka subquery
  let line = '', joinPending = false, prevWord = '';
  const indent = () => '  '.repeat(stack.filter(Boolean).length);
  const nl = () => { if (line.trim()) out.push(line.replace(/\s+$/, '')); line = indent(); };
  line = '';
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === 'cmt') { line += (line.trim() ? ' ' : '') + t.v; if (t.v.startsWith('--')) nl(); continue; }
    if (t.t === 'ws') { if (line.trim() && !line.endsWith(' ') && !line.endsWith('(')) line += ' '; continue; }
    if (t.t === 'sym') {
      if (t.v === '(') {
        const next = toks.slice(k + 1).find(x => x.t !== 'ws');
        stack.push(next?.t === 'word' && /^(select|with)$/i.test(next.v)); line += '(';
        if (stack[stack.length - 1]) nl();
      } else if (t.v === ')') {
        const sub = stack.pop();
        if (sub) { nl(); line = indent() + ')'; } else line = line.replace(/\s+$/, '') + ')';
      } else if (t.v === ';') { line = line.replace(/\s+$/, '') + ';'; nl(); out.push(''); line = ''; stack.length = 0; }
      else if (t.v === ',') line = line.replace(/\s+$/, '') + ',';
      else line += t.v;
      prevWord = ''; continue;
    }
    if (t.t === 'str') { line += t.v; prevWord = ''; continue; }
    const up = t.v.toUpperCase();
    if (UP.has(up)) {
      const isJoinStart = (up === 'JOIN' && !JOIN_MODS.has(prevWord)) || (JOIN_MODS.has(up) && !joinPending);
      const brk = up === 'JOIN' ? isJoinStart : BREAK_BEFORE.has(up) && !(up === 'SET' && prevWord === 'ON') && !(JOIN_MODS.has(up) && joinPending);
      const isSetOp = (up === 'ALL' || up === 'DISTINCT') && /^(UNION|INTERSECT|EXCEPT)$/.test(prevWord);
      if (brk && !isSetOp && line.trim()) nl();
      if ((up === 'AND' || up === 'OR') && /where|having|on/i.test(out.concat(line).join(' ').split(/\bFROM\b|\bSELECT\b/i).pop() || 'where')) { if (line.trim() && !/^\s*(WHERE|HAVING|ON)\b/.test(line) || true) nl(); line += '  '; }
      if (JOIN_MODS.has(up)) joinPending = true; if (up === 'JOIN') joinPending = false;
      line += up; prevWord = up; continue;
    }
    line += t.v; prevWord = '';
  }
  if (line.trim()) out.push(line.replace(/\s+$/, ''));
  return out.join('\n').replace(/[ \t]+\n/g, '\n').trim();
}

/** Kata di kiri kursor (huruf/angka/_/.) */
export function wordAt(text, pos) {
  const m = /[\w.$"]*$/.exec(text.slice(0, pos));
  return { word: m ? m[0] : '', start: pos - (m ? m[0].length : 0) };
}

/** Saran: tabel (dan schema.tabel), kolom (juga tabel.kolom), kata kunci. catalog: Map(schema -> {tables:[{name,cols}]}) */
export function suggest(word, catalog, limit = 8) {
  const w = word.replace(/"/g, '').toLowerCase();
  if (w.length < 2) return [];
  const items = [];
  for (const [schema, { tables }] of catalog) for (const t of tables) {
    items.push({ text: schema === 'public' ? t.name : `${schema}.${t.name}`, kind: 'tabel' });
    for (const c of t.cols) { items.push({ text: c.name, kind: `kolom ${t.name}` }); items.push({ text: `${t.name}.${c.name}`, kind: 'kolom' }); }
  }
  for (const k of KEYWORDS) items.push({ text: k, kind: 'kata kunci' });
  const seen = new Set(), pre = [], mid = [];
  for (const it of items) {
    const key = it.text.toLowerCase(); if (seen.has(key) || key === w) continue;
    if (key.startsWith(w)) { seen.add(key); pre.push(it); } else if (key.includes(w) && w.length >= 3) { seen.add(key); mid.push(it); }
  }
  const rank = it => (it.kind === 'tabel' ? 0 : it.kind.startsWith('kolom') ? 1 : 2);
  return [...pre.sort((a, b) => rank(a) - rank(b) || a.text.length - b.text.length), ...mid].slice(0, limit)
    .map(it => ({ ...it, text: /^[a-z_][a-z0-9_.]*$/.test(it.text) || it.kind === 'kata kunci' ? it.text : it.text.split('.').map(p => /^[a-z_][a-z0-9_]*$/.test(p) ? p : `"${p.replace(/"/g, '""')}"`).join('.') }));
}

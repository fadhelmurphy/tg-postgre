import { describe, it, expect } from 'vitest';
import { layoutERD } from '../src/ui/erd.js';

describe('erd layout', () => {
  const T = (name, cols) => ({ schema: 'public', name, cols: cols.map(c => ({ name: c, type: 'int', pk: c === 'id' })) });
  it('posisi tidak tumpang tindih dan relasi tersambung ke baris kolom yang benar', () => {
    const tables = ['a', 'b', 'c', 'd', 'e', 'f'].map(n => T(n, ['id', 'x_id', 'y']));
    const fks = [{ name: 'f1', schema: 'public', table: 'b', cols: ['x_id'], refSchema: 'public', refTable: 'a', refCols: ['id'] },
      { name: 'f2', schema: 'public', table: 'c', cols: ['x_id'], refSchema: 'public', refTable: 'a', refCols: ['id'] },
      { name: 'self', schema: 'public', table: 'a', cols: ['x_id'], refSchema: 'public', refTable: 'a', refCols: ['id'] },
      { name: 'orphan', schema: 'public', table: 'b', cols: ['x_id'], refSchema: 'other', refTable: 'zz', refCols: ['id'] }];
    const L = layoutERD(tables, fks);
    expect(L.lines.length).toBe(3);   // yang menunjuk tabel tak dikenal dibuang
    for (const a of L.nodes) for (const b of L.nodes) if (a !== b) expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
    for (const n of L.nodes) { expect(n.x + n.w).toBeLessThanOrEqual(L.width); expect(n.y + n.h).toBeLessThanOrEqual(L.height); }
    expect(L.nodes[0].key).toBe('public.a');   // paling banyak terhubung
    const a = L.nodes.find(n => n.key === 'public.a'), l = L.lines.find(x => x.name === 'f1');
    expect(l.y2).toBe(a.y + 28 + 0 * 18 + 9);   // baris kolom id
    expect(L.lines.every(x => /^M[\d.]+,[\d.]+ C/.test(x.d))).toBe(true);
  });
  it('tanpa tabel tetap valid', () => { const L = layoutERD([], []); expect(L.width).toBeGreaterThan(0); expect(L.lines).toEqual([]); });
});

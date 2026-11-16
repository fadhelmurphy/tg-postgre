// Diagram relasi antar tabel (ERD) sebagai SVG. layoutERD murni (bisa dites tanpa DOM).
const W = 220, HEAD = 28, ROW = 18, GAP_X = 70, GAP_Y = 40, PAD = 24;

/** tables: [{schema,name,cols:[{name,type,pk}]}]; fks: [{schema,table,cols,refSchema,refTable,refCols}] */
export function layoutERD(tables, fks) {
  const key = (s, n) => `${s}.${n}`;
  const nodes = new Map(tables.map(t => [key(t.schema, t.name), { ...t, key: key(t.schema, t.name), h: HEAD + Math.max(1, t.cols.length) * ROW + 6, links: 0 }]));
  const edges = [];
  for (const f of fks) {
    const a = nodes.get(key(f.schema, f.table)), b = nodes.get(key(f.refSchema, f.refTable));
    if (!a || !b) continue;
    a.links++; if (a !== b) b.links++;
    edges.push({ from: a.key, to: b.key, cols: f.cols, refCols: f.refCols, name: f.name });
  }
  // yang paling banyak terhubung di tengah: urut turun, isi grid baris demi baris
  const list = [...nodes.values()].sort((x, y) => y.links - x.links || x.key.localeCompare(y.key));
  const perRow = Math.max(1, Math.ceil(Math.sqrt(list.length * 1.4)));
  const rowsH = [];
  list.forEach((n, i) => { const r = Math.floor(i / perRow); rowsH[r] = Math.max(rowsH[r] || 0, n.h); });
  list.forEach((n, i) => {
    const r = Math.floor(i / perRow), c = i % perRow;
    n.x = PAD + c * (W + GAP_X);
    n.y = PAD + rowsH.slice(0, r).reduce((s, h) => s + h + GAP_Y, 0);
    n.w = W;
  });
  const width = PAD * 2 + Math.min(perRow, list.length) * W + (Math.min(perRow, list.length) - 1) * GAP_X;
  const height = PAD * 2 + rowsH.reduce((s, h) => s + h, 0) + Math.max(0, rowsH.length - 1) * GAP_Y;
  const colY = (n, c) => { const i = n.cols.findIndex(x => x.name === c); return n.y + HEAD + (i < 0 ? 0 : i) * ROW + ROW / 2; };
  const lines = edges.map(e => {
    const a = nodes.get(e.from), b = nodes.get(e.to);
    const y1 = colY(a, e.cols[0]), y2 = colY(b, e.refCols[0]);
    let x1, x2, dir;
    if (a === b) { x1 = a.x + W; x2 = a.x + W; dir = 1; }
    else if (a.x + W + 10 <= b.x) { x1 = a.x + W; x2 = b.x; dir = 1; }
    else if (b.x + W + 10 <= a.x) { x1 = a.x; x2 = b.x + W; dir = -1; }
    else { x1 = a.x + W; x2 = b.x + W; dir = 1; }   // satu kolom: lengkungkan lewat sisi kanan
    const bend = a === b || x1 === x2 ? 40 : Math.max(30, Math.abs(x2 - x1) / 2);
    const d = x1 === x2 ? `M${x1},${y1} C${x1 + bend},${y1} ${x2 + bend},${y2} ${x2},${y2}`
      : `M${x1},${y1} C${x1 + dir * bend},${y1} ${x2 - dir * bend},${y2} ${x2},${y2}`;
    return { ...e, d, x1, y1, x2, y2, dir };
  });
  return { nodes: [...nodes.values()], lines, width: Math.max(width, 300), height: Math.max(height, 120) };
}

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function renderERD(tables, fks, { onOpen = null } = {}) {
  const L = layoutERD(tables, fks);
  const svg = el('svg', { width: L.width, height: L.height, viewBox: `0 0 ${L.width} ${L.height}`, role: 'img', 'aria-label': 'Diagram relasi tabel' });
  const defs = el('defs'); const m = el('marker', { id: 'erd-many', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' });
  m.append(el('path', { d: 'M1 1L9 5L1 9', fill: 'none', stroke: '#8b93a7', 'stroke-width': 1.4 })); defs.append(m); svg.append(defs);
  for (const l of L.lines) {
    const p = el('path', { d: l.d, fill: 'none', stroke: '#8b93a7', 'stroke-width': 1.2, 'marker-end': 'url(#erd-many)' });
    p.append(el('title', {}, `${l.name}: ${l.cols.join(', ')} → ${l.refCols.join(', ')}`)); svg.append(p);
  }
  for (const n of L.nodes) {
    const g = el('g', { class: 'erd-t', tabindex: 0, role: 'button', 'aria-label': `Tabel ${n.name}` });
    g.append(el('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 6, fill: '#171a21', stroke: '#2a2f3a' }));
    g.append(el('rect', { x: n.x, y: n.y, width: n.w, height: HEAD, rx: 6, fill: '#1d212b' }));
    g.append(el('text', { x: n.x + 10, y: n.y + 18, fill: '#e6e8ee', 'font-size': 13, 'font-weight': 600 }, clip(n.schema === 'public' ? n.name : `${n.schema}.${n.name}`, 28)));
    n.cols.forEach((c, i) => {
      const y = n.y + HEAD + i * ROW + 13;
      g.append(el('text', { x: n.x + 10, y, fill: c.pk ? '#ffcc66' : '#e6e8ee', 'font-size': 12 }, (c.pk ? '🔑 ' : '') + clip(c.name, 18)));
      g.append(el('text', { x: n.x + n.w - 8, y, fill: '#8b93a7', 'font-size': 11, 'text-anchor': 'end' }, clip(c.type, 16)));
    });
    if (onOpen) { g.style.cursor = 'pointer'; g.addEventListener('dblclick', () => onOpen(n.schema, n.name)); g.addEventListener('keydown', e => { if (e.key === 'Enter') onOpen(n.schema, n.name); }); }
    svg.append(g);
  }
  return svg;
}

export function erdToSVGString(svg) {
  const s = svg.cloneNode(true); s.setAttribute('xmlns', NS);
  const bg = el('rect', { width: '100%', height: '100%', fill: '#0f1115' }); s.insertBefore(bg, s.firstChild);
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(s);
}

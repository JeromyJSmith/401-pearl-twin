// The plan sheet's annotation layer: drawn once to a canvas in plan metres, then laid on the floor plane by
// the composite shader. Everything drawn comes from the model: room names, net areas and sizes from IfcSpace,
// dimension strings and grid lines from the room footprints. Nothing is invented (no furniture, no labels
// the model does not carry).

const INK = '#1d1d1f';
const DIM = 'rgba(29,29,31,.62)';

// distinct wall lines along one axis: edges of room footprints, merged within tol, kept when two or more agree
function gridLines(values, tol = 0.2) {
  const sorted = [...values].sort((a, b) => a - b);
  const groups = [];
  for (const v of sorted) {
    const g = groups[groups.length - 1];
    if (g && v - g.at(-1) <= tol) g.push(v); else groups.push([v]);
  }
  return groups.filter((g) => g.length >= 2).map((g) => g.reduce((s, v) => s + v, 0) / g.length);
}

function thin(lines, minGap) {
  const out = [];
  for (const v of lines) if (!out.length || v - out.at(-1) >= minGap) out.push(v);
  return out;
}

export function sheetBounds(footprint) {
  const pad = 6.2;
  const [u0, v0, u1, v1] = footprint;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const half = Math.max(u1 - u0, v1 - v0) / 2 + pad;
  return { min: [cu - half, cv - half], size: [2 * half, 2 * half] };
}

export function drawSheet({ rooms, footprint, bounds, northDeg, fixtures = [], px = 4096 }) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  const s = px / bounds.size[0];
  const X = (u) => (u - bounds.min[0]) * s;
  const Y = (v) => (bounds.min[1] + bounds.size[1] - v) * s;
  const m = (metres) => metres * s; // metres on the sheet to canvas px
  g.clearRect(0, 0, px, px);
  g.lineCap = 'butt';

  const [u0, v0, u1, v1] = footprint;

  // grid lines and bubbles from the room footprints
  const us = [], vs = [];
  for (const r of rooms) for (const [u, v] of r.poly) { us.push(u); vs.push(v); }
  const gu = thin(gridLines([...us, u0, u0, u1, u1]), 2.2).slice(0, 6);
  const gv = thin(gridLines([...vs, v0, v0, v1, v1]), 2.2).slice(0, 7);
  g.setLineDash([m(0.5), m(0.12), m(0.06), m(0.12)]);
  g.strokeStyle = 'rgba(29,29,31,.35)';
  g.lineWidth = m(0.012);
  const ext = 2.2;
  gu.forEach((u) => { g.beginPath(); g.moveTo(X(u), Y(v1 + ext - 0.55)); g.lineTo(X(u), Y(v0 - ext - 0.35)); g.stroke(); });
  gv.forEach((v) => { g.beginPath(); g.moveTo(X(u0 - ext + 0.55), Y(v)); g.lineTo(X(u1 + ext - 0.55), Y(v)); g.stroke(); });
  g.setLineDash([]);
  const bubble = (x, y, t) => {
    g.beginPath(); g.arc(x, y, m(0.3), 0, Math.PI * 2);
    g.fillStyle = '#efebe2'; g.fill(); g.lineWidth = m(0.02); g.strokeStyle = INK; g.stroke();
    g.fillStyle = INK; g.font = `500 ${m(0.3)}px "Geist Mono"`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(t, x, y + m(0.015));
  };
  gu.forEach((u, i) => { bubble(X(u), Y(v1 + ext), String.fromCharCode(65 + i)); bubble(X(u), Y(v0 - ext - 0.9), String.fromCharCode(65 + i)); });
  gv.forEach((v, i) => { bubble(X(u0 - ext), Y(v), String(i + 1)); bubble(X(u1 + ext), Y(v), String(i + 1)); });

  // dimension strings: overall and the grid chain, south and east sides
  const dimH = (a, b, v, label) => {
    g.strokeStyle = INK; g.lineWidth = m(0.012);
    g.beginPath(); g.moveTo(X(a), Y(v)); g.lineTo(X(b), Y(v)); g.stroke();
    for (const u of [a, b]) { g.beginPath(); g.moveTo(X(u) - m(0.1), Y(v) + m(0.1)); g.lineTo(X(u) + m(0.1), Y(v) - m(0.1)); g.stroke(); g.beginPath(); g.moveTo(X(u), Y(v) - m(0.18)); g.lineTo(X(u), Y(v) + m(0.18)); g.stroke(); }
    g.fillStyle = INK; g.font = `400 ${m(0.2)}px "Geist Mono"`; g.textAlign = 'center'; g.textBaseline = 'bottom';
    g.fillText(label, (X(a) + X(b)) / 2, Y(v) - m(0.06));
  };
  const dimV = (a, b, u, label) => {
    g.save(); g.translate(X(u), (Y(a) + Y(b)) / 2); g.rotate(-Math.PI / 2);
    const h = Math.abs(Y(a) - Y(b)) / 2;
    g.strokeStyle = INK; g.lineWidth = m(0.012);
    g.beginPath(); g.moveTo(-h, 0); g.lineTo(h, 0); g.stroke();
    for (const x of [-h, h]) { g.beginPath(); g.moveTo(x - m(0.1), m(0.1)); g.lineTo(x + m(0.1), -m(0.1)); g.stroke(); g.beginPath(); g.moveTo(x, -m(0.18)); g.lineTo(x, m(0.18)); g.stroke(); }
    g.fillStyle = INK; g.font = `400 ${m(0.2)}px "Geist Mono"`; g.textAlign = 'center'; g.textBaseline = 'bottom';
    g.fillText(label, 0, -m(0.06));
    g.restore();
  };
  const f2 = (x) => x.toFixed(2);
  dimH(u0, u1, v0 - 1.35, f2(u1 - u0));
  const chainU = [u0, ...gu.filter((u) => u > u0 + 0.3 && u < u1 - 0.3), u1];
  for (let i = 0; i < chainU.length - 1; i++) dimH(chainU[i], chainU[i + 1], v0 - 0.8, f2(chainU[i + 1] - chainU[i]));
  dimV(v0, v1, u1 + 1.35, f2(v1 - v0));
  const chainV = [v0, ...gv.filter((v) => v > v0 + 0.3 && v < v1 - 0.3), v1];
  for (let i = 0; i < chainV.length - 1; i++) dimV(chainV[i], chainV[i + 1], u1 + 0.8, f2(chainV[i + 1] - chainV[i]));

  // room labels, fitted to the room; small rooms get the number tag only
  for (const r of rooms) {
    // parts of a bathroom (shower area, toilet area) carry no words: the fixtures drawn in them say what they are
    if (/\b(shower|toilet)\s+area\b/i.test(r.label)) continue;
    const w = m(r.w), h = m(r.d);
    const cx = X(r.cu), cy = Y(r.cv);
    const name = r.label.toUpperCase();
    const meta = `${r.area.toFixed(1)} M²`;
    const size = `${r.w.toFixed(2)} × ${r.d.toFixed(2)}`;
    let fs = m(0.26);
    g.font = `500 ${fs}px "Geist Mono"`;
    const fit = Math.min(1, (w * 0.8) / g.measureText(name).width);
    fs *= fit;
    g.textAlign = 'center';
    // a room too small for a readable label carries its number tag only (the HUD names it on arrival)
    const labelled = fs >= m(0.16) && h > m(1.3) && r.area >= 2.5;
    if (labelled) {
      g.fillStyle = INK; g.font = `500 ${fs}px "Geist Mono"`; g.textBaseline = 'alphabetic';
      g.fillText(name, cx, cy - m(0.02));
      const ms = Math.min(fs * 0.8, m(0.19));
      g.fillStyle = DIM; g.font = `400 ${ms}px "Geist Mono"`; g.textBaseline = 'top';
      g.fillText(meta, cx, cy + m(0.08));
      if (h > m(1.6) && g.measureText(size).width < w * 0.9) g.fillText(size, cx, cy + m(0.34));
    }
    // number tag
    const tx = cx, ty = labelled ? cy - m(0.6) : cy;
    g.beginPath(); g.arc(tx, ty, m(0.16), 0, Math.PI * 2); g.lineWidth = m(0.012); g.strokeStyle = INK; g.stroke();
    g.fillStyle = INK; g.font = `500 ${m(0.14)}px "Geist Mono"`; g.textBaseline = 'middle';
    g.fillText(String(r.n).padStart(2, '0'), tx, ty + m(0.01));
  }

  // fixtures: plan symbols from the model's own elements, no words (owner 2026-10-18: "just draw what they are")
  g.save(); g.strokeStyle = INK; g.lineWidth = m(0.014);
  for (const f of fixtures) {
    const [u0, v0, u1, v1] = f.box, x = X(u0), y = Y(v1), w = m(u1 - u0), h = m(v1 - v0), cx = x + w / 2, cy = y + h / 2, k = f.kind;
    const rr = (ax, ay, aw, ah, r) => { g.beginPath(); g.roundRect(ax, ay, aw, ah, r); g.stroke(); };
    const long = w >= h; // the fixture's long side
    if (/toilet|water ?closet|wc\b/.test(k)) { // tank on the long back edge, bowl as an ellipse
      const tw = long ? w : h * 0.32, th = long ? h * 0.32 : h;
      rr(x, y, long ? w : w * 0.32, long ? h * 0.32 : h, m(0.03));
      g.beginPath(); g.ellipse(long ? cx : x + w * 0.62, long ? y + h * 0.64 : cy, long ? w * 0.36 : w * 0.34, long ? h * 0.34 : h * 0.36, 0, 0, Math.PI * 2); g.stroke();
    } else if (/bath ?tub|tub\b/.test(k)) { rr(x, y, w, h, m(0.05)); rr(x + m(0.08), y + m(0.08), w - m(0.16), h - m(0.16), Math.min(w, h) * 0.35); }
    else if (/shower/.test(k)) { rr(x, y, w, h, 0); g.beginPath(); g.moveTo(x, y); g.lineTo(x + w, y + h); g.moveTo(x + w, y); g.lineTo(x, y + h); g.stroke(); g.beginPath(); g.arc(cx, cy, m(0.05), 0, Math.PI * 2); g.stroke(); }
    else if (/sink|basin|lavatory/.test(k)) { rr(x, y, w, h, m(0.02)); g.beginPath(); g.ellipse(cx, cy, w * 0.32, h * 0.3, 0, 0, Math.PI * 2); g.stroke(); }
    else if (/range|stove|cooktop|oven/.test(k)) { rr(x, y, w, h, 0); for (const [a, b] of [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]]) { g.beginPath(); g.arc(x + w * a, y + h * b, Math.min(w, h) * 0.14, 0, Math.PI * 2); g.stroke(); } }
    else if (/refrigerator|fridge/.test(k)) { rr(x, y, w, h, 0); g.beginPath(); g.moveTo(x, y); g.lineTo(x + w, y + h); g.stroke(); }
    else if (/washer|dryer|laundry/.test(k)) { rr(x, y, w, h, m(0.02)); g.beginPath(); g.arc(cx, cy, Math.min(w, h) * 0.33, 0, Math.PI * 2); g.stroke(); }
    else { rr(x, y, w, h, m(0.02)); } // cabinets, counters, bars: their outline
  }
  g.restore();

  // north arrow (grid north, from the house-axis rotation) and scale bar, south-west corner
  const na = [X(u0 - 1.2), Y(v0 - 3.9)];
  g.save(); g.translate(...na); g.rotate((northDeg * Math.PI) / 180);
  g.beginPath(); g.arc(0, 0, m(0.42), 0, Math.PI * 2); g.lineWidth = m(0.012); g.strokeStyle = INK; g.stroke();
  g.beginPath(); g.moveTo(0, -m(0.52)); g.lineTo(m(0.13), m(0.18)); g.lineTo(0, m(0.06)); g.lineTo(-m(0.13), m(0.18)); g.closePath(); g.fillStyle = INK; g.fill();
  g.font = `500 ${m(0.18)}px "Geist Mono"`; g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillText('N', 0, -m(0.58));
  g.restore();
  const sb = [X(u0 + 0.2), Y(v0 - 3.95)];
  for (let i = 0; i < 5; i++) { g.fillStyle = i % 2 ? '#efebe2' : INK; g.fillRect(sb[0] + m(i), sb[1], m(1), m(0.08)); }
  g.strokeStyle = INK; g.lineWidth = m(0.01); g.strokeRect(sb[0], sb[1], m(5), m(0.08));
  g.fillStyle = INK; g.font = `400 ${m(0.15)}px "Geist Mono"`; g.textAlign = 'center'; g.textBaseline = 'top';
  [0, 1, 2, 5].forEach((k) => g.fillText(k === 5 ? '5 M' : String(k), sb[0] + m(k), sb[1] + m(0.14)));
  g.textAlign = 'left';
  g.fillText('MAIN LEVEL · CUT +1.20', X(u0 + 0.2), Y(v0 - 4.45));
  return c;
}

// Chapter C, the permit clock: red-lines from the twin's measured and cited site data (site.json): the lot line,
// each required setback drawn inside its lot line with required vs measured, the buildable envelope hatched, and
// the neighbour's proposed house named where it stands. `toHouse` maps the model frame to the sheet's house frame.
const RED = '#c4262e';
export function redlineBounds(site, toHouse, extra = []) {
  const pts = [...site.lot.map(toHouse), ...extra]; // extra points are already in the house frame
  const us = pts.map((p) => p[0]), vs = pts.map((p) => p[1]);
  const cu = (Math.min(...us) + Math.max(...us)) / 2, cv = (Math.min(...vs) + Math.max(...vs)) / 2;
  const half = Math.max(Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs)) / 2 + 5;
  return { min: [cu - half, cv - half], size: [2 * half, 2 * half] };
}
export function drawRedlines({ site, toHouse, bounds, neighbour, px = 4096 }) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  const s = px / bounds.size[0];
  const X = (u) => (u - bounds.min[0]) * s;
  const Y = (v) => (bounds.min[1] + bounds.size[1] - v) * s;
  const m = (metres) => metres * s;
  const FT = 1200 / 3937;
  const lot = site.lot.map(toHouse);
  const cen = lot.reduce((a, p) => [a[0] + p[0] / lot.length, a[1] + p[1] / lot.length], [0, 0]);
  // envelope: hatched
  g.save();
  for (const poly of site.envelope) {
    const h = poly.map(toHouse);
    g.beginPath(); h.forEach(([u, v], k) => (k ? g.lineTo(X(u), Y(v)) : g.moveTo(X(u), Y(v)))); g.closePath();
    g.fillStyle = 'rgba(196,38,46,0.07)'; g.fill();
    g.save(); g.clip();
    g.strokeStyle = 'rgba(196,38,46,0.35)'; g.lineWidth = m(0.012);
    for (let k = -px; k < px * 2; k += m(0.35)) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k - px, px); g.stroke(); }
    g.restore();
    g.setLineDash([m(0.3), m(0.15)]); g.strokeStyle = RED; g.lineWidth = m(0.02); g.stroke(); g.setLineDash([]);
  }
  g.restore();
  // lot line
  g.beginPath(); lot.forEach(([u, v], k) => (k ? g.lineTo(X(u), Y(v)) : g.moveTo(X(u), Y(v)))); g.closePath();
  g.strokeStyle = RED; g.lineWidth = m(0.05); g.setLineDash([m(0.9), m(0.18), m(0.18), m(0.18)]); g.stroke(); g.setLineDash([]);
  // setbacks
  g.font = `500 ${m(0.3)}px "Geist Mono"`; g.textAlign = 'center';
  for (const e of site.edges) {
    const a = toHouse(e.start), b = toHouse(e.end);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let n = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if ((cen[0] - mid[0]) * n[0] + (cen[1] - mid[1]) * n[1] < 0) n = [-n[0], -n[1]]; // inward
    const req = (e.required_ft || 0) * FT, got = e.measured_ft * FT;
    // required setback line (dashed), measured dimension (solid with ticks)
    g.strokeStyle = RED; g.lineWidth = m(0.02); g.setLineDash([m(0.25), m(0.12)]);
    g.beginPath(); g.moveTo(X(a[0] + n[0] * req), Y(a[1] + n[1] * req)); g.lineTo(X(b[0] + n[0] * req), Y(b[1] + n[1] * req)); g.stroke();
    g.setLineDash([]);
    const q = [mid[0] + (b[0] - a[0]) / L * L * 0.18, mid[1] + (b[1] - a[1]) / L * L * 0.18];
    g.lineWidth = m(0.025);
    g.beginPath(); g.moveTo(X(q[0]), Y(q[1])); g.lineTo(X(q[0] + n[0] * got), Y(q[1] + n[1] * got)); g.stroke();
    for (const t of [0, got]) { g.beginPath(); g.arc(X(q[0] + n[0] * t), Y(q[1] + n[1] * t), m(0.07), 0, Math.PI * 2); g.fillStyle = RED; g.fill(); }
    // label along the lot line, outside
    const ang = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
    const flip = Math.abs(ang) > Math.PI / 2;
    g.save(); g.translate(X(mid[0] - n[0] * 0.7), Y(mid[1] - n[1] * 0.7)); g.rotate(flip ? ang + Math.PI : ang);
    g.fillStyle = RED; g.textBaseline = 'middle';
    const role = e.role.replace('_', ' ').toUpperCase();
    g.fillText(`${role} SETBACK · ${e.required_ft?.toFixed(0)} FT REQUIRED · ${e.measured_ft.toFixed(1)} FT MEASURED${e.fails ? ' · SHORT' : ''}`, 0, 0);
    g.restore();
  }
  // lot data block and neighbour label
  g.fillStyle = RED; g.textAlign = 'left'; g.textBaseline = 'top'; g.font = `500 ${m(0.34)}px "Geist Mono"`;
  const tl = lot.reduce((a, p) => (p[1] - p[0] > a[1] - a[0] ? p : a), lot[0]);
  const lines = [`LOT ${site.parcel_no} · ${site.zone} · ${Math.round(site.lot_area_sf).toLocaleString('en-US')} SF`,
    `HEIGHT LIMIT ${site.height.limit_ft.toFixed(1)} FT (${site.height.formula})`, `SHORT: ${site.failing.map((f) => f.replace('_setback_ft', '').replace('_', ' ').toUpperCase()).join(' · ')}`];
  lines.forEach((t, k) => g.fillText(t, X(tl[0] - 1.5), Y(tl[1] + 3.2) + k * m(0.5)));
  if (neighbour) {
    g.textAlign = 'center'; g.font = `500 ${m(0.36)}px "Geist Mono"`; g.fillStyle = '#1d1d1f';
    g.fillText(neighbour.label, X(neighbour.at[0]), Y(neighbour.at[1]));
    g.font = `400 ${m(0.26)}px "Geist Mono"`; g.fillStyle = 'rgba(29,29,31,.62)';
    g.fillText(neighbour.sub, X(neighbour.at[0]), Y(neighbour.at[1]) + m(0.45));
  }
  return c;
}

// Shot timeline in the reference's grammar (docs/presentation/CASA_SERRA_CHOREOGRAPHY.md, §1–§5), original code.
// Units: scroll in vh. Each shot has hold and go lengths (authored vh × 0.85). Holds sit still on their shot (with a 5 %
// push-in and a ±1.2° drift); between two holds there is ONE cosine-eased move that passes the via shots at speeds set
// by their go lengths; the path is a uniform Catmull-Rom spline over target, yaw, pitch, ln(fov) and ln(framed height),
// and distance is rebuilt from framed height and fov so long-lens to wide-lens moves never jump.
// Yaw here is the view heading in degrees (90 = looking north, +y), not wrapped: authored values choose turn direction.

// reference scale 0.85; the owner asked for much slower transitions, so every hold and go is 1.9× longer (D626)
export const SCALE = 0.85 * 1.9;
const DEG = Math.PI / 180;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const cr = (p0, p1, p2, p3, t) => 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);

// lay out h0 / h1 / g1 for every shot
export function layout(shots) {
  let s = 0;
  for (const sh of shots) {
    sh.h0 = s; sh.h1 = s + (sh.hold || 0) * SCALE; sh.g1 = sh.h1 + (sh.go || 0) * SCALE; s = sh.g1;
    if (sh.frame == null) sh.frame = 2 * sh.dist * Math.tan((sh.fov * DEG) / 2);
  }
  return s; // total vh
}

// sample the camera at scroll position s (vh)
export function sample(shots, s) {
  const n = shots.length;
  const held = shots.map((sh, i) => ((sh.hold || 0) > 0 ? i : -1)).filter((i) => i >= 0);
  let idx = 0, push = 0, r = 0, A = held[0], B = held[0], moving = false;
  const inHold = held.find((i) => s >= shots[i].h0 && s <= shots[i].h1);
  if (inHold != null) {
    idx = inHold; A = B = inHold;
    push = (s - shots[inHold].h0) / Math.max(1e-6, shots[inHold].h1 - shots[inHold].h0);
  } else {
    A = held.filter((i) => shots[i].h1 <= s).pop();
    B = held.find((i) => shots[i].h0 >= s);
    if (A == null) { A = B; idx = B; }
    else if (B == null) { B = A; idx = A; }
    else {
      moving = true;
      const a = shots[A].h1, b = shots[B].h0;
      r = (s - a) / Math.max(1e-6, b - a);
      const ev = a + (0.5 - 0.5 * Math.cos(Math.PI * r)) * (b - a);
      idx = B;
      for (let k = A; k < B; k++) {
        const sk = shots[k];
        if (ev >= sk.h1 && ev <= sk.g1) { idx = k + (ev - sk.h1) / Math.max(1e-6, sk.g1 - sk.h1); break; }
      }
      push = 1 - smooth(0, 0.35, r);
    }
  }
  const i = Math.floor(idx), f = idx - i;
  const P = (k) => shots[Math.min(n - 1, Math.max(0, k))];
  const ch = (get) => cr(get(P(i - 1)), get(P(i)), get(P(i + 1)), get(P(i + 2)), f);
  const out = {
    x: ch((q) => q.t[0]), y: ch((q) => q.t[1]), z: ch((q) => q.t[2]),
    yaw: ch((q) => q.yaw), pitch: ch((q) => q.pitch),
    fov: Math.exp(ch((q) => Math.log(q.fov))), frame: Math.exp(ch((q) => Math.log(q.frame))),
    focus: Math.exp(ch((q) => Math.log(q.focus || Math.max(3, q.frame / (2 * Math.tan((q.fov * DEG) / 2)))))),
    index: idx, held: inHold != null ? shots[inHold] : null, from: shots[A], to: shots[B], r, moving, push,
  };
  // push-in and drift during holds, locked out for plan views
  const lock = smooth(70, 88, out.pitch);
  const sign = Math.round(idx) % 2 === 0 ? 1 : -1;
  out.frame *= 1 - 0.05 * push * (1 - lock);
  out.yaw += 1.2 * sign * push * (1 - lock);
  out.pitch = Math.min(89.5, out.pitch);
  out.dist = out.frame / (2 * Math.tan((out.fov * DEG) / 2));
  return out;
}

// value of a per-shot channel interpolated with the same hold / eased-move logic (cut height, exposure …)
export function channel(shots, s, key, fallback) {
  const smp = sample(shots, s);
  const val = (sh) => (sh[key] != null ? sh[key] : fallback);
  if (!smp.moving) return val(smp.from);
  const e = 0.5 - 0.5 * Math.cos(Math.PI * smp.r);
  return val(smp.from) + (val(smp.to) - val(smp.from)) * e;
}

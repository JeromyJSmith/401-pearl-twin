// Original hold/go timeline. Targets and explicit eyes stay between adjacent
// authored endpoints; each move eases to rest without a spline or held drift.
// Existing Z-up scene: yaw90 looks +Y; positive pitch looks down.
export const SCALE = 0.85 * 1.9;
const DEG = Math.PI / 180;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const quintic = (t) => { t = clamp01(t); return clamp01(t * t * t * (10 + t * (-15 + 6 * t))); };
const lerp = (a, b, t) => t <= 0 ? a : t >= 1 ? b : a + (b - a) * t;
const logLerp = (a, b, t) => t <= 0 ? a : t >= 1 ? b : Math.exp(lerp(Math.log(a), Math.log(b), t));
const explicitEye = (q) => Array.isArray(q.eye) && q.eye.length === 3 && q.eye.every(Number.isFinite);
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const direction = (p) => {
  const y = p.yaw * DEG, a = p.pitch * DEG;
  return [Math.cos(a) * Math.cos(y), Math.cos(a) * Math.sin(y), -Math.sin(a)];
};
const eyeOf = (p) => p.eye || direction(p).map((v, i) => [p.x, p.y, p.z][i] - p.dist * v);
const angle = (a, b) => {
  const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return Math.atan2(Math.hypot(...cross), a.reduce((s, v, i) => s + v * b[i], 0)) / DEG;
};
const shortest = (delta) => {
  const wrapped = ((delta + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 && delta > 0 ? 180 : wrapped;
};
function headings(shots) {
  const values = [shots[0].yaw];
  for (let i = 1; i < shots.length; i++) values.push(values[i - 1] + shortest(shots[i].yaw - values[i - 1]));
  return values;
}

export function layout(shots) {
  let s = 0;
  for (const sh of shots) {
    if (!Array.isArray(sh.t) || sh.t.length !== 3 || !sh.t.every(Number.isFinite)
        || !Number.isFinite(sh.yaw) || !Number.isFinite(sh.pitch) || Math.abs(sh.pitch) > 90) {
      throw new RangeError('Shot target and heading must be finite, with pitch between -90 and 90');
    }
    if (sh.eye != null && !explicitEye(sh)) throw new RangeError('Shot eye must contain three finite coordinates');
    for (const value of [sh.hold ?? 0, sh.go ?? 0]) {
      if (!Number.isFinite(value) || value < 0) throw new RangeError('Shot hold/go must be finite and nonnegative');
    }
    sh.h0 = s;
    sh.h1 = s + Math.max(0, sh.hold || 0) * SCALE;
    sh.g1 = sh.h1 + Math.max(0, sh.go || 0) * SCALE;
    s = sh.g1;
    if (!(sh.fov > 0 && sh.fov < 180)) throw new RangeError('Shot fov must be between 0 and 180 degrees');
    if (sh.frame == null) {
      const dist = sh.dist ?? (explicitEye(sh) ? distance(sh.eye, sh.t) : NaN);
      if (!(dist > 0)) throw new RangeError('Shot requires a positive dist/frame or eye-to-target distance');
      sh.frame = 2 * dist * Math.tan(sh.fov * DEG / 2);
    }
    if (!(sh.frame > 0) || !Number.isFinite(sh.frame)) throw new RangeError('Shot frame must be finite and positive');
    if (sh.focus != null && (!(sh.focus > 0) || !Number.isFinite(sh.focus))) throw new RangeError('Shot focus must be finite and positive');
  }
  return s;
}

function locate(shots, s) {
  for (let i = 0; i < shots.length; i++) {
    const a = shots[i];
    if (s <= a.h1 || i === shots.length - 1) return { i, j: i, r: 0, e: 0, moving: false };
    if (s < a.g1) {
      const r = clamp01((s - a.h1) / (a.g1 - a.h1));
      return { i, j: i + 1, r, e: quintic(r), moving: true };
    }
  }
}

export function sample(shots, s) {
  if (!shots.length) throw new RangeError('At least one camera shot is required');
  if (!Number.isFinite(s)) throw new RangeError('Camera scroll position must be finite');
  const { i, j, r, e, moving } = locate(shots, s);
  const a = shots[i], b = shots[j], yaw = headings(shots);
  const ch = (get) => lerp(get(a), get(b), e);
  const lens = (get) => logLerp(get(a), get(b), e);
  const out = {
    x: ch((q) => q.t[0]), y: ch((q) => q.t[1]), z: ch((q) => q.t[2]),
    yaw: lerp(yaw[i], yaw[j], e), pitch: ch((q) => q.pitch),
    fov: lens((q) => q.fov), frame: lens((q) => q.frame),
    focus: lens((q) => q.focus || Math.max(3, q.frame / (2 * Math.tan(q.fov * DEG / 2)))),
    index: i + (j - i) * e, held: !moving && (a.hold || 0) > 0 ? a : null,
    from: a, to: b, r, moving, push: 0,
  };
  out.dist = out.frame / (2 * Math.tan(out.fov * DEG / 2));
  if (explicitEye(a) && explicitEye(b)) out.eye = a.eye.map((v, k) => lerp(v, b.eye[k], e));
  return out;
}

export function channel(shots, s, key, fallback) {
  const p = sample(shots, s);
  const value = (sh) => sh[key] != null ? sh[key] : fallback;
  return lerp(value(p.from), value(p.to), quintic(p.r));
}

// Conservative path-length bounds in quintic's eased parameter, not just an
// endpoint test: fast seeks cannot hide outward-and-back camera excursions.
function segmentBounds(shots, s0, s1) {
  const mid = locate(shots, (s0 + s1) / 2);
  if (!mid.moving) return { world: 0, angular: 0 };
  const a = shots[mid.i], b = shots[mid.j], yaw = headings(shots);
  const eAt = (s) => quintic((s - a.h1) / (a.g1 - a.h1));
  const de = Math.abs(eAt(s1) - eAt(s0));
  const turn = Math.abs(yaw[mid.j] - yaw[mid.i]) + Math.abs(b.pitch - a.pitch);
  let world;
  if (explicitEye(a) && explicitEye(b)) world = distance(a.eye, b.eye);
  else {
    const fmax = Math.max(a.fov, b.fov) * DEG;
    const dmax = Math.max(a.frame, b.frame) / (2 * Math.tan(Math.min(a.fov, b.fov) * DEG / 2));
    const radial = Math.abs(Math.log(b.frame / a.frame)) + fmax / Math.sin(fmax) * Math.abs(Math.log(b.fov / a.fov));
    world = distance(a.t, b.t) + dmax * (radial + turn * DEG);
  }
  return { world: world * de, angular: turn * de };
}

export function advanceProgress(shots, currentNormalized, targetNormalized, dt, {
  maxVhPerSecond = 85, maxSpeed = 4, maxAngularSpeed = 22, maxFovSpeed = 12,
} = {}) {
  if (![currentNormalized, targetNormalized, dt].every(Number.isFinite)) throw new RangeError('Progress and elapsed seconds must be finite');
  const current = clamp01(currentNormalized), target = clamp01(targetNormalized);
  dt = Math.min(.05, Math.max(0, dt));
  for (const value of [maxVhPerSecond, maxSpeed, maxAngularSpeed, maxFovSpeed]) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Motion limits must be finite and nonnegative');
  }
  if (!dt || !shots.length || current === target) return current;
  const total = shots[shots.length - 1].g1;
  if (!Number.isFinite(total)) throw new RangeError('Layout must run before advancing the timeline');
  if (!(total > 0)) return current;
  const start = current * total, sign = Math.sign(target - current);
  let end = start + sign * Math.min(Math.abs(target * total - start), maxVhPerSecond * dt);
  // Visit every hold/via boundary, even when opposing segments cancel their pose.
  for (const sh of shots) for (const boundary of [sh.h0, sh.h1, sh.g1]) {
    if ((boundary - start) * sign > 1e-10 && (end - boundary) * sign > 0) end = boundary;
  }
  const pose = sample(shots, start), eye = eyeOf(pose), view = direction(pose);
  const within = (s) => {
    const p = sample(shots, s), bound = segmentBounds(shots, start, s);
    return bound.world <= maxSpeed * dt + 1e-10 && bound.angular <= maxAngularSpeed * dt + 1e-10
      && distance(eye, eyeOf(p)) <= maxSpeed * dt + 1e-10
      && angle(view, direction(p)) <= maxAngularSpeed * dt + 1e-10
      && Math.abs(p.fov - pose.fov) <= maxFovSpeed * dt + 1e-10;
  };
  if (within(end)) return clamp01(end / total);
  let low = 0, high = 1;
  for (let k = 0; k < 40; k++) {
    const f = (low + high) / 2;
    if (within(lerp(start, end, f))) low = f;
    else high = f;
  }
  return clamp01(lerp(start, end, low) / total);
}

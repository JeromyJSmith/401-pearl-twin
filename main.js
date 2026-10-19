// 401 Pearl — plan to walk, checkpoint 2: one scroll from the plan sheet through the permit clock (C), the house built
// in construction order (B), the site, and every room twice, existing then proposed (A), to the as-built plan and a
// free walk. Original MARPA code; the look follows Casa Serra (studied, not copied; that repo has no licence).
//
// One model drives everything: the fix29 composed IFCX + the 99z presentation-edits layer, baked by the server and
// re-baked live when either changes (server-sent `build` events). Each frame renders
//   1. a colour pass: CC0 PBR materials, the model's own IFCX colours for the existing pass, and the Gaussian splats,
//   2. a pre-pass into two float targets: view normal + paint state, world position + view depth; the cut plane, the
//      per-phase construction cuts and each room's two reveals are evaluated per fragment,
//   3. a composite: ink edges and paper with grain, black poché from back faces, the floor tile grid, the plan
//      annotations and red-lines on the floor, the orange reveal band on the joints, and the colour pass where revealed.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { drawSheet, sheetBounds, drawRedlines, redlineBounds } from './sheet.js';
import { furnish } from './furniture.js';
import { Post } from './post.js';
import { layout, sample, channel, advanceProgress } from './timeline.js';
import { buildRoomTransfer, directedPose } from './room-transfer.js';
import { createGeometryClearance } from './geometry-clearance.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { makeObservation, captureTriplet, replayObservation, comparisonCapture } from './observations.mjs';

const Q = new URLSearchParams(location.search);
const REC = Q.has('rec');
// owner 2026-10-18: the walk shows the as-built structure first: class shaders, no furniture, no Poly Haven floors, no
// interior scan (construction junk, ghost doors); ?look=proposed brings back the materials, furniture and the scan pass
const ASB = Q.get('look') !== 'proposed';
const NR = 64;          // room slots in the shaders (35 IfcSpaces on 2026-10-18; headroom for the basement)
const NP = 5;           // construction phases: 0 neighbour massing, 1 foundation + slabs, 2 ground floor, 3 upper floor, 4 roof
const DEG = Math.PI / 180;
const CUT_ABOVE_FLOOR = 1.2;
const EYE = 1.6;
const FT = 1200 / 3937;
const css = getComputedStyle(document.documentElement);
const ACCENT = css.getPropertyValue('--accent').trim() || '#f0500f';

// ---------- gate ----------
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
if (!renderer.capabilities.isWebGL2 || !renderer.extensions.get('EXT_color_buffer_float')) {
  document.querySelector('#loader .story').innerHTML = '<p class="line on">This walk needs WebGL2.</p>';
  throw new Error('WebGL2 with float render targets is required');
}
const DPR = Math.min(window.devicePixelRatio || 1, REC ? 1 : 1.5);
renderer.setPixelRatio(DPR);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.autoClear = false;

// ---------- loader ----------
const loader = document.getElementById('loader');
const loadStart = performance.now();
[...loader.querySelectorAll('.line')].forEach((l, i) => setTimeout(() => l.classList.add('on'), 250 + i * 900));
const parts = { fonts: 0, model: 0, splat: 0, tex: 0 };
function setLoad() {
  const p = (parts.fonts + parts.model * 2 + parts.splat * 3 + parts.tex) / 7;
  document.getElementById('loadbar').style.width = `${(p * 100).toFixed(0)}%`;
  document.getElementById('loadpct').textContent = `${(p * 100).toFixed(0)}%`;
}
const fontsReady = Promise.all(['500 20px "Geist Mono"', '400 20px "Geist Mono"', '20px "Saira Stencil One"', '20px "Instrument Serif"'].map((f) => document.fonts.load(f)))
  .then(() => { parts.fonts = 1; setLoad(); });
// the published copy (GitHub Pages / Vercel) has no server: read-only, no live rebuilds, no edits or new flags
const STATIC = document.documentElement.dataset.static === '1';
const getJSON = async (u) => { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); };
const [data0, site, context, build0] = await Promise.all([getJSON('model.json'), getJSON('site.json'), getJSON('context.json'), getJSON('build.json')]);
parts.model = 1; setLoad();
await fontsReady;

// ---------- frame: house axis from the main-level rooms (length-weighted median edge direction mod 90°) ----------
function houseAxisDeg(spaces) {
  const edges = [];
  for (const s of spaces) {
    const f = s.footprint;
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L > 0.3) edges.push([((Math.atan2(b[1] - a[1], b[0] - a[0]) / DEG) % 90 + 90) % 90, L]);
    }
  }
  edges.sort((x, y) => x[0] - y[0]);
  const half = edges.reduce((s, e) => s + e[1], 0) / 2;
  let acc = 0;
  for (const [deg, L] of edges) { acc += L; if (acc >= half) return deg > 45 ? deg - 90 : deg; }
  return 0;
}
const storeyOf = (d, re) => d.storeys.find((s) => re.test(s.name));
const MAIN0 = storeyOf(data0, /main/i) || data0.storeys[1];
const AXIS = houseAxisDeg(data0.spaces.filter((s) => s.storey === MAIN0.id));
const ca = Math.cos(-AXIS * DEG), sa = Math.sin(-AXIS * DEG);
const toHouse = ([x, y]) => [x * ca - y * sa, x * sa + y * ca];

// ---------- scene ----------
const scene = new THREE.Scene();
const world = new THREE.Group();   // model frame (IFCX local metres) rotated into the house frame
world.rotation.z = -AXIS * DEG;
scene.add(world);
const overlay = new THREE.Scene(); // red-line envelope, drawn over the composite

// shared uniforms: cut, construction phases, room maps and both reveals
const U = {
  uNear: { value: 0.1 }, // camera.near, for the poché depth nudge in the pre-pass
  uPocheOff: { value: 0 }, // 1: back faces read as the surface, not black poché (as-built walk with no cut)
  uCut: { value: 99 },
  uPhaseCut: { value: new Float32Array(NP).fill(99) },
  uRoomMapA: { value: null }, uRoomMapB: { value: null },
  uMapMin: { value: new THREE.Vector2() }, uMapSize: { value: new THREE.Vector2(1, 1) },
  uMapZ: { value: new THREE.Vector4(-9, -9, -9, -9) },
  uRev1: { value: new Float32Array(NR) }, uRev2: { value: new Float32Array(NR) },
  uOrg: { value: Array.from({ length: NR }, () => new THREE.Vector3()) },
  uRad: { value: new Float32Array(NR).fill(8) },
  uExist: { value: new Float32Array(NR) }, // 1: the existing pass is the scan (model surfaces step aside)
  uAll: { value: 0 },
  uExtOrg: { value: new THREE.Vector3() }, uExtRev1: { value: 0 }, uExtRev2: { value: 0 }, uExtRad: { value: 14 },                      // 1: every surface plays as proposed (finale, free walk)
  uBand: { value: 0.9 },                   // width of the reveal band behind the front (m)
};

// ---------- CC0 textures (Poly Haven) ----------
const texLoader = new THREE.TextureLoader();
const tex = (path, srgb) => new Promise((res) => texLoader.load(path, (t) => {
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  res(t);
}, undefined, () => res(null)));
const [woodD, woodR, plasterD] = await Promise.all([tex('textures/wood_floor/diff.jpg', true), tex('textures/wood_floor/rough.jpg', false), tex('textures/plaster/diff.jpg', true)]);
parts.tex = 1; setLoad();

// ---------- shader chunks ----------
const COMMON_GLSL = /* glsl */`
#ifndef NR
#define NR ${NR}
#define NP ${NP}
#endif
uniform float uCut; uniform float uPhaseCut[NP];
uniform sampler2D uRoomMapA, uRoomMapB; uniform vec2 uMapMin, uMapSize; uniform vec4 uMapZ;
uniform float uRev1[NR], uRev2[NR], uRad[NR], uExist[NR]; uniform vec3 uOrg[NR];
uniform float uAll, uBand; uniform vec3 uExtOrg; uniform float uExtRev1, uExtRev2, uExtRad;
bool cutAway(vec3 wp, float phase) { return wp.z > min(uCut, uPhaseCut[int(phase + 0.5)]); }
int roomAt(vec3 wp, vec3 nw) {
  vec2 uv = (wp.xy + nw.xy * 0.12 - uMapMin) / uMapSize;
  float r;
  if (wp.z > uMapZ.x && wp.z < uMapZ.y) r = texture(uRoomMapA, uv).r;
  else if (wp.z > uMapZ.z && wp.z < uMapZ.w) r = texture(uRoomMapB, uv).r;
  else return -1;
  return int(r * 255.0 + 0.5) - 1;
}
// state: 0 drawing, 1 revealed, 2 revealed inside the moving band; pass: 1 existing, 2 proposed
float revealAt(vec3 wp, vec3 nw, float phase, out int idx, out float pass) {
  pass = 0.0; idx = -1;
  if (phase < 0.5) return 0.0; // the neighbour stays a drawing
  if (uAll > 0.5) { pass = 2.0; return 1.0; }
  idx = roomAt(wp, nw);
  if (idx < 0) { // outside faces, roofs, foundation, basement: the exterior sweeps from the house centre, low to high
    float de = distance(wp.xy, uExtOrg.xy) * 0.6 + max(wp.z - uExtOrg.z, 0.0);
    float E2 = uExtRev2 * uExtRad, E1 = uExtRev1 * uExtRad;
    if (de < E2) { pass = 2.0; return de > E2 - uBand * 1.6 && uExtRev2 < 0.999 ? 2.0 : 1.0; }
    if (de < E1) { pass = 1.0; return de > E1 - uBand * 1.6 && uExtRev1 < 0.999 ? 2.0 : 1.0; }
    return 0.0;
  }
  if (idx >= NR) return 0.0;
  float d = distance(wp.xy, uOrg[idx].xy) + max(wp.z - uOrg[idx].z, 0.0) * 0.55;
  float R2 = uRev2[idx] * uRad[idx], R1 = uRev1[idx] * uRad[idx];
  if (d < R2) { pass = 2.0; return d > R2 - uBand && uRev2[idx] < 0.999 ? 2.0 : 1.0; }
  if (d < R1) { pass = 1.0; return d > R1 - uBand && uRev1[idx] < 0.999 ? 2.0 : 1.0; }
  return 0.0;
}`;

// ---------- materials by slot ----------
// Every model element takes a slot from its IFCX material (bsi::ifc::material); the colour pass picks the slot's
// finish from two palettes: the existing pass plays the house as found (direction A, from the drone capture and the
// model of record), the proposed pass plays the chosen exterior direction (B by default, ?ext=A|B|C). Exterior walls
// show siding outside and plaster inside (the room-id map decides which face is which); floors show wood on top and a
// ceiling below; the foundation's top is the porch deck. Surface detail is procedural (lap lines, shingle courses,
// standing seams, stone) with the CC0 oak floor and plaster textures.
const SLOT = { plaster: 0, siding: 1, roof: 2, fascia: 3, stone: 4, floor: 5, concrete: 6, door: 7, stair: 8, furniture: 9, partition: 10, valance: 11, deck: 12, ceiling: 13, membrane: 14, counter: 15, glass: 16 };
const NS = 17;
function slotOf(e) {
  const m = (e.material || '').toLowerCase(), c = e.cls;
  if (c === 'IfcDoor') return SLOT.door;
  if (c === 'IfcWindow' || /glass|glazing/.test(m)) return SLOT.glass; // glazing plates too (IfcPlate, fix34)
  if (/stair|tread|winder|newel|stringer|baluster|handrail|post/.test(m) || /IfcStair|IfcRailing|IfcMember/.test(c)) return SLOT.stair;
  if (/clapboard|exterior wall|siding/.test(m)) return SLOT.siding;
  if (/plaster|party wall|half wall/.test(m)) return SLOT.plaster;
  if (/wood stud partition/.test(m)) return SLOT.partition;
  if (/foundation|stone/.test(m)) return SLOT.stone;
  if (/shingle|standing seam|metal roof/.test(m) || (c === 'IfcRoof' && !/membrane/.test(m))) return SLOT.roof;
  if (/membrane/.test(m)) return SLOT.membrane;
  if (/fascia|rake/.test(m)) return SLOT.fascia;
  if (/valance/.test(m)) return SLOT.valance;
  if (/concrete/.test(m)) return SLOT.concrete;
  if (/countertop/.test(m)) return SLOT.counter;
  if (/floor framing|timber floor/.test(m) || c === 'IfcSlab') return SLOT.floor;
  if (c === 'IfcWall') return SLOT.plaster;
  return SLOT.fascia;
}
const hexes = (list) => list.map((h) => new THREE.Color(h)); // sRGB hex -> linear
// slot order: plaster, siding, roof, fascia, stone, floor, concrete, door, stair, furniture, partition, valance, deck, ceiling, membrane, counter
const PALETTES = {
  A: hexes(['#ebe7df', '#e6e4de', '#a9adb0', '#24365a', '#b9a58c', '#a87b52', '#8e9192', '#efeeea', '#c9c7c2', '#ffffff', '#c9c7c2', '#f3f2ee', '#8e9192', '#f1efea', '#b4b6b6', '#9b7350', '#b9c8cf']),
  B: hexes(['#f1ede4', '#ece5d6', '#3b3e42', '#1f1f1f', '#b98a5c', '#b4895c', '#a2a3a1', '#7b5a3e', '#b4895c', '#ffffff', '#d9d3c8', '#f4f1ea', '#7b5a3e', '#f6f3ec', '#4a4d51', '#b4895c', '#b9c8cf']),
  // as built: one quiet palette for both passes, walls / floors / stairs / ceilings told apart by tone, not texture.
  // Outside as it stands today (owner 2026-10-18): blue siding; trim, fascia, shutters and porch posts white
  S: hexes(['#ece7de', '#5b7a99', '#6d7276', '#f2f1ec', '#b9a58c', '#cdbfa8', '#9a9c9b', '#e2ddd3', '#a4a8ac', '#ffffff', '#e4ded4', '#ecebe6', '#b3a58f', '#f4f2ec', '#7a7e82', '#d8d2c6', '#b9c8cf']),
  C: hexes(['#f1ede4', '#2b302c', '#1d1f21', '#1d1f21', '#b98a5c', '#9c6b3f', '#a2a3a1', '#9c6b3f', '#9c6b3f', '#ffffff', '#d9d3c8', '#efeeea', '#6e5038', '#f6f3ec', '#26292c', '#9c6b3f', '#b9c8cf']),
};
const ROUGH = [0.92, 0.8, 0.6, 0.5, 0.95, 0.55, 0.85, 0.45, 0.6, 0.7, 0.9, 0.7, 0.75, 0.95, 0.85, 0.4, 0.05];
const EXT = PALETTES[(Q.get('ext') || 'B').toUpperCase()] ? (Q.get('ext') || 'B').toUpperCase() : 'B';
U.uPalA = { value: ASB ? PALETTES.S : PALETTES.A };
U.uPalP = { value: ASB ? PALETTES.S : PALETTES[EXT] };
U.uStruct = { value: ASB ? 1 : 0 };
U.uRough = { value: Float32Array.from(ROUGH) };
U.uWood = { value: woodD };
U.uWoodR = { value: woodR };
U.uMetalRoof = { value: ASB || EXT === 'A' ? 0 : 1 }; // A keeps asphalt shingle; B and C are standing seam

const SLOT_GLSL = /* glsl */`
#define NS ${NS}
uniform vec3 uPalA[NS]; uniform vec3 uPalP[NS]; uniform float uRough[NS];
uniform sampler2D uWood, uWoodR; uniform float uMetalRoof; uniform float uStruct;
float h1(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h1(i), h1(i + vec2(1, 0)), f.x), mix(h1(i + vec2(0, 1)), h1(i + vec2(1, 1)), f.x), f.y); }
// returns albedo (linear) and writes roughness
vec3 slotFinish(int s, vec3 wp, vec3 n, bool proposed, out float rough) {
  vec3 base = proposed ? uPalP[s] : uPalA[s];
  rough = uRough[s];
  vec2 hz = abs(n.x) > abs(n.y) ? vec2(wp.y, wp.z) : vec2(wp.x, wp.z); // wall-plane coordinates (along, up)
  if (s == ${SLOT.siding}) { // lap siding: 0.15 m courses, a shadow line under each lap
    float c = fract(wp.z / 0.15);
    base *= 0.82 + 0.18 * smoothstep(0.0, 0.18, c) - 0.05 * n2(hz * vec2(0.6, 6.0));
  } else if (s == ${SLOT.roof}) {
    if (uMetalRoof > 0.5 && proposed) { float sm = fract(dot(wp.xy, vec2(0.7071, 0.7071)) / 0.45); base *= 0.9 + 0.1 * smoothstep(0.0, 0.04, sm) * smoothstep(1.0, 0.96, sm); rough = 0.35; }
    else { float row = floor(wp.z / 0.14); float tab = fract((dot(wp.xy, vec2(0.7071, -0.7071)) + row * 0.17) / 0.33);
      base *= 0.8 + 0.2 * smoothstep(0.0, 0.08, fract(wp.z / 0.14)) * (0.9 + 0.1 * step(0.04, tab)) + 0.06 * (h1(vec2(row, floor(tab * 9.0))) - 0.5); }
  } else if (s == ${SLOT.stone}) { // rubble sandstone: irregular blocks, warm variation, mortar
    vec2 q = hz * vec2(2.4, 3.4); vec2 cell = floor(q + vec2(0.0, floor(q.y) * 0.5)); vec2 f = fract(q + vec2(0.0, floor(q.y) * 0.5));
    float mortar = smoothstep(0.0, 0.06, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
    base *= mix(0.62, 1.0, mortar) * (0.78 + 0.32 * h1(cell)) * (0.9 + 0.2 * n2(q * 3.0));
  } else if (uStruct > 0.5 && (s == ${SLOT.floor} || s == ${SLOT.deck})) { // as built: fine board lines, no texture
    float b = fract(wp.x / 0.14); base *= 0.95 + 0.05 * smoothstep(0.0, 0.05, b) * smoothstep(1.0, 0.95, b);
  } else if (uStruct > 0.5 && s == ${SLOT.stair}) { // grey, no wood: treads light and alternating step to step, risers and stringers dark
    float step2 = mod(floor(wp.z / 0.19 + 0.5), 2.0);
    base *= n.z > 0.6 ? (1.32 - 0.16 * step2) : 0.62;
  } else if (s == ${SLOT.floor} || s == ${SLOT.deck} || s == ${SLOT.stair} && proposed) {
    vec3 w = texture(uWood, wp.xy / 2.2).rgb; base = w * mix(vec3(1.05), base * 1.6, 0.3); rough = texture(uWoodR, wp.xy / 2.2).g;
  } else if (s == ${SLOT.concrete}) { base *= 0.9 + 0.12 * n2(wp.xy * 3.0) + 0.04 * n2(wp.xy * 40.0); }
  else if (s == ${SLOT.plaster} || s == ${SLOT.ceiling}) { base *= 0.96 + 0.04 * n2(hz * 9.0); }
  return base;
}`;

// colour pass material: slot finishes, existing palette in the existing pass, the chosen direction in the proposed
// pass, 99z edits and furniture take their own colour; surfaces step aside where the existing pass is the scan
function cutMaterial(params) {
  const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, ...params });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPhase; attribute float aFurn; attribute vec3 aCol; attribute float aEdit; attribute float aSlot; attribute float aBias;\nvarying vec3 vWp; varying vec3 vWn; varying float vPhase; varying float vFurn; varying vec3 vCol; varying float vEdit; varying float vSlot;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz; vWn = normalize(mat3(modelMatrix) * objectNormal); vPhase = aPhase; vFurn = aFurn; vCol = aCol; vEdit = aEdit; vSlot = aSlot;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  gl_Position.z -= aBias * 2.0e-5 * gl_Position.w;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWp; varying vec3 vWn; varying float vPhase; varying float vFurn; varying vec3 vCol; varying float vEdit; varying float vSlot;\n${COMMON_GLSL}\n${SLOT_GLSL}\nfloat gPass; float gRough;`)
      .replace('void main() {', `void main() {
  if (cutAway(vWp, vPhase)) discard;
  { int ridx; float pass; revealAt(vWp, normalize(gl_FrontFacing ? vWn : -vWn), vPhase, ridx, pass); gPass = pass;
    if (pass > 0.5 && pass < 1.5 && ridx >= 0 && (uExist[ridx] > 0.5 || vFurn > 0.5)) discard;
    // only revealed surfaces exist in the colour pass: where a room steps aside for its scan, nothing unrevealed
    // behind it (shown in its proposed material) may leak into the composite
    if (pass < 0.5) discard; }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
  {
    vec3 nW = normalize(gl_FrontFacing ? vWn : -vWn);
    int s = int(vSlot + 0.5);
    if (s == ${SLOT.siding}) { int ri = roomAt(vWp, nW); if (ri >= 0) s = ${SLOT.plaster}; }      // inside face of an exterior wall
    if (s == ${SLOT.floor} && nW.z < -0.5) s = ${SLOT.ceiling};
    if ((s == ${SLOT.roof} || s == ${SLOT.membrane}) && roomAt(vWp, nW) >= 0) s = ${SLOT.ceiling};       // a roof seen from inside is a ceiling                                        // underside of a floor
    if (s == ${SLOT.stone} && nW.z > 0.5) s = ${SLOT.deck};                                            // top of the foundation: porch deck
    gRough = uRough[s];
    if (vEdit > 0.5) diffuseColor.rgb = vCol;
    else diffuseColor.rgb = slotFinish(s, vWp, nW, gPass > 1.5, gRough);
  }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = gRough;');
  };
  return m;
}
const MAT = {
  solid: cutMaterial({ color: 0xffffff, roughness: 0.8 }),
  IfcWindow: cutMaterial({ color: 0x9fb3bf, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.32 }),
};
MAT.furniture = MAT.solid; MAT.default = MAT.solid;
// furniture takes its kit colour in the proposed pass: use the aCol path with aEdit=1
// pre-pass
const PRE_VS = /* glsl */`
precision highp float;
uniform mat4 modelMatrix, viewMatrix, projectionMatrix;
uniform mat3 normalMatrix;
in vec3 position; in vec3 normal; in float aPhase; in float aFurn; in float aBias;
out vec3 vW; out vec3 vNV; out vec3 vNW; out float vD; out float vPhase; out float vFurn;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz; vNW = normalize(mat3(modelMatrix) * normal); vNV = normalize(normalMatrix * normal); vPhase = aPhase; vFurn = aFurn;
  vec4 mv = viewMatrix * w; vD = -mv.z;
  gl_Position = projectionMatrix * mv;
  gl_Position.z -= aBias * 2.0e-5 * gl_Position.w;
}`;
const PRE_FS = /* glsl */`
precision highp float; precision highp int;
${COMMON_GLSL}
uniform float uKind; uniform float uPocheOff; uniform float uNear;
in vec3 vW; in vec3 vNV; in vec3 vNW; in float vD; in float vPhase; in float vFurn;
layout(location = 0) out vec4 gND;
layout(location = 1) out vec4 gW;
// paint state, /8 in alpha: 0 paper, 1 revealed, 2 reveal band, 3 poché, 4 ground sheet, 5 selected, 6 furniture paper
void main() {
  if (abs(uKind - 4.0) > 0.5 && cutAway(vW, vPhase)) discard;
  vec3 nv = normalize(vNV), nw = normalize(vNW);
  float state = uKind;
  if (uKind < 0.5) {
    if (!gl_FrontFacing) {
      state = uPocheOff > 0.5 ? 1.0 : 3.0; nv = -nv;
      if (vFurn > 0.5) { int bi; float bp; revealAt(vW, -nw, vPhase, bi, bp); if (bp > 0.5 && bp < 1.5) discard; }
    }
    else {
      int idx; float pass; state = revealAt(vW, nw, vPhase, idx, pass);
      if (state < 0.5 && vFurn > 0.5) state = 6.0;
      if (pass > 0.5 && pass < 1.5 && vFurn > 0.5 && idx >= 0) discard; // furniture hides while the room is its scan
    }
  } else if (uKind > 4.5 && !gl_FrontFacing) { nv = -nv; }
  gND = vec4(nv * 0.5 + 0.5, state / 8.0);
  gW = vec4(vW, vD);
  // a cut wall shows its inside (back faces) as poché; an interior wall stands on the slab, so its inside bottom face is
  // coplanar with the slab top and loses the depth test there. Back faces come 2 mm nearer (depth = 1 - near/d, so
  // a 2 mm step is 0.002 (1 - z)^2 / near): every cut wall reads solid on the plan, nothing else moves.
  float z = gl_FragCoord.z;
  gl_FragDepth = gl_FrontFacing ? z : max(0.0, z - 0.002 * (1.0 - z) * (1.0 - z) / max(uNear, 1e-3));
}`;
const preMaterial = (kind) => new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3, vertexShader: PRE_VS, fragmentShader: PRE_FS, side: THREE.DoubleSide,
  uniforms: { ...U, uKind: { value: kind }, uPocheOff: U.uPocheOff, uNear: U.uNear },
});
const PRE = preMaterial(0), PRE_SEL = preMaterial(5);

// ---------- model (rebuilt in place on every live build) ----------
const M = { meshes: [], rooms: [], spaces: [], storeys: {}, doors: {}, group: null, furn: null, build: build0 };
const ROOM_GROUPS = [
  ['AptA - Entry'], ['AptA - Front room'], ['AptA - Living area'], ['AptA - Kitchen w/ bar'], ['AptA - Pantry', 'AptA - Refrigerator'],
  ['AptA - Bathroom'], ['AptA - Stairs up'], ['Upper - Stairs', 'Upper - Hallway'], ['Upper - Room 2', 'Upper - Closet'], ['Upper - Room 1'],
  ['Upper - Toilet', 'Upper - Shower'], ['Upper - Room 3', 'Upper - Room 3 closet'], ['AptA - Stairs to basement'],
  ['@basement'], ['@porch-east'], ['AptB - Front Room'], ['AptB - Kitchen'], ['AptB - Nook'], ['AptB - Bathroom'], ['AptB - Bedroom'],
];

function phaseOf(e, storeys) {
  if (e.cls === 'IfcRoof') return 4;
  const s = storeys[e.storey]?.name || '';
  if (/basement/i.test(s)) return 1;
  if (e.cls === 'IfcSlab' && /main/i.test(s) && !/bar/i.test(e.name || '')) return 1;
  if (/upper/i.test(s)) return 3;
  return 2;
}
let BIAS_SEQ = 0;
function geometryFor(e, phase, furn, col, edited, toH, slot = 0) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(e.positions, 3));
  geo.setIndex(e.indices);
  const flat = geo.toNonIndexed();
  flat.computeVertexNormals();
  const p = flat.attributes.position, n = flat.attributes.normal, N = p.count;
  const uv = new Float32Array(N * 2), ph = new Float32Array(N).fill(phase), fu = new Float32Array(N).fill(furn);
  const cc = new Float32Array(N * 3), ed = new Float32Array(N).fill(edited ? 1 : 0);
  for (let i = 0; i < N; i++) {
    const [hx, hy] = toH([p.getX(i), p.getY(i)]);
    const [nx, ny] = toH([n.getX(i), n.getY(i)]);
    const up = Math.abs(n.getZ(i)) > 0.7;
    uv[i * 2] = up ? hx / 2.2 : (Math.abs(nx) > Math.abs(ny) ? hy : hx) / 2.2;
    uv[i * 2 + 1] = up ? hy / 2.2 : p.getZ(i) / 2.2;
    cc[i * 3] = col[0]; cc[i * 3 + 1] = col[1]; cc[i * 3 + 2] = col[2];
  }
  flat.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  flat.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
  flat.setAttribute('aFurn', new THREE.BufferAttribute(fu, 1));
  flat.setAttribute('aCol', new THREE.BufferAttribute(cc, 3));
  flat.setAttribute('aEdit', new THREE.BufferAttribute(ed, 1));
  flat.setAttribute("aSlot", new THREE.BufferAttribute(new Float32Array(N).fill(slot), 1));
  // a fixed per-element depth priority: duplicate / coplanar surfaces in the model always resolve the same way (no z-fighting flicker)
  flat.setAttribute("aBias", new THREE.BufferAttribute(new Float32Array(N).fill(((BIAS_SEQ++ * 37) % 97) / 97), 1));
  return flat;
}
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// context: the 2010 4th St proposed massing was removed (owner 2026-10-18: "not in the right spot and not correct at
// all"); context.json is still served but nothing is built from it. The group stays empty so phase 0 and the redline
// bounds keep a defined (zero) box at the origin.
const ctxGroup = new THREE.Group();
world.add(ctxGroup);
const ctxBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0));
void context;
world.updateMatrixWorld(true);

// ---------- CC0 furniture models (Poly Haven, assets/MANIFEST.json) ----------
// glTF is Y-up metres; each piece is turned Z-up, faced into its room, scaled down only if it does not fit its slot,
// and given the presentation attributes so it cuts, reveals and inks like the model. Kinds the catalogue lacks
// (toilet, tub, vanity, shower tray, wardrobe, counter run, fridge) stay as plain proxy boxes.
const KIND_MODEL = { sofa: 'sofa_02', coffee: 'modern_coffee_table_01', chair: 'mid_century_lounge_chair', bed: 'GothicBed_01',
  night: 'painted_wooden_nightstand', table: 'dining_table', stool: 'bar_chair_round_01', shelf: 'wooden_display_shelves_01',
  bench: 'painted_wooden_bench', desk: 'ClassicConsole_01', wardrobe: 'drawer_cabinet' };
// decor added next to a kind: [model, offset along the piece's width, offset forward, z on top of the piece (1) or floor (0)]
const KIND_DECOR = { coffee: [['ceramic_vase_01', 0.25, 0, 1], ['book_encyclopedia_set_01', -0.2, 0, 1]], sofa: [['throw_pillows_01', 0, 0.05, 0.45], ['potted_plant_01', 1.35, 0.15, 0]],
  night: [['industrial_pipe_lamp', 0, 0, 1]], table: [['wooden_bowl_01', 0, 0, 1]], counter: [['pot_enamel_01', -0.5, 0, 1], ['wooden_cutting_board', 0.4, 0, 1]],
  bench: [['potted_plant_02', 0.9, 0, 0]], desk: [['ceramic_vase_02', 0.4, 0, 1], ['standing_picture_frame_01', -0.4, 0, 1]], tub: [['potted_plant_04', 0.9, 0.1, 0]] };
let manifest = null;
const modelCache = new Map();
const gltfLoader = new GLTFLoader();
async function loadModels() {
  try { manifest = await getJSON('assets/MANIFEST.json'); } catch { manifest = null; return; }
  const want = new Set([...Object.values(KIND_MODEL), ...Object.values(KIND_DECOR).flat().map((d) => d[0])]);
  const load = async (url, tries = 3) => { for (let k = 1; ; k++) { try { return await gltfLoader.loadAsync(url); } catch (e) { if (k >= tries) throw e; await new Promise((r) => setTimeout(r, 300 * k)); } } };
  await Promise.all(manifest.models.filter((m) => want.has(m.id)).map((m) => load(`assets/${m.gltf}`).then((g) => {
    const root = g.scene; root.rotation.x = Math.PI / 2; // Y-up -> Z-up
    const holder = new THREE.Group(); holder.add(root); holder.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(holder);
    root.position.set(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -b.min.z); // centre on the floor point
    holder.updateMatrixWorld(true);
    modelCache.set(m.id, { holder, size: b.getSize(new THREE.Vector3()) });
  }).catch((err) => console.warn('model', m.id, err.message))));
}
const furnMats = new Map();
function presentationMaterial(src) { // the glTF material with the cut, reveal and existing-pass rules of the model
  if (furnMats.has(src)) return furnMats.get(src);
  const m = src.clone();
  m.side = THREE.DoubleSide;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPhase;\nvarying vec3 vWp; varying vec3 vWn; varying float vPhase;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz; vWn = normalize(mat3(modelMatrix) * objectNormal); vPhase = aPhase;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWp; varying vec3 vWn; varying float vPhase;\n${COMMON_GLSL}`)
      .replace('void main() {', `void main() {
  if (cutAway(vWp, vPhase)) discard;
  { int ridx; float pass; revealAt(vWp, normalize(gl_FrontFacing ? vWn : -vWn), vPhase, ridx, pass); if (pass < 1.5) discard; }`);
  };
  m.customProgramCacheKey = () => 'presentation-furniture';
  furnMats.set(src, m);
  return m;
}
function placeModel(id, at, yaw, fit, phase, label) {
  const c = modelCache.get(id);
  if (!c) return null;
  const g = c.holder.clone(true);
  const s = fit ? Math.min(1, fit[0] / c.size.x, fit[1] / c.size.y) : 1;
  const piece = new THREE.Group();
  piece.add(g); piece.position.set(at[0], at[1], at[2]); piece.rotation.z = yaw; piece.scale.setScalar(s);
  piece.updateMatrixWorld(true);
  const meshes = [];
  piece.traverse((o) => {
    if (!o.isMesh) return;
    const N = o.geometry.attributes.position.count;
    o.geometry = o.geometry.clone();
    o.geometry.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(N).fill(phase), 1));
    o.geometry.setAttribute('aFurn', new THREE.BufferAttribute(new Float32Array(N).fill(1), 1));
    const mat = Array.isArray(o.material) ? o.material.map(presentationMaterial) : presentationMaterial(o.material);
    o.material = mat; o.castShadow = true; o.receiveShadow = true;
    o.userData = { e: { cls: 'Furniture (CC0 model)', name: `${label} · ${id}`, id: null }, color: mat, pre: PRE, phase, proxy: true };
    meshes.push(o);
  });
  return { piece, meshes, size: c.size.clone().multiplyScalar(s) };
}
function disposeModel() {
  if (M.group) { world.remove(M.group); M.group.traverse((o) => o.geometry?.dispose()); }
  if (M.furn) { scene.remove(M.furn); M.furn.traverse((o) => o.geometry?.dispose()); }
  for (const d of Object.values(M.doors)) scene.remove(d.pivot);
}

// an IfcDoor arrives as one mesh: casing, frame and leaf. Split it by connected parts so only the leaf swings
// (the leaf is the part with the lowest head; casing and frame stay in the wall)
function splitDoor(e) {
  const P = e.positions, I = e.indices, key = (i) => `${P[3 * i].toFixed(4)},${P[3 * i + 1].toFixed(4)},${P[3 * i + 2].toFixed(4)}`;
  const id = new Map(), par = [];
  const vid = I.map((i) => { const k = key(i); if (!id.has(k)) { id.set(k, par.length); par.push(par.length); } return id.get(k); });
  const find = (a) => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
  for (let t = 0; t < vid.length; t += 3) { const a = find(vid[t]); par[find(vid[t + 1])] = a; par[find(vid[t + 2])] = a; }
  const parts = new Map();
  for (let t = 0; t < vid.length; t += 3) { const r = find(vid[t]); if (!parts.has(r)) parts.set(r, []); parts.get(r).push(I[t], I[t + 1], I[t + 2]); }
  if (parts.size < 2) return [e];
  const top = (tri) => Math.max(...tri.map((i) => P[3 * i + 2]));
  const list = [...parts.values()].sort((a, b) => top(a) - top(b));
  const leaf = list[0], rest = list.slice(1).flat();
  return [{ ...e, indices: rest, doorPart: 'frame' }, { ...e, indices: leaf, doorPart: 'leaf' }];
}

// centre and radius of a polygon's largest inscribed circle, by a coarse-to-fine grid search (plan units)
function labelPole(poly) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const segD = (px, py) => { let d = Infinity; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [ax, ay] = poly[j], [bx, by] = poly[i]; const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-9; const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)); d = Math.min(d, Math.hypot(px - ax - t * dx, py - ay - t * dy)); } return d; };
  let best = [(x0 + x1) / 2, (y0 + y1) / 2, 0];
  for (let pass = 0; pass < 3; pass++) {
    const n = 24, sx = (x1 - x0) / n, sy = (y1 - y0) / n;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
      const px = x0 + i * sx, py = y0 + j * sy;
      if (!pointIn([px, py], poly)) continue;
      const d = segD(px, py); if (d > best[2]) best = [px, py, d];
    }
    const hx = (x1 - x0) / 8, hy = (y1 - y0) / 8; x0 = best[0] - hx; x1 = best[0] + hx; y0 = best[1] - hy; y1 = best[1] + hy;
  }
  return best;
}

function buildModel(data) {
  disposeModel();
  const storeys = Object.fromEntries(data.storeys.map((s) => [s.id, s]));
  const main = storeyOf(data, /main/i), upper = storeyOf(data, /upper/i), base = storeyOf(data, /basement/i);
  M.storeys = { main, upper, base };
  M.FFL = main.elevation;
  M.group = new THREE.Group();
  M.meshes = [];
  M.wallBase = Math.min(...data.elements.filter((e) => e.cls === 'IfcWall' && phaseOf(e, storeys) === 2 && e.positions?.length).map((e) => { let z = Infinity; for (let i = 2; i < e.positions.length; i += 3) z = Math.min(z, e.positions[i]); return z; }));
  for (const e of data.elements.flatMap((x) => x.cls === 'IfcDoor' ? splitDoor(x) : [x])) {
    const phase = phaseOf(e, storeys);
    const col = (e.color || [0.8, 0.8, 0.8]).map(srgbToLinear);
    const mat = e.cls === "IfcWindow" || slotOf(e) === SLOT.glass ? MAT.IfcWindow : MAT.solid;
    const mesh = new THREE.Mesh(geometryFor(e, phase, 0, col, e.edited, toHouse, slotOf(e)), mat);
    mesh.castShadow = mesh.receiveShadow = mat !== MAT.IfcWindow;
    mesh.userData = { e, color: mat, pre: PRE, phase };
    M.group.add(mesh);
    M.meshes.push(mesh);
  }
  world.add(M.group);
  world.updateMatrixWorld(true);
  M.box = new THREE.Box3().setFromObject(M.group);
  M.phaseZ = Array.from({ length: NP }, () => [Infinity, -Infinity]);
  for (const m of M.meshes) {
    const b = new THREE.Box3().setFromObject(m), z = M.phaseZ[m.userData.phase];
    z[0] = Math.min(z[0], b.min.z); z[1] = Math.max(z[1], b.max.z);
  }
  M.phaseZ[0] = [ctxBox.min.z, ctxBox.max.z];

  // rooms (all storeys), house coordinates
  const order = ROOM_GROUPS.flat();
  M.spaces = data.spaces.map((s, i) => {
    const poly = s.footprint.map(toHouse);
    const us = poly.map((p) => p[0]), vs = poly.map((p) => p[1]);
    const bbox = [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)];
    const apt = (s.name.match(/^Apt\s?([A-Z])/i) || [])[1];
    return {
      i, s, poly, name: s.name, bbox, floorZ: s.floor_z, storey: storeys[s.storey]?.name || '',
      apt: apt ? `Apartment ${apt}` : /upper/i.test(s.name) ? 'Upper level' : '',
      label: s.name.replace(/^[^-]*-\s*/, ''), area: s.net_floor_area, height: s.height,
      w: bbox[2] - bbox[0], d: bbox[3] - bbox[1], cu: (bbox[0] + bbox[2]) / 2, cv: (bbox[1] + bbox[3]) / 2,
      n: order.indexOf(s.name) + 1,
    };
  });
  M.rooms = M.spaces.filter((r) => storeys[r.s.storey]?.id === main.id);

  // main-level footprint (main floor slab)
  const slab = data.elements.find((e) => e.cls === 'IfcSlab' && e.storey === main.id && /main/i.test(e.name)) || data.elements.find((e) => e.cls === 'IfcSlab');
  let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
  for (let i = 0; i < slab.positions.length; i += 3) {
    const [u, v] = toHouse([slab.positions[i], slab.positions[i + 1]]);
    a = Math.min(a, u); b = Math.min(b, v); c = Math.max(c, u); d = Math.max(d, v);
  }
  M.fp = [a, b, c, d];
  M.center = new THREE.Vector3((a + c) / 2, (b + d) / 2, M.FFL);

  // doors: the exterior door leaf nearest each apartment's front room. It swings into the house about its hinge edge
  // (the hinge side from the IFC OperationType), clear of the casing and frame, which stay in the wall
  const doorNear = (room) => {
    let best = null, bd = 1e9;
    for (const m of M.meshes) {
      if (m.userData.e.cls !== 'IfcDoor' || m.userData.e.doorPart !== 'leaf') continue;
      const bx = new THREE.Box3().setFromObject(m), cc = bx.getCenter(new THREE.Vector3());
      const dd = Math.hypot(cc.x - room.cu, cc.y - room.cv);
      if (dd < bd) { bd = dd; best = { mesh: m, box: bx, center: cc }; }
    }
    return best;
  };
  const byName = (n) => M.spaces.find((r) => r.name === n);
  M.doors = {};
  for (const [key, roomName] of [['west', 'AptA - Entry'], ['east', 'AptB - Front Room']]) {
    const r = byName(roomName);
    const dr = r && doorNear(r);
    if (!dr) continue;
    M.group.remove(dr.mesh);
    dr.mesh.geometry.applyMatrix4(world.matrixWorld);
    // the leaf's width runs along its longest plan direction; its thickness across it
    const pos = dr.mesh.geometry.attributes.position, cx = dr.center.x, cy = dr.center.y;
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < pos.count; i++) { const dx = pos.getX(i) - cx, dy = pos.getY(i) - cy; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), u = [Math.cos(th), Math.sin(th)];
    let lo = 1e9, hi = -1e9;
    for (let i = 0; i < pos.count; i++) { const t = (pos.getX(i) - cx) * u[0] + (pos.getY(i) - cy) * u[1]; lo = Math.min(lo, t); hi = Math.max(hi, t); }
    // inward: the leaf normal that points at the house centre
    let nrm = [-u[1], u[0]];
    if ((M.center.x - cx) * nrm[0] + (M.center.y - cy) * nrm[1] < 0) nrm = [-nrm[0], -nrm[1]];
    // standing outside looking in (along nrm), left is nrm turned 90° anticlockwise
    const left = [-nrm[1], nrm[0]], leftEnd = (u[0] * left[0] + u[1] * left[1]) > 0 ? hi : lo, rightEnd = leftEnd === hi ? lo : hi;
    const op = String(dr.mesh.userData.e.operation || '').toUpperCase();
    const hingeT = op.includes('RIGHT') ? rightEnd : leftEnd;
    const hinge = [cx + u[0] * hingeT, cy + u[1] * hingeT];
    // the swing sign that carries the leaf centre inward
    const rel = [cx - hinge[0], cy - hinge[1]], a = 10 * DEG;
    const moved = [rel[0] * Math.cos(a) - rel[1] * Math.sin(a), rel[0] * Math.sin(a) + rel[1] * Math.cos(a)];
    const sign = ((moved[0] - rel[0]) * nrm[0] + (moved[1] - rel[1]) * nrm[1]) > 0 ? 1 : -1;
    const pivot = new THREE.Group();
    pivot.position.set(hinge[0], hinge[1], 0);
    const holder = new THREE.Group();
    holder.position.set(-hinge[0], -hinge[1], 0);
    pivot.add(holder);
    holder.add(dr.mesh);
    // the door's glazing is its own IfcPlate: it rides on the leaf
    const reachBox = dr.box.clone().expandByScalar(0.12);
    for (const m of [...M.meshes]) {
      if (m.userData.e.cls !== 'IfcPlate' || !/door/i.test(m.userData.e.name || '')) continue;
      if (!reachBox.containsPoint(new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3()))) continue;
      M.group.remove(m); m.geometry.applyMatrix4(world.matrixWorld); holder.add(m);
    }
    scene.add(pivot);
    M.doors[key] = { ...dr, pivot, sign, at: new THREE.Vector3(dr.center.x, dr.center.y, M.FFL) };
  }

  // room-id maps per storey
  const sb = sheetBounds(M.fp);
  M.sheetB = sb;
  const roomMap = (list) => {
    const px = 1024, cv = document.createElement('canvas'); cv.width = cv.height = px;
    const g = cv.getContext('2d'), s = px / sb.size[0];
    g.fillStyle = '#000'; g.fillRect(0, 0, px, px);
    for (const r of list) {
      g.fillStyle = `rgb(${r.i + 1},0,0)`;
      g.beginPath();
      r.poly.forEach(([u, v], k) => { const x = (u - sb.min[0]) * s, y = (sb.min[1] + sb.size[1] - v) * s; k ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.closePath(); g.fill();
    }
    const t = new THREE.CanvasTexture(cv);
    t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.NoColorSpace;
    return t;
  };
  U.uRoomMapA.value?.dispose(); U.uRoomMapB.value?.dispose();
  U.uRoomMapA.value = roomMap(M.spaces.filter((r) => r.s.storey === main.id));
  U.uRoomMapB.value = roomMap(M.spaces.filter((r) => upper && r.s.storey === upper.id));
  U.uMapMin.value.set(...sb.min); U.uMapSize.value.set(...sb.size);
  U.uMapZ.value.set(main.elevation - 0.3, main.elevation + 2.75, upper ? upper.elevation - 0.15 : -9, upper ? upper.elevation + 3.9 : -9);
  U.uExist.value.fill(0);
  // existing = the iPhone scan only where it reads well at eye level (Apartment A's main rooms); elsewhere the as-found materials
  const SCAN_ROOMS = /^AptA - (Entry|Front room|Living area|Kitchen w\/ bar|Pantry|Refrigerator)$/;
  for (const r of M.spaces) U.uExist.value[r.i] = !ASB && storeys[r.s.storey]?.id === main.id && SCAN_ROOMS.test(r.name) ? 1 : 0;

  // annotations: plan sheet (main level) and the large floor labels for the walk
  M.ann?.dispose();
  // fixtures on the main level, as house-frame boxes: drawn on the sheet as plan symbols (toilet, sink, tub, washer...)
  const fixtures = data.elements.filter((e) => /IfcSanitaryTerminal|IfcElectricAppliance|IfcFurniture|IfcFurnishingElement|IfcFlowTerminal/.test(e.cls) && e.storey === main.id && e.positions?.length).map((e) => {
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (let i = 0; i < e.positions.length; i += 3) { const [u, v] = toHouse([e.positions[i], e.positions[i + 1]]); u0 = Math.min(u0, u); v0 = Math.min(v0, v); u1 = Math.max(u1, u); v1 = Math.max(v1, v); }
    return { kind: `${e.name || ''} ${e.material || ''}`.toLowerCase(), box: [u0, v0, u1, v1] };
  });
  M.ann = new THREE.CanvasTexture(drawSheet({ rooms: M.rooms, footprint: M.fp, bounds: sb, northDeg: AXIS, fixtures }));
  M.ann.anisotropy = 8; M.ann.colorSpace = THREE.NoColorSpace;
  const floorLabels = (list) => {
    const px = 4096, cv = document.createElement('canvas'); cv.width = cv.height = px;
    const g = cv.getContext('2d'), s = px / sb.size[0];
    for (const r of list) {
      if (/\b(shower|toilet)\s+area\b/i.test(r.label)) continue; // bathroom parts: no words, the fixtures say it
      // the label sits where the room is widest (the centre of its largest inscribed circle), sized to that circle,
      // so an L-shaped hall or a room beside a stair keeps its words inside its own walls
      const [pu, pv, rad] = labelPole(r.poly);
      const x = (pu - sb.min[0]) * s, y = (sb.min[1] + sb.size[1] - pv) * s, w = 2 * rad * s * 0.92;
      let fs = Math.min(rad * s * 0.42, 0.62 * s);
      g.font = `500 ${fs}px "Geist Mono"`;
      const name = r.label.toUpperCase();
      fs *= Math.min(1, w / g.measureText(name).width);
      const tight = fs < 0.16 * s; fs = Math.max(fs, 0.16 * s); // a narrow room keeps its name at a readable size
      g.fillStyle = 'rgba(29,29,31,.78)'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      g.font = `500 ${fs}px "Geist Mono"`; g.fillText(name, x, y);
      const sub = `${r.area.toFixed(1)} M²  ·  ${r.w.toFixed(2)} × ${r.d.toFixed(2)}`;
      let ss = fs * 0.5; g.font = `400 ${ss}px "Geist Mono"`;
      ss *= Math.min(1, w / g.measureText(sub).width); g.font = `400 ${ss}px "Geist Mono"`; g.textBaseline = 'top';
      if (!tight || ss >= 0.08 * s) g.fillText(sub, x, y + fs * 0.25);
    }
    const t = new THREE.CanvasTexture(cv); t.anisotropy = 8; t.colorSpace = THREE.NoColorSpace;
    return t;
  };
  M.lblA?.dispose(); M.lblB?.dispose();
  M.lblA = floorLabels(M.spaces.filter((r) => r.s.storey === main.id));
  M.lblB = floorLabels(M.spaces.filter((r) => upper && r.s.storey === upper.id));

  // walk stops (rooms grouped, stand points, origins), then proxy furniture facing each stand point (not in the as-built walk)
  M.stops = M.spaces.map(r=>({rooms:[r],stand:[r.cu,r.cv]}));
  M.furn = new THREE.Group();
  const inPoly = (pt, poly) => { let c2 = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c2 = !c2; } return c2; };
  if (!ASB) for (const st of M.stops) for (const r of st.rooms) {
    for (const pc of furnish(r, st.stand)) {
      const [cx, cy, cz] = pc.center, [sx, sy, sz] = pc.size;
      const corners = [[cx - sx / 2, cy - sy / 2], [cx + sx / 2, cy - sy / 2], [cx + sx / 2, cy + sy / 2], [cx - sx / 2, cy + sy / 2]];
      if (!corners.every((q) => inPoly(q, r.poly))) continue;
      const ph = /upper/i.test(r.storey) ? 3 : 2;
      const rc = [r.cu, r.cv], dir = [rc[0] - cx, rc[1] - cy];
      const yaw = Math.abs(dir[0]) + Math.abs(dir[1]) > 0.05 ? Math.atan2(dir[1], dir[0]) + Math.PI / 2 : 0;
      const fw = Math.max(sx, sy), fd = Math.min(sx, sy);
      const placed = KIND_MODEL[pc.kind] && placeModel(KIND_MODEL[pc.kind], [cx, cy, r.floorZ], yaw, [fw * 1.15, fd * 1.3], ph, `${pc.kind} · ${r.label}`);
      const decor = (KIND_DECOR[pc.kind] || []).map(([id, along, fwd, top]) => {
        const ax = [Math.cos(yaw), Math.sin(yaw)], fx = [-Math.sin(yaw), Math.cos(yaw)];
        const h = top === 1 ? (placed ? placed.size.z : sz) : top;
        return placeModel(id, [cx + ax[0] * along - fx[0] * fwd, cy + ax[1] * along - fx[1] * fwd, r.floorZ + h], yaw, null, ph, `decor · ${r.label}`);
      }).filter(Boolean);
      for (const d of [placed, ...decor]) if (d) { M.furn.add(d.piece); M.meshes.push(...d.meshes); }
      if (placed) continue;
      const bg = new THREE.BoxGeometry(sx, sy, sz).translate(cx, cy, cz);
      const e = { positions: Array.from(bg.attributes.position.array), indices: Array.from(bg.index.array) };
      const c3 = new THREE.Color(pc.color);
      const mesh = new THREE.Mesh(geometryFor(e, /upper/i.test(r.storey) ? 3 : 2, 1, [c3.r, c3.g, c3.b], true, (q) => q, SLOT.furniture), MAT.furniture);
      mesh.castShadow = true; mesh.receiveShadow = false;
      mesh.userData = { e: { cls: 'Furniture (proxy)', name: `${pc.kind} · ${r.label}`, id: null }, color: MAT.furniture, pre: PRE, phase: 2, proxy: true };
      M.furn.add(mesh);
      M.meshes.push(mesh);
    }
  }
  scene.add(M.furn);

  // fixed numbers on the page
  // the title block carries the drawing, not the pipeline (owner 2026-10-18: no build ids, times or counts)
  buildRuler();
  buildNav(); applyLayers();
}

// ---------- walk stops: stand point at the side nearest the previous stop, looking across the room ----------
const pointIn = (pt, poly) => { let c2 = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c2 = !c2; } return c2; };
// the camera is indoors when it stands over the main footprint below the roof
const cameraIndoors = () => { const q = camera.position; return q.x > M.fp[0] && q.x < M.fp[2] && q.y > M.fp[1] && q.y < M.fp[3] && q.z < M.box.max.z - 0.5 && q.z > (M.storeys.base?.elevation ?? -3) - 0.5; };
// ---------- lights, environment, splats ----------
const sun = new THREE.DirectionalLight(0xffd9a8, 4.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 100, far: 190 });
sun.shadow.normalBias = 0.03;
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target, new THREE.HemisphereLight(0xe6e6ea, 0xd8be98, 0.7));
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
// late-afternoon sky (Poly Haven CC0, the reference's own HDR) replaces the studio environment once loaded
new HDRLoader().loadAsync('assets/hdri/qwantani_late_afternoon_puresky_1k.hdr').then((t) => { t.mapping = THREE.EquirectangularReflectionMapping; scene.environment = pmrem.fromEquirectangular(t).texture; scene.environmentRotation = new THREE.Euler(Math.PI / 2, 0, 0); t.dispose(); }).catch((e) => console.warn('hdr', e.message));
scene.environmentIntensity = 0.9;

const loadedCaptureHashes = {};
const bufferSha256 = async (buffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map((v)=>v.toString(16).padStart(2,'0')).join('');
async function captureBytes(key,url) {
  const response=await fetch(url); if (!response.ok) throw new Error('Capture unavailable');
  const bytes=await response.arrayBuffer(); loadedCaptureHashes[key]=await bufferSha256(bytes); return bytes;
}
let splat = null, interior = null;
const splatReady = (async () => {
  try {
    const { SparkRenderer, SplatMesh } = await import('@sparkjsdev/spark');
    // stable splats while the camera moves: no LoD swapping, radial sort (order holds under rotation), sort every frame
    const spark = new SparkRenderer({ renderer, enableLod: false, sortRadial: true, minSortIntervalMs: 0 });
    spark.layers.set(1);
    scene.add(spark);
    splat = new SplatMesh({ fileBytes: await captureBytes('splat','splats/exterior_clean_v2.spz'), fileName:'exterior_clean_v2.spz' });
    splat.opacity = Number($('opScan').value) / 100;
    interior = new SplatMesh({ fileBytes: await captureBytes('scan','splats/interior_ground_all.spz'), fileName:'interior_ground_all.spz' });
    for (const s of [splat, interior]) { s.layers.set(1); world.add(s); }
    interior.visible = false;
    await Promise.all([splat.initialized, interior.initialized]);
  } catch (err) {
    console.error('splat unavailable:', err?.message || err);
    splat = interior = null;
  }
  parts.splat = 1; setLoad();
})();

// ---------- chapter C overlays: red-lines texture + the zoning envelope in 3D ----------
const redB = redlineBounds(site, toHouse, [[ctxBox.min.x, ctxBox.min.y], [ctxBox.max.x, ctxBox.max.y]].map(([x, y]) => { const r = toHouse([x, y]); return r; }));
const redTex = new THREE.CanvasTexture(drawRedlines({ site, toHouse, bounds: redB }));
redTex.anisotropy = 8; redTex.colorSpace = THREE.NoColorSpace;
const envMat = new THREE.LineDashedMaterial({ color: 0xc4262e, dashSize: 0.35, gapSize: 0.18, transparent: true, opacity: 0, depthTest: false });
{
  const pts = [];
  const z0 = site.height.grade_z, z1 = site.height.top_z;
  for (const poly of site.envelope) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      for (const z of [z0, z1]) pts.push(a[0], a[1], z, b[0], b[1], z);
      pts.push(a[0], a[1], z0, a[0], a[1], z1);
    }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(g, envMat); lines.computeLineDistances();
  const holder = new THREE.Group(); holder.rotation.z = -AXIS * DEG; holder.add(lines); overlay.add(holder);
}

// ---------- targets and composite ----------
const camera = new THREE.PerspectiveCamera(3, innerWidth / innerHeight, 1, 5000);
camera.up.set(0, 0, 1);
const W = () => Math.floor(innerWidth * DPR), H = () => Math.floor(innerHeight * DPR);
const rtColor = new THREE.WebGLRenderTarget(W(), H(), { type: THREE.HalfFloatType, samples: 4 });
const rtPre = new THREE.WebGLRenderTarget(W(), H(), { count: 2, type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
// scan pass (owner 2026-10-18: "blend the two together"): every point-cloud scan, alone, colour + view depth in alpha
const rtScan = new THREE.WebGLRenderTarget(W(), H(), { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
const fxPost = new Post(renderer);
// look-dev constants (set from the choreography spec): bloom threshold (linear, pre-exposure), AO radius (m)
const LOOK = { bloomThreshold: 1.6, aoRadius: 0.45 };

const COMP_FS = /* glsl */`
precision highp float;
uniform sampler2D tND, tW, tColor, tAnn, tRed, tLblA, tLblB, tBloom, tAO, tDof, tScan;
uniform float uModelOp, uScanOp, uScanTint;
uniform float uBloom, uAO, uFocus, uAperture;
uniform vec2 uRes, uAnnMin, uAnnSize, uRedMin, uRedSize;
uniform vec3 uPaper, uInk, uAccent, uEdgeCol;
uniform float uEdgeOp;
uniform float uSplat, uPixA, uAnnOp, uRedOp, uLblOp, uFFL, uFFL2, uPx, uInkReal, uSeed, uExposure, uGrid, uTime, uDebug;
in vec2 vUv;
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec4 sampleIn(sampler2D t, vec2 uv) { return (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) ? texture(t, uv) : vec4(0.0); }
// joints of a 0.6 m tile grid on the surface plane (floors: xy, walls: the in-plane horizontal + z)
float joints(vec3 w, vec3 n, float pxw) {
  vec2 q = abs(n.z) > 0.6 ? w.xy : vec2(abs(n.x) > abs(n.y) ? w.y : w.x, w.z);
  vec2 g = abs(fract(q / 0.6 + 0.5) - 0.5) * 0.6;
  return 1.0 - smoothstep(pxw * 0.6, pxw * 1.6, min(g.x, g.y));
}
void main() {
  vec2 px = 1.0 / uRes;
  vec4 nd = texture(tND, vUv), w = texture(tW, vUv);
  bool hit = w.w > 0.0;
  float state = hit ? floor(nd.a * 8.0 + 0.5) : 4.0;
  vec3 n = nd.xyz * 2.0 - 1.0;
  vec2 sp = gl_FragCoord.xy / uPx;
  float grain = fbm(sp * vec2(0.004, 0.0016) + uSeed) * 0.06 + fbm(sp * vec2(0.08, 0.02)) * 0.03 + (hash(sp) - 0.5) * 0.02;
  vec3 paper = uPaper * (0.985 + grain - 0.03);
  float pxw = max(w.w, 0.001) * uPixA * uPx;
  float edge = 0.0;
  for (int k = 0; k < 4; k++) {
    vec2 o = (k == 0 ? vec2(1, 0) : k == 1 ? vec2(-1, 0) : k == 2 ? vec2(0, 1) : vec2(0, -1)) * px * uPx;
    vec4 nd2 = texture(tND, vUv + o), w2 = texture(tW, vUv + o);
    bool hit2 = w2.w > 0.0;
    if (hit != hit2) { edge = 1.0; continue; }
    if (!hit) continue;
    float s2 = floor(nd2.a * 8.0 + 0.5);
    vec3 n2 = nd2.xyz * 2.0 - 1.0;
    float crease = smoothstep(0.12, 0.3, 1.0 - dot(n, n2));
    float step_ = smoothstep(2.0, 4.0, abs(dot(w2.xyz - w.xyz, n)) / pxw);
    float st = (s2 != state && (s2 >= 3.0 || state >= 3.0) && !(s2 == 6.0 && state == 0.0) && !(s2 == 0.0 && state == 6.0)) ? 1.0 : 0.0;
    edge = max(edge, max(max(crease, step_), st));
  }
  vec4 colPass = texture(tColor, vUv);
  { bvec4 nn = notEqual(colPass, colPass); if (any(nn)) colPass = vec4(0.0); } // a NaN from the colour pass is dropped, not spread
  // look-dev on the real image: ambient occlusion, depth of field (half-res blur mixed by circle of confusion), bloom
  float coc = clamp(abs(w.w - uFocus) / max(uFocus, 0.1) * uAperture, 0.0, 1.0);
  vec3 lin = mix(colPass.rgb, texture(tDof, vUv).rgb, w.w > 0.0 ? coc : uAperture * 0.6);
  lin *= mix(1.0, texture(tAO, vUv).r, uAO);
  lin += texture(tBloom, vUv).rgb * uBloom;
  vec3 real = toSRGB(aces(lin * uExposure));
  bool captured = colPass.a > 0.5;
  float light = 0.5 + 0.5 * dot(n, normalize(vec3(-0.35, 0.45, 0.82)));
  bool up = hit && n.y > 0.0; // (view-space normal is not world up; floors are tested by height below)
  bool onFloorA = hit && abs(w.z - uFFL) < 0.06;
  bool onFloorB = hit && abs(w.z - uFFL2) < 0.08;
  vec3 col;
  if (state == 4.0) { float s = uSplat * (captured ? 1.0 : 0.0); col = mix(paper, real, s); edge *= 1.0 - s * 0.85; }
  else if (state == 3.0) col = uInk;
  else if (state == 1.0) { if (captured) { col = real; edge *= uInkReal; } else col = paper * (0.93 + 0.07 * light); }
  else if (state == 2.0) {
    float j = joints(w.xyz, n, pxw);
    col = mix(real, uAccent * 1.15, j * 0.95);
    col += uAccent * j * 0.3; // steady glow on the joints (no time pulse: it read as flicker)
    edge *= uInkReal;
  }
  else if (state == 5.0) { col = mix(captured ? real : paper * (0.9 + 0.1 * light), uAccent, 0.1); edge = max(edge, 0.0); }
  else { // paper (0) and furniture on paper (6)
    col = paper * (0.9 + 0.1 * light);
    if ((onFloorA || onFloorB) && state == 0.0) col = mix(col, uInk, joints(w.xyz, vec3(0, 0, 1), pxw) * 0.18 * uGrid);
  }
  // floor annotations: plan sheet, large room labels (walk), red-lines (chapter C)
  if (uAnnOp > 0.001 && (onFloorA || state == 4.0) && state != 3.0) {
    vec4 a = sampleIn(tAnn, (w.xy - uAnnMin) / uAnnSize);
    col = mix(col, a.rgb, a.a * uAnnOp * (state == 1.0 ? 0.3 : 1.0));
  }
  if (uLblOp > 0.001 && state == 0.0) {
    vec4 a = onFloorA ? sampleIn(tLblA, (w.xy - uAnnMin) / uAnnSize) : onFloorB ? sampleIn(tLblB, (w.xy - uAnnMin) / uAnnSize) : vec4(0.0);
    col = mix(col, a.rgb, a.a * uLblOp);
  }
  if (uRedOp > 0.001 && (state == 4.0 || onFloorA) && state != 3.0) {
    vec4 a = sampleIn(tRed, (w.xy - uRedMin) / uRedSize);
    col = mix(col, a.rgb, a.a * uRedOp);
  }
  col = mix(col, uEdgeCol, clamp(edge, 0.0, 1.0) * 0.92 * uEdgeOp); // line opacity and colour: top bar (owner 2026-10-18)
  // model opacity, then the scans over it: a scan point shows fully where it stands in front of the model (or where
  // there is no model), and through the model as far as the model is faded
  // faded model: the imagery underneath (photo scan where captured, paper elsewhere), the model's own edges kept as
  // blue outlines so its walls, openings and arches read against the real room
  vec3 under = captured ? real : uPaper * 0.97;
  col = mix(under, col, uModelOp);
  col = mix(col, vec3(0.05, 0.35, 0.95), clamp(edge, 0.0, 1.0) * (1.0 - uModelOp) * 0.9);
  vec4 sc = texture(tScan, vUv);
  if (sc.a > 0.0 && uScanOp > 0.0) {
    bool front = !hit || sc.a < w.w + 0.06;
    float lum = dot(sc.rgb, vec3(0.299, 0.587, 0.114));
    vec3 scol = mix(sc.rgb, vec3(1.0, 0.42, 0.0) * (0.55 + 0.6 * lum), uScanTint); // orange: the scan against the white model
    col = mix(col, scol, uScanOp * (front ? 1.0 : 1.0 - uModelOp));
  }
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * 0.22;
  col += (hash(gl_FragCoord.xy + uSeed) - 0.5) * 0.012;
  if (uDebug > 1.5) col = vec3(state == 3.0 ? 1.0 : 0.0, state == 1.0 || state == 2.0 ? 1.0 : 0.0, state == 6.0 ? 1.0 : (state == 0.0 ? 0.5 : 0.0));
  outColor = vec4(uDebug > 0.5 && uDebug < 1.5 ? real : col, 1.0);
}`;
const lin = (hex) => new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace); // display values passed through untouched
const CU = {
  tND: { value: rtPre.textures[0] }, tW: { value: rtPre.textures[1] }, tColor: { value: rtColor.texture },
  tBloom: { value: null }, tAO: { value: null }, tDof: { value: null }, tScan: { value: rtScan.texture }, uModelOp: { value: 1 }, uScanOp: { value: 0.7 }, uScanTint: { value: 0 }, uBloom: { value: 0.35 }, uAO: { value: 0.85 }, uFocus: { value: 4 }, uAperture: { value: 0 },
  tAnn: { value: null }, tRed: { value: redTex }, tLblA: { value: null }, tLblB: { value: null },
  uRes: { value: new THREE.Vector2(W(), H()) }, uAnnMin: { value: new THREE.Vector2() }, uAnnSize: { value: new THREE.Vector2(1, 1) },
  uRedMin: { value: new THREE.Vector2(...redB.min) }, uRedSize: { value: new THREE.Vector2(...redB.size) },
  uPaper: { value: lin(0xefebe2) }, uInk: { value: lin(0x1d1d1f) }, uEdgeCol: { value: lin(0x1d1d1f) }, uEdgeOp: { value: 1 }, uAccent: { value: lin(parseInt(ACCENT.slice(1), 16)) },
  uSplat: { value: 0 }, uPixA: { value: 0.001 }, uAnnOp: { value: 1 }, uRedOp: { value: 0 }, uLblOp: { value: 0 }, uFFL: { value: 0 }, uFFL2: { value: 3 },
  uPx: { value: DPR }, uInkReal: { value: 0.12 }, uSeed: { value: 3.1 }, uExposure: { value: 1.25 }, uGrid: { value: 1 }, uTime: { value: 0 }, uDebug: { value: { color: 1, state: 2 }[Q.get('debug')] || 0 },
};
const comp = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: 'in vec3 position; out vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: COMP_FS, uniforms: CU, depthTest: false, depthWrite: false,
}));
const compScene = new THREE.Scene(); compScene.add(comp);
// FXAA over the composite: steadies the 1 px ink lines while the camera moves (the reference anti-aliases its line pass)
const rtFinal = new THREE.WebGLRenderTarget(4, 4, { type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
const fxaa = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ ...FXAAShader, uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms), depthTest: false, depthWrite: false }));
fxaa.material.uniforms.tDiffuse.value = rtFinal.texture;
const fxaaScene = new THREE.Scene(); fxaaScene.add(fxaa);
const compCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), null);
ground.userData = { pre: preMaterial(4) };
scene.add(ground);

function applyModelUniforms() {
  CU.tAnn.value = M.ann; CU.tLblA.value = M.lblA; CU.tLblB.value = M.lblB;
  CU.uAnnMin.value.set(...M.sheetB.min); CU.uAnnSize.value.set(...M.sheetB.size);
  CU.uFFL.value = M.FFL; CU.uFFL2.value = M.storeys.upper?.elevation ?? 99;
  // the paper sits below the lowest wall base, so a cut wall shows its black section everywhere, not only where its base clears the paper
  ground.position.set(M.center.x, M.center.y, Math.min(M.FFL - 0.012, M.wallBase ?? 0) - 0.02);
  // sun: elevation 32°, late afternoon from the west-south-west (reference "warm" preset: #ffd9a8)
  { const el = 32 * DEG, d = new THREE.Vector2(-0.88, -0.47).normalize(); sun.position.set(M.center.x + 140 * Math.cos(el) * d.x, M.center.y + 140 * Math.cos(el) * d.y, M.center.z + 140 * Math.sin(el)); }
  sun.target.position.copy(M.center);
  U.uExtOrg.value.set(M.center.x, M.center.y, M.FFL); U.uExtRad.value = Math.hypot(M.fp[2] - M.fp[0], M.fp[3] - M.fp[1]) * 0.6 + (M.box.max.z - M.FFL) + 2;
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  rtColor.setSize(W(), H()); rtPre.setSize(W(), H()); rtScan.setSize(W(), H()); fxPost.setSize(W(), H()); rtFinal.setSize(W(), H());
  fxaa.material.uniforms.resolution.value.set(1 / W(), 1 / H());
  CU.uRes.value.set(W(), H());
  camera.aspect = innerWidth / innerHeight;
}
addEventListener('resize', resize);
resize();

// ---------- timeline: the reference's shot grammar on 401 Pearl (timeline.js; spec §1–§5) ----------
const ease = (x) => x * x * (3 - 2 * x);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const band = (p, a, b) => clamp01((p - a) / (b - a));
const cubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const EYE_FOV = 78, VIA_FOV = 72; // owner: a wide first-person lens for tight rooms (reference 46–60)
let shots = [], TOTAL = 1, dossiers = [], revWin = [], extWin = null, ext2Win = null, doorWin = {}, heroShot = null, asbuiltShot = null, rollWin = null;
const OFF = () => M.box.max.z + 0.4; // a cut above everything = no cut
function unwrapYaw(prev, y) { if (prev == null) return y; while (y - prev > 180) y -= 360; while (y - prev < -180) y += 360; return y; }
const clearance = createGeometryClearance({THREE,meshes:()=>M.meshes,spaces:()=>M.spaces,clipping:()=>({cut:U.uCut.value,phaseCuts:[...U.uPhaseCut.value]})});
let routeRows = [], transfer = null, pendingNavigation = null, navigationToken = 0, activeRoom = null, targetRoom = null, navigationStage = 'floor-plan-hover';
function sh(o) {
  const t=Array.isArray(o.t)?o.t:[o.t.x,o.t.y,o.t.z];
  const yaw=unwrapYaw(shots.at(-1)?.yaw,o.yaw), pitch=o.pitch;
  const dist=o.dist??o.frame/(2*Math.tan(o.fov*DEG/2));
  const dir=[Math.cos(pitch*DEG)*Math.cos(yaw*DEG),Math.cos(pitch*DEG)*Math.sin(yaw*DEG),-Math.sin(pitch*DEG)];
  const eye=o.eye?(Array.isArray(o.eye)?[...o.eye]:o.eye.toArray()):t.map((v,i)=>v-dir[i]*dist);
  const q={hold:35,go:70,...o,t,yaw,eye,dist}; shots.push(q); return q;
}
function flightAltitude() {
  const size=M.box.getSize(new THREE.Vector3()), aspect=Math.max(.2,innerWidth/innerHeight);
  return M.box.max.z+Math.max(3,Math.max(size.y+3,(size.x+3)/aspect)/(2*Math.tan(16*DEG)));
}
function planShotCentred() {
  return directedPose([M.center.x,M.center.y,flightAltitude()],90,89,32,{cut:M.FFL+1.2,id:'plan-centre',hold:60,go:80,navigationStage:'floor-plan-hover'});
}
const planShot=planShotCentred;
function qualifiedStop(r,n) {
  const q=clearance.target(r), eye=q.eye||[r.cu,r.cv,flightAltitude()];
  const row={...q,key:r.name,room:r.name,name:r.name,storey:r.storey,apt:r.apt,spaceID:r.s.id};
  routeRows.push(row);
  return {key:r.name,title:r.label||r.name,apt:r.apt,meta:`${r.area.toFixed(1)} m² · ${r.storey}`,rooms:[r],floorZ:r.floorZ,stand:eye.slice(0,2),look:[r.cu,r.cv],qualification:row,n};
}
function floorCenterFor(key){const room=M.spaces.find(r=>r.name===key),peers=room?M.spaces.filter(r=>Math.abs(r.floorZ-room.floorZ)<.3):M.spaces;return [(Math.min(...peers.map(r=>r.bbox[0]))+Math.max(...peers.map(r=>r.bbox[2])))/2,(Math.min(...peers.map(r=>r.bbox[1]))+Math.max(...peers.map(r=>r.bbox[3])))/2];}
function roomPose(st) {
  const q=st.qualification,r=st.rooms[0], pos=q.eye||[r.cu,r.cv,flightAltitude()];
  return directedPose(pos,90,q.status==='SAFE_ROOM'?0:89,q.status==='SAFE_ROOM'?72:32,{roomKey:st.key,cut:q.status==='SAFE_ROOM'?OFF():r.floorZ+1.2});
}
function buildTimeline() {
  shots=[]; dossiers=[]; revWin=[]; routeRows=[]; clearance.refresh();
  M.stops=M.spaces.map((r,i)=>qualifiedStop(r,i+1)); buildNav();
  heroShot=sh({...planShotCentred(),id:'hero'});
  sh({...planShotCentred(),id:'plan-centre'});
  const orbit=directedPose([M.center.x,M.box.min.y-8,Math.max(M.box.max.z+3,8)],90,25,50,{id:'orbit',hold:70,cut:OFF(),navigationStage:'outside'});
  // Exterior and every interior use the identical stationary-cut / overhead route.
  for(const pose of buildRoomTransfer(shots.at(-1),orbit,{flightZ:flightAltitude(),targetCut:OFF()})) sh({...pose,go:pose.go||70});
  for(const st of M.stops) {
    const destination=roomPose(st), route=buildRoomTransfer(shots.at(-1),destination,{flightZ:flightAltitude(),roomKey:st.key,targetCut:destination.cut,floorCenter:floorCenterFor(st.key)});
    for(const pose of route){const q=sh({...pose,go:pose.go||65});if(q.navigationStage==='floor-plan-hover')q.id=`floor-plan:${st.key}`;}
    const first=shots.at(-1); first.id=`room:${st.key}`; first.hold=65;
    const last=sh({...destination,yaw:destination.yaw+18,hold:55,go:75,navigationStage:'room-pan'});
    dossiers.push({shot:first,last,st,n:st.n});
  }
  const final=planShotCentred();
  for(const pose of buildRoomTransfer(shots.at(-1),final,{flightZ:flightAltitude(),targetCut:final.cut})) sh({...pose,go:pose.go||70});
  asbuiltShot=sh({...final,id:'asbuilt',hold:100,go:0});
  TOTAL=layout(shots); extWin=[0,1];ext2Win=[TOTAL+1,TOTAL+2];doorWin={west:[TOTAL+1,TOTAL+2],east:[TOTAL+1,TOTAL+2]};rollWin=[TOTAL+1,TOTAL+2];
  for(const d of dossiers) {d.win=[d.shot.h0,d.last.h1]; for(const r of d.st.rooms)revWin.push({i:r.i,e:[0,1],p:[TOTAL+1,TOTAL+2]});}
  document.getElementById('track').style.height=`${TOTAL+120}vh`; buildRuler();
}
let splatWins=null;
let camCut = 99, camSample = null;
const insp = { yaw: 0, pitch: 0, drag: null, told: false };
function poseCamera(c) {
  const yaw=(c.yaw+insp.yaw)*DEG,pitch=Math.max(-89.8,Math.min(89.8,c.pitch+insp.pitch))*DEG;
  camera.position.fromArray(c.eye);camera.fov=c.fov;camera.near=.05;camera.far=2000;camera.updateProjectionMatrix();
  camera.lookAt(camera.position.clone().add(new THREE.Vector3(Math.cos(pitch)*Math.cos(yaw),Math.cos(pitch)*Math.sin(yaw),-Math.sin(pitch))));
  camera.updateMatrixWorld(); CU.uPixA.value=2*Math.tan(camera.fov*DEG/2)/H();
}
function placeCamera(s) {
  const c=sample(shots,s);camSample=c;poseCamera(c);camCut=channel(shots,s,'cut',OFF());
  navigationStage=c.moving?(c.to.navigationStage||'room-pan'):(c.from.navigationStage||'room-pan');
  activeRoom=c.from.roomKey??activeRoom;targetRoom=c.to.roomKey??activeRoom;
}

// ---------- page chrome ----------
const $ = (id) => document.getElementById(id);
const hero = $('hero'), chapter = $('chapter'), caption = $('caption'), walkTag = $('walkTag'), hud = $('hud');
const count = $('count'), rulerMark = $('rulerMark'), phaseChip = $('phase'), roll = $('roll'), walkPill = $('walkPill');
const hint = walkTag;
function buildRuler() {
  const ticks = $('rulerTicks'); ticks.innerHTML = '';
  for (const d of dossiers) {
    if (d.via) continue;
    const i = document.createElement('i'); i.style.top = `${(((d.shot.h0 + d.shot.h1) / 2 / TOTAL) * 100).toFixed(2)}%`; i.title = d.st.title; ticks.appendChild(i);
  }
}
function setChapter(kicker, title, line, facts) {
  if (chapter.dataset.key === title) return;
  chapter.dataset.key = title;
  $('chKicker').textContent = kicker; $('chTitle').innerHTML = title; $('chLine').textContent = line;
  $('chFacts').innerHTML = facts.map(([t, short]) => `<li class="${short ? 'short' : ''}">${t}</li>`).join('');
}
const anchorV = new THREE.Vector3();
let hudFor = null;
function placeHud(d) { // reticle on the projected anchor (the room's far upper corner), tag beside it, clamped on screen
  const st = d.st;
  const z = st.floorZ + (st.rooms[0]?.height ?? 2.6) * 0.86;
  anchorV.set(st.look[0], st.look[1], z).project(camera);
  const x = (anchorV.x * 0.5 + 0.5) * innerWidth, y = (-anchorV.y * 0.5 + 0.5) * innerHeight;
  const w = hud.offsetWidth || 320, h = hud.offsetHeight || 120;
  const X = Math.min(innerWidth - 92 - w, Math.max(12, x + 40)), Y = Math.min(innerHeight - 110 - h, Math.max(70, y - 20));
  hud.style.left = `${X}px`; hud.style.top = `${Y}px`; hud.style.right = 'auto';
}

function update(p) {
  const s = p * TOTAL;
  placeCamera(s);
  const FFL = M.FFL, CUT0 = FFL + CUT_ABOVE_FLOOR;
  U.uPhaseCut.value.fill(99);
  U.uCut.value = camCut;
  U.uPocheOff.value = ASB && camCut > M.box.max.z - 0.2 ? 1 : 0;
  // reveals: existing then proposed per room, multiplied by the as-built switch (paper again after the outro roll)
  const roll01 = band(s, rollWin[0], rollWin[1]);
  const asBuilt = 1 - band(roll01, 0.27, 1);
  U.uRev1.value.fill(0); U.uRev2.value.fill(0);
  for (const w of revWin) {
    U.uRev1.value[w.i] = Math.max(U.uRev1.value[w.i], cubic(band(s, w.e[0], w.e[1]))) * asBuilt;
    U.uRev2.value[w.i] = Math.max(U.uRev2.value[w.i], cubic(band(s, w.p[0], w.p[1]))) * asBuilt;
  }
  U.uExtRev1.value = cubic(band(s, extWin[0], extWin[1])) * asBuilt;
  U.uExtRev2.value = cubic(band(s, ext2Win[0], ext2Win[1])) * asBuilt;
  // as built: once inside, the whole house is revealed at once: no half-drawn paper walls seen through a doorway
  U.uAll.value = 1;
  if (M.doors.west) M.doors.west.pivot.rotation.z = 0;
  if (M.doors.east) M.doors.east.pivot.rotation.z = 0;
  // floor annotations: the plan sheet on the sheet shots; big room labels while rooms are paper
  // the sheet (room names, sizes, dimensions) stays until the big floor labels have taken over (owner 2026-10-18)
  CU.uAnnOp.value = Math.max(1 - band(s, shots[1].g1 + 40, shots[1].g1 + 100), band(s, asbuiltShot.h0 - 40, asbuiltShot.h0));
  CU.uRedOp.value = 0; envMat.opacity = 0;
  CU.uLblOp.value = band(s, shots[1].g1, shots[1].g1 + 60) * (1 - band(s, asbuiltShot.h0 - 80, asbuiltShot.h0 - 20));
  CU.uGrid.value = 1;
  const outdoors = !cameraIndoors();
  CU.uSplat.value = !splat ? 0 : ASB && splatWins // as built: the drone splat only around the orbits (no ghost doors at the porch)
    ? Math.max(band(s, splatWins[0][0], splatWins[0][0] + 80) * (1 - band(s, splatWins[0][1] - 60, splatWins[0][1])), band(s, splatWins[1][0], splatWins[1][0] + 60) * (1 - band(s, splatWins[1][1] - 40, splatWins[1][1])))
    : band(s, extWin[0], extWin[0] + 80) * (1 - band(s, asbuiltShot.h0 - 60, asbuiltShot.h0));
  // look-dev per the reference: ink on real 0.12 indoors / 0.05 outdoors, DOF on holds, vignette off on plan shots
  const flat = camSample.pitch > 80 ? 1 : 0;
  CU.uInkReal.value = outdoors ? 0.05 : 0.12;
  const dofT = flat ? 0 : camSample.held ? (outdoors ? 0.07 : 0.18) : 0.05;
  CU.uAperture.value += (dofT - CU.uAperture.value) * 0.08;
  CU.uFocus.value = camSample.focus;
  // dossiers: HUD window h0 − 20 → h1 + 16; interior scan while a ground-floor room plays existing
  const active = dossiers.find((d) => s >= d.win[0] && s <= d.win[1] && !d.via);
  const inStop = dossiers.find((d) => s >= d.win[0] - 60 && s <= d.win[1]);
  const scanOn = inStop && inStop.st.rooms.some((r) => U.uExist.value[r.i] > 0.5 && U.uRev1.value[r.i] > 0.02 && U.uRev2.value[r.i] < 0.6);
  if (interior) interior.visible = !!scanOn;
  if (!layers.splat) CU.uSplat.value = 0;
  if (interior && layers.scan) interior.visible = true;
  if (splat) splat.visible = CU.uSplat.value > 0.01 && outdoors && U.uCut.value > M.box.max.z - 0.3;
  // chrome
  const hf = band(s, 0.5 * heroShot.h1, 0.5 * heroShot.h1 + 40);
  hero.style.opacity = String(1 - hf); hero.style.transform = `translateY(${-50 * hf}px)`;
  const finOp = band(s, asbuiltShot.h1 - 10, asbuiltShot.h1 + 30);
  chapter.style.opacity = String(finOp);
  if (finOp > 0) setChapter('A-101 · 401 Pearl St · as built', 'Two flats, one house. <em>Walk it as it stands.</em>', 'The house as it stands, before the work begins.',
    [['401 PEARL ST · BOULDER, COLORADO'], ['DUPLEX · 3 BEDROOMS · 2 BATHS · ABOUT 1,690 SQ FT'], ['LOT 4,145 SQ FT · 4TH & PEARL · BOULDER, COLORADO'], ['WALK THE HOUSE: WASD · MOUSE · [ ] LENS']]);
  caption.style.opacity = '0';
  const firstHold = dossiers.find((d) => !d.via)?.shot;
  const secondHold = dossiers.filter((d) => !d.via)[1]?.shot;
  hint.textContent = s < (firstHold?.h0 ?? 0) ? 'Scroll to walk in' : s < (secondHold?.h0 ?? 0) ? 'Click the marker to open the file' : 'Scroll to the next room';
  hint.style.opacity = String(s > asbuiltShot.h0 - 60 ? 0 : 1);
  walkPill.classList.toggle('on', s > asbuiltShot.h1 - 20);
  const chromeOn = Math.min(band(s, shots[1].g1 - 30, shots[1].g1 + 10), 1 - band(s, asbuiltShot.h0 - 40, asbuiltShot.h0));
  document.querySelector('.ruler').style.opacity = String(chromeOn); count.style.opacity = String(chromeOn);
  if (active) {
    const st = active.st, d = active;
    if (hudFor !== d) { hudFor = d; hud.classList.remove('on'); void hud.offsetWidth; hud.classList.add('on'); }
    hud.style.opacity = '1';
    $('hudNum').textContent = st.rooms.length ? `Room ${String(d.n).padStart(2, '0')} · ${st.apt}` : `${String(d.n).padStart(2, '0')} · ${st.apt}`;
    $('hudTitle').textContent = st.title;
    $('hudMeta').textContent = st.meta;
    const r0 = st.rooms[0];
    const ex = r0 && U.uRev2.value[r0.i] < 0.5;
    $('hudPass').textContent = !r0 ? '' : ex ? (U.uExist.value[r0.i] > 0.5 ? 'Existing · the scan' : 'Existing · as modelled') : 'Proposed';
    phaseChip.textContent = !r0 ? 'Existing conditions' : ex ? 'Existing conditions' : 'Proposed';
    placeHud(d);
  } else {
    hudFor = null; hud.classList.remove('on'); hud.style.opacity = '0';
    phaseChip.textContent = s < extWin[0] ? 'The sheet' : s > asbuiltShot.h0 - 40 ? 'As built' : U.uExtRev2.value > 0.05 ? 'Proposed' : 'Existing conditions';
  }
  const nd = dossiers.filter((d) => !d.via);
  const reached = nd.filter((d) => s > d.shot.h0 - 20).length;
  count.textContent = `${String(reached).padStart(2, '0')} / ${String(nd.length).padStart(2, '0')} rooms`;
  rulerMark.style.top = `${((Math.min(s, TOTAL) / TOTAL) * 100).toFixed(2)}%`;
  // outro roll: sweeps across the as-built sheet, then the house is paper again
  roll.style.transition = 'none';
  if (roll01 > 0 && roll01 < 1) { roll.style.left = '0'; roll.style.right = 'auto'; roll.style.width = `${(roll01 < 0.16 ? 0.4 * (roll01 / 0.16) : roll01 < 0.27 ? 0.4 : 0.4 + 0.6 * ease(band(roll01, 0.27, 1))) * 100}vw`; roll.classList.add('outro'); }
  else if (roll.classList.contains('outro')) { roll.style.width = '0'; roll.classList.remove('outro'); }
}

// ---------- render ----------
function render() {
  CU.uTime.value = performance.now() / 1000;
  const sel = selected?.mesh;
  for (const m of [...M.meshes, ...ctxGroup.children]) m.material = flaggedPaths.has(m.userData.e?.id) ? MAT_FLAG : m.userData.color;
  ground.visible = false;
  // model faded (owner: "map it to the actual imagery"): the colour pass draws the scans without the model in front,
  // so the photo scan is seen whole; the model stays in the line pass and is drawn as outlines over it
  const ghost = CU.uModelOp.value < 0.99;
  if (ghost) { for (const m of M.meshes) m.userData._vis = m.visible, m.visible = false; for (const d of Object.values(M.doors || {})) d.pivot.visible = false; }
  camera.layers.set(0); camera.layers.enable(1);
  renderer.setRenderTarget(rtColor);
  renderer.setClearColor(0xefebe2, 0); // alpha 0: nothing captured or modelled here
  renderer.clear();
  renderer.render(scene, camera);
  if (ghost) { for (const m of M.meshes) m.visible = m.userData._vis; for (const d of Object.values(M.doors || {})) d.pivot.visible = layers.model; }
  for (const m of [...M.meshes, ...ctxGroup.children]) m.material = m === sel ? PRE_SEL : m.userData.pre;
  ground.material = ground.userData.pre; ground.visible = U.uCut.value >= ground.position.z; // The decorative sheet cannot occlude a basement cutaway.
  camera.layers.set(0);
  U.uNear.value = camera.near;
  SCAN_MAT.uniforms.uScale.value = H() / (2 * Math.tan((camera.fov * DEG) / 2));
  renderer.setRenderTarget(rtPre);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, camera);
  camera.layers.set(2); // the scans alone
  renderer.setRenderTarget(rtScan); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera);
  camera.layers.set(0);
  const fx = fxPost.run({ color: rtColor, pre: rtPre, camera, exposure: CU.uExposure.value, threshold: LOOK.bloomThreshold, aoRadius: LOOK.aoRadius, pixA: CU.uPixA.value });
  CU.tBloom.value = fx.bloom; CU.tAO.value = fx.ao; CU.tDof.value = fx.dof;
  renderer.setRenderTarget(rtFinal);
  renderer.clear();
  renderer.render(compScene, compCam);
  renderer.setRenderTarget(null);
  renderer.clear();
  renderer.render(fxaaScene, compCam);
  if (envMat.opacity > 0.01 || shape) renderer.render(overlay, camera);
}

// ---------- scroll ----------
let target = 0, prog = 0, mode = 'scroll';
const track = $('track');
let lenis = null;
if (!REC && window.Lenis && window.gsap && window.ScrollTrigger) {
  gsap.registerPlugin(ScrollTrigger);
  lenis = new Lenis({ duration: 2.2, wheelMultiplier: 0.6, touchMultiplier: 0.8 }); // slower than the reference (owner)
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
  ScrollTrigger.create({ trigger: track, start: 'top top', end: 'bottom bottom', onUpdate: (st) => { target = navHeld() ?? st.progress; } });
} else addEventListener('scroll', () => { target = navHeld() ?? scrollY / Math.max(1, track.offsetHeight - innerHeight); });
// a Plan / Model jump holds its target for a moment: the scroll library reports the old position once after the jump
let navHold = null;
function navHeld() { return navHold && performance.now() < navHold.until ? navHold.p : null; }

// ---------- selection: every element by its IFCX path; Edit writes 99z, Flag writes a BCF topic ----------
let selected = null;
let comparisonBusy = false, comparisonEnabled = false;
const ray = new THREE.Raycaster();
const panel = $('panel');
let lastPick = null; // { mesh, point (scene frame), normalZ } of the last click: where a new tag is pinned
function pick(ndc) {
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(M.meshes.filter((m) => m.visible), false).filter((h) => mode === 'walk' || !U.uCut || h.point.z <= Math.min(U.uCut.value, 99));
  const h = hits[0];
  lastPick = h ? { mesh: h.object, point: h.point.clone(), normalZ: h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld).z : 0 } : null;
  return h?.object || null;
}
function select(mesh) {
  selected = mesh ? { mesh } : null;
  panel.hidden = !mesh;
  comparisonEnabled = false;
  $('pnFlag').querySelector('button[type=submit]').textContent = STATIC ? 'Save comparison' : 'Flag as BCF';
  if (!mesh) { stopShapeEdit(); return; }
  const chosen = selected;
  if (!STATIC) getJSON('api/rebuild-status').then((s) => { if (selected === chosen) chosen.revision = s.revision; }).catch((err) => { if (selected === chosen) $('pnStatus').textContent = err.message; });
  const e = mesh.userData.e;
  $('pnName').textContent = e.name || e.cls;
  const rows = [['Class', e.cls], ['Path', e.id || '— (proxy, not in the model)'], ['GUID', e.guid || '—'], ['Layer', e.layer || '—'], ['Material', e.material || '—'], ['Edited', e.edited ? 'yes (99z)' : 'no']];
  $('pnMeta').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${String(v).replace(/[<>&]/g, '')}</dd>`).join('');
  const c = e.color || [0.8, 0.8, 0.8];
  $('pnColor').value = '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  $('pnMat').value = e.material || '';
  $('pnStatus').textContent = e.id ? '' : 'Proxy furniture has no IFCX path; edits apply to model elements.';
  for (const f of ['pnEdit', 'pnFlag']) $(f).querySelectorAll('button,input').forEach((x) => { x.disabled = !e.id; });
  if (!STATIC && EDIT) startShapeEdit(mesh); else stopShapeEdit();
}
canvas.addEventListener('click', (ev) => {
  if (mode === 'walk') return;
  if (downAt && Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 4) return; // that was an inspect drag
  const r = canvas.getBoundingClientRect();
  select(pick(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1)));
});
$('pnClose').addEventListener('click', () => select(null));
$('openFile').addEventListener('click', () => {
  const st = hudFor?.st;
  const m = st && M.meshes.find((x) => x.userData.e.cls === 'IfcWall' && x.userData.phase === (/upper/i.test(st.rooms[0]?.storey || '') ? 3 : 2));
  select(m || null);
});
const post = async (u, body) => { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; };
$('pnEdit').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const e = selected?.mesh.userData.e; if (!e?.id) return;
  const hex = $('pnColor').value, color = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  $('pnStatus').textContent = 'Writing to 99z-presentation-edits…';
  try { const editing = selected; const r = await post('api/edit', { path: e.id, color, material: $('pnMat').value || undefined, expected_revision: editing.revision }); editing.revision = r.revision; $('pnStatus').textContent = r.state === 'queued' ? 'Saved; queued for rebuild.' : 'Saved; rebuilding the shared model…'; pendingSel = e.id; }
  catch (err) { $('pnStatus').textContent = `Not saved: ${err.message}`; }
});
$('pnFlag').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if(transfer||mode==='transfer'){$('pnStatus').textContent='Wait for the room change to finish before saving a comparison or flag.';return;}
  const e = selected?.mesh.userData.e; if (!e?.id) return;
  let observation = null;
  try { if (STATIC && !comparisonEnabled) await prepareComparison(); if (comparisonEnabled) observation = await saveComparison(); }
  catch (err) { $('pnStatus').textContent=err.message; return; }
  render();
  const png = observation?.frames.blend.png || canvas.toDataURL('image/png');
  if (STATIC) {
    const url=URL.createObjectURL(new Blob([JSON.stringify(observation,null,2)+'\n'],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download=`401-pearl-comparison-${new Date().toISOString().replaceAll(':','-')}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    $('pnStatus').textContent='Comparison saved to your downloads. Share it with your review notes.';return;
  }
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  // BCF camera in the model frame (undo the house rotation)
  const back = (v) => { const x = v.x * Math.cos(AXIS * DEG) - v.y * Math.sin(AXIS * DEG), y = v.x * Math.sin(AXIS * DEG) + v.y * Math.cos(AXIS * DEG); return [x, y, v.z]; };
  try {
    const r = await post('api/flag', { path: e.id, title: $('pnTitle').value || undefined, description: (() => { const r = roomOf(selected.mesh); return `Flagged in the ${mode === 'walk' ? 'free walk' : 'presentation'}${r ? ` in ${r.label}${r.apt ? `, ${r.apt}` : ''}` : ''} on ${e.name || e.id}`; })(), camera: { position: back(camera.position), direction: back(dir), up: [0, 0, 1], fov: camera.fov, aspect: camera.aspect }, png, observation, at: lastPick && lastPick.mesh === selected.mesh ? back(lastPick.point) : undefined });
    $('pnStatus').textContent = `Flagged: BCF 3.0 topic ${r.guid.slice(0, 8)} saved in the model's bcf folder.`;
    say(`Flagged “${$('pnTitle').value || r.element}” on ${r.element} · BCF topic ${r.guid.slice(0, 8)} saved`);
    $('pnTitle').value = '';
    await loadFlags();
  } catch (err) { $('pnStatus').textContent = `Not flagged: ${err.message}`; }
});
let pendingSel = null;

// ---------- element editor (owner 2026-10-18): click any element; every vertex is a node you can drag; double-click a
// line to add a node; double-click a node to curve or straighten the segment into it; Option-click a node to delete it.
// "Draw shape" puts a new shape on the face you are looking at (click its corners, double-click to finish); its slider
// pushes it in (recess, or through) or pulls it out. Save writes it all to opening-params.json ("elements") and the
// server rebuilds that element in the model from exactly these nodes.
let openingDoc = { walls: {} };
async function loadOpenings() { try { openingDoc = await getJSON('opening-params.json'); } catch { openingDoc = { walls: {} }; } }
loadOpenings();
let shape = null; // { path, name, e: {normal, thickness, profile:{outlines,holes}, features}, orig, group, handles, sel, drag, drawing }
const shapeMat = new THREE.MeshBasicMaterial({ color: 0x1f6bff, transparent: true, opacity: 0.22, depthTest: false, side: THREE.DoubleSide });
const outMat = new THREE.MeshBasicMaterial({ color: 0x10a35a, transparent: true, opacity: 0.45, depthTest: false, side: THREE.DoubleSide });
const inMat = new THREE.MeshBasicMaterial({ color: 0xd8322a, transparent: true, opacity: 0.45, depthTest: false, side: THREE.DoubleSide });
const shapeLine = new THREE.LineBasicMaterial({ color: 0x1f6bff, depthTest: false });
const guideLine = new THREE.LineDashedMaterial({ color: 0x1f6bff, dashSize: 0.03, gapSize: 0.03, depthTest: false });
const clone = (x) => JSON.parse(JSON.stringify(x));
const loopsOf = (e) => ({ o: e.profile.outlines, h: e.profile.holes, f: e.features.map((f) => f.loop) });
const loopRef = (kind, li) => (kind === 'f' ? shape.e.features[li].loop : kind === 'o' ? shape.e.profile.outlines[li] : shape.e.profile.holes[li]);
// plane (a, b) <-> house frame: normal u -> (t, a, b); v -> (a, t, b); z -> (a, b, t)
function planePoint(e, a, b, t = null) {
  const tt = t ?? (e.thickness[0] + e.thickness[1]) / 2;
  return e.normal === 'u' ? new THREE.Vector3(tt, a, b) : e.normal === 'v' ? new THREE.Vector3(a, tt, b) : new THREE.Vector3(a, b, tt);
}
function planeMatrix(e, t0) {
  return e.normal === 'u' ? new THREE.Matrix4().set(0, 0, 1, t0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1)
    : e.normal === 'v' ? new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, t0, 0, 1, 0, 0, 0, 0, 0, 1)
      : new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, t0, 0, 0, 0, 1);
}
function addLoop(path, nodes) {
  const last = nodes[nodes.length - 1].p;
  path.moveTo(last[0], last[1]);
  for (const n of nodes) { if (n.c) path.quadraticCurveTo(n.c[0], n.c[1], n.p[0], n.p[1]); else path.lineTo(n.p[0], n.p[1]); }
}
function prismGeometry(e, loops, t0, t1) { // loops: even-odd (outlines and holes by winding via ShapePath)
  const sp = new THREE.ShapePath();
  for (const l of loops) { if (l.length < 3) continue; const pth = new THREE.Path(); addLoop(pth, l); sp.subPaths.push(pth); }
  const shapes = sp.toShapes(false);
  const g = new THREE.ExtrudeGeometry(shapes, { depth: Math.max(1e-3, Math.abs(t1 - t0)), bevelEnabled: false, curveSegments: 16 });
  g.applyMatrix4(planeMatrix(e, Math.min(t0, t1)));
  return g;
}
function redrawShape() {
  if (!shape) return;
  const e = shape.e;
  shape.group.clear();
  const base = prismGeometry(e, [...e.profile.outlines, ...e.profile.holes], e.thickness[0], e.thickness[1]);
  shape.group.add(new THREE.Mesh(base, shapeMat), new THREE.LineSegments(new THREE.EdgesGeometry(base, 15), shapeLine));
  for (const f of e.features) {
    if (f.loop.length < 3) continue;
    const face = f.face === 'back' ? e.thickness[0] : e.thickness[1], sign = f.face === 'back' ? -1 : 1, d = f.depth || 0;
    const g = prismGeometry(e, [f.loop], face, face + sign * (Math.abs(d) < 0.002 ? 0.002 * Math.sign(d || 1) : d));
    shape.group.add(new THREE.Mesh(g, d >= 0 ? outMat : inMat), new THREE.LineSegments(new THREE.EdgesGeometry(g, 15), shapeLine));
  }
  if (shape.drawing?.length) {
    const pts = shape.drawing.map((n) => planePoint(e, n.p[0], n.p[1], e.thickness[1]));
    shape.group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x10a35a, depthTest: false })));
  }
  for (const [kind, loops] of Object.entries(loopsOf(e))) loops.forEach((ns) => ns.forEach((n, i) => {
    if (!n.c) return;
    const a = ns[(i - 1 + ns.length) % ns.length].p;
    const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints([planePoint(e, ...a), planePoint(e, ...n.c), planePoint(e, ...n.p)]), guideLine);
    ln.computeLineDistances(); shape.group.add(ln);
  }));
  // readout
  const cnt = (ls) => ls.reduce((k, l) => k + l.length, 0);
  const sel = shape.sel ? (() => { const [k, li, ni, w] = shape.sel; const q = loopRef(k, li)?.[ni]?.[w]; return q ? `${w === 'c' ? 'bend' : 'node'} ${q[0].toFixed(3)}, ${q[1].toFixed(3)} m` : ''; })() : 'none';
  $('shVals').innerHTML = `<dt>Plane</dt><dd>${e.normal === 'z' ? 'horizontal' : 'vertical'} · ${(e.thickness[1] - e.thickness[0]).toFixed(3)} m thick</dd>`
    + `<dt>Nodes</dt><dd>${cnt(e.profile.outlines) + cnt(e.profile.holes)} (${e.profile.holes.length} openings) · ${e.features.length} shapes</dd><dt>Selected</dt><dd>${sel}</dd>`
    + `<dt>Do</dt><dd>${shape.drawing ? 'click the corners of the new shape on the face · double-click to finish · Esc to cancel' : 'drag nodes · double-click a line to add a node · double-click a node: curve/straight · Option-click: delete'}</dd>`;
  // push/pull sliders, one per shape
  const fl = $('shFeatures'); fl.innerHTML = '';
  e.features.forEach((f, fi) => {
    const div = document.createElement('div'); div.className = 'feat';
    const lim = e.thickness[1] - e.thickness[0] + 0.02;
    div.innerHTML = `<div class="frow"><span>Shape ${fi + 1} · ${f.face} face · <b>${(f.depth >= 0 ? 'out ' : 'in ') + Math.abs(f.depth).toFixed(3)} m</b></span><button type="button">delete</button></div>`
      + `<input type="range" min="${(-lim).toFixed(3)}" max="0.300" step="0.002" value="${f.depth}"><div class="frow"><span>← push in</span><span>pull out →</span></div>`;
    div.querySelector('input').addEventListener('input', (ev) => { f.depth = Number(ev.target.value); div.querySelector('b').textContent = (f.depth >= 0 ? 'out ' : 'in ') + Math.abs(f.depth).toFixed(3) + ' m'; redrawShape(true); });
    div.querySelector('button').addEventListener('click', () => { e.features.splice(fi, 1); shape.sel = null; redrawShape(); });
    fl.appendChild(div);
  });
  if (shape.drag && shape.handles.length) { placeHandles(); return; }
  if (arguments[0] === true && shape.handles.length) { placeHandles(); return; } // slider: keep handles and the slider
  buildHandles();
}
function buildHandles() {
  const box = $('handles'); box.innerHTML = ''; shape.handles = [];
  const e = shape.e;
  const main = mainOutline(e);
  for (const [kind, loops] of Object.entries(loopsOf(e))) loops.forEach((ns, li) => ns.forEach((n, ni) => {
    if (kind === 'o' && li !== main) return; // inner pieces (sashes, frames) follow the outer shape
    if (kind === 'h' && !shape.wallLike) return; // a window's glass follows its frame; a wall's openings keep their own nodes
    for (const w of n.c ? ['p', 'c'] : ['p']) {
      const ref = [kind, li, ni, w];
      const el = document.createElement('div'); el.className = `hnd ${w === 'c' ? 'r' : 'e'} ${kind === 'f' ? 'f' : ''}`;
      el.addEventListener('pointerdown', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        if (ev.altKey && w === 'p') { const l = loopRef(kind, li); if (l.length > 3) { l.splice(ni, 1); shape.sel = null; redrawShape(); } return; }
        el.setPointerCapture(ev.pointerId); shape.drag = ref; shape.sel = ref;
      });
      el.addEventListener('pointermove', (ev) => { if (shape?.drag === ref) dragNode(ref, ev); });
      el.addEventListener('pointerup', () => { if (shape) { shape.drag = null; redrawShape(); } });
      el.addEventListener('dblclick', (ev) => {
        ev.stopPropagation(); if (w !== 'p') return;
        const l = loopRef(kind, li), nn = l[ni], a = l[(ni - 1 + l.length) % l.length].p;
        if (nn.c) delete nn.c; else nn.c = [(a[0] + nn.p[0]) / 2, (a[1] + nn.p[1]) / 2];
        redrawShape();
      });
      box.appendChild(el);
      shape.handles.push({ el, ref });
    }
  }));
  placeHandles();
}
function placeHandles() {
  if (!shape) return;
  for (const h of shape.handles) {
    const [kind, li, ni, w] = h.ref, q = loopRef(kind, li)?.[ni]?.[w];
    if (!q) { h.el.style.display = 'none'; continue; }
    const f = kind === 'f' ? shape.e.features[li] : null;
    const t = f ? (f.face === 'back' ? shape.e.thickness[0] : shape.e.thickness[1]) : null;
    const v = planePoint(shape.e, q[0], q[1], t).project(camera);
    const on = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
    h.el.style.display = on ? '' : 'none';
    h.el.classList.toggle('sel', !!shape.sel && shape.sel.join() === h.ref.join());
    if (on) { h.el.style.left = `${((v.x + 1) / 2) * innerWidth}px`; h.el.style.top = `${((1 - v.y) / 2) * innerHeight}px`; }
  }
}
const shapeRay = new THREE.Raycaster();
function planeHit(ev, t = null) {
  const e = shape.e, tt = t ?? (e.thickness[0] + e.thickness[1]) / 2;
  shapeRay.setFromCamera(ndcOf(ev), camera);
  const nrm = e.normal === 'u' ? new THREE.Vector3(1, 0, 0) : e.normal === 'v' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const hit = new THREE.Vector3();
  if (!shapeRay.ray.intersectPlane(new THREE.Plane(nrm, -tt), hit)) return null;
  return e.normal === 'u' ? [hit.y, hit.z] : e.normal === 'v' ? [hit.x, hit.z] : [hit.x, hit.y];
}
const r4 = (x) => Math.round(x * 10000) / 10000;
function dragNode(ref, ev) {
  const [kind, li, ni, w] = ref, f = kind === 'f' ? shape.e.features[li] : null;
  const q = planeHit(ev, f ? (f.face === 'back' ? shape.e.thickness[0] : shape.e.thickness[1]) : null); if (!q) return;
  const before = kind === 'o' && li === mainOutline(shape.e) ? loopBox(shape.e.profile.outlines[li]) : null;
  loopRef(kind, li)[ni][w] = [r4(q[0]), r4(q[1])];
  if (before) {
    const after = loopBox(shape.e.profile.outlines[li]);
    const map = (pt) => [r4(after[0] + (pt[0] - before[0]) * (after[2] - after[0]) / ((before[2] - before[0]) || 1)), r4(after[1] + (pt[1] - before[1]) * (after[3] - after[1]) / ((before[3] - before[1]) || 1))];
    shape.e.profile.outlines.forEach((l, k) => { if (k !== li) for (const n of l) { n.p = map(n.p); if (n.c) n.c = map(n.c); } });
    if (!shape.wallLike) shape.e.profile.holes.forEach((l) => { for (const n of l) { n.p = map(n.p); if (n.c) n.c = map(n.c); } });
  }
  redrawShape();
}
const loopBox = (l) => { let a = [Infinity, Infinity, -Infinity, -Infinity]; for (const n of l) { a = [Math.min(a[0], n.p[0]), Math.min(a[1], n.p[1]), Math.max(a[2], n.p[0]), Math.max(a[3], n.p[1])]; } return a; };
const loopArea = (l) => { const b = loopBox(l); return (b[2] - b[0]) * (b[3] - b[1]); };
const mainOutline = (e) => e.profile.outlines.reduce((best, l, i, all) => (loopArea(l) > loopArea(all[best]) ? i : best), 0);
// a scanned/meshed loop has many points on every rounded corner: keep the real corners, and turn each run of short
// segments (a round) into one node with one bend handle at the crossing of the two straight sides (owner 2026-10-18)
function simplifyLoop(loop) {
  const P = loop.map((n) => n.p), N = P.length;
  if (N <= 4) return loop;
  const len = (i) => Math.hypot(P[(i + 1) % N][0] - P[i][0], P[(i + 1) % N][1] - P[i][1]); // segment i: P[i] -> P[i+1]
  const LONG = 0.06, isLong = P.map((_, i) => len(i) >= LONG);
  if (!isLong.some(Boolean)) { const step = Math.ceil(N / 8); return P.filter((_, i) => i % step === 0).map((p) => ({ p })); }
  const start = isLong.indexOf(true), out = [];
  let i = start;
  do {
    // P[i] -> P[i+1] is long; then a (possibly empty) run of short segments up to the next long one
    let j = (i + 1) % N;
    while (!isLong[j]) j = (j + 1) % N;
    const a0 = P[i], a1 = P[(i + 1) % N], b0 = P[j], b1 = P[(j + 1) % N];
    if (j === (i + 1) % N) out.push({ p: a1 });
    else {
      // a tiny jog at a corner is a corner, not a curve
      const cc = (() => { const d1 = [a1[0] - a0[0], a1[1] - a0[1]], d2 = [b1[0] - b0[0], b1[1] - b0[1]], den = d1[0] * d2[1] - d1[1] * d2[0]; if (Math.abs(den) < 1e-9) return null; const t = ((b0[0] - a1[0]) * d2[1] - (b0[1] - a1[1]) * d2[0]) / den; return [a1[0] + d1[0] * t, a1[1] + d1[1] * t]; })();
      if (cc && Math.hypot(cc[0] - a1[0], cc[1] - a1[1]) < 0.035 && Math.hypot(cc[0] - b0[0], cc[1] - b0[1]) < 0.035) { out.push({ p: [r4(cc[0]), r4(cc[1])] }); i = j; continue; }
      out.push({ p: a1 });
      // the bend handle: where the two straight sides would meet
      const d1 = [a1[0] - a0[0], a1[1] - a0[1]], d2 = [b1[0] - b0[0], b1[1] - b0[1]], den = d1[0] * d2[1] - d1[1] * d2[0];
      let c;
      if (Math.abs(den) > 1e-9) { const t = ((b0[0] - a1[0]) * d2[1] - (b0[1] - a1[1]) * d2[0]) / den; c = [a1[0] + d1[0] * t, a1[1] + d1[1] * t]; }
      else { let k = (i + 1) % N, m = 0; const run = []; while (k !== (j + 1) % N) { run.push(P[k]); k = (k + 1) % N; } const mid = run[run.length >> 1]; c = [2 * mid[0] - (a1[0] + b0[0]) / 2, 2 * mid[1] - (a1[1] + b0[1]) / 2]; }
      out.push({ p: b0, c: [r4(c[0]), r4(c[1])] });
    }
    i = j;
  } while (i !== start);
  // drop nodes that sit on a straight line between their neighbours (no bend in or out)
  return out.filter((n, k) => {
    if (n.c || out[(k + 1) % out.length].c) return true;
    const a = out[(k - 1 + out.length) % out.length].p, b = out[(k + 1) % out.length].p, p = n.p;
    return Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1) > 0.004;
  });
}
// the face toward the camera: shapes are drawn there
function nearFace() {
  const e = shape.e, c = camera.position, mid = (e.thickness[0] + e.thickness[1]) / 2;
  const cc = e.normal === 'u' ? c.x : e.normal === 'v' ? c.y : c.z;
  return cc >= mid ? 'front' : 'back';
}
$('shDraw').addEventListener('click', () => {
  if (!shape) return;
  shape.drawing = shape.drawing ? null : [];
  $('shDraw').classList.toggle('on', !!shape.drawing); document.body.classList.toggle('drawing', !!shape.drawing);
  redrawShape();
});
function finishDrawing() {
  if (!shape?.drawing) return;
  if (shape.drawing.length >= 3) shape.e.features.push({ loop: shape.drawing, face: nearFace(), depth: 0 });
  shape.drawing = null; $('shDraw').classList.remove('on'); document.body.classList.remove('drawing');
  redrawShape();
}
addEventListener('keydown', (ev) => { if (shape?.drawing && ev.key === 'Escape') { shape.drawing = null; $('shDraw').classList.remove('on'); document.body.classList.remove('drawing'); redrawShape(); ev.stopImmediatePropagation(); } if (shape?.drawing && ev.key === 'Enter') finishDrawing(); }, true);
// clicks while drawing put corners on the face (and nothing else happens: no walking, no selecting)
canvas.addEventListener('click', (ev) => {
  if (!shape?.drawing) return;
  ev.stopImmediatePropagation();
  const face = nearFace() === 'back' ? shape.e.thickness[0] : shape.e.thickness[1];
  const q = planeHit(ev, face); if (!q) return;
  shape.drawing.push({ p: [r4(q[0]), r4(q[1])] });
  redrawShape();
}, true);
// double-click: finish a drawing, or add a node on the nearest line (a curve is split so it keeps its shape)
canvas.addEventListener('dblclick', (ev) => {
  if (!shape) return;
  if (shape.drawing) { ev.stopImmediatePropagation(); shape.drawing.pop(); finishDrawing(); return; }
  const q = planeHit(ev); if (!q) return;
  let best = null;
  for (const [kind, loops] of Object.entries(loopsOf(shape.e))) loops.forEach((ns, li) => ns.forEach((n, ni) => {
    const a = ns[(ni - 1 + ns.length) % ns.length].p, b = n.p, c = n.c;
    for (let s = 0; s <= 40; s++) {
      const t = s / 40;
      const x = c ? (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0] : a[0] + (b[0] - a[0]) * t;
      const y = c ? (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1] : a[1] + (b[1] - a[1]) * t;
      const d = Math.hypot(x - q[0], y - q[1]);
      if (!best || d < best.d) best = { d, kind, li, ni, t, x, y };
    }
  }));
  if (!best || best.d > 0.12) return;
  ev.stopImmediatePropagation();
  const l = loopRef(best.kind, best.li), n = l[best.ni], a = l[(best.ni - 1 + l.length) % l.length].p, t = best.t;
  const node = { p: [r4(best.x), r4(best.y)] };
  if (n.c) { const c = n.c; node.c = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t]; n.c = [c[0] + (n.p[0] - c[0]) * t, c[1] + (n.p[1] - c[1]) * t]; }
  l.splice(best.ni, 0, node);
  shape.sel = [best.kind, best.li, best.ni, 'p'];
  redrawShape();
}, true);
async function startShapeEdit(mesh) {
  stopShapeEdit();
  const path = mesh?.userData.e?.id;
  if (!path) return;
  $('pnShape').hidden = false; $('shVals').innerHTML = '<dt>Reading</dt><dd>its nodes from the model…</dd>';
  let e;
  try { e = await getJSON(`api/element-profile?path=${encodeURIComponent(path)}`); } catch (err) { $('shVals').innerHTML = `<dt>Not editable</dt><dd>${err.message}</dd>`; return; }
  if (selected?.mesh !== mesh) return; // the selection moved on while reading
  const revision = e.revision;
  e = { name: e.name || mesh.userData.e.name, normal: e.normal, thickness: e.thickness, profile: { outlines: e.profile.outlines || [], holes: e.profile.holes || [] }, features: e.features || [] };
  e.profile.outlines = e.profile.outlines.map(simplifyLoop); e.profile.holes = e.profile.holes.map(simplifyLoop); e.features.forEach((f) => { f.loop = simplifyLoop(f.loop); });
  const wallLike = /IfcWall|IfcSlab|IfcRoof|IfcCovering/.test(mesh.userData.e.cls || '');
  shape = { path, name: e.name, e, revision, wallLike, orig: clone(e), group: new THREE.Group(), handles: [], sel: null, drag: null, drawing: null };
  overlay.add(shape.group);
  redrawShape();
}
function stopShapeEdit() {
  if (!shape) { $('pnShape').hidden = true; return; }
  overlay.remove(shape.group); shape = null; $('handles').innerHTML = ''; $('pnShape').hidden = true; document.body.classList.remove('drawing');
}
$('shReset').addEventListener('click', () => { if (!shape) return; shape.e = clone(shape.orig); shape.sel = null; shape.drawing = null; redrawShape(); });
$('shSave').addEventListener('click', async () => {
  if (!shape) return;
  const editing = shape;
  const { path, name, e } = editing;
  try {
    const saved = await post('api/element-shape', { path, name, normal: e.normal, thickness: e.thickness, profile: e.profile, features: e.features, expected_revision: editing.revision });
    editing.revision = saved.revision;
    pendingSel = path;
    say(`Saved ${name} · rebuilding it from your nodes…`);
    $('pnStatus').textContent = saved.state === 'queued' ? 'Saved. Waiting for the current rebuild.' : 'Saved. Rebuilding the shared model.';
    editing.orig = clone(e);
  } catch (err) { $('pnStatus').textContent = `Not saved: ${err.message}`; }
});

// ---------- issues: every flag is a buildingSMART BCF 3.0 topic (server /api/flags); its element turns red, carries a
// red tag on screen, and is listed with its room; Go to stands you at the flag's own camera (owner 2026-10-18) ----------
const MAT_FLAG = new THREE.MeshBasicMaterial({ color: 0xc8261f });
let flags = [];
const flaggedPaths = new Map(); // element path -> its topics
const fwdModel = (p) => p && [p[0] * Math.cos(AXIS * DEG) + p[1] * Math.sin(AXIS * DEG), -p[0] * Math.sin(AXIS * DEG) + p[1] * Math.cos(AXIS * DEG), p[2]];
const meshOfPath = (path) => M.meshes.find((m) => m.userData.e?.id === path) || null;
function roomOf(mesh) {
  if (!mesh) return null;
  const c = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
  const hits = M.spaces.filter((r) => pointIn([c.x, c.y], r.poly) && r.floorZ <= c.z + 0.3 && c.z - r.floorZ < 3.2);
  return hits.sort((a, b) => b.floorZ - a.floorZ || a.area - b.area)[0] || null;
}
const whereText = (f) => {
  const m = meshOfPath(f.path), r = roomOf(m);
  return `${m?.userData.e.name || f.path}${r ? ` · ${r.label}${r.apt ? `, ${r.apt}` : ''}` : ''}`;
};
let tagEls = [];
async function loadFlags() {
  try { flags = await getJSON('api/flags'); } catch { flags = []; }
  flaggedPaths.clear();
  const open = flags.filter((f) => f.status !== 'Closed');
  for (const f of open) if (f.path) { if (!flaggedPaths.has(f.path)) flaggedPaths.set(f.path, []); flaggedPaths.get(f.path).push(f); }
  $('issuesPill').textContent = `Issues · ${open.length}`;
  $('issuesPill').classList.toggle('has', open.length > 0);
  const showClosed = $('issuesResolved').checked;
  const list = $('issueList'); list.innerHTML = '';
  for (const f of flags.filter((x) => showClosed || x.status !== 'Closed')) {
    const li = document.createElement('li');
    li.classList.toggle('closed', f.status === 'Closed');
    const d = new Date(f.created);
    li.innerHTML = '<b></b><span></span><span></span>';
    li.children[0].textContent = f.title;
    li.children[1].textContent = whereText(f);
    li.children[2].textContent = `${isNaN(d) ? '' : d.toLocaleString()} · ${f.status === 'Closed' ? 'resolved' : 'open'} · BCF ${f.guid.slice(0, 8)}`;
    li.addEventListener('click', () => { openIssue(f); });
    list.appendChild(li);
  }
  // one red tag per open issue, at its pinned spot (or the top of its element for flags made before pins)
  const box = $('tags'); box.innerHTML = ''; tagEls = [];
  for (const f of open) {
    const mesh = meshOfPath(f.path); if (!mesh) continue;
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'itag';
    el.textContent = `! ${f.title.slice(0, 26)}`;
    el.addEventListener('click', (ev) => { ev.stopPropagation(); openIssue(f); });
    box.appendChild(el);
    const pin = f.pin ? new THREE.Vector3(...fwdModel(f.pin)) : null;
    tagEls.push({ el, mesh, pin });
  }
}
$('issuesResolved').addEventListener('change', loadFlags);
const _tv = new THREE.Vector3(), _tb = new THREE.Box3(), _tp = new THREE.Vector3(), tagRay = new THREE.Raycaster();
function updateTags() {
  const cut = mode === 'walk' ? 99 : U.uCut.value;
  const visibleMeshes = M.meshes.filter((m) => m.visible);
  for (const t of tagEls) {
    if (t.pin) _tp.copy(t.pin);
    else { _tb.setFromObject(t.mesh); _tp.set((_tb.min.x + _tb.max.x) / 2, (_tb.min.y + _tb.max.y) / 2, Math.min(_tb.max.z, cut)); }
    _tv.copy(_tp).project(camera);
    let on = t.mesh.visible && _tv.z < 1 && Math.abs(_tv.x) < 1.05 && Math.abs(_tv.y) < 1.05 && _tp.z <= cut + 0.05;
    if (on) { // hidden when a wall or floor stands between you and the spot (owner: "not through the walls")
      const d = _tp.distanceTo(camera.position);
      tagRay.set(camera.position, _tp.clone().sub(camera.position).normalize()); tagRay.far = d;
      const hit = tagRay.intersectObjects(visibleMeshes, false).find((h) => h.object !== t.mesh && h.point.z <= cut);
      if (hit && hit.distance < d - 0.12) on = false;
    }
    t.el.style.display = on ? '' : 'none';
    if (on) { t.el.style.left = `${((_tv.x + 1) / 2) * innerWidth}px`; t.el.style.top = `${((1 - _tv.y) / 2) * innerHeight}px`; }
  }
}
let cardFlag = null;
function openIssue(f) {
  cardFlag = f;
  $('icKicker').textContent = `Issue · BCF 3.0 · ${f.status}`;
  $('icTitle').textContent = f.title;
  $('icWhere').textContent = whereText(f);
  const d = new Date(f.created);
  $('icMeta').textContent = `${f.description || ''}${f.description ? ' · ' : ''}${isNaN(d) ? '' : d.toLocaleString()} · ${f.author || ''} · topic ${f.guid}`;
  $('icShot').hidden = !f.snapshot;
  if (f.snapshot) $('icShot').src = `api/flag-snapshot?guid=${encodeURIComponent(f.guid)}`;
  $('icCompare').hidden = !f.comparison;
  $('icResolve').textContent = f.status === 'Closed' ? 'Reopen' : 'Resolve';
  $('issueCard').hidden = false;
}
function goToIssue(f) {
  $('issueCard').hidden=true;$('issues').hidden=true;$('issuesPill').classList.remove('on');
  const p=fwdModel(f.camera?.position),m=meshOfPath(f.path),r=m&&roomOf(m);
  const room=r||(p&&roomUnder(p[0],p[1],p[2]-EYE));
  if(room)navigateRoom(room.name,p);else goShot('orbit');
}
$('issuesPill').addEventListener('click', () => { const h = !$('issues').hidden; $('issues').hidden = h; $('issuesPill').classList.toggle('on', !h); $('issuesPill').setAttribute('aria-expanded', String(!h)); });
$('issuesClose').addEventListener('click', () => { $('issues').hidden = true; $('issuesPill').classList.remove('on'); });
$('icClose').addEventListener('click', () => { $('issueCard').hidden = true; });
$('icGo').addEventListener('click', () => { if (cardFlag) goToIssue(cardFlag); });
$('icResolve').addEventListener('click', async () => {
  if (!cardFlag) return;
  const status = cardFlag.status === 'Closed' ? 'Open' : 'Closed';
  try { await post('api/flag-status', { guid: cardFlag.guid, status }); say(`${status === 'Closed' ? 'Resolved' : 'Reopened'}: “${cardFlag.title}” (BCF ${cardFlag.guid.slice(0, 8)})`); }
  catch (err) { say(`Not changed: ${err.message}`); }
  $('issueCard').hidden = true;
  await loadFlags();
});
// Plan | Walk | Model work in every mode (owner 2026-10-18): Plan = the plan of the floor you are on, Walk = the free
// walk where you left it, Model = the whole model from outside; the panel minimises out of the way
function syncTourPosition(p) {
  target=prog=p;navHold={p,until:performance.now()+900};
  const y=p*Math.max(1,track.offsetHeight-innerHeight);if(lenis)lenis.scrollTo(y,{immediate:true});else scrollTo(0,y);
}
function currentPose() {
  const dir=camera.getWorldDirection(new THREE.Vector3());
  return directedPose(camera.position.toArray(),Math.atan2(dir.y,dir.x)/DEG,-Math.asin(Math.max(-1,Math.min(1,dir.z)))/DEG,camera.fov,{cut:U.uCut.value});
}
function requestTransfer(destination, {key=null,finishMode='walk',resumeProgress=null,qualification=null,resumeInspection=null}={}) {
  if(comparisonBusy){say('Finish the capture comparison before changing rooms.');return {error:'COMPARISON_IN_PROGRESS'};}
  const request={destination,key,finishMode,resumeProgress,qualification,resumeInspection};
  if(transfer){pendingNavigation=request;return {queued:true,token:transfer.token};}
  if(mode==='scroll'&&!pausedTour)pausedTour={p:prog,yaw:insp.yaw,pitch:insp.pitch};
  const from=currentPose();insp.yaw=insp.pitch=insp.desiredYaw=insp.desiredPitch=0;insp.drag=null;keys.clear();dragging=null;
  const sequence=buildRoomTransfer(from,destination,{flightZ:Math.max(flightAltitude(),from.eye[2],destination.eye[2]),roomKey:key,targetCut:destination.cut??OFF(),floorCenter:floorCenterFor(key)});
  transfer={...request,shots:sequence,total:layout(sequence),progress:0,token:++navigationToken};targetRoom=key;
  mode='transfer';document.body.classList.add('walking');walkHud.hidden=false;$('resumePill').hidden=false;
  hero.style.opacity=chapter.style.opacity=hud.style.opacity=caption.style.opacity=walkTag.style.opacity='0';
  U.uAll.value=1;U.uPhaseCut.value.fill(99);CU.uAnnOp.value=CU.uLblOp.value=0;lenis?.stop();
  return {queued:false,token:transfer.token};
}
function navigateRoom(key, preferredEye=null, {finishMode='scroll',pose=null}={}) {
  const st=M.stops.find(s=>s.key===key||s.rooms[0]?.s.id===key);if(!st)return {error:'Unknown room'};
  let destination=roomPose(st),qualification=st.qualification;
  if(preferredEye&&finishMode==='walk'){const q=clearance.target(st.rooms[0],preferredEye);if(q.status==='SAFE_ROOM'){qualification=q;destination=directedPose(q.eye,pose?.yaw??90,pose?.pitch??0,pose?.fov??72,{cut:OFF(),roomKey:st.key});}}
  const dossier=dossiers.find(d=>d.st.key===st.key),resumeProgress=dossier?(dossier.shot.h0+dossier.shot.h1)/2/TOTAL:prog;
  requestTransfer(destination,{key:st.key,qualification,finishMode,resumeProgress});
  return qualification;
}
function goShot(id) {
  const q=shots.find(x=>x.id===id)||shots.find(x=>x.id==='plan-centre');if(!q)return;
  const p=(q.h0+q.h1)/2/TOTAL,c=sample(shots,p*TOTAL);
  return requestTransfer({...q,eye:c.eye,yaw:c.yaw,pitch:c.pitch,fov:c.fov},{key:q.roomKey??null,finishMode:'scroll',resumeProgress:p});
}
$('navPlan').addEventListener('click',()=>goShot(activeRoom?`floor-plan:${activeRoom}`:'plan-centre'));
$('navModel').addEventListener('click',()=>explore('outside'));
$('navWalk').addEventListener('click',()=>explore('inside'));
$('pnMin').addEventListener('click',()=>panel.classList.toggle('min'));
$('icFile').addEventListener('click',()=>{const m=cardFlag&&meshOfPath(cardFlag.path);$('issueCard').hidden=true;if(m)select(m);});

const walkHud=$('walkhud'),keys=new Set();
const walk={pos:new THREE.Vector3(),yaw:90,pitch:0,floor:0,fov:72,pending:[0,0],desiredYaw:90,desiredPitch:0,desiredFov:72};
let pausedTour=null,insidePose=null;
function rememberInside(){if(mode==='walk'&&roomUnder(walk.pos.x,walk.pos.y,walk.floor))insidePose={key:roomUnder(walk.pos.x,walk.pos.y,walk.floor).name,pos:walk.pos.clone(),floor:walk.floor,yaw:walk.yaw,pitch:walk.pitch,fov:walk.fov};}
function explore(where) {
  if(transfer){pendingNavigation={explore:where};return;}
  rememberInside();
  if(where==='inside') {
    const st=M.stops.find(s=>s.key===(insidePose?.key??activeRoom))||dossiers.filter(d=>d.shot.h0<=prog*TOTAL).at(-1)?.st||M.stops.find(s=>s.key==='AptA - Entry'&&s.qualification.status==='SAFE_ROOM')||M.stops.find(s=>s.qualification.status==='SAFE_ROOM')||M.stops[0];
    return navigateRoom(st.key,insidePose?.pos.toArray(),{finishMode:'walk',pose:insidePose});
  }
  const z=Math.max(M.FFL+EYE,M.box.min.z+EYE),pos=[M.center.x,M.box.min.y-5,z];
  const dest=directedPose(pos,90,-5,72,{cut:OFF()});
  return requestTransfer(dest,{key:null});
}
function enterWalk(){return explore('inside');}
function leaveWalk(){
  rememberInside();const p=pausedTour?.p??prog,c=sample(shots,p*TOTAL),inspection={yaw:pausedTour?.yaw??0,pitch:pausedTour?.pitch??0};
  const destination={...c,t:[c.x,c.y,c.z],yaw:c.yaw+inspection.yaw,pitch:Math.max(-89.8,Math.min(89.8,c.pitch+inspection.pitch)),cut:channel(shots,p*TOTAL,'cut',OFF())};
  return requestTransfer(destination,{key:c.from.roomKey??null,finishMode:'scroll',resumeProgress:p,resumeInspection:inspection});
}
walkPill.addEventListener('click', () => explore('inside'));
$('outsidePill').addEventListener('click', () => explore('outside'));
$('resumePill').addEventListener('click', leaveWalk);
addEventListener('keydown', (e) => {
  if (mode !== 'walk') return;
  if (e.key === 'Escape') return leaveWalk();
  if(['0','1','2'].includes(e.key)){const z=e.key==='0'?M.storeys.base?.elevation:e.key==='2'?M.storeys.upper?.elevation:M.FFL;const st=M.stops.find(s=>Math.abs(s.floorZ-z)<.3);if(st)navigateRoom(st.key);return;}
  if(e.key.toLowerCase()==='e')select(pick(new THREE.Vector2(0,0)));
  if(e.key==='[')walk.desiredFov=Math.max(60,walk.desiredFov-5);
  if(e.key===']')walk.desiredFov=Math.min(90,walk.desiredFov+5);
  keys.add(e.key.toLowerCase());
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
// walk mouse (owner 2026-10-18): left or right drag looks around, middle drag slides sideways and forward/back,
// the wheel requests bounded forward/back movement at the current level.
let dragging = null;
function moveWalk(mx,my){if(mode!=='walk')return;walk.pending[0]+=mx;walk.pending[1]+=my;const n=Math.hypot(...walk.pending);if(n>1)walk.pending=walk.pending.map(v=>v/n);}
canvas.addEventListener('contextmenu', (e) => { if (mode === 'walk') e.preventDefault(); });
canvas.addEventListener('mousedown', (e) => { if (mode === 'walk') { dragging = { x: e.clientX, y: e.clientY, b: e.button }; if (e.button === 1) e.preventDefault(); } });
canvas.addEventListener('mousemove', (e) => {
  if (mode !== 'walk' || !dragging) return;
  const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
  dragging.x = e.clientX; dragging.y = e.clientY;
  if (dragging.b === 1) {
    const y = walk.yaw * DEG, f = [Math.cos(y), Math.sin(y)], r = [Math.sin(y), -Math.cos(y)], k = 0.012;
    moveWalk(-dx * k * r[0] + dy * k * f[0], -dx * k * r[1] + dy * k * f[1]);
  } else { walk.desiredYaw -= dx * 0.15; walk.desiredPitch = Math.max(-80, Math.min(80, walk.desiredPitch + dy * 0.15)); }
});
addEventListener('mouseup', () => { dragging = null; });
canvas.addEventListener('wheel', (e) => {
  if (mode !== 'walk') return;
  e.preventDefault();
  const step = -Math.sign(e.deltaY) * Math.min(0.6, Math.abs(e.deltaY) * 0.004);
  const y = walk.yaw * DEG, p = walk.pitch * DEG;
  moveWalk(Math.cos(y)*step,Math.sin(y)*step);
}, { passive: false });
const roomUnder = (x, y, z) => M.spaces.find((r) => Math.abs(r.floorZ - z) < 1.2 && (() => { let c2 = false; const poly = r.poly; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c2 = !c2; } return c2; })());
// Manual movement keeps its qualified level and checks actual support and swept body clearance.
// Floor changes use the same overhead room route as the navigator.
const downRay = new THREE.Raycaster(), sideRay = new THREE.Raycaster();
const STEP_UP = 0.45, RADIUS = 0.28;
const walkables = () => M.meshes.filter((m) => /IfcSlab|IfcStair|IfcStairFlight/.test(m.userData.e?.cls || '') || /foundation/i.test(m.userData.e?.name || ''));
const blockers = () => M.meshes.filter((m) => /IfcWall|IfcWindow|IfcDoor|IfcRailing/.test(m.userData.e?.cls || '') && !/foundation/i.test(m.userData.e?.name || ''));
function floorBelow(x, y, from) {
  downRay.set(new THREE.Vector3(x, y, from + STEP_UP), new THREE.Vector3(0, 0, -1));
  downRay.far = 6;
  const hit = downRay.intersectObjects(walkables(), false).find((h) => (h.face ? Math.abs(h.face.normal.clone().transformDirection(h.object.matrixWorld).z) > 0.5 : true));
  return hit ? hit.point.z : null;
}
function blocked(x0,y0,x1,y1,z){return clearance.collision([x1,y1,z],{previous:[x0,y0,z]}).length>0;}
function stepWalk(dt) {
  dt=Math.max(0,Math.min(.05,dt));
  const cap=(a,b,n)=>a+Math.max(-n,Math.min(n,b-a));
  const angular=Math.hypot(walk.desiredYaw-walk.yaw,walk.desiredPitch-walk.pitch),turn=Math.min(1,22*dt/(angular||1));walk.yaw+=(walk.desiredYaw-walk.yaw)*turn;walk.pitch+=(walk.desiredPitch-walk.pitch)*turn;walk.fov=cap(walk.fov,walk.desiredFov,12*dt);
  const f=[Math.cos(walk.yaw*DEG),Math.sin(walk.yaw*DEG)],r=[Math.sin(walk.yaw*DEG),-Math.cos(walk.yaw*DEG)];
  let dx=(keys.has('w')||keys.has('arrowup')?1:0)-(keys.has('s')||keys.has('arrowdown')?1:0),dy=(keys.has('d')||keys.has('arrowright')?1:0)-(keys.has('a')||keys.has('arrowleft')?1:0);
  let mx=f[0]*dx+r[0]*dy+walk.pending[0]*4,my=f[1]*dx+r[1]*dy+walk.pending[1]*4;
  const n=Math.hypot(mx,my),speed=(keys.has('shift')?1.6:1.4)*dt;
  if(n&&!walk.overheadOnly){mx=mx/n*Math.min(n*dt,speed);my=my/n*Math.min(n*dt,speed);
    const next=walk.pos.clone().add(new THREE.Vector3(mx,my,0));
    // Keep the current level; a different level is always an overhead route.
    const support=floorBelow(next.x,next.y,walk.floor),supported=activeRoom===null||(support!==null&&Math.abs(support-walk.floor)<=.2);
    const bodyContacts=clearance.bodyCollision(next,{previous:walk.pos,floorZ:walk.floor});
    if(supported&&!bodyContacts.length)walk.pos.copy(next);
  }
  const decay=Math.max(0,1-dt*8);walk.pending=walk.pending.map(v=>v*decay);
  poseCamera({eye:walk.pos.toArray(),yaw:walk.yaw,pitch:walk.pitch,fov:walk.fov});
  const room=roomUnder(walk.pos.x,walk.pos.y,walk.floor);if(room)activeRoom=room.name;
  $('walkWhere').textContent=walk.overheadOnly?`Floor plan · ${room?.label||activeRoom||''}`:room?`${room.label} · ${room.apt}`:'Outside';
  applyLayers();
}

// ---------- navigator (owner 2026-10-18): click a room or a floor to go there; capture layers on and off ----------
const layers = { model: true, splat: false, scan: false };
// scans as point clouds, one layer each, all in the model frame (capture placement exports; scripts/export_capture_points.py
// format: uint32 N, N x 3 float32, N x 3 uint8). Each is loaded the first time it is switched on; one that is not
// placed yet says so. They render in their own pass (layer 2) and blend with the model by the two opacity sliders.
const SCANS = [
  { key: 'lidarUpper', label: 'Upper level · metric LiDAR (g4)', url: 'splats/lidar_upper.bin' },
  { key: 'lidarStair', label: 'Stairs · metric LiDAR', url: 'splats/lidar_stair.bin' },
  { key: 'lidarMain', label: 'Apartment A · metric LiDAR', url: 'splats/lidar_apta_main.bin' },
  { key: 'kiriUpper', label: 'Upper level · KIRI c730', url: 'splats/upper_kiri_c730.bin' },
  { key: 'polycamUpper', label: 'Upper level · Polycam (LiDAR aligned)', url: 'splats/polycam_upper_lidar_registered.bin' },
  { key: 'polycamMain', label: 'Apartment B · Polycam', url: 'splats/polycam_main_aptb.bin' },
  { key: 'kiriBasement', label: 'Basement · KIRI (stair direction to confirm)', url: 'splats/kiri_basement.bin' },
];
const scanObj = {}, scanBusy = {};
const SCAN_MAT = new THREE.ShaderMaterial({
  uniforms: { uSize: { value: 0.014 }, uScale: { value: 1 } },
  vertexShader: `attribute vec3 color; varying vec3 vC; varying float vD; uniform float uSize, uScale;
    void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vD = -mv.z; vC = color; gl_Position = projectionMatrix * mv; gl_PointSize = max(1.5, uSize * uScale / max(vD, 0.05)); }`,
  fragmentShader: `varying vec3 vC; varying float vD;
    void main() { vec2 c = gl_PointCoord - 0.5; if (dot(c, c) > 0.25) discard; gl_FragColor = vec4(vC, vD); }`, // colours stay as stored (display sRGB): the composite works in display colour
});
async function ensureScan(sc) {
  if (scanObj[sc.key] || scanBusy[sc.key]) return;
  scanBusy[sc.key] = true;
  try {
    const r = await fetch(sc.url);
    if (!r.ok) throw new Error('not placed yet');
    const buf = await r.arrayBuffer();
    loadedCaptureHashes[sc.key] = await bufferSha256(buf);
    const n = new Uint32Array(buf, 0, 1)[0];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, 4, n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(buf, 4 + n * 12, n * 3), 3, true));
    const pts = new THREE.Points(g, SCAN_MAT);
    pts.layers.set(2); pts.frustumCulled = false;
    world.add(pts);
    scanObj[sc.key] = pts;
  } catch (err) { say(`${sc.label}: ${err.message}`); const cb = $(`ly_${sc.key}`); if (cb) cb.checked = false; layers[sc.key] = false; }
  scanBusy[sc.key] = false;
  applyLayers();
} // drone scan off until asked for (owner 2026-10-18)
function glideTo(x,y,floorZ){const r=roomUnder(x,y,floorZ);if(r)return navigateRoom(r.name,[x,y,floorZ+EYE]);return goShot('plan-centre');}
function solidStand(st){return st.qualification?.eye?.slice(0,2)||st.stand;}
function goToStop(st){return navigateRoom(st.key);}
function buildNav(){
  const box=$('navRooms');box.innerHTML='';const groups=new Map();
  for(const st of M.stops){const title=`${st.apt} · ${st.rooms[0]?.storey||'Floor'}`;if(!groups.has(title))groups.set(title,[]);groups.get(title).push(st);}
  for(const [title,stops] of groups){const head=document.createElement('div');head.className='navhead';head.textContent=title;box.appendChild(head);
    for(const st of stops){const b=document.createElement('button');b.type='button';b.textContent=st.title+(st.qualification?.status==='BLOCKED_OVERHEAD_ONLY'?' · Floor plan':'');b.addEventListener('click',()=>goToStop(st));box.appendChild(b);}}
}
$('navToggle').addEventListener('click', () => { const body = $('navBody'); body.hidden = !body.hidden; $('navToggle').setAttribute('aria-expanded', String(!body.hidden)); });
function applyLayers() {
  if (M.group) M.group.visible = layers.model;
  for (const sc of SCANS) { if (layers[sc.key]) ensureScan(sc); if (scanObj[sc.key]) scanObj[sc.key].visible = !!layers[sc.key]; }
  for (const d of Object.values(M.doors || {})) d.pivot.visible = layers.model;
  if (mode === 'walk') { // in the walk the scroll timeline is not running: apply the scan layers here
    CU.uSplat.value = splat && layers.splat ? 1 : 0;
    if (splat) splat.visible = layers.splat && !cameraIndoors();
    if (interior) interior.visible = layers.scan;
  }
}
// one switch per scan, and the two blend sliders
for (const sc of SCANS) {
  const lab = document.createElement('label');
  lab.innerHTML = `<input type="checkbox" id="ly_${sc.key}"> `;
  lab.append(sc.label);
  $('lyScans').appendChild(lab);
  $(`ly_${sc.key}`).addEventListener('change', (e) => { layers[sc.key] = e.target.checked; applyLayers(); });
}
for (const [id, u] of [['opModel', 'uModelOp'], ['opScan', 'uScanOp']]) {
  $(id).addEventListener('input', (e) => { CU[u].value = e.target.value / 100; $(`${id}V`).textContent = `${e.target.value}%`; });
}
// Scan % also drives the real interior Gaussian splat (owner 2026-10-18): above 0 it is on, at that opacity
$('opScan').addEventListener('input', (e) => {
  const v = e.target.value / 100;
  layers.scan = v > 0; $('lyScan').checked = layers.scan;
  if (splat) splat.opacity = v;
  if (interior) { interior.opacity = v; interior.visible = layers.scan; }
  applyLayers(); render();
});
for (const [id, key] of [['lyModel', 'model'], ['lySplat', 'splat'], ['lyScan', 'scan']]) $(id).addEventListener('change', (e) => { layers[key] = e.target.checked; applyLayers(); syncSplatPill(); });
// the drone scan has its own switch in the header too
const syncSplatPill = () => { $('splatPill').classList.toggle('on', layers.splat); $('splatPill').setAttribute('aria-pressed', String(layers.splat)); $('lySplat').checked = layers.splat; };
$('splatPill').addEventListener('click', () => { layers.splat = !layers.splat; applyLayers(); syncSplatPill(); });
syncSplatPill();
// click (walk) or double-click (scroll) on a floor or stair: go there
const floorHit = (ndc) => {
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(walkables(), false).filter((h) => h.face && Math.abs(h.face.normal.clone().transformDirection(h.object.matrixWorld).z) > 0.6 && (mode === 'walk' || h.point.z <= U.uCut.value));
  return hits[0] || null;
};
const ndcOf = (ev) => { const r = canvas.getBoundingClientRect(); return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1); };
let downAt = null;
canvas.addEventListener('pointerdown', (ev) => {
  downAt = [ev.clientX, ev.clientY];
  if (mode === 'scroll' && !transfer && ev.button === 0) { insp.drag = [ev.clientX, ev.clientY]; canvas.setPointerCapture(ev.pointerId); }
});
canvas.addEventListener('pointermove', (ev) => {
  if (!insp.drag || mode !== 'scroll' || transfer) return;
  const dx = ev.clientX - insp.drag[0], dy = ev.clientY - insp.drag[1]; insp.drag = [ev.clientX, ev.clientY];
  const inside = camSample && camSample.dist <= 3;
  insp.desiredYaw = (insp.desiredYaw??insp.yaw)+dx*(inside?-.18:-.3); insp.desiredPitch = Math.max(-75,Math.min(75,(insp.desiredPitch??insp.pitch)+dy*.15));
  target = prog; // hold the walk where it is while inspecting
});
const endDrag = () => { insp.drag = null; };
canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('click', (ev) => {
  if (mode !== 'walk' || !downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 4) return;
  const ndc = ndcOf(ev);
  const m = pick(ndc);
  const floor = m && /IfcSlab|IfcStair/.test(m.userData.e?.cls || '') && (lastPick?.normalZ ?? 0) > 0.6;
  if (floor && !ev.shiftKey) { const h = floorHit(ndc); if (h) glideTo(h.point.x, h.point.y, h.point.z); return; }
  if (m) { select(m); panel.classList.remove('min'); }
});
canvas.addEventListener('dblclick', (ev) => {
  if (mode === 'walk') return;
  const h = floorHit(ndcOf(ev));
  if(h)glideTo(h.point.x,h.point.y,h.point.z);
});

// ---------- live model: server-sent build events rebuild in place, keeping the scroll ----------
function rebuild(data, build) {
  M.build = build;
  buildModel(data);
  applyModelUniforms();
  buildTimeline();
  buildRuler();
  loadFlags();
  loadOpenings();
  if (pendingSel) { const m = M.meshes.find((x) => x.userData.e.id === pendingSel); select(m || null); if (m) $('pnStatus').textContent = `Saved and rebuilt: build ${build.id}.`; pendingSel = null; }
  else if (selected) select(M.meshes.find((x) => x.userData.e.id === selected.mesh.userData.e.id) || null);
}
const toast = $('toast');
function say(t) { toast.textContent = t; toast.classList.add('on'); clearTimeout(say.t); say.t = setTimeout(() => toast.classList.remove('on'), 4200); }
const builds = [];
if (window.EventSource && !Q.has('nolive') && !STATIC) {
  const es = new EventSource('events');
  es.addEventListener('build', async (ev) => {
    const b = JSON.parse(ev.data);
    if (b.id === M.build?.id) return;
    try {
      const [data, build] = await Promise.all([getJSON(`model.json?b=${b.id}`), getJSON(`build.json?b=${b.id}`)]);
      if (data.source?.sha256 !== build.model_sha256) throw new Error('Model and build revision differ; reload after rebuilding');
      rebuild(data, build);
      builds.push({ id: build.id, at: build.at, edited: data.edited?.length || 0 });
      say('Model updated');
    } catch (err) { console.error('live rebuild failed', err); }
  });
  es.addEventListener('rebuild-status', (ev) => {
    const state = JSON.parse(ev.data);
    const failure = state.failure || state.delivery_failure;
    if (failure) { $('pnStatus').textContent = `Rebuild failed: ${failure.message}. The last delivered model is retained.`; say('Rebuild failed; your edits are preserved.'); }
    else if (state.pending) $('pnStatus').textContent = 'Saved. Another revision is queued.';
    else if (state.active) $('pnStatus').textContent = 'Rebuilding the shared model.';
    else if (state.last_good) $('pnStatus').textContent = 'Shared model rebuilt.';
  });
  getJSON('api/rebuild-status').then((state) => { if (state.failure || state.delivery_failure) say('The previous rebuild failed; saved edits are preserved.'); else if (state.active || state.pending) say('Saved edits are rebuilding.'); }).catch(console.error);
  es.addEventListener('build-error', (ev) => say(`Model build failed: ${JSON.parse(ev.data).message.slice(0, 120)}`));
}

// ---------- start ----------
if (!ASB) await loadModels();
rebuild(data0, build0);
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
if (!Q.has('at')) scrollTo(0, 0);
if (Q.has('at')) target = prog = Number(Q.get('at'));
let last=performance.now(),rafPaused=false;
function finishTransfer(t){
  transfer=null;activeRoom=t.key;targetRoom=t.key;navigationStage=t.finishMode==='walk'?'room-pan':'floor-plan-hover';
  if(t.finishMode==='scroll'){
    mode='scroll';insp.yaw=insp.desiredYaw=t.resumeInspection?.yaw??0;insp.pitch=insp.desiredPitch=t.resumeInspection?.pitch??0;syncTourPosition(t.resumeProgress);pausedTour=null;document.body.classList.remove('walking');walkHud.hidden=true;$('resumePill').hidden=true;lenis?.start();update(prog);
  }else{
    mode='walk';walk.pos.fromArray(t.destination.eye);walk.floor=t.qualification?.floorZ??(t.destination.eye[2]-EYE);
    walk.yaw=walk.desiredYaw=t.destination.yaw;walk.pitch=walk.desiredPitch=t.destination.pitch;walk.fov=walk.desiredFov=t.destination.fov;walk.pending=[0,0];walk.overheadOnly=t.qualification?.status==='BLOCKED_OVERHEAD_ONLY';
    U.uCut.value=t.destination.cut??OFF();U.uPhaseCut.value.fill(99);stepWalk(0);
  }
  if(pendingNavigation){const next=pendingNavigation;pendingNavigation=null;if(next.explore)explore(next.explore);else requestTransfer(next.destination,next);}
}
function advanceApplication(dt){
  if(!Number.isFinite(dt))throw new RangeError('Finite frame time required');dt=Math.max(0,Math.min(.05,dt));
  if(comparisonBusy)return;
  if(transfer){
    const t=transfer;t.progress=advanceProgress(t.shots,t.progress,1,dt);const s=t.progress*t.total,c=sample(t.shots,s);
    poseCamera(c);U.uCut.value=channel(t.shots,s,'cut',OFF());U.uPhaseCut.value.fill(99);U.uAll.value=1;
    navigationStage=c.moving?(c.to.navigationStage||'restore'):(c.from.navigationStage||'restore');
    const destinationStop=M.stops.find(q=>q.key===t.key),stageTitle=({'open-cutaway':'Leaving room',rise:'Leaving room','floor-plan-hover':'Floor plan',align:'Moving above destination',descend:'Entering room',restore:'Entering room'})[navigationStage]||'Floor plan';
    $('walkWhere').textContent=`${stageTitle}${destinationStop?' · '+destinationStop.title+' · '+destinationStop.apt+' · '+destinationStop.rooms[0].storey:''}`;
    // Existing floor-label textures cover main/upper only; never project main-floor annotations onto basement.
    CU.uAnnOp.value=0;CU.uLblOp.value=navigationStage==='floor-plan-hover'&&destinationStop&&Math.abs(destinationStop.floorZ-M.FFL)<.3?1:navigationStage==='floor-plan-hover'&&destinationStop&&M.storeys.upper&&Math.abs(destinationStop.floorZ-M.storeys.upper.elevation)<.3?1:0;
    if(t.progress>=1-1e-10)finishTransfer(t);
  }else if(mode==='walk')stepWalk(dt);
  else{
    const moving=Math.abs(target-prog)>1e-7;
    if(moving&&!insp.drag)insp.desiredYaw=insp.desiredPitch=0;
    const dy=(insp.desiredYaw??0)-insp.yaw,dp=(insp.desiredPitch??0)-insp.pitch,limit=Math.min(1,11*dt/(Math.hypot(dy,dp)||1));insp.yaw+=dy*limit;insp.pitch+=dp*limit;
    prog=advanceProgress(shots,prog,target,dt,{maxAngularSpeed:11});update(prog);
  }
  render();updateTags();placeHandles();
}
function frame(now){const dt=(now-last)/1000;last=now;if(!rafPaused)advanceApplication(dt);requestAnimationFrame(frame);}
await Promise.race([splatReady, new Promise((r) => setTimeout(r, 45000))]);
update(prog); render();
await new Promise((r) => setTimeout(r, Math.max(0, 3200 - (performance.now() - loadStart))));
loader.classList.add('done');
// paper roll: the sheet unrolls from the right after the loader (time-based, like the reference intro)
roll.style.width = '62vw';
if (!REC) requestAnimationFrame(() => { roll.style.transition = 'width 2.4s cubic-bezier(.7,0,.2,1)'; roll.style.width = '0vw'; });
else roll.style.width = '0vw';
requestAnimationFrame(frame);

// Save/replay the existing view; no second renderer or model is introduced.
const compareButton=document.createElement('button');
compareButton.type='button'; compareButton.className='pill mono'; compareButton.textContent='Compare capture';
$('pnFlag').appendChild(compareButton);
if (STATIC) $('pnFlag').style.setProperty('display','grid','important');
const importButton=document.createElement('button');importButton.type='button';importButton.className='pill mono';importButton.textContent='Open comparison';
const importInput=document.createElement('input');importInput.type='file';importInput.accept='.json,application/json';importInput.hidden=true;
$('pnFlag').append(importButton,importInput);
importButton.addEventListener('click',()=>importInput.click());
importInput.addEventListener('change',async()=>{
  try {const file=importInput.files[0];if (!file) return;if (file.size>50000000) throw new Error('Comparison file is too large.');await replayComparison(JSON.parse(await file.text()));$('pnStatus').textContent='Comparison restored.';}
  catch(err) {$('pnStatus').textContent=err.message;} finally {importInput.value='';}
});
const replayButton=document.createElement('button');
replayButton.type='button'; replayButton.className='pill'; replayButton.id='icCompare'; replayButton.textContent='Replay comparison'; replayButton.hidden=true;
$('icGo').parentElement.appendChild(replayButton);
async function currentObservationContext() {
  const context=await getJSON(STATIC ? 'observation-context.json' : 'api/observation-context');
  if (context.revision.build_id !== M.build?.id || context.revision.model_sha256 !== M.build?.model_sha256 || (context.revision.parameter_sha256 ?? null) !== (M.build?.parameter_sha256 ?? null) || (context.revision.edits_sha256 ?? null) !== (M.build?.edits_sha256 ?? null)) throw new Error('The model changed. Reload before saving a comparison.');
  return context;
}
function observationState() {
  if(transfer||mode==='transfer')throw new Error('Wait for the room change to finish before making a comparison.');
  camera.updateMatrixWorld(true);
  return {mode,progress:prog,target,pausedTour:structuredClone(pausedTour),selectedElement:selected?.mesh.userData.e.id || null,
    camera:{position:camera.position.toArray(),quaternion:camera.quaternion.toArray(),up:camera.up.toArray(),
      fov:camera.fov,aspect:camera.aspect,near:camera.near,far:camera.far,
      matrixWorld:camera.matrixWorld.toArray(),matrixWorldInverse:camera.matrixWorldInverse.toArray(),projectionMatrix:camera.projectionMatrix.toArray()},
    walk:{position:walk.pos.toArray(),floor:walk.floor,yaw:walk.yaw,pitch:walk.pitch,fov:walk.fov,extra:structuredClone(Object.fromEntries(Object.entries(walk).filter(([key])=>!['pos','floor','yaw','pitch','fov'].includes(key))))},heldKeys:[...keys],
    inspection:{yaw:insp.yaw,pitch:insp.pitch}, layers:{...layers},
    opacity:{model:CU.uModelOp.value,capture:CU.uScanOp.value},
    visibleElements:M.meshes.filter((m)=>m.visible).map((m)=>m.userData.e.id),contextVisible:ctxGroup.visible,
    doorAngles:Object.fromEntries(Object.entries(M.doors || {}).map(([key,d])=>[key,d.pivot.rotation.z])),
    clipping:{cut:U.uCut.value,phaseCuts:[...U.uPhaseCut.value],all:U.uAll.value,
      reveal1:[...U.uRev1.value],reveal2:[...U.uRev2.value],existing:[...U.uExist.value]}};
}
function applyObservationState(state) {
  mode=state.mode; prog=state.progress; target=state.target; pausedTour=structuredClone(state.pausedTour);
  insp.yaw=insp.desiredYaw=state.inspection.yaw; insp.pitch=insp.desiredPitch=state.inspection.pitch;
  walk.pos.fromArray(state.walk.position); Object.assign(walk,state.walk.extra,{floor:state.walk.floor,yaw:state.walk.yaw,pitch:state.walk.pitch,fov:state.walk.fov});keys.clear();for(const key of state.heldKeys) keys.add(key);
  Object.assign(layers,state.layers); CU.uModelOp.value=state.opacity.model; CU.uScanOp.value=state.opacity.capture;
  applyLayers(); CU.uSplat.value=splat && layers.splat ? 1 : 0;
  if (splat) splat.opacity=state.opacity.capture;
  if (interior) {interior.opacity=state.opacity.capture;interior.visible=!!layers.scan;}
  const visible=new Set(state.visibleElements);
  for (const mesh of M.meshes) mesh.visible=visible.has(mesh.userData.e.id);
  ctxGroup.visible=state.contextVisible;
  for (const [key,angle] of Object.entries(state.doorAngles)) if (M.doors[key]) M.doors[key].pivot.rotation.z=angle;
  U.uCut.value=state.clipping.cut;U.uPhaseCut.value.set(state.clipping.phaseCuts);U.uAll.value=state.clipping.all;
  U.uRev1.value.set(state.clipping.reveal1);U.uRev2.value.set(state.clipping.reveal2);U.uExist.value.set(state.clipping.existing);
  const c=state.camera; camera.position.fromArray(c.position);camera.quaternion.fromArray(c.quaternion);camera.up.fromArray(c.up);
  Object.assign(camera,{fov:c.fov,aspect:c.aspect,near:c.near,far:c.far});camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
  document.body.classList.toggle('walking',mode==='walk');walkHud.hidden=mode!=='walk';$('resumePill').hidden=mode!=='walk';
  for (const [id,key] of [['lyModel','model'],['lySplat','splat'],['lyScan','scan'],...SCANS.map((sc)=>['ly_'+sc.key,sc.key])]) if ($(id)) $(id).checked=!!layers[key];
  for (const [id,value] of [['opModel',state.opacity.model],['opScan',state.opacity.capture]]) {$(id).value=String(value*100);$(`${id}V`).textContent=`${Math.round(value*100)}%`;const scrub=document.querySelector(`.scrub[data-for="${id}"] b`);if(scrub)scrub.textContent=`${Math.round(value*100)}%`;}
  if (state.selectedElement && selected?.mesh.userData.e.id!==state.selectedElement) select(meshOfPath(state.selectedElement));
  if (mode==='walk') lenis?.stop();else lenis?.start();
  syncSplatPill();render();
}
const observationAdapter={read:observationState,apply:applyObservationState,
  settle:()=>new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),
  snapshot:()=>{render();return canvas.toDataURL('image/png');}};
function requireStableComparisonView(){
  if(transfer||mode==='transfer')throw new Error('Wait for the room change to finish before making a comparison.');
  if(comparisonBusy)throw new Error('A comparison is already being saved or restored.');
}
async function prepareComparison() {
  requireStableComparisonView();comparisonBusy=true;
  try {
  if (!selected?.mesh.userData.e.id) throw new Error('Choose an element first.');
  if (!Object.entries(layers).some(([k,v])=>k!=='model' && v)) {
    const {key}=comparisonSource();
    const capture=SCANS.find((sc)=>sc.key===key);layers[key]=true;await ensureScan(capture);
    if (!scanObj[key]) throw new Error('Choose an available capture from Layers.');
  }
  CU.uModelOp.value=.5;CU.uScanOp.value=.5;$('opModel').value='50';$('opScan').value='50';
  for (const id of ['opModel','opScan']) {$(`${id}V`).textContent='50%';const scrub=document.querySelector(`.scrub[data-for="${id}"] b`);if(scrub)scrub.textContent='50%';}
  applyLayers();render();comparisonEnabled=true;$('pnFlag').querySelector('button[type=submit]').textContent='Save comparison';
  const sources=SCANS.filter((sc)=>layers[sc.key]).map((sc)=>sc.label);if(layers.splat)sources.push('Drone scan');if(layers.scan)sources.push('Interior Gaussian capture');
  $('pnStatus').textContent=`${sources.join(' · ')}. Adjust the view and blend, describe what is wrong, then save the comparison.`;
  }finally{comparisonBusy=false;}
}
function comparisonSource() {
  const cameraRoom=M.spaces.filter((r)=>pointIn([camera.position.x,camera.position.y],r.poly) && r.floorZ<=camera.position.z && camera.position.z-r.floorZ<3.2)
    .sort((a,b)=>b.floorZ-a.floorZ || a.area-b.area)[0] || null;
  return comparisonCapture({cameraRoom,elementRoom:roomOf(selected?.mesh),phase:selected?.mesh.userData.phase,
    mainFloor:M.FFL,upperFloor:M.storeys.upper.elevation,cameraFloor:mode==='walk'?walk.floor:undefined});
}
async function saveComparison() {
  requireStableComparisonView();
  if (comparisonBusy) throw new Error('A comparison is already being saved.');
  if (shape) throw new Error('Close the shape editor before saving a comparison. Your edits stay in the editor.');
  comparisonBusy=true;
  try {
    const context=await currentObservationContext();
    const captures=context.captures.filter((c)=>layers[c.key]).map((c)=>{
      if (loadedCaptureHashes[c.key]!==c.sha256) throw new Error('The capture changed or is still loading. Reload or wait before saving.');
      const object=c.key==='splat'?splat:c.key==='scan'?interior:scanObj[c.key];
      object.updateWorldMatrix(true,false);
      return {...c,visible:object.visible,instance_matrix_world:object.matrixWorld.toArray()};
    });
    const state=observationState();const e=selected?.mesh.userData.e;
    // An explicitly chosen capture is still usable when a shared wall has no unique room.
    let room=null;try {room=comparisonSource().room;} catch {}
    const roomGlobalId=room?(context.spaces?.find(s=>s.id===room.s.id)?.global_id??room.s.guid??null):null;
    if(room&&!roomGlobalId)throw new Error('Room identity is unavailable. Reload before saving this comparison.');
    const observation=makeObservation({context,state,captures,element:{path:e.id,global_id:e.guid,name:e.name},room:room?{id:room.s.id,global_id:roomGlobalId,name:room.name||room.label,storey:room.storey,storey_id:room.s.storey,apartment:room.apt}:null,title:$('pnTitle').value});
    Object.assign(observation,await captureTriplet(observationAdapter));
    // Detect model/capture publication during screenshot capture before persistence.
    const after=await currentObservationContext();
    await replayObservation(observation,after,{read:observationState,apply:()=>{}});
    return observation;
  } finally {comparisonBusy=false;}
}
async function replayComparison(observation) {
  requireStableComparisonView();comparisonBusy=true;let previous=null;
  try {
    const context=await currentObservationContext();
    // Stale revisions are checked before loading captures or changing the view.
    await replayObservation(observation,context,{read:()=>null,apply:()=>{}});
    if(observation.state?.mode==='transfer')throw new Error('A comparison from an unfinished room change cannot be restored.');
    previous=observationState();
    for(const capture of observation.captures){
      const sc=SCANS.find(c=>c.key===capture.key);if(sc)await ensureScan(sc);
      if(loadedCaptureHashes[capture.key]!==capture.sha256)throw new Error('Reload to use the capture saved with this comparison.');
      const object=capture.key==='splat'?splat:capture.key==='scan'?interior:scanObj[capture.key];object.updateWorldMatrix(true,false);
      if(object.matrixWorld.toArray().some((v,i)=>Math.abs(v-capture.instance_matrix_world[i])>1e-9))throw new Error('The capture placement differs from the saved comparison.');
    }
    await replayObservation(observation,context,observationAdapter);
    if(mode==='walk'){walk.pos.fromArray(observation.state.camera.position);walk.fov=observation.state.camera.fov;}
    comparisonEnabled=true;$('pnFlag').querySelector('button[type=submit]').textContent='Save comparison';
    return observationState();
  }catch(err){if(previous)applyObservationState(previous);throw err;}finally{comparisonBusy=false;}
}
compareButton.addEventListener('click',()=>prepareComparison().catch((err)=>$('pnStatus').textContent=err.message));
replayButton.addEventListener('click',async()=>{
  try {const observation=await getJSON(`api/flag-observation?guid=${encodeURIComponent(cardFlag.guid)}`);await replayComparison(observation);$('issueCard').hidden=true;say('Comparison restored.');}
  catch (err) {say(err.message);}
});

// deterministic hooks for recording and checks
window.__P401 = {
  ready: true,
  routeAudit:()=>routeRows.map(r=>({...r,targetEye:r.eye})),
  rawShots:()=>shots.map(q=>({...q,progress:q.h0/TOTAL})),
  navigate:navigateRoom,
  inspectHeading(yaw,pitch=0){if(transfer)return false;if(mode==='walk'){walk.desiredYaw=yaw;walk.desiredPitch=pitch;}else{insp.desiredYaw=unwrapYaw(camSample.yaw,yaw)-camSample.yaw;insp.desiredPitch=pitch-camSample.pitch;target=prog;}return true;},
  navigationState:()=>({camera:{position:camera.position.toArray(),quaternion:camera.quaternion.toArray(),fov:camera.fov,near:camera.near,aspect:camera.aspect},worldMatrix:world.matrixWorld.toArray(),clipping:{cut:U.uCut.value,phaseCuts:[...U.uPhaseCut.value]},modelVisible:M.group.visible,mode,stage:navigationStage,transferActive:!!transfer,token:transfer?.token??navigationToken,activeRoom,targetRoom,meshes:M.meshes.map(m=>({instanceID:m.uuid,sourceID:m.userData.e?.id,id:m.userData.e?.id,guid:m.userData.e?.guid,phase:m.userData.phase,visible:m.visible,matrixWorld:m.matrixWorld.toArray()}))}),
  advance(dt){rafPaused=true;advanceApplication(dt);return this.navigationState();},
  resumeRAF(){rafPaused=false;last=performance.now();},
  cameraCollision:()=>clearance.collision(camera.position),
  geometrySnapshot:()=>M.meshes.map(m=>{m.updateWorldMatrix(true,false);return {instanceID:m.uuid,sourceID:m.userData.e?.id,ifcGUID:m.userData.e?.guid,name:m.userData.e?.name,cls:m.userData.e?.cls,positions:Array.from(m.geometry.attributes.position.array),indices:m.geometry.index?Array.from(m.geometry.index.array):Array.from({length:m.geometry.attributes.position.count},(_,i)=>i),matrixWorld:m.matrixWorld.toArray(),phase:m.userData.phase,visible:m.visible};}),
  observation:{state:observationState,prepare:prepareComparison,capture:saveComparison,replay:replayComparison,context:currentObservationContext},
  axisDeg: AXIS, get ffl() { return M.FFL; }, get build() { return M.build; }, builds,
  get stops() { return dossiers.map((d) => ({ key: d.st.key, n: d.n, via: !!d.via, h0: +d.shot.h0.toFixed(1), h1: +d.shot.h1.toFixed(1), p: +((d.shot.h0 + d.shot.h1) / 2 / TOTAL).toFixed(4), rooms: d.st.rooms.map((r) => r.name) })); },
  get shots() { return shots.map((q) => ({ id: q.id, h0: +q.h0.toFixed(1), h1: +q.h1.toFixed(1), g1: +q.g1.toFixed(1), p0: +(q.h0 / TOTAL).toFixed(4) })); },
  get totalVh() { return TOTAL; },
  get rooms() { return M.spaces.map((r) => ({ n: r.n, name: r.name, w: +r.w.toFixed(2), d: +r.d.toFixed(2), area: +r.area.toFixed(2) })); },
  get furniture() { return M.furn?.children.length || 0; },
  models: () => ({ loaded: modelCache.size, wanted: new Set([...Object.values(KIND_MODEL), ...Object.values(KIND_DECOR).flat().map((d) => d[0])]).size }),
  debugStops: () => M.stops.map((s) => ({ key: s.key, stand: s.stand.map((v) => +v.toFixed(2)), look: s.look.map((v) => +v.toFixed(2)), z: +s.floorZ.toFixed(2), bbox: s.rooms.map((r) => r.bbox.map((v) => +v.toFixed(2))) })),
  splat: () => ({ exterior: splat?.packedSplats?.numSplats ?? 0, interior: interior?.packedSplats?.numSplats ?? 0 }),
  // what is under a screen point (fractions 0..1): every object the ray crosses, nearest first
  pick(fx, fy) {
    const r = new THREE.Raycaster(); r.setFromCamera(new THREE.Vector2(fx * 2 - 1, 1 - fy * 2), camera);
    return r.intersectObjects(scene.children, true).slice(0, 8).map((h) => ({ d: +h.distance.toFixed(2), cls: h.object.userData?.e?.cls || h.object.type, name: h.object.userData?.e?.name || h.object.name || '', part: h.object.userData?.e?.doorPart || null }));
  },
  camera: () => ({ pos: camera.position.toArray().map((v) => +v.toFixed(2)), fov: camera.fov }),
  scanProbe: () => { render(); const w = rtScan.width, h = rtScan.height, buf = new Float32Array(4 * 64 * 64); renderer.readRenderTargetPixels(rtScan, (w >> 1) - 32, (h >> 1) - 32, 64, 64, buf); let n = 0, a = 0; for (let i = 0; i < buf.length; i += 4) if (buf[i + 3] > 0) { n++; a += buf[i + 3]; } return { w, h, hits: n, meanDepth: n ? a / n : 0 }; },
  scanInfo: () => Object.fromEntries(Object.entries(scanObj).map(([k, o]) => [k, { n: o.geometry.attributes.position.count, vis: o.visible, mask: o.layers.mask, parent: o.parent?.type, size: SCAN_MAT.uniforms.uScale.value }])),
  isolate: (q) => { for (const m of M.meshes) m.visible = !q || (m.userData.e.name || '').includes(q); render(); },
  meshInfo: (q) => M.meshes.filter((m) => (m.userData.e.name || '').includes(q)).map((m) => { const b = new THREE.Box3().setFromObject(m); return { name: m.userData.e.name, vis: m.visible, parent: m.parent?.type, phase: m.userData.phase, min: b.min.toArray().map((v) => +v.toFixed(2)), max: b.max.toArray().map((v) => +v.toFixed(2)) }; }),
  setProgress(p) { transfer=null;pendingNavigation=null;mode='scroll';target=prog=Math.max(0,Math.min(1,p));insp.yaw=insp.pitch=0;update(prog);render(); },
  roll(w) { roll.style.transition = 'none'; roll.style.width = w; },
  walk(x,y,yaw,floorKey='main',pitch=0){const floor=floorKey==='upper'?M.storeys.upper.elevation:floorKey==='base'?M.storeys.base.elevation:M.FFL;return glideTo(x,y,floor);},
  selectByName(name) { const m = M.meshes.find((x) => x.userData.e.name === name); select(m || null); return m?.userData.e.id; },
  edit: (path, color, extra = {}) => post('api/edit', { path, color, ...extra }),
  leaveWalk,
  walkTick: (dt, held = []) => { rafPaused=true;keys.clear();for(const k of held)keys.add(k);advanceApplication(dt);return {x:camera.position.x,y:camera.position.y,floor:walk.floor}; },
  walkState: () => ({ mode, progress: prog, pausedProgress: pausedTour?.p ?? null, x: +walk.pos.x.toFixed(2), y: +walk.pos.y.toFixed(2), z: +walk.pos.z.toFixed(2), floor: +walk.floor.toFixed(2), yaw: +walk.yaw.toFixed(1) }),
  stairInfo: () => M.spaces.filter((r) => /stair/i.test(r.name)).map((r) => ({ name: r.name, bbox: r.bbox.map((v) => +v.toFixed(2)), floorZ: r.floorZ })),
};

// ---------- top-bar opacity scrubbers (owner 2026-10-18): always there; drag the number up/down, scroll on it, or tap
// the arrows; they drive the same model/scan opacity as the Layers panel and stay in sync with it ----------
for (const sc of document.querySelectorAll('.scrub')) {
  const rng = $(sc.dataset.for), b = sc.querySelector('b');
  const set = (v) => { v = Math.max(0, Math.min(100, Math.round(v))); rng.value = v; rng.dispatchEvent(new Event('input')); };
  const show = () => { b.textContent = `${rng.value}%`; };
  rng.addEventListener('input', show); show();
  sc.querySelectorAll('button').forEach((x) => x.addEventListener('click', () => set(+rng.value + +x.dataset.d)));
  sc.addEventListener('wheel', (ev) => { ev.preventDefault(); ev.stopPropagation(); set(+rng.value + (ev.deltaY < 0 ? 5 : -5)); }, { passive: false });
  b.addEventListener('pointerdown', (ev) => {
    ev.preventDefault(); ev.stopPropagation(); b.setPointerCapture(ev.pointerId);
    const y0 = ev.clientY, x0 = ev.clientX, v0 = +rng.value;
    const mv = (e) => set(v0 + (y0 - e.clientY) / 2 + (e.clientX - x0) / 2);
    b.addEventListener('pointermove', mv);
    b.addEventListener('pointerup', () => b.removeEventListener('pointermove', mv), { once: true });
  });
}

// ---------- Edit toggle (owner 2026-10-18): off by default so walking around never moves a wall; off = select and flag
// (BCF) only; on = nodes, push/pull, colour and material ----------
let EDIT = false;
$('editPill').addEventListener('click', () => {
  EDIT = !EDIT;
  document.body.classList.toggle('editing', EDIT);
  $('editPill').textContent = `Edit · ${EDIT ? 'on' : 'off'}`; $('editPill').setAttribute('aria-pressed', String(EDIT)); $('editPill').classList.toggle('on', EDIT);
  if (EDIT && selected?.mesh) startShapeEdit(selected.mesh); else stopShapeEdit();
});

// ---------- Reset view (owner 2026-10-18): one click (or R) from anywhere, lost in a wall or in the dark, back to the
// whole house: leaves the walk, clears the selection and any isolate, model and scan at their defaults ----------
function resetView() {
  select(null);
  for (const m of M.meshes) m.visible = true;
  for (const [id, v] of [['opModel', 100], ['opScan', 70]]) { const r = $(id); r.value = v; r.dispatchEvent(new Event('input')); }
  goShot('orbit');
}
$('resetPill').addEventListener('click', resetView);
addEventListener('keydown', (ev) => { if ((ev.key === 'r' || ev.key === 'R') && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '') && !shape?.drawing) resetView(); });

// ---------- Lines (owner 2026-10-18): the drawn edges have their own opacity and colour in the top bar ----------
$('opLines').addEventListener('input', (e) => { CU.uEdgeOp.value = e.target.value / 100; render(); });
$('lineCol').addEventListener('input', (e) => { CU.uEdgeCol.value = lin(parseInt(e.target.value.slice(1), 16)); render(); });
$('layersPill').addEventListener('click', () => $('navToggle').click()); // Layers sits in the top row (owner 2026-10-18)

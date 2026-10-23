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
import { layout, sample, channel } from './timeline.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

const Q = new URLSearchParams(location.search);
const REC = Q.has('rec');
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
const STATIC = document.documentElement.dataset.static === '1'; // set by export_static.mjs
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
  if (c === 'IfcWindow') return SLOT.glass;
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
  if (c === 'IfcElectricAppliance' || c === 'IfcSanitaryTerminal' || /enamel|china|porcelain/.test(m)) return SLOT.plaster;
  return SLOT.fascia;
}
const hexes = (list) => list.map((h) => new THREE.Color(h)); // sRGB hex -> linear
// slot order: plaster, siding, roof, fascia, stone, floor, concrete, door, stair, furniture, partition, valance, deck, ceiling, membrane, counter
const PALETTES = {
  A: hexes(['#ebe7df', '#e6e4de', '#a9adb0', '#24365a', '#b9a58c', '#a87b52', '#8e9192', '#efeeea', '#c9c7c2', '#ffffff', '#c9c7c2', '#f3f2ee', '#8e9192', '#f1efea', '#b4b6b6', '#9b7350', '#e4ecef']),
  B: hexes(['#f1ede4', '#ece5d6', '#3b3e42', '#1f1f1f', '#b98a5c', '#b4895c', '#a2a3a1', '#7b5a3e', '#b4895c', '#ffffff', '#d9d3c8', '#f4f1ea', '#7b5a3e', '#f6f3ec', '#4a4d51', '#b4895c', '#b9c8cf']),
  C: hexes(['#f1ede4', '#2b302c', '#1d1f21', '#1d1f21', '#b98a5c', '#9c6b3f', '#a2a3a1', '#9c6b3f', '#9c6b3f', '#ffffff', '#d9d3c8', '#efeeea', '#6e5038', '#f6f3ec', '#26292c', '#9c6b3f', '#b9c8cf']),
};
const ROUGH = [0.92, 0.8, 0.6, 0.5, 0.95, 0.55, 0.85, 0.45, 0.6, 0.7, 0.9, 0.7, 0.75, 0.95, 0.85, 0.4, 0.05];
// the story plays the house as it is (owner 2026-10-23): direction A unless ?ext= asks for a design direction
const STORY = true; // the story page: no element file, flags or free walk
const EXT = PALETTES[(Q.get('ext') || 'A').toUpperCase()] ? (Q.get('ext') || 'A').toUpperCase() : 'A';
U.uPalA = { value: PALETTES.A };
U.uPalP = { value: PALETTES[EXT] };
U.uRough = { value: Float32Array.from(ROUGH) };
U.uWood = { value: woodD };
U.uWoodR = { value: woodR };
U.uMetalRoof = { value: EXT === 'A' ? 0 : 1 }; // A keeps asphalt shingle; B and C are standing seam

const SLOT_GLSL = /* glsl */`
#define NS ${NS}
uniform vec3 uPalA[NS]; uniform vec3 uPalP[NS]; uniform float uRough[NS];
uniform sampler2D uWood, uWoodR; uniform float uMetalRoof;
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
  IfcWindow: cutMaterial({ color: 0x9fb3bf, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.32, emissive: 0xf6f1e6, emissiveIntensity: 0 }),
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
uniform float uKind;
in vec3 vW; in vec3 vNV; in vec3 vNW; in float vD; in float vPhase; in float vFurn;
layout(location = 0) out vec4 gND;
layout(location = 1) out vec4 gW;
// paint state, /8 in alpha: 0 paper, 1 revealed, 2 reveal band, 3 poché, 4 ground sheet, 5 selected, 6 furniture paper
void main() {
  if (abs(uKind - 4.0) > 0.5 && cutAway(vW, vPhase)) discard;
  vec3 nv = normalize(vNV), nw = normalize(vNW);
  float state = uKind;
  if (uKind < 0.5) {
    if (!gl_FrontFacing && vFurn > 0.2 && vFurn < 0.4) { nv = -nv; int idx; float pass; state = revealAt(vW, -nw, vPhase, idx, pass); }
    else if (!gl_FrontFacing) {
      state = 3.0; nv = -nv;
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
}`;
const preMaterial = (kind) => new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3, vertexShader: PRE_VS, fragmentShader: PRE_FS, side: THREE.DoubleSide,
  uniforms: { ...U, uKind: { value: kind } },
});
const PRE = preMaterial(0), PRE_SEL = preMaterial(5);

// ---------- model (rebuilt in place on every live build) ----------
const M = { meshes: [], rooms: [], spaces: [], storeys: {}, doors: {}, group: null, furn: null, build: build0 };
const ROOM_GROUPS = [
  ['AptA - Entry'], ['AptA - Front room'], ['AptA - Living area'], ['AptA - Kitchen w/ bar'], ['AptA - Pantry', 'AptA - Refrigerator'],
  // the current model splits each bathroom into Bathroom, Shower Area and Toilet Area: they play as one room
 ['AptA - Bathroom', 'AptA - Shower Area', 'AptA - Toilet Area'], ['AptA - Stairs up'], ['Upper - Stairs', 'Upper - Hallway'], ['Upper - Room 2', 'Upper - Closet'],
  // Room 1, the toilet room and the shower are the one upstairs bathroom, with laundry and a wet bar (owner 2026-10-23)
  ['Upper - Room 1', 'Upper - Toilet', 'Upper - Shower'], ['Upper - Room 3', 'Upper - Room 3 closet'], ['AptA - Stairs to basement'],
  ['@basement'], ['@porch-east'], ['AptB - Front Room'], ['AptB - Kitchen'], ['AptB - Nook'], ['AptB - Bathroom', 'AptB - Shower Area', 'AptB - Toilet Area'], ['AptB - Bedroom'],
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
  // a closed piece wound inside-out shows only back faces, which the cut shader paints as black poché. Pieces are
  // checked one by one (connected components): a wall can be right except one rebuilt panel (Apartment A wall 07 by
  // Apartment B's refrigerator alcove, fix38), so each piece with a negative signed volume is turned right side out
  let idx = Array.from(e.indices);
  { const P = e.positions, T = idx.length / 3;
    const parent = new Int32Array(P.length / 3).map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const key = (i) => `${P[i * 3].toFixed(4)},${P[i * 3 + 1].toFixed(4)},${P[i * 3 + 2].toFixed(4)}`;
    const first = new Map(); // vertices at the same spot belong together even when the mesh repeats them
    for (let i = 0; i < P.length / 3; i++) { const k = key(i); if (first.has(k)) parent[find(i)] = find(first.get(k)); else first.set(k, i); }
    for (let t = 0; t < T; t++) { const a = find(idx[t * 3]); parent[find(idx[t * 3 + 1])] = a; parent[find(idx[t * 3 + 2])] = a; }
    const vol = new Map();
    for (let t = 0; t < T; t++) {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3, r = find(idx[t * 3]);
      vol.set(r, (vol.get(r) || 0) + P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]));
    }
    if (!Q.get('noorient')) for (let t = 0; t < T; t++) if (vol.get(find(idx[t * 3])) < 0) { const x = idx[t * 3 + 1]; idx[t * 3 + 1] = idx[t * 3 + 2]; idx[t * 3 + 2] = x; }
    // box-like fixtures with mixed winding (some faces in, some out): turn each face away from the object's centre
    if (/IfcElectricAppliance|IfcSanitaryTerminal|IfcFurniture|IfcFurnishingElement/.test(e.cls || '')) {
      let cx = 0, cy = 0, cz = 0; const nv = P.length / 3;
      for (let k = 0; k < P.length; k += 3) { cx += P[k]; cy += P[k + 1]; cz += P[k + 2]; }
      cx /= nv; cy /= nv; cz /= nv;
      idx = Array.from(idx);
      for (let k = 0; k < idx.length; k += 3) {
        const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const mx = (P[a] + P[b] + P[c]) / 3 - cx, my = (P[a + 1] + P[b + 1] + P[c + 1]) / 3 - cy, mz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3 - cz;
        if (nx * mx + ny * my + nz * mz < 0) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; }
      }
    }
  }
  // drop zero-area slivers: their normal is (0,0,0), which lights as NaN, and the bloom and depth-of-field blurs spread
  // one NaN pixel into a black screen-aligned square (Apartment A wall 07 by the Apt B fridge alcove has three)
  { const P = e.positions, keep = [];
    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (cx * cx + cy * cy + cz * cz > 1e-14) keep.push(idx[k], idx[k + 1], idx[k + 2]);
    }
    idx = keep;
  }
  geo.setIndex(idx);
  const flat = geo.toNonIndexed();
  flat.computeVertexNormals();
  const p = flat.attributes.position, n = flat.attributes.normal, N = p.count;
  // appliances and sanitary fixtures (e.g. Apartment B's refrigerator, set into an alcove that pokes through Apartment A's
  // wall 07) are not cut solids: aFurn 0.3 marks them so their back faces take their finish instead of black poché
  const fixture = !furn && /IfcElectricAppliance|IfcSanitaryTerminal/.test(e.cls || '');
  const uv = new Float32Array(N * 2), ph = new Float32Array(N).fill(phase), fu = new Float32Array(N).fill(fixture ? 0.3 : furn);
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

// context: the 2010 4th St proposed massing (RISE 2025), phase 0, always a drawing
const ctxGroup = new THREE.Group();
world.add(ctxGroup);
ctxGroup.visible = false; // the 2010 4th St neighbour massing is not shown (owner 2026-10-18: wrong place, wrong shape)
const ctxBox = new THREE.Box3();
for (const e of context.elements) {
  const mesh = new THREE.Mesh(geometryFor(e, 0, 0, [0.8, 0.8, 0.8], false, toHouse), MAT.default);
  mesh.userData = { e, color: MAT.default, pre: PRE, context: true };
  ctxGroup.add(mesh);
}
world.updateMatrixWorld(true);
ctxBox.setFromObject(ctxGroup);

// ---------- CC0 furniture models (Poly Haven, assets/MANIFEST.json) ----------
// glTF is Y-up metres; each piece is turned Z-up, faced into its room, scaled down only if it does not fit its slot,
// and given the presentation attributes so it cuts, reveals and inks like the model. Kinds the catalogue lacks
// (toilet, tub, vanity, shower tray, wardrobe, counter run, fridge) stay as plain proxy boxes.
const KIND_MODEL = { sofa: 'sofa_02', coffee: 'modern_coffee_table_01', chair: 'mid_century_lounge_chair', bed: 'GothicBed_01',
  night: 'painted_wooden_nightstand', table: 'dining_table', stool: 'bar_chair_round_01', shelf: 'wooden_display_shelves_01',
  bench: 'painted_wooden_bench', desk: 'ClassicConsole_01', wardrobe: 'drawer_cabinet',
  sofa3: 'Sofa_01', dchair: 'dining_chair_02', console: 'ClassicConsole_01', // Sofa_01 (owner 2026-10-23: a more elegant couch; sofa_03 is 2.73 m and pushed into the wall)
  credenza: 'modern_wooden_cabinet', barstool: 'bar_chair_round_01', dresser: 'drawer_cabinet', lounge: 'mid_century_lounge_chair',
  sidetable: 'side_table_01', plant: 'potted_plant_01', art: 'hanging_picture_frame_01' };
// owner 2026-10-23: some colour in the living area; Sofa_01's cream fabric (one material, legs included) dyed a deep sage
// model elements a staged piece replaces in the story: Apartment A's refrigerator (owner 2026-10-23: a built-in that fills the nook)
// and Apartment B's kitchen runs, sink, range and bookshelf, restyled from its 360 capture (staged at the same extents)
const STAGED_OVER = /^Apartment A refrigerator$|^Apartment B kitchen (?!flat ceiling)|^Apartment B range|^Apartment B inset bookshelf|^S-D2 Front east door|^S-D2 door glazing/;
const MODEL_TINT = { Sofa_01: 0x7f9f97 };
// decor added next to a kind: [model, offset along the piece's width, offset forward, z on top of the piece (1) or floor (0)]
const KIND_DECOR = { coffee: [['ceramic_vase_01', 0.25, 0, 1], ['book_encyclopedia_set_01', -0.2, 0, 1]], sofa: [['throw_pillows_01', 0, 0.05, 0.45], ['potted_plant_01', 1.35, 0.15, 0]], sofa3: [['throw_pillows_01', 0, 0.05, 0.45], ['potted_plant_01', -1.15, 0.12, 0]],
  credenza: [['ceramic_vase_01', -0.7, 0, 1], ['book_encyclopedia_set_01', 0.62, 0, 1]], range: [['pot_enamel_01', -0.19, 0.08, 1]], cab: [['wooden_cutting_board', 0.1, 0, 1]],
  night: [['industrial_pipe_lamp', 0, 0, 1]], table: [['wooden_bowl_01', 0, 0, 1]], counter: [['pot_enamel_01', -0.5, 0, 1], ['wooden_cutting_board', 0.4, 0, 1]],
  bench: [['potted_plant_02', 0.9, 0, 0]], desk: [['ceramic_vase_02', 0.4, 0, 1], ['standing_picture_frame_01', -0.4, 0, 1]], tub: [['potted_plant_04', 0.9, 0.1, 0]] };
// ---------- pieces the catalogue lacks, built here: base cabinet runs with a stone top, the sink run, the rug ----------
// Same holder convention as the glTF models: width along x, front to -y, standing on z = 0.
const PMAT = {
  body: new THREE.MeshStandardMaterial({ color: 0x2e4440, roughness: 0.55 }), // deep green-grey flat-panel fronts
  kick: new THREE.MeshStandardMaterial({ color: 0x1b1d1d, roughness: 0.8 }),
  groove: new THREE.MeshStandardMaterial({ color: 0x172120, roughness: 0.9 }),
  stone: new THREE.MeshStandardMaterial({ color: 0xece8e1, roughness: 0.22 }),
  brass: new THREE.MeshStandardMaterial({ color: 0xb8925a, metalness: 1, roughness: 0.32 }),
  steel: new THREE.MeshStandardMaterial({ color: 0xcfcfcb, metalness: 0.65, roughness: 0.32 }), // brushed: less mirror, so the sky does not turn it blue
  basin: new THREE.MeshStandardMaterial({ color: 0x5a5f61, metalness: 1, roughness: 0.42 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x0d0e10, metalness: 0.2, roughness: 0.08 }),
  iron: new THREE.MeshStandardMaterial({ color: 0x232425, metalness: 0.6, roughness: 0.5 }),
  red: new THREE.MeshStandardMaterial({ color: 0xa3201f, roughness: 0.35 }),
  leaf: new THREE.MeshStandardMaterial({ color: 0xf1eee8, roughness: 0.5 }),
  walnut: new THREE.MeshStandardMaterial({ color: 0x5b3b26, roughness: 0.55 }),
  linen: new THREE.MeshStandardMaterial({ color: 0xefebe3, roughness: 0.95 }),
  ceramic: new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.3 }),
  shade: new THREE.MeshStandardMaterial({ color: 0xf3e6cc, roughness: 0.9, emissive: 0xffd9a0, emissiveIntensity: 0.9, side: THREE.DoubleSide }),
  mirror: new THREE.MeshStandardMaterial({ color: 0xc9d1d3, metalness: 1, roughness: 0.04 }),
  enamel: new THREE.MeshStandardMaterial({ color: 0xf6f5f1, roughness: 0.12 }),
  navy: new THREE.MeshStandardMaterial({ color: 0x1f2b3d, roughness: 0.5 }), // Apartment B's cabinets, from the capture
  block: new THREE.MeshStandardMaterial({ color: 0xc8955c, roughness: 0.6 }), // butcher block
  oak: new THREE.MeshStandardMaterial({ color: 0xc08f58, roughness: 0.6 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xd6d9db, metalness: 1, roughness: 0.15 }),
  paint: new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.7 }),
  frost: new THREE.MeshStandardMaterial({ color: 0xe8ecec, roughness: 0.35, emissive: 0xf6f1e6, emissiveIntensity: 0.35 }), // patterned glass, lit from outside
  sheer: new THREE.MeshStandardMaterial({ color: 0xf6f3ec, roughness: 1, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
  water: new THREE.MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.05 }),
};
const RUGS = { rust: ['#9c4f36', '#e6d8bf'], sage: ['#7d9483', '#ece4d2'], ink: ['#38465a', '#d9cdb4'] };
function rugTexture(palette = 'rust') { // a wool rug: field, border and a quiet lattice (canvas x runs along the rug's width)
  const W = 768, H = 576, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const [field, edge] = RUGS[palette] || RUGS.rust;
  g.fillStyle = field; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(230,216,191,.28)'; g.lineWidth = 2;
  for (let k = -16; k < 32; k++) { g.beginPath(); g.moveTo(k * 48, 0); g.lineTo(k * 48 + H, H); g.moveTo(k * 48, 0); g.lineTo(k * 48 - H, H); g.stroke(); }
  g.fillStyle = edge; g.fillRect(0, 0, W, 30); g.fillRect(0, H - 30, W, 30); g.fillRect(0, 0, 30, H); g.fillRect(W - 30, 0, 30, H);
  g.strokeStyle = edge; g.lineWidth = 3; g.strokeRect(48, 48, W - 96, H - 96);
  const img = g.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) { const n = (Math.random() - 0.5) * 18; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
const rugMats = {};
const box = (grp, mat, w, d, h, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), mat); m.position.set(x, y, z); grp.add(m); return m; };
function upper(g, x0, x1, d, body = PMAT.body) { // a wall cupboard from x0 to x1, its back on the wall behind the run
  const w = x1 - x0, y = d / 2 + 0.03 - 0.17, fy = y - 0.165;
  if (w < 0.25) return;
  box(g, body, w, 0.33, 0.75, (x0 + x1) / 2, y, 1.85);
  const n = Math.max(1, Math.round(w / 0.45));
  for (let i = 1; i < n; i++) box(g, PMAT.groove, 0.006, 0.004, 0.75, x0 + (w * i) / n, fy - 0.002, 1.85);
  for (let i = 0; i < n; i++) box(g, PMAT.brass, 0.012, 0.016, 0.14, x0 + (w * (i + 0.5)) / n + (i % 2 ? -1 : 1) * (w / n) * 0.35, fy - 0.01, 1.58);
}
function splash(g, x0, x1, z0, z1, d) { // glazed tile backsplash on the wall behind the run
  tileMat ??= new THREE.MeshStandardMaterial({ map: tileTexture(), roughness: 0.18 });
  const m = box(g, tileMat, x1 - x0, 0.01, z1 - z0, (x0 + x1) / 2, d / 2 + 0.03 - 0.005, (z0 + z1) / 2);
  const uv = m.geometry.attributes.uv; // tiles at 7.5 x 15 cm whatever the panel's size
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (x1 - x0) / 0.6, uv.getY(i) * (z1 - z0) / 0.6);
  m.material.map.wrapS = m.material.map.wrapT = THREE.RepeatWrapping;
}
function tileTexture() { // 4 x 8 handmade-looking white tiles, 0.6 m square per repeat
  const cv = document.createElement('canvas'); cv.width = cv.height = 512;
  const g = cv.getContext('2d');
  g.fillStyle = '#d9d4cb'; g.fillRect(0, 0, 512, 512);
  for (let r = 0; r < 8; r++) for (let c = -1; c < 5; c++) {
    const x = c * 128 + (r % 2) * 64, y = r * 64, t = 236 + Math.round((Math.random() - 0.5) * 14);
    g.fillStyle = `rgb(${t},${t - 3},${t - 8})`; g.fillRect(x + 2, y + 2, 124, 60);
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
let tileMat = null, marbleMat = null, plankMat = null, hexMat = null;
function hexTexture() { // white 5 cm hexagon mosaic with grey grout (Apartment B's bathroom floor), 0.6 m per repeat
  const W = 1024, H = 1024, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); g.fillStyle = '#b9bcbd'; g.fillRect(0, 0, W, H);
  const r = 1024 / 12 / Math.sqrt(3), dx = Math.sqrt(3) * r, dy = 1.5 * r;
  for (let j = -1; j * dy < H + r; j++) for (let i = -1; i * dx < W + dx; i++) {
    const cx = i * dx + (j % 2 ? dx / 2 : 0), cy = j * dy, t = 238 + ((i * 7 + j * 13) % 9);
    g.fillStyle = `rgb(${t},${t},${t - 2})`; g.beginPath();
    for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + k * Math.PI / 3; g.lineTo(cx + (r - 2) * Math.cos(a), cy + (r - 2) * Math.sin(a)); }
    g.fill();
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function plankTexture() { // 2.4 x 1.2 m of grey-brown laminate planks (1.2 x 0.2, staggered), printed grain
  const W = 1536, H = 768, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pw = W / 2, ph = H / 6;
  for (let r = 0; r < 6; r++) for (let c = -1; c < 3; c++) {
    const x = c * pw + ((r * 0.37) % 1) * pw, y = r * ph, base = 100 + rnd() * 26; // warm grey-brown, as captured
    g.fillStyle = `rgb(${base + 34},${base + 18},${base - 2})`; g.fillRect(x, y, pw, ph);
    for (let k = 0; k < 26; k++) { const yy = y + rnd() * ph; g.strokeStyle = `rgba(${60 + rnd() * 30},${52 + rnd() * 25},${44 + rnd() * 20},${0.12 + rnd() * 0.2})`; g.lineWidth = 0.6 + rnd() * 1.6;
      g.beginPath(); g.moveTo(x, yy); g.bezierCurveTo(x + pw * 0.3, yy + (rnd() - 0.5) * 8, x + pw * 0.7, yy + (rnd() - 0.5) * 8, x + pw, yy + (rnd() - 0.5) * 6); g.stroke(); }
    g.strokeStyle = 'rgba(40,34,28,.55)'; g.lineWidth = 2; g.strokeRect(x, y, pw, ph);
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function marbleTexture() { // 1.8 x 1.2 m of long tiles (0.9 x 0.3, half bond): white marble with blue-grey veins
  const W = 1536, H = 1024, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#c9ced4'; g.fillRect(0, 0, W, H); // grout
  const tw = W / 2, th = H / 4;
  for (let r = 0; r < 4; r++) for (let c = -1; c < 3; c++) {
    const x = c * tw + (r % 2) * tw / 2, y = r * th;
    g.save(); g.beginPath(); g.rect(x + 2, y + 2, tw - 4, th - 4); g.clip();
    const t = 242 + Math.round(rnd() * 8); g.fillStyle = `rgb(${t},${t + 1},${t + 3})`; g.fillRect(x, y, tw, th);
    const vein = (n, wMin, wMax, aMin, aMax, blur) => { // long, mostly diagonal veins: a soft cloudy pass, then fine sharp ones
      g.filter = blur ? `blur(${blur}px)` : 'none';
      for (let k = 0; k < n; k++) {
        g.strokeStyle = `rgba(${60 + rnd() * 40},${88 + rnd() * 40},${132 + rnd() * 40},${aMin + rnd() * (aMax - aMin)})`; g.lineWidth = wMin + rnd() * (wMax - wMin);
        let px = x - 60 + rnd() * tw * 0.3, py = y - 20 + rnd() * th, dx = tw / 7, dy = (rnd() - 0.3) * th * 0.35;
        g.beginPath(); g.moveTo(px, py);
        for (let sgm = 0; sgm < 9; sgm++) { const nx = px + dx * (0.7 + rnd() * 0.6), ny = py + dy + (rnd() - 0.5) * th * 0.18; g.lineTo(nx, ny); px = nx; py = ny; }
        g.stroke();
      }
    };
    vein(3, 14, 30, 0.04, 0.08, 10); vein(6, 0.5, 1.4, 0.18, 0.4, 0); vein(10, 0.3, 0.7, 0.08, 0.2, 0);
    g.filter = 'none';
    g.restore();
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function cabinetRun(w, d, pc = {}) {
  const g = new THREE.Group(), fy = -d / 2 + 0.02; // door faces sit 2 cm back from the stone's front edge
  const body = pc.body || PMAT.body, top = pc.top || PMAT.stone, pullMat = pc.pull || PMAT.brass;
  box(g, PMAT.kick, w, d - 0.08, 0.1, 0, 0.04, 0.05);
  box(g, body, w, d - 0.02, 0.78, 0, 0.01, 0.49);
  const n = Math.max(1, Math.round(w / 0.5));
  for (let i = 1; i < n; i++) box(g, PMAT.groove, 0.006, 0.004, 0.78, -w / 2 + (w * i) / n, fy - 0.002, 0.49);
  box(g, PMAT.groove, w, 0.004, 0.006, 0, fy - 0.002, 0.72); // drawer line
  for (let i = 0; i < n; i++) {
    const pull = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, Math.min(0.2, (w / n) * 0.5), 10), pullMat);
    pull.rotation.z = Math.PI / 2; pull.position.set(-w / 2 + (w * (i + 0.5)) / n, fy - 0.016, 0.8); g.add(pull);
  }
  box(g, top, w, d + 0.02, 0.04, 0, -0.01, 0.9);
  if (pc.window) { // uppers either side of the window, tile from the counter up to the sill and up to the uppers beside it
    const [wl, wr] = pc.window;
    upper(g, -w / 2, wl - 0.08, d); upper(g, wr + 0.08, w / 2, d);
    splash(g, -w / 2, w / 2, 0.92, 1.2, d);
    splash(g, -w / 2, wl - 0.08, 1.2, 1.475, d); splash(g, wr + 0.08, w / 2, 1.2, 1.475, d);
  }
  if (pc.uppers) { upper(g, -w / 2, w / 2, d); splash(g, -w / 2, w / 2, 0.92, 1.475, d); }
  return g;
}
const PROC = {
  cab: (w, d, pc) => cabinetRun(w, d, pc),
  sinkrun: (w, d, pc) => {
    const g = cabinetRun(w, d, pc), sx = pc.sinkAt ?? 0; // the basin's offset along the run (under the window)
    box(g, PMAT.steel, 0.64, 0.44, 0.004, sx, -0.02, 0.922);
    box(g, PMAT.basin, 0.58, 0.38, 0.004, sx, -0.02, 0.923);
    const by = 0.24, base = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.03, 0.05, 16), PMAT.brass);
    base.rotation.x = Math.PI / 2; base.position.set(sx, by, 0.945); g.add(base);
    const neck = new THREE.CatmullRomCurve3([[0, by, 0.95], [0, by, 1.24], [0, by - 0.05, 1.33], [0, by - 0.15, 1.31], [0, by - 0.19, 1.2]].map(([x, y, z]) => new THREE.Vector3(sx + x, y, z)));
    g.add(new THREE.Mesh(new THREE.TubeGeometry(neck, 40, 0.012, 10), PMAT.brass));
    box(g, PMAT.brass, 0.012, 0.012, 0.09, sx + 0.06, by, 1.0).rotation.y = 0.5; // the lever
    return g;
  },
  // a 36-inch pro range: stainless body, six sealed burners under continuous cast-iron grates, red knobs on the control
  // band, a solid door with a tubular handle; over it an island hood (42 x 24 in, 30 in above the grates) with its flue
  // to the ceiling
  range: (w, d, pc) => {
    const g = new THREE.Group(), fy = -(d - 0.02) / 2;
    box(g, PMAT.kick, w - 0.04, d - 0.1, 0.08, 0, 0.05, 0.04);
    box(g, PMAT.steel, w, d - 0.02, 0.81, 0, 0.01, 0.485);
    box(g, PMAT.kick, w, d - 0.02, 0.03, 0, 0.01, 0.905);
    for (const x of [-0.29, 0, 0.29]) for (const y of [-0.14, 0.17]) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.022, 20), PMAT.iron); cap.rotation.x = Math.PI / 2; cap.position.set(x, y, 0.93); g.add(cap);
    }
    for (let k = 0; k <= 6; k++) box(g, PMAT.iron, 0.014, d - 0.1, 0.014, -w / 2 + 0.03 + ((w - 0.06) * k) / 6, 0.01, 0.95);
    for (const y of [-0.27, -0.14, 0.0, 0.17, 0.3]) box(g, PMAT.iron, w - 0.06, 0.014, 0.014, 0, y, 0.95);
    box(g, PMAT.groove, w, 0.004, 0.006, 0, fy - 0.002, 0.765); // control band over the door
    box(g, PMAT.groove, w, 0.004, 0.006, 0, fy - 0.002, 0.11);
    for (let i = 0; i < 6; i++) { const k = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.03, 18), PMAT.red); k.position.set(-0.33 + i * 0.132, fy - 0.015, 0.825); g.add(k); }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, w - 0.14, 14), PMAT.steel); bar.rotation.z = Math.PI / 2; bar.position.set(0, fy - 0.055, 0.69); g.add(bar);
    for (const x of [-(w - 0.14) / 2 + 0.03, (w - 0.14) / 2 - 0.03]) box(g, PMAT.steel, 0.02, 0.055, 0.02, x, fy - 0.027, 0.69);
    const ceil = (pc.ceil || 2.7) - 0.01, hz = 0.92 + 0.76;
    box(g, PMAT.steel, 1.07, 0.61, 0.08, 0, 0, hz + 0.04);
    const cone = new THREE.CylinderGeometry(0.2546, 0.7566, 0.3, 4, 1, false, Math.PI / 4); cone.scale(1, 1, 0.57); cone.rotateX(Math.PI / 2);
    const canopy = new THREE.Mesh(cone, PMAT.steel); canopy.position.set(0, 0, hz + 0.08 + 0.15); g.add(canopy);
    box(g, PMAT.steel, 0.34, 0.24, ceil - (hz + 0.38), 0, 0, (hz + 0.38 + ceil) / 2);
    box(g, PMAT.groove, 1.0, 0.54, 0.004, 0, 0, hz - 0.002); // the filters' dark underside
    return g;
  },
  // a built-in refrigerator column (36 x 84 in class): French doors over a freezer drawer, tubular handles, the louvred
  // grille at the top, and a panelled cupboard above it to the ceiling so it fills the nook
  fridge2: (w, d, pc) => {
    const g = new THREE.Group(), fy = -d / 2, top = Math.max(2.14, (pc.ceil || 2.6) - 0.01);
    box(g, PMAT.kick, w, d - 0.06, 0.1, 0, 0.03, 0.05);
    box(g, PMAT.steel, w, d, 1.9, 0, 0, 0.1 + 0.95);
    box(g, PMAT.groove, 0.006, 0.004, 1.14, 0, fy - 0.002, 0.86 + 0.57); // between the French doors
    box(g, PMAT.groove, w, 0.004, 0.006, 0, fy - 0.002, 0.86);
    for (const x of [-0.05, 0.05]) {
      const hdl = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.75, 14), PMAT.steel); hdl.rotation.x = Math.PI / 2; hdl.position.set(x, fy - 0.06, 1.45); g.add(hdl);
      for (const z of [1.1, 1.8]) box(g, PMAT.steel, 0.02, 0.06, 0.02, x, fy - 0.03, z);
    }
    const dh = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, w - 0.16, 14), PMAT.steel); dh.rotation.z = Math.PI / 2; dh.position.set(0, fy - 0.06, 0.76); g.add(dh);
    for (const x of [-(w - 0.16) / 2 + 0.03, (w - 0.16) / 2 - 0.03]) box(g, PMAT.steel, 0.02, 0.06, 0.02, x, fy - 0.03, 0.76);
    box(g, PMAT.iron, w, d, 0.13, 0, 0, 2.065);
    for (let k = 0; k < 5; k++) box(g, PMAT.steel, w - 0.04, 0.004, 0.008, 0, fy - 0.002, 2.02 + k * 0.022);
    if (top > 2.16) { box(g, PMAT.body, w, d, top - 2.13, 0, 0, (2.13 + top) / 2); box(g, PMAT.groove, 0.006, 0.004, top - 2.17, 0, fy - 0.002, (2.15 + top) / 2); }
    return g;
  },
  // an upholstered bed: walnut plinth, mattress, linen duvet turned down, a throw across the foot, pillows, a tall
  // upholstered headboard against the wall (head at +y, foot toward the room)
  bed2: (w, d, pc) => {
    const g = new THREE.Group(), fab = new THREE.MeshStandardMaterial({ color: pc.headboard ?? 0x8c6f5a, roughness: 0.92 });
    const thr = new THREE.MeshStandardMaterial({ color: pc.throw ?? 0x9c4f36, roughness: 0.95 });
    box(g, PMAT.walnut, w - 0.06, d - 0.14, 0.2, 0, -0.04, 0.1);
    box(g, PMAT.linen, w - 0.1, d - 0.18, 0.22, 0, -0.05, 0.31);
    box(g, PMAT.linen, w - 0.04, (d - 0.18) * 0.7, 0.06, 0, -0.05 - (d - 0.18) * 0.15, 0.43); // duvet over the lower 70 %
    box(g, PMAT.linen, w - 0.04, 0.16, 0.075, 0, -0.05 - (d - 0.18) * 0.15 + (d - 0.18) * 0.35 - 0.08, 0.445); // its turned-down fold
    box(g, thr, w - 0.02, 0.5, 0.07, 0, -d / 2 + 0.33, 0.45);
    for (const x of [-(w - 0.1) / 4, (w - 0.1) / 4]) { box(g, PMAT.linen, (w - 0.2) / 2, 0.36, 0.15, x, d / 2 - 0.3, 0.5).rotation.x = -0.35; box(g, fab, (w - 0.3) / 2, 0.06, 0.32, x, d / 2 - 0.42, 0.56).rotation.x = -0.2; }
    box(g, fab, w, 0.1, 1.15, 0, d / 2 - 0.05, 0.575);
    return g;
  },
  // a walnut nightstand with one drawer and a ceramic lamp with a lit linen drum shade
  night2: (w, d) => {
    const g = new THREE.Group(), fy = -d / 2;
    box(g, PMAT.walnut, w, d, 0.52, 0, 0, 0.29); box(g, PMAT.walnut, w - 0.04, d - 0.04, 0.03, 0, 0, 0.015);
    box(g, PMAT.groove, w - 0.04, 0.004, 0.006, 0, fy - 0.002, 0.4); box(g, PMAT.brass, 0.12, 0.012, 0.012, 0, fy - 0.01, 0.47);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.3, 20), PMAT.ceramic); base.rotation.x = Math.PI / 2; base.position.set(0, 0.03, 0.7); g.add(base);
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.17, 0.2, 28, 1, true), PMAT.shade); shade.rotation.x = Math.PI / 2; shade.position.set(0, 0.03, 0.93); g.add(shade);
    return g;
  },
  // a floor of long marble tiles laid over a room's outline (pc.poly, house frame), 4 mm proud of the slab
  marble: (w, d, pc) => {
    const [cx, cy] = pc.center, sh = new THREE.Shape(pc.poly.map(([u, v]) => new THREE.Vector2(u - cx, v - cy)));
    const geo = new THREE.ShapeGeometry(sh); geo.translate(0, 0, 0.004);
    const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 1.8, uv.getY(i) / 1.2);
    if (pc.tex === 'hex') hexMat ??= new THREE.MeshStandardMaterial({ map: hexTexture(), roughness: 0.3 });
    else marbleMat ??= new THREE.MeshStandardMaterial({ map: marbleTexture(), roughness: 0.18 });
    const g = new THREE.Group(); g.add(new THREE.Mesh(geo, pc.tex === 'hex' ? hexMat : marbleMat)); return g;
  },
  // a freestanding oval tub (white, glossy) with a floor-mounted brass filler at its west end
  tub: (w0, d0) => {
    const g = new THREE.Group(), w = Math.min(w0, 1.7), d = Math.min(d0, 0.8); // the generic slots hand pieces an oversized box
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.44, 0.58, 48), PMAT.enamel); shell.rotation.x = Math.PI / 2; shell.scale.set(w / 1.0, 1, d / 1.0); shell.position.z = 0.29; g.add(shell);
    const well = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.01, 48), PMAT.water); well.rotation.x = Math.PI / 2; well.scale.set((w - 0.12) / 0.9, 1, (d - 0.12) / 0.9); well.position.z = 0.585; g.add(well);
    const filler = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[0, 0, 0], [0, 0, 0.92], [0.06, 0, 1.0], [0.16, 0, 0.96]].map(([x, y, z]) => new THREE.Vector3(-w / 2 - 0.14 + x, y, z))), 30, 0.014, 10), PMAT.brass); g.add(filler);
    return g;
  },
  // front-loading washer and dryer side by side under a walnut counter
  laundry: (w, d) => {
    const g = new THREE.Group(), u = (w - 0.06) / 2, fy = -d / 2 + 0.04;
    for (const x of [-u / 2 - 0.015, u / 2 + 0.015]) {
      box(g, PMAT.enamel, u, d - 0.06, 0.85, x, 0.03, 0.425);
      box(g, PMAT.iron, u - 0.04, 0.004, 0.08, x, fy - 0.002, 0.78);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.025, 12, 40), PMAT.steel); ring.rotation.x = Math.PI / 2; ring.position.set(x, fy - 0.01, 0.42); g.add(ring);
      const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.155, 0.01, 40), PMAT.glass); glass.position.set(x, fy - 0.006, 0.42); g.add(glass);
    }
    box(g, PMAT.walnut, w, d, 0.035, 0, 0, 0.9);
    return g;
  },
  // a wet bar: a base run with a stone top and a bar sink, an under-counter wine fridge at its east end, tile behind
  wetbar: (w, d, pc) => {
    const g = cabinetRun(w, d, pc), fy = -d / 2 + 0.02;
    box(g, PMAT.steel, 0.42, 0.36, 0.004, -0.2, -0.02, 0.922); box(g, PMAT.basin, 0.36, 0.3, 0.004, -0.2, -0.02, 0.923);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[-0.2, d / 2 - 0.08, 0.92], [-0.2, d / 2 - 0.08, 1.16], [-0.2, d / 2 - 0.2, 1.2], [-0.2, d / 2 - 0.26, 1.12]].map(([x, y, z]) => new THREE.Vector3(x, y, z))), 30, 0.011, 10), PMAT.brass));
    box(g, PMAT.steel, 0.6, 0.012, 0.8, w / 2 - 0.33, fy - 0.006, 0.48);
    box(g, PMAT.glass, 0.5, 0.004, 0.66, w / 2 - 0.33, fy - 0.013, 0.49);
    splash(g, -w / 2, w / 2, 0.92, 1.25, d);
    return g;
  },
  // a floating walnut vanity with a stone top, a round vessel basin, a brass spout and a round mirror above
  vanity2: (w, d) => {
    const g = new THREE.Group();
    box(g, PMAT.walnut, w, d - 0.02, 0.38, 0, 0.01, 0.62); box(g, PMAT.groove, w - 0.04, 0.004, 0.006, 0, -d / 2 + 0.008, 0.62);
    box(g, PMAT.stone, w, d, 0.03, 0, 0, 0.825);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.13, 32), PMAT.ceramic); bowl.rotation.x = Math.PI / 2; bowl.position.set(0, -0.02, 0.905); g.add(bowl);
    const spout = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[0, d / 2 - 0.02, 1.08], [0, d / 2 - 0.12, 1.08], [0, d / 2 - 0.19, 1.04]].map(([x, y, z]) => new THREE.Vector3(x, y, z))), 12, 0.011, 8), PMAT.brass); g.add(spout);
    const mirror = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.02, 40), PMAT.mirror); mirror.position.set(0, d / 2 - 0.01, 1.5); g.add(mirror);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.012, 8, 48), PMAT.brass); rim.rotation.x = Math.PI / 2; rim.position.set(0, d / 2 - 0.022, 1.5); g.add(rim);
    return g;
  },
  // the shower wall: tile from the tray up, a brass riser with a rain head and a hand shower
  showerkit: (w, d) => {
    const g = new THREE.Group(), wy = d / 2 + 0.03; // the wall face behind the piece
    splash(g, -w / 2, w / 2, 0.1, 2.05, d);
    const riser = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.1, 12), PMAT.brass); riser.rotation.x = Math.PI / 2; riser.position.set(0, wy - 0.03, 1.55); g.add(riser);
    box(g, PMAT.brass, 0.012, 0.3, 0.012, 0, wy - 0.17, 2.1);
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.012, 36), PMAT.brass); head.rotation.x = Math.PI / 2; head.position.set(0, wy - 0.32, 2.09); g.add(head);
    const valve = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 24), PMAT.brass); valve.position.set(0, wy - 0.02, 1.05); g.add(valve);
    return g;
  },
  // Apartment B's kitchen as captured: navy shaker cabinets, a butcher-block top, chrome pulls; options for the double
  // sink with its gooseneck (sinkAt), a two-burner gas cooktop in black glass (cooktopAt), navy uppers and oak floating
  // shelves between them (uppers, shelves: [x0, x1] along the run)
  kitB: (w, d, pc) => {
    const g = cabinetRun(w, d, { body: PMAT.navy, top: PMAT.block, pull: PMAT.chrome });
    if (pc.sinkAt != null) {
      const x = pc.sinkAt;
      box(g, PMAT.chrome, 0.8, 0.46, 0.004, x, -0.03, 0.922);
      for (const dx of [-0.2, 0.2]) box(g, PMAT.basin, 0.36, 0.38, 0.004, x + dx, -0.03, 0.923);
      g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[0, 0.25, 0.92], [0, 0.25, 1.28], [0, 0.17, 1.36], [0, 0.07, 1.3], [0, 0.05, 1.2]].map(([a, b, c]) => new THREE.Vector3(x + a, b, c))), 40, 0.013, 10), PMAT.chrome));
    }
    if (pc.cooktopAt != null) {
      const x = pc.cooktopAt;
      box(g, PMAT.glass, 0.6, 0.48, 0.012, x, -0.02, 0.926);
      for (const dx of [-0.14, 0.14]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.008, 8, 28), PMAT.iron); ring.position.set(x + dx, -0.02, 0.94); g.add(ring);
        box(g, PMAT.iron, 0.2, 0.012, 0.012, x + dx, -0.02, 0.945); box(g, PMAT.iron, 0.012, 0.2, 0.012, x + dx, -0.02, 0.945);
      }
    }
    for (const [x0, x1] of pc.uppers || []) upper(g, x0, x1, d, PMAT.navy);
    if (pc.shelves) for (const z of [1.55, 1.9]) box(g, PMAT.oak, pc.shelves[1] - pc.shelves[0], 0.26, 0.04, (pc.shelves[0] + pc.shelves[1]) / 2, d / 2 + 0.03 - 0.13, z);
    if (pc.uppers || pc.shelves) splash(g, -w / 2, w / 2, 0.92, 1.475, d);
    return g;
  },
  // the inset built-in bookshelf, painted white: a carcass with five open shelves
  builtin: (w, d) => {
    const g = new THREE.Group(), h = 2.04;
    for (const x of [-w / 2 + 0.01, w / 2 - 0.01]) box(g, PMAT.paint, 0.02, d, h, x, 0, h / 2);
    box(g, PMAT.paint, w, 0.012, h, 0, d / 2 - 0.006, h / 2);
    for (let k = 0; k <= 5; k++) box(g, PMAT.paint, w - 0.04, d - 0.02, 0.022, 0, 0.01, 0.1 + k * (h - 0.12) / 5);
    return g;
  },
  // a wall-mounted mini-split head (pc.z: its centre height)
  minisplit: (w, d, pc) => {
    const g = new THREE.Group(), z = pc.z ?? 2.2;
    box(g, PMAT.paint, w, d, 0.3, 0, 0, z); box(g, PMAT.groove, w - 0.06, 0.004, 0.01, 0, -d / 2 - 0.002, z - 0.09);
    return g;
  },
  // a five-blade ceiling fan with a light bowl, hung 0.3 m from the ceiling (pc.ceil above the floor)
  fan: (w, d, pc) => {
    const g = new THREE.Group(), z = (pc.ceil || 2.6) - 0.3;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.26, 10), PMAT.paint); rod.rotation.x = Math.PI / 2; rod.position.z = z + 0.15; g.add(rod);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.09, 0.1, 24), PMAT.paint); hub.rotation.x = Math.PI / 2; hub.position.z = z; g.add(hub);
    const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), PMAT.shade); bowl.rotation.x = -Math.PI / 2; bowl.position.z = z - 0.05; g.add(bowl);
    for (let k = 0; k < 5; k++) { const b = box(g, PMAT.paint, 0.55, 0.12, 0.008, 0, 0, z + 0.01); b.geometry.translate(0.36, 0, 0); b.position.set(0, 0, z + 0.01); b.rotation.z = (k * 2 * Math.PI) / 5; }
    return g;
  },
  // a recessed wall heater: a white grille panel
  heater: (w, d) => {
    const g = new THREE.Group(), z = 1.15;
    box(g, PMAT.paint, w, d, 0.62, 0, 0, z);
    for (let k = 0; k < 9; k++) box(g, PMAT.groove, w - 0.08, 0.004, 0.012, 0, -d / 2 - 0.002, z - 0.24 + k * 0.06);
    return g;
  },
  // a sheer white curtain on a rod over a window: gathered folds
  curtain: (w, d) => {
    const g = new THREE.Group(), h = 2.25, n = 14;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, w + 0.2, 10), PMAT.chrome); rod.rotation.z = Math.PI / 2; rod.position.set(0, 0, h + 0.05); g.add(rod);
    for (let k = 0; k < n; k++) { const f = box(g, PMAT.sheer, w / n * 1.4, 0.012, h - 0.05, -w / 2 + (k + 0.5) * w / n, (k % 2 ? 0.015 : -0.015), (h - 0.05) / 2 + 0.03); f.rotation.z = k % 2 ? 0.5 : -0.5; }
    return g;
  },
  // a grey-brown plank floor (the captured laminate) laid over a room's outline
  plank: (w, d, pc) => {
    const [cx, cy] = pc.center, sh = new THREE.Shape(pc.poly.map(([u, v]) => new THREE.Vector2(u - cx, v - cy)));
    const geo = new THREE.ShapeGeometry(sh); geo.translate(0, 0, 0.004);
    const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 2.4, uv.getY(i) / 1.2);
    plankMat ??= new THREE.MeshStandardMaterial({ map: plankTexture(), roughness: 0.55 });
    const g = new THREE.Group(); g.add(new THREE.Mesh(geo, plankMat)); return g;
  },
  // a small round bistro table on a pedestal
  bistro: (w) => {
    const g = new THREE.Group();
    const top = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, 0.03, 40), PMAT.walnut); top.rotation.x = Math.PI / 2; top.position.z = 0.735; g.add(top);
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.7, 14), PMAT.iron); col.rotation.x = Math.PI / 2; col.position.z = 0.37; g.add(col);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.025, 30), PMAT.iron); foot.rotation.x = Math.PI / 2; foot.position.z = 0.013; g.add(foot);
    return g;
  },
  // a painted half-glass door leaf (pc.color): two stacked frosted lites over a cross-braced panel, a round knob;
  // pc.solid: a plain two-panel leaf (the bathroom's door down to the basement)
  doorleaf: (w, d, pc) => {
    const g = new THREE.Group(), paint = new THREE.MeshStandardMaterial({ color: pc.color ?? 0x4a6872, roughness: 0.45 }), h = 2.03;
    box(g, paint, w, d, h, 0, 0, h / 2);
    if (pc.solid) {
      for (const y of [-d / 2 - 0.003, d / 2 + 0.003]) for (const [z, ph] of [[0.55, 0.8], [1.5, 0.8]]) {
        for (const s of [-1, 1]) { box(g, PMAT.groove, 0.006, 0.004, ph, s * (w / 2 - 0.12), y, z); box(g, PMAT.groove, w - 0.24, 0.004, 0.006, 0, y, z + s * ph / 2); }
      }
      for (const y of [-d / 2 - 0.03, d / 2 + 0.03]) { const k = new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 10), PMAT.brass); k.position.set(-w / 2 + 0.07, y, 0.95); g.add(k); }
      return g;
    }
    for (const z of [1.3, 1.72]) box(g, PMAT.frost, w - 0.24, d + 0.006, 0.36, 0, 0, z);
    for (const s of [-1, 1]) for (const y of [-d / 2 - 0.004, d / 2 + 0.004]) { const b = box(g, paint, Math.hypot(w - 0.24, 0.62), 0.008, 0.06, 0, y, 0.5); b.rotation.y = s * Math.atan2(0.62, w - 0.24); }
    for (const y of [-d / 2 - 0.004, d / 2 + 0.004]) { box(g, paint, w - 0.2, 0.008, 0.05, 0, y, 0.82); box(g, paint, w - 0.2, 0.008, 0.05, 0, y, 0.18); }
    for (const y of [-d / 2 - 0.03, d / 2 + 0.03]) { const k = new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 10), PMAT.chrome); k.position.set(w / 2 - 0.07, y, 0.95); g.add(k); }
    return g;
  },
  // painted shelves across a wall niche, at pc.shelves heights above the floor
  nicheshelf: (w, d, pc) => {
    const g = new THREE.Group();
    for (const z of pc.shelves || []) box(g, PMAT.paint, w - 0.004, d - 0.004, 0.022, 0, 0, z);
    return g;
  },
  // a close-coupled toilet in white vitreous china: an elongated bowl turned on a lathe (narrow foot, flared rim), a
  // closed seat and lid, the tank on the back with its lid and a chrome lever; its back on the wall (+y)
  toilet2: (w, d) => {
    const g = new THREE.Group(), china = PMAT.enamel, by = -d / 2 + 0.27; // the bowl's centre, 0.27 m from the front
    const prof = [[0, 0], [0.12, 0], [0.12, 0.02], [0.105, 0.06], [0.11, 0.2], [0.15, 0.31], [0.185, 0.37], [0.19, 0.39], [0.175, 0.395], [0, 0.395]];
    const bowl = new THREE.Mesh(new THREE.LatheGeometry(prof.map(([r, z]) => new THREE.Vector2(r, z)), 48), china);
    bowl.rotation.x = Math.PI / 2; bowl.scale.set(0.36 / 0.38, 1, 0.48 / 0.38); bowl.position.y = by; g.add(bowl);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.38, 32), china); neck.rotation.x = Math.PI / 2; neck.scale.set(1, 1, 1.3); neck.position.set(0, d / 2 - 0.2, 0.19); g.add(neck);
    const seat = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.024, 12, 48), china); seat.scale.set(1.15, 1.45, 0.6); seat.position.set(0, by, 0.41); g.add(seat);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.175, 0.175, 0.018, 48), china); lid.rotation.x = Math.PI / 2; lid.scale.set(1, 1, 1.3); lid.position.set(0, by, 0.432); g.add(lid);
    const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 12), PMAT.chrome); hinge.rotation.z = Math.PI / 2; hinge.position.set(0, by + 0.24, 0.43); g.add(hinge);
    box(g, china, 0.42, 0.19, 0.36, 0, d / 2 - 0.115, 0.6); // the tank
    box(g, china, 0.44, 0.21, 0.03, 0, d / 2 - 0.115, 0.795); // its lid
    box(g, PMAT.chrome, 0.06, 0.015, 0.015, -0.15, d / 2 - 0.215, 0.72); // the lever
    return g;
  },
  // a corner vanity for a corner (owner 2026-10-23: the sink in the bathroom's north-east corner): a painted cabinet on a
  // triangle with a bowed front, a stone top, an undermount basin and a chrome tap in the corner. Its corner is the
  // holder's back (0, h); the walls run from it at 45 degrees; the bowed front faces -y
  cornersink: (w, d, pc) => {
    const g = new THREE.Group(), h = (pc.leg || 0.6) / Math.SQRT2;
    const foot = (k) => { const s = new THREE.Shape(); s.moveTo(0, h); s.lineTo(-h - k, -k); s.quadraticCurveTo(0, -0.16 - k, h + k, -k); s.closePath(); return s; }; // k: the front's overhang (negative: set back)
    const body = new THREE.Mesh(new THREE.ExtrudeGeometry(foot(0), { depth: 0.72, bevelEnabled: false }), PMAT.paint); body.position.z = 0.1; g.add(body);
    const kick = new THREE.Mesh(new THREE.ExtrudeGeometry(foot(-0.04), { depth: 0.1, bevelEnabled: false }), PMAT.kick); g.add(kick);
    const top = new THREE.Mesh(new THREE.ExtrudeGeometry(foot(0.02), { depth: 0.03, bevelEnabled: false }), PMAT.stone); top.position.z = 0.82; g.add(top);
    box(g, PMAT.groove, 0.004, 0.004, 0.62, 0, -0.085, 0.45); // the two door leaves meet on the centre line
    for (const s of [-1, 1]) { const k = new THREE.Mesh(new THREE.SphereGeometry(0.014, 12, 8), PMAT.chrome); k.position.set(s * 0.05, -0.09, 0.72); g.add(k); }
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.004, 40), PMAT.ceramic); basin.rotation.x = Math.PI / 2; basin.scale.set(1, 1, 0.8); basin.position.set(0, h * 0.25, 0.853); g.add(basin);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.006, 8, 40), PMAT.groove); rim.scale.set(1, 0.8, 1); rim.position.set(0, h * 0.25, 0.853); g.add(rim);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[0, h - 0.12, 0.85], [0, h - 0.12, 1.06], [0, h - 0.2, 1.1], [0, h - 0.26, 1.03]].map(([x, y, z]) => new THREE.Vector3(x, y, z))), 20, 0.011, 8), PMAT.chrome));
    return g;
  },
  // pantry shelving on a wall: oak boards on cleats at pc.shelves heights, stocked with canisters, jars and boxes
  pantryshelf: (w, d, pc) => {
    const g = new THREE.Group(); let seed = pc.seed || 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const shelves = pc.shelves || [0.12, 0.52, 0.92, 1.32, 1.72, 2.1];
    for (const z of shelves) {
      box(g, PMAT.oak, w, d, 0.025, 0, 0, z);
      box(g, PMAT.oak, w, 0.02, 0.04, 0, d / 2 - 0.01, z - 0.032); // the cleat on the wall
      if (z > 1.9) continue; // the top board stays clear
      for (let x = -w / 2 + 0.06; x < w / 2 - 0.08;) {
        const k = rnd(), y = -d / 2 + 0.07 + rnd() * 0.06;
        if (k < 0.35) { const r = 0.045 + rnd() * 0.02, hh = 0.12 + rnd() * 0.08; const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, hh, 20), rnd() < 0.5 ? PMAT.ceramic : PMAT.steel); c.rotation.x = Math.PI / 2; c.position.set(x + r, y, z + 0.0125 + hh / 2); g.add(c); x += 2 * r + 0.03; }
        else if (k < 0.7) { const bw = 0.08 + rnd() * 0.1, bh = 0.18 + rnd() * 0.12; box(g, rnd() < 0.5 ? PMAT.linen : PMAT.block, bw, 0.12 + rnd() * 0.08, bh, x + bw / 2, y + 0.02, z + 0.0125 + bh / 2); x += bw + 0.02; }
        else x += 0.08 + rnd() * 0.12; // a gap
      }
    }
    return g;
  },
  // a flat-panel pocket door leaf; its leading edge (+x, the south end in the kitchen) carries a flush pull both sides
  pocketdoor: (w, d) => {
    const g = new THREE.Group();
    box(g, PMAT.leaf, w, d, 2.0, 0, 0, 1.0);
    for (const y of [-d / 2 - 0.002, d / 2 + 0.002]) box(g, PMAT.iron, 0.025, 0.004, 0.12, w / 2 - 0.05, y, 1.0);
    return g;
  },
  rug: (w, d, pc) => {
    const k = pc.palette || 'rust';
    rugMats[k] ??= new THREE.MeshStandardMaterial({ map: rugTexture(k), roughness: 1 });
    const g = new THREE.Group(); box(g, rugMats[k], w, d, 0.012, 0, 0, 0.006);
    return g;
  },
};

let manifest = null;
const modelCache = new Map();
const gltfLoader = new GLTFLoader();
async function loadModels() {
  try { manifest = await getJSON('assets/MANIFEST.json'); } catch { manifest = null; return; }
  const want = new Set([...Object.values(KIND_MODEL), ...Object.values(KIND_DECOR).flat().map((d) => d[0])]);
  const load = async (url, tries = 3) => { for (let k = 1; ; k++) { try { return await gltfLoader.loadAsync(url); } catch (e) { if (k >= tries) throw e; await new Promise((r) => setTimeout(r, 300 * k)); } } };
  await Promise.all(manifest.models.filter((m) => want.has(m.id)).map((m) => load(`assets/${m.gltf}`).then((g) => {
    const root = g.scene; root.rotation.x = Math.PI / 2; // Y-up -> Z-up
    if (MODEL_TINT[m.id]) root.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.color.multiply(new THREE.Color(MODEL_TINT[m.id])); } });
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
  const s = fit ? Math.min(1, fit[0] / c.size.x, fit[1] / c.size.y) : 1;
  return placeHolder(c.holder.clone(true), c.size, id, at, yaw, s, phase, label);
}
function placeHolder(g, size, id, at, yaw, s, phase, label) { // a holder: centred on its floor point, front to -y
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
  return { piece, meshes, size: size.clone().multiplyScalar(s) };
}
function disposeModel() {
  if (M.group) { world.remove(M.group); M.group.traverse((o) => o.geometry?.dispose()); }
  if (M.furn) { scene.remove(M.furn); M.furn.traverse((o) => o.geometry?.dispose()); }
  for (const d of Object.values(M.doors)) scene.remove(d.pivot);
}

function buildModel(data) {
  disposeModel();
  const storeys = Object.fromEntries(data.storeys.map((s) => [s.id, s]));
  const main = storeyOf(data, /main/i), upper = storeyOf(data, /upper/i), base = storeyOf(data, /basement/i);
  M.storeys = { main, upper, base };
  M.FFL = main.elevation;
  M.group = new THREE.Group();
  M.meshes = [];
  for (const e of data.elements) {
    const phase = phaseOf(e, storeys);
    const col = (e.color || [0.8, 0.8, 0.8]).map(srgbToLinear);
    const mat = e.cls === "IfcWindow" ? MAT.IfcWindow : MAT.solid;
    const mesh = new THREE.Mesh(geometryFor(e, phase, 0, col, e.edited, toHouse, slotOf(e)), mat);
    mesh.castShadow = mesh.receiveShadow = e.cls !== 'IfcWindow';
    if (STAGED_OVER.test(e.name || '')) mesh.visible = false; // a staged piece stands in for it (furniture.js layouts)
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

  // doors: the exterior IfcDoor nearest each apartment's front room; both leaves swing in. Apartment A's front door hangs on
  // its east jamb, on the right as you come in from the porch (owner 2026-10-23); Apartment B's on its west jamb
  const doorNear = (room) => {
    let best = null, bd = 1e9;
    for (const m of M.meshes) {
      if (m.userData.e.cls !== 'IfcDoor') continue;
      const bx = new THREE.Box3().setFromObject(m), cc = bx.getCenter(new THREE.Vector3());
      const dd = Math.hypot(cc.x - room.cu, cc.y - room.cv);
      if (dd < bd) { bd = dd; best = { mesh: m, box: bx, center: cc }; }
    }
    return best;
  };
  const byName = (n) => M.spaces.find((r) => r.name === n);
  M.doors = {};
  for (const [key, roomName, hingeEast] of [['west', 'AptA - Entry', true], ['east', 'AptB - Front Room', false]]) {
    const r = byName(roomName);
    const dr = r && doorNear(r);
    if (!dr) continue;
    const pivot = new THREE.Group(), hx = hingeEast ? dr.box.max.x : dr.box.min.x;
    pivot.position.set(hx, dr.box.max.y, 0); // the hinge on the inside face
    const holder = new THREE.Group();
    holder.position.set(-hx, -dr.box.max.y, 0);
    pivot.add(holder);
    // the leaf and its glazing (a separate IfcPlate inside the leaf's box) swing together
    const grown = dr.box.clone().expandByScalar(0.05);
    const glazing = M.meshes.filter((m) => m.userData.e.cls === 'IfcPlate' && /glazing/i.test(m.userData.e.name || '') && grown.containsBox(new THREE.Box3().setFromObject(m)));
    for (const m of [dr.mesh, ...glazing]) {
      M.group.remove(m);
      m.geometry.applyMatrix4(world.matrixWorld);
      holder.add(m);
    }
    scene.add(pivot);
    M.doors[key] = { ...dr, pivot, swing: hingeEast ? -1 : 1, at: new THREE.Vector3(dr.center.x, dr.center.y, M.FFL) }; // swing: the turn that opens it inward
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
  for (const r of M.spaces) U.uExist.value[r.i] = storeys[r.s.storey]?.id === main.id && SCAN_ROOMS.test(r.name) ? 1 : 0;

  // annotations: plan sheet (main level) and the large floor labels for the walk
  M.ann?.dispose();
  M.ann = new THREE.CanvasTexture(drawSheet({ rooms: M.rooms, footprint: M.fp, bounds: sb, northDeg: AXIS }));
  M.ann.anisotropy = 8; M.ann.colorSpace = THREE.NoColorSpace;
  const floorLabels = (list) => {
    const px = 4096, cv = document.createElement('canvas'); cv.width = cv.height = px;
    const g = cv.getContext('2d'), s = px / sb.size[0];
    for (const r of list) {
      const w = r.w * s, h = r.d * s, x = (r.cu - sb.min[0]) * s, y = (sb.min[1] + sb.size[1] - r.cv) * s;
      let fs = Math.min(h * 0.22, 0.62 * s);
      g.font = `500 ${fs}px "Geist Mono"`;
      const name = r.label.toUpperCase();
      fs *= Math.min(1, (w * 0.86) / g.measureText(name).width);
      if (fs < 0.16 * s) continue;
      g.fillStyle = 'rgba(29,29,31,.78)'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      g.font = `500 ${fs}px "Geist Mono"`; g.fillText(name, x, y);
      g.font = `400 ${fs * 0.62}px "Geist Mono"`; g.textBaseline = 'top';
      g.fillText(`${r.area.toFixed(0)} M²  ·  ${r.w.toFixed(2)} × ${r.d.toFixed(2)}`, x, y + fs * 0.25);
    }
    const t = new THREE.CanvasTexture(cv); t.anisotropy = 8; t.colorSpace = THREE.NoColorSpace;
    return t;
  };
  M.lblA?.dispose(); M.lblB?.dispose();
  M.lblA = floorLabels(M.spaces.filter((r) => r.s.storey === main.id));
  M.lblB = floorLabels(M.spaces.filter((r) => upper && r.s.storey === upper.id));

  // walk stops (rooms grouped, stand points, origins), then proxy furniture facing each stand point
  M.stops = buildStops();
  M.furn = new THREE.Group();
  const inPoly = (pt, poly) => { let c2 = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c2 = !c2; } return c2; };
  // the ceiling over a point: the first model surface straight up (a space's recorded height can sit above a sloped
  // roof: the back wing's low-slope roof falls to 2.5 m at the north wall, and staged pieces poked through it)
  M.group.updateMatrixWorld(true);
  const solids = M.meshes.filter((m) => m.visible && !/IfcSpace|IfcOpeningElement/.test(m.userData.e.cls || ''));
  const up = new THREE.Raycaster(), UP = new THREE.Vector3(0, 0, 1);
  const ceilingOver = (x, y, z) => { up.set(new THREE.Vector3(x, y, z), UP); const h = up.intersectObjects(solids, false)[0]; return h ? h.point.z : Infinity; };
  for (const st of M.stops) for (const r of st.rooms) {
    // pieces stand on the slab: some upper spaces record their floor 5 cm under the slab top (3.04 vs 3.09 m)
    const z0 = Math.max(r.floorZ, (/upper/i.test(r.storey) ? M.storeys.upper?.elevation : M.storeys.main?.elevation) ?? r.floorZ);
    for (const pc of furnish(r, st.stand)) {
      const [cx, cy, cz] = pc.center, [sx, sy, sz] = pc.size;
      if (pc.ceil) pc.ceil = Math.min(pc.ceil, ceilingOver(cx, cy, z0 + 1.0) - z0);
      const corners = [[cx - sx / 2, cy - sy / 2], [cx + sx / 2, cy - sy / 2], [cx + sx / 2, cy + sy / 2], [cx - sx / 2, cy + sy / 2]];
      if (!pc.free && !corners.every((q) => inPoly(q, r.poly))) continue;
      const ph = /upper/i.test(r.storey) ? 3 : 2;
      const rc = [r.cu, r.cv], dir = [rc[0] - cx, rc[1] - cy];
      // a laid-out piece faces its own direction, square to its wall; the others turn toward the room centre
      const yaw = pc.face ? Math.atan2(pc.face[1], pc.face[0]) + Math.PI / 2 : Math.abs(dir[0]) + Math.abs(dir[1]) > 0.05 ? Math.atan2(dir[1], dir[0]) + Math.PI / 2 : 0;
      const fw = Math.max(sx, sy), fd = Math.min(sx, sy);
      const fit = pc.face ? (Math.abs(pc.face[0]) > 0.5 ? [sy, sx] : [sx, sy]) : [fw * 1.15, fd * 1.3]; // [across its front, front to back]
      const placed = PROC[pc.kind] ? placeHolder(PROC[pc.kind](fit[0], fit[1], pc), new THREE.Vector3(fit[0], fit[1], sz), 'procedural', [cx, cy, z0 + (/rug|marble|plank/.test(pc.kind) ? 0.008 : 0)], yaw, 1, ph, `${pc.kind} · ${r.label}`)
        : KIND_MODEL[pc.kind] && placeModel(KIND_MODEL[pc.kind], [cx, cy, z0], yaw, fit, ph, `${pc.kind} · ${r.label}`);
      const decor = (KIND_DECOR[pc.kind] || []).map(([id, along, fwd, top]) => {
        const ax = [Math.cos(yaw), Math.sin(yaw)], fx = [-Math.sin(yaw), Math.cos(yaw)];
        const h = top === 1 ? (placed ? placed.size.z : sz) : top;
        return placeModel(id, [cx + ax[0] * along - fx[0] * fwd, cy + ax[1] * along - fx[1] * fwd, z0 + h], yaw, null, ph, `decor · ${r.label}`);
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
  document.getElementById('tbRooms').textContent = `${M.rooms.length} here · ${M.spaces.length} spaces`;
  document.getElementById('tbModel').textContent = `${M.build?.id || data.source.sha256.slice(0, 12)}${data.edited?.length ? ` · ${data.edited.length} edit${data.edited.length > 1 ? 's' : ''}` : ''}`;
  document.getElementById('tbTime').textContent = (M.build?.model_mtime || '').replace('T', ' ').slice(0, 16) || '—';
  document.getElementById('ldBuild').textContent = `build ${M.build?.id || ''}`;
  buildRuler();
}

// ---------- walk stops: stand point at the side nearest the previous stop, looking across the room ----------
const pointIn = (pt, poly) => { let c2 = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c2 = !c2; } return c2; };
// the camera is indoors when it stands over the main footprint below the roof
const cameraIndoors = () => { const q = camera.position; return q.x > M.fp[0] && q.x < M.fp[2] && q.y > M.fp[1] && q.y < M.fp[3] && q.z < M.box.max.z - 0.5 && q.z > (M.storeys.base?.elevation ?? -3) - 0.5; };
const TITLE = { 'Upper - Room 1+Upper - Toilet+Upper - Shower': 'Bath, laundry + wet bar' }; // the model calls the bathroom Room 1
const VIEW_OVERRIDE = {
  'AptB - Nook': { stand: [0.9, 0.25], look: [-2.0, 0.6] }, // from the kitchen: the fridge, the table and the mini-split
  'AptB - Bedroom': { stand: [0.95, 1.85], look: [2.4, 4.7] }, // from the door corner: the bed head-on
  'AptA - Bathroom+AptA - Shower Area+AptA - Toilet Area': { stand: [-3.3, -1.45], look: [-0.6, -1.6] },
  'AptA - Kitchen w/ bar': { stand: [-5.4, 3.3], look: [-2.45, 3.82] }, // from the west door: sink run, range and hood, the fridge nook
  'AptA - Living area': { stand: [-3.75, -2.45], look: [-4.0, 1.2] }, // from the stair-side corner: couch, TV and bar stools in one view
  'AptA - Pantry+AptA - Refrigerator': { stand: [-3.7, 3.3], look: [-1.7, 3.8] }, // fridge face (v 2.7-3.4) and the pantry doorway beside it (v 3.7-3.9)
};
function buildStops() {
  const byName = (n) => M.spaces.find((r) => r.name === n);
  const stops = [];
  let prev = [M.doors.west?.at.x ?? M.center.x, (M.doors.west?.at.y ?? M.fp[1]) - 1];
  for (const names of ROOM_GROUPS) {
    if (names[0] === '@basement') {
      const z = M.storeys.base?.elevation ?? M.FFL - 2.1;
      const stand = [M.center.x - 1.2, M.center.y - 2.5];
      stops.push({ key: 'basement', rooms: [], stand, floorZ: z, look: [M.center.x - 1.0, M.center.y + 3.5], fov: 74, title: 'Basement', apt: 'Storage', meta: 'No room data in the model yet · storage dividers only' });
      prev = stand; continue;
    }
    if (names[0] === '@porch-east') {
      const d = M.doors.east;
      if (!d) continue;
      const stand = [d.at.x + 0.2, M.fp[1] - 1.2];
      stops.push({ key: 'porch-east', rooms: [], stand, floorZ: M.FFL, look: [d.at.x, d.at.y + 2], fov: 56, exterior: true, door: 'east', title: 'Front porch', apt: 'Apartment B', meta: 'Through the east front door' });
      prev = [d.at.x, d.at.y - 0.4]; continue;
    }
    const rooms = names.map(byName).filter(Boolean);
    if (!rooms.length) continue;
    const u0 = Math.min(...rooms.map((r) => r.bbox[0])), v0 = Math.min(...rooms.map((r) => r.bbox[1]));
    const u1 = Math.max(...rooms.map((r) => r.bbox[2])), v1 = Math.max(...rooms.map((r) => r.bbox[3]));
    const inset = Math.min(0.45, (u1 - u0) * 0.3, (v1 - v0) * 0.3);
    // stand between the room's centre and the side the walk comes from, inside the footprint
    const c = (() => { // area centroid of the largest room's polygon
      const poly = rooms.reduce((a, r) => (r.area > a.area ? r : a), rooms[0]).poly;
      let A = 0, cx = 0, cy = 0;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]; A += f; cx += (poly[j][0] + poly[i][0]) * f; cy += (poly[j][1] + poly[i][1]) * f; }
      return Math.abs(A) > 1e-6 ? [cx / (3 * A), cy / (3 * A)] : [(u0 + u1) / 2, (v0 + v1) / 2];
    })();
    const toPrev = [prev[0] - c[0], prev[1] - c[1]], tl = Math.hypot(...toPrev) || 1;
    const reach = Math.min(Math.max(0.2, Math.min(u1 - u0, v1 - v0) * 0.38), 1.6);
    let stand = [c[0] + (toPrev[0] / tl) * reach, c[1] + (toPrev[1] / tl) * reach];
    const insideAny = (pt) => rooms.some((r) => pointIn(pt, r.poly));
    for (let k = 0; k < 6 && !insideAny(stand); k++) stand = [(stand[0] + c[0]) / 2, (stand[1] + c[1]) / 2];
    stand = [Math.min(u1 - inset, Math.max(u0 + inset, stand[0])), Math.min(v1 - inset, Math.max(v0 + inset, stand[1]))];
    const small = Math.max(u1 - u0, v1 - v0) < 2.2 && !rooms.some((r) => /stair/i.test(r.name));
    if (small) stand = [c[0] + (toPrev[0] / tl) * 1.9, c[1] + (toPrev[1] / tl) * 1.9]; // a cupboard-sized room is seen from the room before it
    const reachF = small ? 0.4 : 1.4;
    let look = [c[0] + (c[0] - stand[0]) * reachF, c[1] + (c[1] - stand[1]) * reachF];
    if (Math.hypot(look[0] - stand[0], look[1] - stand[1]) < 0.8) look = [c[0], c[1] + 2];
    // small rooms seen through their doorway from the room next door (owner 2026-10-23; openings found by casting rays
    // from each room's centre at 1 m in the baked model): the bathroom opens west into the living area, the
    // refrigerator nook (and the pantry behind it) opens west into the kitchen. House-frame metres.
    const ov = VIEW_OVERRIDE[names.join('+')];
    if (ov) { stand = ov.stand; look = ov.look; }
    const main = rooms[0];
    const area = rooms.reduce((s, r) => s + (r.area || 0), 0);
    stops.push({
      key: names.join('+'), rooms, stand, floorZ: main.floorZ, look, fov: Math.max(u1 - u0, v1 - v0) < 2.2 ? 90 : 86, // wide first-person lens: tight rooms
      title: TITLE[names.join('+')] || (/Bathroom/.test(main.name) ? main.label : rooms.map((r) => r.label).join(' + ')), apt: main.apt, n: main.n,
      meta: `${(u1 - u0).toFixed(2)} × ${(v1 - v0).toFixed(2)} M · ${area.toFixed(1)} M² · CEILING ${main.height.toFixed(2)}`,
      door: names[0] === 'AptA - Entry' ? 'west' : names[0] === 'AptB - Front Room' ? 'east' : null,
    });
    for (const r of rooms) {
      U.uOrg.value[r.i].set(stand[0], stand[1], r.floorZ);
      U.uRad.value[r.i] = Math.hypot(u1 - u0, v1 - v0) + 1.6;
    }
    prev = c;
  }
  return stops;
}

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

let splat = null, interior = null;
// Gaussian splats go once the model is checked against them, room by room (owner 2026-10-23: arches, ceilings, framing
// first); until then they stay on and ?splat=0 shows the modelled-only house. Tag story-with-splats-20261023 keeps the
// first published version.
const COMPARE = Q.get('compare') === '1'; // the room check's capture layers (debug)
const SPLATS = Q.get('splat') !== '0' || COMPARE;
const captures = [], compareState = { model: true, capture: false, furniture: false };
const splatReady = (async () => {
  if (!SPLATS) { parts.splat = 1; setLoad(); return; }
  try {
    const { SparkRenderer, SplatMesh } = await import('@sparkjsdev/spark');
    // stable splats while the camera moves: no LoD swapping, radial sort (order holds under rotation), sort every frame
    const spark = new SparkRenderer({ renderer, enableLod: false, sortRadial: true, minSortIntervalMs: 0 });
    spark.layers.set(1);
    scene.add(spark);
    // the drone capture is the site; the rooms are drawn and furnished, so the interior scan is not loaded (owner 2026-10-23)
    splat = new SplatMesh({ url: 'splats/exterior_clean_v2.spz' });
    splat.layers.set(1); world.add(splat);
    if (COMPARE) { // the room check: every placed capture, toggled against the model with __P401.layers()
      const meta = await getJSON('splats/aptb_360_20261019.json');
      const aptb = new SplatMesh({ url: 'splats/aptb_360_20261019.ply' });
      aptb.matrixAutoUpdate = false;
      aptb.matrix.fromArray(new THREE.Matrix4().fromArray(meta.matrix_splat_to_model.flat()).transpose().elements);
      const main = new SplatMesh({ url: 'splats/interior_ground_all.spz' }); // Apartment A's main floor, model frame
      for (const m of [aptb, main]) { m.layers.set(1); world.add(m); captures.push(m); }
      for (const name of ['polycam_upper_lidar_registered', 'kiri_basement']) { // coloured point layers (uint32 n, xyz f32, rgb u8)
        const b = await (await fetch(`splats/${name}.bin`)).arrayBuffer(), n = new DataView(b).getUint32(0, true);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b, 4, n * 3), 3));
        g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(b, 4 + n * 12, n * 3), 3, true));
        const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.014, vertexColors: true }));
        pts.layers.set(1); world.add(pts); captures.push(pts);
      }
      await Promise.all([aptb.initialized, main.initialized]);
    }
    await splat.initialized;
  } catch (err) {
    console.error('splat unavailable:', err?.message || err);
    splat = interior = null;
  }
  parts.splat = 1; setLoad();
})();

// ---------- chapter C overlays: red-lines texture + the zoning envelope in 3D ----------
const ctxCenterModel = (() => { const c = new THREE.Vector3(); ctxBox.getCenter(c); return [c.x, c.y]; })(); // already house frame (box of world-rotated group)
const redB = redlineBounds(site, toHouse, [[ctxBox.min.x, ctxBox.min.y], [ctxBox.max.x, ctxBox.max.y]].map(([x, y]) => { const r = toHouse([x, y]); return r; }));
const redTex = new THREE.CanvasTexture(drawRedlines({ site, toHouse, bounds: redB, neighbour: { label: '2010 4TH ST · PROPOSED', sub: 'RISE PROJECTS 2025 · MASSING', at: ctxCenterModel } }));
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
const fxPost = new Post(renderer);
// look-dev constants (set from the choreography spec): bloom threshold (linear, pre-exposure), AO radius (m)
const LOOK = { bloomThreshold: 1.6, aoRadius: 0.45 };

const COMP_FS = /* glsl */`
precision highp float;
uniform sampler2D tND, tW, tColor, tAnn, tRed, tLblA, tLblB, tBloom, tAO, tDof;
uniform float uBloom, uAO, uFocus, uAperture;
uniform vec2 uRes, uAnnMin, uAnnSize, uRedMin, uRedSize;
uniform vec3 uPaper, uInk, uAccent;
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
  // look-dev on the real image: ambient occlusion, depth of field (half-res blur mixed by circle of confusion), bloom
  float coc = clamp(abs(w.w - uFocus) / max(uFocus, 0.1) * uAperture, 0.0, 1.0);
  vec3 lin = mix(colPass.rgb, texture(tDof, vUv).rgb, w.w > 0.0 ? coc : uAperture * 0.6);
  lin *= mix(1.0, texture(tAO, vUv).r, uAO);
  lin += texture(tBloom, vUv).rgb * uBloom;
  if (any(isnan(lin)) || any(isinf(lin))) lin = colPass.rgb == colPass.rgb ? colPass.rgb : vec3(0.85); // never let a NaN through
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
  col = mix(col, uInk, clamp(edge, 0.0, 1.0) * 0.92);
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * 0.22;
  col += (hash(gl_FragCoord.xy + uSeed) - 0.5) * 0.012;
  if (uDebug > 1.5) col = vec3(state == 3.0 ? 1.0 : 0.0, state == 1.0 || state == 2.0 ? 1.0 : 0.0, state == 6.0 ? 1.0 : (state == 0.0 ? 0.5 : 0.0));
  outColor = vec4(uDebug > 0.5 && uDebug < 1.5 ? real : col, 1.0);
}`;
const lin = (hex) => new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace); // display values passed through untouched
const CU = {
  tND: { value: rtPre.textures[0] }, tW: { value: rtPre.textures[1] }, tColor: { value: rtColor.texture },
  tBloom: { value: null }, tAO: { value: null }, tDof: { value: null }, uBloom: { value: 0.35 }, uAO: { value: 0.85 }, uFocus: { value: 4 }, uAperture: { value: 0 },
  tAnn: { value: null }, tRed: { value: redTex }, tLblA: { value: null }, tLblB: { value: null },
  uRes: { value: new THREE.Vector2(W(), H()) }, uAnnMin: { value: new THREE.Vector2() }, uAnnSize: { value: new THREE.Vector2(1, 1) },
  uRedMin: { value: new THREE.Vector2(...redB.min) }, uRedSize: { value: new THREE.Vector2(...redB.size) },
  uPaper: { value: lin(0xefebe2) }, uInk: { value: lin(0x1d1d1f) }, uAccent: { value: lin(parseInt(ACCENT.slice(1), 16)) },
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
  ground.position.set(M.center.x, M.center.y, M.FFL - 0.012);
  // sun: elevation 32°, late afternoon from the west-south-west (reference "warm" preset: #ffd9a8)
  { const el = 32 * DEG, d = new THREE.Vector2(-0.88, -0.47).normalize(); sun.position.set(M.center.x + 140 * Math.cos(el) * d.x, M.center.y + 140 * Math.cos(el) * d.y, M.center.z + 140 * Math.sin(el)); }
  sun.target.position.copy(M.center);
  U.uExtOrg.value.set(M.center.x, M.center.y, M.FFL); U.uExtRad.value = Math.hypot(M.fp[2] - M.fp[0], M.fp[3] - M.fp[1]) * 0.6 + (M.box.max.z - M.FFL) + 2;
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  rtColor.setSize(W(), H()); rtPre.setSize(W(), H()); fxPost.setSize(W(), H()); rtFinal.setSize(W(), H());
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
function sh(o) { // authoring helper: t (Vector3), yaw, pitch, fov, dist|frame, hold, go, cut, focus …
  const prev = shots.length ? shots[shots.length - 1].yaw : null;
  const s = { ...o, t: [o.t.x, o.t.y, o.t.z], yaw: unwrapYaw(prev, o.yaw) };
  shots.push(s);
  return s;
}
const eye = (pos, look, fov, extra = {}) => { // eye at pos, target 2.5 m along the look direction
  const d = V(look.x - pos.x, look.y - pos.y, look.z - pos.z).normalize();
  const yaw = Math.atan2(d.y, d.x) / DEG, pitch = -Math.asin(d.z) / DEG;
  return sh({ t: pos.clone().addScaledVector(d, 2.5), yaw, pitch, fov, dist: 2.5, focus: extra.focus ?? 4.5, ...extra });
};
function planShot() {
  const aspect = innerWidth / innerHeight, fp = M.fp;
  const frame = Math.max(fp[3] - fp[1] + 10.4, (fp[2] - fp[0] + 7) / (aspect * 0.58));
  const shift = aspect > 1 ? 0.1 * frame * aspect : 0;
  return { t: V(M.center.x - shift, M.center.y - 1.75, M.FFL), yaw: 90, pitch: 89.4, fov: 3, frame };
}
function buildTimeline() {
  shots = []; dossiers = []; revWin = [];
  const FFL = M.FFL, CUT0 = FFL + CUT_ABOVE_FLOOR, c = M.center, top = M.box.max.z;
  const doorW = M.doors.west?.at || V(c.x, M.fp[1], FFL), doorE = M.doors.east?.at || doorW;
  const cutIn = (z) => z + 2.35; // "3.52" analogue: just under the ceiling, rooms open from above
  const byKey = (k) => M.stops.find((s) => s.key === k);
  const groups = (pred) => M.stops.filter(pred);
  // 1 sheet
  heroShot = sh({ id: 'hero', ...planShot(), hold: 40, go: 150, cut: CUT0 });
  if (Q.get('chapters') === 'CB') { /* the permit clock and construction chapters stay available behind this switch */ }
  // 2 descent with the cut rising, 3 the orbit (owner: circle around) while the outside sweeps to as found
  sh({ id: 'lens', t: V(doorW.x, doorW.y + 3, FFL), yaw: 90, pitch: 64, fov: 36, dist: 26, go: 120, cut: cutIn(FFL) });
  const R = 24, oz = FFL + 1.5;
  const orbit = [[60, 32], [-30, 30], [-120, 28], [-210, 26]];
  const o0 = shots.length;
  for (const [yaw, pitch] of orbit) sh({ id: 'orbit', t: V(c.x, c.y, oz), yaw, pitch, fov: 34, dist: R, go: 75, cut: OFF() });
  sh({ id: 'approach', t: V(doorW.x, doorW.y, FFL + 1.7), yaw: 90, pitch: 13.6, fov: 44, dist: 12.35, go: 100, cut: OFF() });
  const doorShot = sh({ id: 'door', t: V(doorW.x, doorW.y + 2.6, FFL + 1.75), yaw: 90, pitch: -3, fov: 56, dist: 7.6, hold: 90, go: 110, cut: OFF(), focus: 7 });
  // rooms: dossier holds in walk order; overhead interludes before the first big room, the floor change and Apartment B
  const holdFor = (st, n, extra = {}) => {
    const z = st.floorZ + EYE;
    const s = eye(V(st.stand[0], st.stand[1], z), V(st.look[0], st.look[1], z - 0.12), st.fov <= 80 ? EYE_FOV : st.fov, { hold: 120, go: 100, cut: OFF(), id: st.key, ...extra });
    lastStand = V(st.stand[0], st.stand[1], z);
    dossiers.push({ shot: s, st, n });
    return s;
  };
  let lastStand = null;
  const viaInto = (st) => { // threshold via: halfway from the last stand point to this room's, looking the way we walk
    const z = st.floorZ + EYE, a = V(st.stand[0], st.stand[1], z), b = V(st.look[0], st.look[1], z - 0.1);
    const from = lastStand && Math.abs(lastStand.z - z) < 0.5 ? lastStand.clone().lerp(a, 0.5) : a.clone();
    const lookAt = from.distanceTo(a) > 0.4 ? a.clone().addScaledVector(b.clone().sub(a).normalize(), 1.5) : b;
    return eye(from, lookAt, VIA_FOV, { go: 95, cut: OFF(), id: `${st.key}-via` });
  };
  const overhead = (st, zf) => {
    const rs = st.rooms.length ? st.rooms : [];
    const bb = rs.length ? [Math.min(...rs.map((r) => r.bbox[0])), Math.min(...rs.map((r) => r.bbox[1])), Math.max(...rs.map((r) => r.bbox[2])), Math.max(...rs.map((r) => r.bbox[3]))] : [st.stand[0] - 2, st.stand[1] - 2, st.stand[0] + 2, st.stand[1] + 2];
    const rc = V((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, zf);
    const side = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
    sh({ id: 'rise', t: rc.clone().add(V(0, -1, 0)), yaw: shots[shots.length - 1].yaw, pitch: 62, fov: 30, dist: 14, go: 120, cut: cutIn(zf) });
    sh({ id: `${st.key}-top`, t: rc, yaw: 90, pitch: 89.4, fov: 4, frame: side + 1.5, hold: 90, go: 120, cut: cutIn(zf) });
    const toward = Math.atan2(st.look[1] - st.stand[1], st.look[0] - st.stand[0]) / DEG;
    sh({ id: 'drop', t: V(st.stand[0], st.stand[1], zf + 0.5), yaw: toward, pitch: 50, fov: 44, dist: 8, go: 110, cut: cutIn(zf) });
  };
  let n = 0;
  const A = groups((s) => /^AptA - (Entry)$/.test(s.key))[0];
  // the entry is held the way the reference holds its hall (owner 2026-10-23): just inside the door, looking on into
  // the house along the walk, not back at the door leaf from the room's centre
  if (A) {
    const z = FFL + EYE, next = byKey('AptA - Front room');
    const toward = next ? V(next.stand[0], next.stand[1], z) : V(A.look[0], A.look[1], z);
    const inward = toward.clone().sub(V(doorW.x, doorW.y, z)).setZ(0).normalize();
    const at = V(doorW.x, doorW.y, z).addScaledVector(inward, 0.9);
    const s = eye(at, at.clone().addScaledVector(inward, 3.5).setZ(z - 0.12), EYE_FOV, { hold: 110, go: 140, cut: OFF(), id: A.key });
    lastStand = at; dossiers.push({ shot: s, st: A, n: ++n });
  }
  const aRooms = ['AptA - Front room', 'AptA - Living area', 'AptA - Kitchen w/ bar', 'AptA - Pantry+AptA - Refrigerator', 'AptA - Bathroom+AptA - Shower Area+AptA - Toilet Area'];
  aRooms.forEach((k, i) => {
    const st = byKey(k); if (!st) return;
    if (/Pantry/.test(k)) { // a closet behind a 0.35 m doorway: read from above with the cut lowered, as the reference reads tight spaces
      const bb = [Math.min(...st.rooms.map((r) => r.bbox[0])), Math.min(...st.rooms.map((r) => r.bbox[1])), Math.max(...st.rooms.map((r) => r.bbox[2])), Math.max(...st.rooms.map((r) => r.bbox[3]))];
      // camera above the kitchen side, looking down into the closet and the fridge nook; walls cut at 1.6 m
      const s2 = eye(V(bb[0] - 1.6, (bb[1] + bb[3]) / 2 - 0.5, st.floorZ + 3.3), V((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2 + 0.2, st.floorZ + 0.4), 50, { hold: 90, go: 110, cut: st.floorZ + 1.6, id: st.key });
      dossiers.push({ shot: s2, st, n: ++n });
      return;
    }
    if (i === 0) overhead(st, st.floorZ); else viaInto(st);
    holdFor(st, ++n);
  });
  const up = byKey('Upper - Stairs+Upper - Hallway');
  const stairsUp = byKey('AptA - Stairs up');
  const stairVia = (st) => { // a stair is read from above, the cut lowered into its well
    const r0 = st.rooms[0]; const c2 = V((r0.bbox[0] + r0.bbox[2]) / 2, (r0.bbox[1] + r0.bbox[3]) / 2, st.floorZ + 0.8);
    return sh({ id: `${st.key}-stair`, t: c2, yaw: shots[shots.length - 1].yaw, pitch: 58, fov: 46, dist: 6.5, go: 110, cut: st.floorZ + 2.4 });
  };
  // the floor change (owner 2026-10-23, checkpoint 3): lift out to the whole upper floor drawn as a plan, drop onto the
  // upper landing and hold looking down the stair (the view of the owner's photo upper-flight-looking-down.jpg), the
  // stair's main-floor and upper spaces revealing together; then the hall
  const sp = (name) => M.spaces.find((r) => r.name === name);
  const upStair = sp('Upper - Stairs'), landing = sp('Upper - Stair Landing & Transition');
  if (up) overhead({ ...up, rooms: M.spaces.filter((r) => /^Upper/.test(r.name)) }, up.floorZ);
  if (stairsUp && upStair) {
    const [u0, v0, u1, v1] = upStair.bbox, cu = (u0 + u1) / 2, z = upStair.floorZ + EYE;
    const st = { ...stairsUp, rooms: [...stairsUp.rooms, upStair, ...(landing ? [landing] : [])] };
    const s = eye(V(cu, v1 + 0.55, z), V(cu - 0.05, v0 + 0.4, upStair.floorZ - 0.65), 70, { hold: 120, go: 110, cut: OFF(), id: stairsUp.key });
    dossiers.push({ shot: s, st, n: ++n });
    lastStand = V(cu, v1 + 0.55, z);
  }
  if (up) { viaInto(up); holdFor(up, ++n); }
  for (const k of ['Upper - Room 2+Upper - Closet', 'Upper - Room 1+Upper - Toilet+Upper - Shower', 'Upper - Room 3+Upper - Room 3 closet']) {
    const st = byKey(k); if (!st) continue;
    if (/Upper - Toilet/.test(k)) { // the bathroom wraps the alcove under low attic slopes: read from above, walls cut at 1.45 m
      const bb = [Math.min(...st.rooms.map((r) => r.bbox[0])), Math.min(...st.rooms.map((r) => r.bbox[1])), Math.max(...st.rooms.map((r) => r.bbox[2])), Math.max(...st.rooms.map((r) => r.bbox[3]))];
      const cu = (bb[0] + bb[2]) / 2, cv = (bb[1] + bb[3]) / 2;
      const s2 = eye(V(cu + 0.8, bb[1] - 1.9, st.floorZ + 5.2), V(cu - 0.2, cv + 0.2, st.floorZ + 0.2), 62, { hold: 120, go: 110, cut: st.floorZ + 1.45, id: st.key });
      dossiers.push({ shot: s2, st, n: ++n });
      continue;
    }
    viaInto(st); holdFor(st, ++n);
  }
  const down = byKey('AptA - Stairs to basement'), base = byKey('basement');
  if (down) { const s = stairVia(down); dossiers.push({ shot: s, st: down, n: ++n, via: true }); }
  if (base) { viaInto(base); holdFor(base, ++n, { hold: 90 }); }
  // out, round to the porch, in through Apartment B's own door
  sh({ id: 'out', t: V(c.x, c.y, FFL + 1), yaw: shots[shots.length - 1].yaw, pitch: 40, fov: 34, dist: 20, go: 110, cut: OFF() });
  sh({ id: 'approachB', t: V(doorE.x, doorE.y, FFL + 1.7), yaw: 90, pitch: 12, fov: 44, dist: 11, go: 100, cut: OFF() });
  const doorBShot = sh({ id: 'doorB', t: V(doorE.x, doorE.y + 2.4, FFL + 1.75), yaw: 90, pitch: -3, fov: 56, dist: 6.8, hold: 90, go: 110, cut: OFF(), focus: 6.5 });
  ['AptB - Front Room', 'AptB - Kitchen', 'AptB - Nook', 'AptB - Bathroom+AptB - Shower Area+AptB - Toilet Area', 'AptB - Bedroom'].forEach((k, i) => {
    const st = byKey(k); if (!st) return;
    if (/AptB - Bathroom/.test(k)) { // a narrow bathroom with the laundry in it: read from above, the walls cut at 1.45 m
      const bb = [Math.min(...st.rooms.map((r) => r.bbox[0])), Math.min(...st.rooms.map((r) => r.bbox[1])), Math.max(...st.rooms.map((r) => r.bbox[2])), Math.max(...st.rooms.map((r) => r.bbox[3]))];
      const cu = (bb[0] + bb[2]) / 2, cv = (bb[1] + bb[3]) / 2;
      const s2 = eye(V(bb[2] + 1.6, bb[1] - 1.0, st.floorZ + 4.4), V(cu, cv + 0.2, st.floorZ + 0.2), 58, { hold: 120, go: 110, cut: st.floorZ + 1.45, id: st.key });
      dossiers.push({ shot: s2, st, n: ++n });
      return;
    }
    if (i === 0) overhead(st, st.floorZ); else viaInto(st);
    holdFor(st, ++n);
  });
  // lift and the second orbit (the proposed exterior), then the as-built sheet spinning in
  const e0 = shots.length;
  sh({ id: 'lift', t: V(c.x, c.y, FFL + 1), yaw: shots[shots.length - 1].yaw, pitch: 60, fov: 30, dist: 40, go: 150, cut: OFF() });
  for (const [yaw, pitch] of [[200, 34], [110, 32], [20, 40]]) sh({ id: 'orbit2', t: V(c.x, c.y, oz), yaw, pitch, fov: 34, dist: R + 4, go: 70, cut: OFF() });
  const pl = planShot();
  asbuiltShot = sh({ id: 'asbuilt', ...pl, yaw: unwrapYaw(shots[shots.length - 1].yaw, pl.yaw) - 360, hold: 150, go: 0, cut: CUT0 });
  TOTAL = layout(shots);
  // windows (vh)
  extWin = [shots[o0].h0 - 10, shots[o0 + orbit.length - 1].g1];
  ext2Win = [shots[e0 + 1].h0, shots[e0 + 3].g1];
  doorWin = { west: [doorShot.h0 + 8, doorShot.h1 - 6], east: [doorBShot.h0 + 8, doorBShot.h1 - 6] };
  let prevEnd = doorShot.h1;
  for (const d of dossiers) {
    const s = d.shot;
    const h0 = s.h0, h1 = d.via ? s.g1 : s.h1;
    for (const r of d.st.rooms) revWin.push({ i: r.i, e: [prevEnd - 30, h0 + 30], p: [lerp(h0, h1, 0.5), h1 + 15] });
    d.win = [h0 - 20, h1 + 16];
    prevEnd = h1 + 10;
  }
  rollWin = [asbuiltShot.h0 + 4, asbuiltShot.h1 - 24];
  document.getElementById('track').style.height = `${TOTAL + 120}vh`;
}
let camCut = 99, camSample = null;
function placeCamera(s) {
  const c = sample(shots, s);
  camSample = c;
  const yaw = c.yaw * DEG, pitch = c.pitch * DEG;
  const dir = new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch));
  const t = new THREE.Vector3(c.x, c.y, c.z);
  // aspect fit: frames widen on narrow screens, distance keeps the authored fov
  const aspect = innerWidth / innerHeight;
  const vfov = 2 * Math.atan(Math.tan((c.fov * DEG) / 2) * Math.max(1, 1.5 / aspect) ** 0.6) / DEG;
  camera.position.copy(t).addScaledVector(dir, -c.dist);
  camera.fov = vfov;
  camera.near = Math.min(30, Math.max(0.05, 0.02 * c.dist));
  camera.far = Math.max(2000, 6 * c.dist);
  camera.updateProjectionMatrix();
  camera.lookAt(t);
  { // cut follows the shot index (snaps per shot, like the reference), smoothed inside each segment
    const i = Math.floor(c.index), f = c.index - i, A2 = shots[Math.max(0, Math.min(shots.length - 1, i))], B2 = shots[Math.max(0, Math.min(shots.length - 1, i + 1))];
    camCut = lerp(A2.cut ?? 99, B2.cut ?? 99, ease(f)); }
  CU.uPixA.value = 2 * Math.tan((vfov * DEG) / 2) / H();
  if (debugPose) { // __P401.pose({at, look, fov, cut}): a fixed camera for checking a view before it becomes a shot
    camera.position.set(...debugPose.at); camera.fov = debugPose.fov ?? 60; camera.near = 0.05; camera.updateProjectionMatrix();
    camera.lookAt(...debugPose.look); if (debugPose.cut != null) camCut = debugPose.cut;
  }
}
let debugPose = null;

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
  // reveals: existing then proposed per room, multiplied by the as-built switch (paper again after the outro roll)
  const roll01 = band(s, rollWin[0], rollWin[1]);
  const asBuilt = 1 - band(roll01, 0.27, 1);
  U.uRev1.value.fill(0); U.uRev2.value.fill(0);
  for (const w of revWin) {
    // drawing -> finished room with its materials and furniture, as Casa Serra (owner 2026-10-23): one reveal per room
    U.uRev2.value[w.i] = Math.max(U.uRev2.value[w.i], cubic(band(s, w.e[0], w.p[1]))) * asBuilt;
    U.uRev1.value[w.i] = U.uRev2.value[w.i];
  }
  U.uExtRev1.value = cubic(band(s, extWin[0], extWin[1])) * asBuilt;
  U.uExtRev2.value = 0; // no design direction over the house as found
  U.uAll.value = Q.get('all') ? 1 : 0; // ?all=1: every surface revealed (debug)
  if (M.doors.west) M.doors.west.pivot.rotation.z = M.doors.west.swing * cubic(band(s, ...doorWin.west)) * 95 * DEG;
  if (M.doors.east) M.doors.east.pivot.rotation.z = M.doors.east.swing * cubic(band(s, ...doorWin.east)) * 95 * DEG;
  // floor annotations: the plan sheet on the sheet shots; big room labels while rooms are paper
  CU.uAnnOp.value = Math.max(1 - band(s, heroShot.h1, heroShot.g1 * 0.6), band(s, asbuiltShot.h0 - 40, asbuiltShot.h0));
  CU.uRedOp.value = 0; envMat.opacity = 0;
  CU.uLblOp.value = band(s, shots[1].g1, shots[1].g1 + 60) * (1 - band(s, asbuiltShot.h0 - 80, asbuiltShot.h0 - 20));
  CU.uGrid.value = 1;
  const outdoors = !cameraIndoors();
  // from inside, a window reads as daylight (owner 2026-10-23, after the reference): glowing glass, not the empty sky
  MAT.IfcWindow.emissiveIntensity = outdoors ? 0 : 1.15; MAT.IfcWindow.opacity = outdoors ? 0.32 : 0.96;
  CU.uSplat.value = splat ? band(s, extWin[0], extWin[0] + 80) * (1 - band(s, asbuiltShot.h0 - 60, asbuiltShot.h0)) : 0;
  // look-dev per the reference: ink on real 0.12 indoors / 0.05 outdoors, DOF on holds, vignette off on plan shots
  const flat = camSample.pitch > 80 ? 1 : 0;
  CU.uInkReal.value = outdoors ? 0.05 : 0.12;
  const dofT = flat ? 0 : camSample.held ? (outdoors ? 0.07 : 0.18) : 0.05;
  CU.uAperture.value += (dofT - CU.uAperture.value) * 0.08;
  if (Q.get('nodof')) CU.uAperture.value = 0; // debug switches: ?nodof=1, ?noao=1
  if (Q.get('noao')) CU.uAO.value = 0;
  CU.uFocus.value = camSample.focus;
  // dossiers: HUD window h0 − 20 → h1 + 16; interior scan while a ground-floor room plays existing
  const active = dossiers.find((d) => s >= d.win[0] && s <= d.win[1] && !d.via);
  const inStop = dossiers.find((d) => s >= d.win[0] - 60 && s <= d.win[1]);
  const scanOn = inStop && inStop.st.rooms.some((r) => U.uExist.value[r.i] > 0.5 && U.uRev1.value[r.i] > 0.02 && U.uRev2.value[r.i] < 0.6);
  if (interior) interior.visible = !!scanOn;
  if (splat) splat.visible = CU.uSplat.value > 0.01 && outdoors && U.uCut.value > M.box.max.z - 0.3;
  if (COMPARE) { M.group.visible = compareState.model; M.furn.visible = compareState.model && !!compareState.furniture; for (const c of captures) c.visible = compareState.capture; if (compareState.capture) splat && (splat.visible = false); }
  // chrome
  const hf = band(s, 0.5 * heroShot.h1, 0.5 * heroShot.h1 + 40);
  hero.style.opacity = String(1 - hf); hero.style.transform = `translateY(${-50 * hf}px)`;
  const finOp = band(s, asbuiltShot.h1 - 10, asbuiltShot.h1 + 30);
  chapter.style.opacity = String(finOp);
  if (finOp > 0) setChapter('A-101 · 401 Pearl St · as built', 'Every building starts flat. <em>This one is walkable.</em>', 'Two flats, one house, drawn from the scan.',
    [[`BUILD ${M.build?.id || ''} · ${M.spaces.length} SPACES`], ['40.016° N · 105.290° W · BOULDER, COLORADO'], ['RENDERED LIVE IN YOUR BROWSER · MATERIALS POLY HAVEN CC0'], ['WALK THE HOUSE: WASD · MOUSE · [ ] LENS']]);
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
  for (const m of [...M.meshes, ...ctxGroup.children]) m.material = m.userData.color;
  ground.visible = false;
  camera.layers.set(0); camera.layers.enable(1);
  renderer.setRenderTarget(rtColor);
  renderer.setClearColor(0xefebe2, 0); // alpha 0: nothing captured or modelled here
  renderer.clear();
  renderer.render(scene, camera);
  for (const m of [...M.meshes, ...ctxGroup.children]) m.material = m === sel ? PRE_SEL : m.userData.pre;
  ground.material = ground.userData.pre; ground.visible = true;
  camera.layers.set(0);
  renderer.setRenderTarget(rtPre);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, camera);
  const fx = fxPost.run({ color: rtColor, pre: rtPre, camera, exposure: CU.uExposure.value, threshold: LOOK.bloomThreshold, aoRadius: LOOK.aoRadius, pixA: CU.uPixA.value });
  CU.tBloom.value = fx.bloom; CU.tAO.value = fx.ao; CU.tDof.value = fx.dof;
  renderer.setRenderTarget(rtFinal);
  renderer.clear();
  renderer.render(compScene, compCam);
  renderer.setRenderTarget(null);
  renderer.clear();
  renderer.render(fxaaScene, compCam);
  if (envMat.opacity > 0.01) renderer.render(overlay, camera);
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
  ScrollTrigger.create({ trigger: track, start: 'top top', end: 'bottom bottom', onUpdate: (st) => { target = st.progress; } });
} else addEventListener('scroll', () => { target = scrollY / Math.max(1, track.offsetHeight - innerHeight); });

// ---------- selection: every element by its IFCX path; Edit writes 99z, Flag writes a BCF topic ----------
let selected = null;
const ray = new THREE.Raycaster();
const panel = $('panel');
function pick(ndc) {
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(M.meshes, false).filter((h) => !U.uCut || h.point.z <= Math.min(U.uCut.value, 99));
  return hits[0]?.object || null;
}
function select(mesh) {
  selected = mesh ? { mesh } : null;
  panel.hidden = !mesh;
  if (!mesh) return;
  const e = mesh.userData.e;
  $('pnName').textContent = e.name || e.cls;
  const rows = [['Class', e.cls], ['Path', e.id || '— (proxy, not in the model)'], ['GUID', e.guid || '—'], ['Layer', e.layer || '—'], ['Material', e.material || '—'], ['Edited', e.edited ? 'yes (99z)' : 'no']];
  $('pnMeta').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${String(v).replace(/[<>&]/g, '')}</dd>`).join('');
  const c = e.color || [0.8, 0.8, 0.8];
  $('pnColor').value = '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  $('pnMat').value = e.material || '';
  $('pnStatus').textContent = e.id ? '' : 'Proxy furniture has no IFCX path; edits apply to model elements.';
  for (const f of ['pnEdit', 'pnFlag']) $(f).querySelectorAll('button,input').forEach((x) => { x.disabled = !e.id; });
}
canvas.addEventListener('click', (ev) => {
  if (mode === 'walk' || STORY) return;
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
  try { const r = await post('/api/edit', { path: e.id, color, material: $('pnMat').value || undefined }); $('pnStatus').textContent = `Saved in ${r.layer}. Rebuilding…`; pendingSel = e.id; }
  catch (err) { $('pnStatus').textContent = `Not saved: ${err.message}`; }
});
$('pnFlag').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const e = selected?.mesh.userData.e; if (!e?.id) return;
  render();
  const png = canvas.toDataURL('image/png');
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  // BCF camera in the model frame (undo the house rotation)
  const back = (v) => { const x = v.x * Math.cos(AXIS * DEG) - v.y * Math.sin(AXIS * DEG), y = v.x * Math.sin(AXIS * DEG) + v.y * Math.cos(AXIS * DEG); return [x, y, v.z]; };
  try {
    const r = await post('/api/flag', { path: e.id, title: $('pnTitle').value || undefined, description: `Flagged in the presentation at scroll ${(prog * 100).toFixed(1)} %`, camera: { position: back(camera.position), direction: back(dir), up: [0, 0, 1], fov: camera.fov, aspect: camera.aspect }, png });
    $('pnStatus').textContent = `BCF topic ${r.guid.slice(0, 8)} written for the model build.`;
  } catch (err) { $('pnStatus').textContent = `Not flagged: ${err.message}`; }
});
let pendingSel = null;

// ---------- free walk (WASD, mouse look, 1.6 m eye, no collision) ----------
const walkHud = $('walkhud');
const keys = new Set();
const walk = { pos: new THREE.Vector3(), yaw: 90, pitch: 0, floor: 0, fov: 90 };
function enterWalk() {
  mode = 'walk';
  document.body.classList.add('walking');
  walkHud.hidden = false; hud.style.opacity = '0'; chapter.style.opacity = '0'; hero.style.opacity = '0'; caption.style.opacity = '0'; walkTag.style.opacity = '0';
  phaseChip.textContent = 'Free walk · proposed';
  roll.classList.remove('outro'); roll.style.transition = 'none'; roll.style.width = '0';
  const st = M.stops[0];
  walk.floor = M.FFL;
  walk.pos.set(st.stand[0], st.stand[1], walk.floor + EYE);
  walk.yaw = Math.atan2(st.look[1] - st.stand[1], st.look[0] - st.stand[0]) / DEG; walk.pitch = 0;
  U.uAll.value = 1; U.uCut.value = 99; U.uPhaseCut.value.fill(99);
  CU.uAnnOp.value = 0; CU.uRedOp.value = 0; CU.uLblOp.value = 0; CU.uSplat.value = splat ? 1 : 0; envMat.opacity = 0;
  if (interior) interior.visible = false;
  lenis?.stop();
  if (!REC) { try { const r = canvas.requestPointerLock?.(); r?.catch?.(() => {}); } catch { /* drag-to-look still works */ } }
}
function leaveWalk() {
  mode = 'scroll'; document.body.classList.remove('walking'); walkHud.hidden = true; lenis?.start();
  if (document.pointerLockElement) document.exitPointerLock();
}
walkPill.addEventListener('click', enterWalk);
addEventListener('keydown', (e) => {
  if (mode !== 'walk') return;
  if (e.key === 'Escape') return leaveWalk();
  if (e.key === '1') walk.floor = M.FFL;
  if (e.key === '2' && M.storeys.upper) walk.floor = M.storeys.upper.elevation;
  if (e.key === '0' && M.storeys.base) walk.floor = M.storeys.base.elevation;
  if (e.key.toLowerCase() === 'e') select(pick(new THREE.Vector2(0, 0)));
  if (e.key === '[') walk.fov = Math.max(60, walk.fov - 5);
  if (e.key === ']') walk.fov = Math.min(110, walk.fov + 5);
  keys.add(e.key.toLowerCase());
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
let dragging = null;
canvas.addEventListener('mousemove', (e) => {
  if (mode !== 'walk') return;
  const dx = document.pointerLockElement ? e.movementX : dragging ? e.clientX - dragging[0] : 0;
  const dy = document.pointerLockElement ? e.movementY : dragging ? e.clientY - dragging[1] : 0;
  if (dragging) dragging = [e.clientX, e.clientY];
  walk.yaw -= dx * 0.15; walk.pitch = Math.max(-70, Math.min(70, walk.pitch + dy * 0.15));
});
canvas.addEventListener('mousedown', (e) => { if (mode === 'walk' && !document.pointerLockElement) dragging = [e.clientX, e.clientY]; });
addEventListener('mouseup', () => { dragging = null; });
const roomUnder = (x, y, z) => M.spaces.find((r) => Math.abs(r.floorZ - z) < 1.2 && (() => { let c2 = false; const poly = r.poly; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c2 = !c2; } return c2; })());
// free walk physics: floor following (step-up 0.45 m, so stair treads carry you up), a ramp fallback inside the stair
// rooms (you always reach the top), and walls that block with sliding
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
function stairRamp(x, y) { // inside a stair room: the floor rises with the run from the lower to the upper level
  const up = M.storeys.upper?.elevation;
  if (up == null) return null;
  for (const r of M.spaces) {
    if (!/stair/i.test(r.name) || /basement/i.test(r.name) || !pointIn([x, y], r.poly)) continue;
    const [u0, v0, u1, v1] = r.bbox, alongV = v1 - v0 >= u1 - u0;
    const t = alongV ? (y - v0) / (v1 - v0) : (x - u0) / (u1 - u0);
    return { lo: M.FFL, hi: up, t: Math.min(1, Math.max(0, t)) };
  }
  return null;
}
function blocked(x0, y0, x1, y1, z) {
  const d = new THREE.Vector3(x1 - x0, y1 - y0, 0); const L = d.length();
  if (L < 1e-5) return false;
  d.normalize();
  for (const hz of [z - 0.9, z - 0.2]) {
    sideRay.set(new THREE.Vector3(x0, y0, hz), d); sideRay.far = L + RADIUS;
    if (sideRay.intersectObjects(blockers(), false).length) return true;
  }
  return false;
}
// stairs: stepping into a stair room glides you to the other floor (the owner: "force the upstairs")
function glideTarget(x, y, floorZ) {
  const inRoom = (name) => { const r = M.spaces.find((q) => q.name === name); return r && pointIn([x, y], r.poly) ? r : null; };
  const stopBy = (k) => M.stops.find((s) => s.key === k);
  const up = stopBy('Upper - Stairs+Upper - Hallway'), entry = stopBy('AptA - Entry'), base = stopBy('basement');
  const onMain = Math.abs(floorZ - M.FFL) < 1, onUpper = M.storeys.upper && Math.abs(floorZ - M.storeys.upper.elevation) < 1.2;
  const onBase = M.storeys.base && Math.abs(floorZ - M.storeys.base.elevation) < 1;
  const well = ['AptA - Stairs up', 'Upper - Stairs'].map((n) => M.spaces.find((q) => q.name === n)).filter(Boolean);
  const mid = well.length ? [well.reduce((s, r) => s + r.cu, 0) / well.length, well.reduce((s, r) => s + r.cv, 0) / well.length] : [x, y];
  const hall = M.spaces.find((q) => q.name === 'Upper - Hallway');
  if (onMain && inRoom('AptA - Stairs up') && up) return { to: hall ? [hall.cu, hall.cv, hall.floorZ] : [up.stand[0], up.stand[1], up.floorZ], mid: [mid[0], mid[1], (M.FFL + up.floorZ) / 2] };
  if (onUpper && inRoom('Upper - Stairs') && entry) return { to: [entry.stand[0], entry.stand[1], M.FFL], mid: [mid[0], mid[1], (M.FFL + M.storeys.upper.elevation) / 2] };
  if (onMain && inRoom('AptA - Stairs to basement') && base) return { to: [base.stand[0], base.stand[1], base.floorZ], mid: [x, y, (M.FFL + base.floorZ) / 2] };
  if (onBase && entry) { const r = M.spaces.find((q) => q.name === 'AptA - Stairs to basement'); if (r && pointIn([x, y], r.poly)) return { to: [entry.stand[0], entry.stand[1], M.FFL], mid: [x, y, (M.FFL + floorZ) / 2] }; }
  return null;
}
function stepWalk(dt) {
  if (walk.glide) { // a guided run up or down the stair
    const g = walk.glide; g.t = Math.min(1, g.t + dt / g.dur);
    const k = ease(g.t), a = g.from, m = g.mid, b = g.to;
    const q = (i) => (1 - k) * (1 - k) * a[i] + 2 * (1 - k) * k * m[i] + k * k * b[i];
    const nx = q(0), ny = q(1);
    if (Math.hypot(nx - walk.pos.x, ny - walk.pos.y) > 1e-4) walk.yaw = lerp(walk.yaw, Math.atan2(ny - walk.pos.y, nx - walk.pos.x) / DEG, 0.08);
    walk.pos.x = nx; walk.pos.y = ny; walk.floor = q(2); walk.pos.z = walk.floor + EYE;
    if (g.t >= 1) { walk.glide = null; walk.glideLock = true; }
  }
  const sp = (walk.glide ? 0 : keys.has('shift') ? 3 : 1.4) * dt;
  const f = [Math.cos(walk.yaw * DEG), Math.sin(walk.yaw * DEG)], r = [Math.sin(walk.yaw * DEG), -Math.cos(walk.yaw * DEG)];
  let mx = 0, my = 0;
  if (keys.has('w') || keys.has('arrowup')) { mx += f[0]; my += f[1]; }
  if (keys.has('s') || keys.has('arrowdown')) { mx -= f[0]; my -= f[1]; }
  if (keys.has('d') || keys.has('arrowright')) { mx += r[0]; my += r[1]; }
  if (keys.has('a') || keys.has('arrowleft')) { mx -= r[0]; my -= r[1]; }
  const ml = Math.hypot(mx, my);
  if (ml > 0) {
    mx = (mx / ml) * sp; my = (my / ml) * sp;
    const x0 = walk.pos.x, y0 = walk.pos.y, z = walk.pos.z;
    if (!walk.ghost && blocked(x0, y0, x0 + mx, y0 + my, z)) { // slide along the wall
      if (!blocked(x0, y0, x0 + mx, y0, z)) my = 0; else if (!blocked(x0, y0, x0, y0 + my, z)) mx = 0; else mx = my = 0;
    }
    walk.pos.x += mx; walk.pos.y += my;
  }
  if (walk.glideLock && !glideTarget(walk.pos.x, walk.pos.y, walk.floor)) walk.glideLock = false; // re-arm once off the stair
  if (!walk.glide && !walk.glideLock && ml > 0) { const gt = glideTarget(walk.pos.x, walk.pos.y, walk.floor); if (gt) walk.glide = { from: [walk.pos.x, walk.pos.y, walk.floor], mid: gt.mid, to: gt.to, t: 0, dur: 3.2 }; }
  // floor under the feet: stair ramp if in a stair room, else the highest walkable surface within the step-up
  const ramp = walk.glide ? null : stairRamp(walk.pos.x, walk.pos.y);
  const hit = walk.glide ? null : floorBelow(walk.pos.x, walk.pos.y, walk.floor);
  if (ramp && (hit == null || Math.abs(hit - walk.floor) > STEP_UP)) walk.floor = lerp(ramp.lo, ramp.hi, ramp.t);
  else if (hit != null) walk.floor = hit;
  if (!walk.glide) walk.pos.z = lerp(walk.pos.z, walk.floor + EYE, Math.min(1, dt * 8));
  const dir = new THREE.Vector3(Math.cos(walk.pitch * DEG) * Math.cos(walk.yaw * DEG), Math.cos(walk.pitch * DEG) * Math.sin(walk.yaw * DEG), -Math.sin(walk.pitch * DEG));
  camera.position.copy(walk.pos); camera.fov = walk.fov; camera.near = 0.03; camera.far = 600; camera.updateProjectionMatrix();
  camera.lookAt(walk.pos.clone().add(dir));
  CU.uPixA.value = 2 * Math.tan((walk.fov / 2) * DEG) / H();
  const r0 = roomUnder(walk.pos.x, walk.pos.y, walk.floor);
  if (splat) splat.visible = !cameraIndoors();
  $('walkWhere').textContent = r0 ? `${r0.label.toUpperCase()} · ${r0.area.toFixed(1)} M² · ${r0.apt.toUpperCase()}` : walk.floor < M.FFL - 1 ? 'BASEMENT' : 'OUTSIDE';
}

// ---------- live model: server-sent build events rebuild in place, keeping the scroll ----------
function rebuild(data, build) {
  M.build = build;
  buildModel(data);
  applyModelUniforms();
  buildTimeline();
  buildRuler();
  if (pendingSel) { const m = M.meshes.find((x) => x.userData.e.id === pendingSel); select(m || null); if (m) $('pnStatus').textContent = `Saved and rebuilt: build ${build.id}.`; pendingSel = null; }
  else if (selected) select(M.meshes.find((x) => x.userData.e.id === selected.mesh.userData.e.id) || null);
}
const toast = $('toast');
function say(t) { toast.textContent = t; toast.classList.add('on'); clearTimeout(say.t); say.t = setTimeout(() => toast.classList.remove('on'), 4200); }
const builds = [];
if (window.EventSource && !Q.has('nolive') && !STATIC) { // the static (published) copy has no rebuild channel
  const es = new EventSource('/events');
  es.addEventListener('build', async (ev) => {
    const b = JSON.parse(ev.data);
    if (b.id === M.build?.id) return;
    try {
      const [data, build] = await Promise.all([getJSON(`model.json?b=${b.id}`), getJSON('build.json')]);
      rebuild(data, build);
      builds.push({ id: build.id, at: build.at, edited: data.edited?.length || 0 });
      say(`Model updated · build ${build.id} · ${build.reason || ''}`);
    } catch (err) { console.error('live rebuild failed', err); }
  });
  es.addEventListener('build-error', (ev) => say(`Model build failed: ${JSON.parse(ev.data).message.slice(0, 120)}`));
}

// ---------- start ----------
await loadModels();
rebuild(data0, build0);
if (Q.has('at')) target = prog = Number(Q.get('at'));
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (mode === 'walk') { if (!REC) stepWalk(dt); } // in recording the hooks drive the walk deterministically
  else {
    prog += (target - prog) * (REC ? 1 : 1 - Math.exp(-dt * 2.0)); // camera catches up with a ~0.5 s time constant
    if (Math.abs(target - prog) < 1e-5) prog = target;
    update(prog);
  }
  render();
  requestAnimationFrame(frame);
}
await Promise.race([splatReady, new Promise((r) => setTimeout(r, 45000))]);
update(prog); render();
await new Promise((r) => setTimeout(r, Math.max(0, 3200 - (performance.now() - loadStart))));
loader.classList.add('done');
// paper roll: the sheet unrolls from the right after the loader (time-based, like the reference intro)
roll.style.width = '62vw';
if (!REC) requestAnimationFrame(() => { roll.style.transition = 'width 2.4s cubic-bezier(.7,0,.2,1)'; roll.style.width = '0vw'; });
else roll.style.width = '0vw';
requestAnimationFrame(frame);

// deterministic hooks for recording and checks
window.__P401 = {
  scene: () => scene,
  // debug: what object is drawn at a screen point (ndc), for checking frames
  probe: (x, y) => { const rc = new THREE.Raycaster(); rc.layers.enableAll(); rc.setFromCamera(new THREE.Vector2(x, y), camera); return rc.intersectObjects(scene.children, true).slice(0, 4).map((h) => ({ d: +h.distance.toFixed(2), name: h.object.name, type: h.object.type, ud: JSON.stringify(h.object.userData?.e?.name || h.object.userData?.label || {}).slice(0, 90), p: h.point.toArray().map((v) => +v.toFixed(2)), n: h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld).toArray().map((v) => +v.toFixed(2)) : null, front: h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld).dot(rc.ray.direction) < 0 : null })); },
  ready: true,
  axisDeg: AXIS, get ffl() { return M.FFL; }, get build() { return M.build; }, builds,
  get stops() { return dossiers.map((d) => ({ key: d.st.key, n: d.n, via: !!d.via, h0: +d.shot.h0.toFixed(1), h1: +d.shot.h1.toFixed(1), p: +((d.shot.h0 + d.shot.h1) / 2 / TOTAL).toFixed(4), rooms: d.st.rooms.map((r) => r.name) })); },
  get shots() { return shots.map((q) => ({ id: q.id, h0: +q.h0.toFixed(1), h1: +q.h1.toFixed(1), g1: +q.g1.toFixed(1), p0: +(q.h0 / TOTAL).toFixed(4) })); },
  get totalVh() { return TOTAL; },
  get rooms() { return M.spaces.map((r) => ({ n: r.n, name: r.name, w: +r.w.toFixed(2), d: +r.d.toFixed(2), area: +r.area.toFixed(2), bbox: r.bbox.map((v) => +v.toFixed(2)), poly: r.poly.map((q) => q.map((v) => +v.toFixed(2))), floorZ: r.floorZ, height: r.height })); },
  get furniture() { return M.furn?.children.length || 0; },
  models: () => ({ loaded: modelCache.size, wanted: new Set([...Object.values(KIND_MODEL), ...Object.values(KIND_DECOR).flat().map((d) => d[0])]).size }),
  debugStops: () => M.stops.map((s) => ({ key: s.key, stand: s.stand.map((v) => +v.toFixed(2)), look: s.look.map((v) => +v.toFixed(2)), z: +s.floorZ.toFixed(2), bbox: s.rooms.map((r) => r.bbox.map((v) => +v.toFixed(2))) })),
  splat: () => ({ exterior: splat?.packedSplats?.numSplats ?? 0, interior: interior?.packedSplats?.numSplats ?? 0 }),
  setProgress(p) { if (mode === 'walk') leaveWalk(); target = prog = p; update(p); render(); },
  pose(o) { debugPose = o || null; update(prog); render(); },
  layers(o) { Object.assign(compareState, o); update(prog); render(); return { ...compareState, captures: captures.length }; },
  // where the ray through a screen pixel meets the plane u = value or v = value (house frame), for measuring a capture
  wallPoint(x, y, axis, value) {
    const r = new THREE.Raycaster(); r.setFromCamera(new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1), camera);
    const i = axis === 'u' ? 0 : 1, t = (value - r.ray.origin.getComponent(i)) / r.ray.direction.getComponent(i);
    return r.ray.origin.clone().addScaledVector(r.ray.direction, t).toArray().map((v) => +v.toFixed(3));
  },
  roll(w) { roll.style.transition = 'none'; roll.style.width = w; },
  walk(x, y, yaw, floorKey = 'main', pitch = 0) {
    if (mode !== 'walk') enterWalk();
    walk.floor = floorKey === 'upper' ? M.storeys.upper.elevation : floorKey === 'base' ? M.storeys.base.elevation : M.FFL;
    walk.pos.set(x, y, walk.floor + EYE); walk.yaw = yaw; walk.pitch = pitch; stepWalk(0); render();
  },
  selectByName(name) { const m = M.meshes.find((x) => x.userData.e.name === name); select(m || null); return m?.userData.e.id; },
  edit: (path, color) => post('/api/edit', { path, color }),
  leaveWalk,
  walkTick: (dt, held = []) => { keys.clear(); for (const k of held) keys.add(k); stepWalk(dt); render(); return { x: walk.pos.x, y: walk.pos.y, floor: walk.floor }; },
  walkState: () => ({ x: +walk.pos.x.toFixed(2), y: +walk.pos.y.toFixed(2), z: +walk.pos.z.toFixed(2), floor: +walk.floor.toFixed(2), yaw: +walk.yaw.toFixed(1) }),
  stairInfo: () => M.spaces.filter((r) => /stair/i.test(r.name)).map((r) => ({ name: r.name, bbox: r.bbox.map((v) => +v.toFixed(2)), floorZ: r.floorZ })),
};

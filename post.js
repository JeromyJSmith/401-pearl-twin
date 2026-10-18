// Post passes for the presentation's look-dev (original code): bloom from the colour pass, screen-space ambient
// occlusion from the pre-pass (world position + normals), and a half-resolution blurred copy of the colour pass that
// the composite mixes in by depth for depth of field. Strengths are set from the choreography spec.
import * as THREE from 'three';

const QUAD_VS = 'in vec3 position; out vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }';

const BRIGHT_FS = /* glsl */`
precision highp float;
uniform sampler2D tSrc; uniform float uThreshold, uKnee, uExposure;
in vec2 vUv; out vec4 o;
void main() {
  vec3 c = fin(texture(tSrc, vUv)).rgb * uExposure;
  float l = max(c.r, max(c.g, c.b));
  float k = clamp((l - uThreshold + uKnee) / (2.0 * uKnee), 0.0, 1.0);
  float w = max(l - uThreshold, 0.0) + k * k * uKnee;
  o = vec4(c * (w / max(l, 1e-4)), 1.0);
}`;

const BLUR_FS = /* glsl */`
precision highp float;
uniform sampler2D tSrc; uniform vec2 uDir; uniform vec2 uTexel;
in vec2 vUv; out vec4 o;
void main() {
  // 9-tap gaussian along uDir
  vec4 s = fin(texture(tSrc, vUv)) * 0.227027;
  vec2 d = uDir * uTexel;
  s += (fin(texture(tSrc, vUv + d * 1.3846)) + fin(texture(tSrc, vUv - d * 1.3846))) * 0.3162162;
  s += (fin(texture(tSrc, vUv + d * 3.2308)) + fin(texture(tSrc, vUv - d * 3.2308))) * 0.0702703;
  o = s;
}`;

const ADD_FS = /* glsl */`
precision highp float;
uniform sampler2D t1, t2, t3; in vec2 vUv; out vec4 o;
void main() { o = fin(texture(t1, vUv)) * 0.5 + fin(texture(t2, vUv)) * 0.32 + fin(texture(t3, vUv)) * 0.18; }`;

// ambient occlusion: sample a disc in screen space scaled by depth, count samples above the surface plane
const AO_FS = /* glsl */`
precision highp float;
uniform sampler2D tND, tW; uniform mat3 uViewToWorld; uniform vec2 uRes; uniform float uRadius, uPixA, uBias;
in vec2 vUv; out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec4 w = texture(tW, vUv);
  if (w.w <= 0.0) { o = vec4(1.0); return; }
  float state = floor(texture(tND, vUv).a * 8.0 + 0.5);
  vec3 n = normalize(uViewToWorld * (texture(tND, vUv).xyz * 2.0 - 1.0));
  float rpx = uRadius / max(w.w * uPixA, 1e-4);      // world radius in pixels at this depth
  rpx = clamp(rpx, 2.0, 80.0);
  float a0 = hash(gl_FragCoord.xy) * 6.2831;
  float occ = 0.0, tot = 0.0;
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float r = rpx * sqrt((fi + 0.5) / 12.0);
    float a = a0 + fi * 2.39996;
    vec2 uv = vUv + vec2(cos(a), sin(a)) * r / uRes;
    vec4 ws = texture(tW, uv);
    if (ws.w <= 0.0) continue;
    vec3 d = ws.xyz - w.xyz;
    float L = length(d);
    float h = dot(d, n) / max(L, 1e-4);
    float fall = 1.0 - smoothstep(uRadius * 0.6, uRadius * 1.6, L);
    occ += max(h - uBias, 0.0) * fall;
    tot += 1.0;
  }
  float ao = 1.0 - (tot > 0.0 ? occ / tot : 0.0) * 1.6;
  o = vec4(vec3(clamp(ao, 0.0, 1.0)), 1.0);
}`;

function quad(fs, uniforms) {
  return new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: QUAD_VS, fragmentShader: `precision highp float;\nvec4 fin(vec4 v) { bvec4 n = notEqual(v, v); return clamp(vec4(n.x ? 0.0 : v.x, n.y ? 0.0 : v.y, n.z ? 0.0 : v.z, n.w ? 0.0 : v.w), -1.0e4, 64.0); }\n${fs.replace('precision highp float;', '')}`,
    uniforms, depthTest: false, depthWrite: false,
  }));
}

export class Post {
  constructor(renderer) {
    this.r = renderer;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene = new THREE.Scene();
    const rt = () => new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.b = [rt(), rt(), rt(), rt(), rt(), rt()]; // bloom chain: 3 levels x ping/pong
    this.bloom = rt();
    this.ao = [rt(), rt()];
    this.dof = [rt(), rt()];
    this.bright = quad(BRIGHT_FS, { tSrc: { value: null }, uThreshold: { value: 1.0 }, uKnee: { value: 0.5 }, uExposure: { value: 1.25 } });
    this.blur = quad(BLUR_FS, { tSrc: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uTexel: { value: new THREE.Vector2() } });
    this.add = quad(ADD_FS, { t1: { value: null }, t2: { value: null }, t3: { value: null } });
    this.aoq = quad(AO_FS, { tND: { value: null }, tW: { value: null }, uViewToWorld: { value: new THREE.Matrix3() }, uRes: { value: new THREE.Vector2() }, uRadius: { value: 0.5 }, uPixA: { value: 0.001 }, uBias: { value: 0.08 } });
    this.copy = quad('uniform sampler2D tSrc; in vec2 vUv; out vec4 o; void main(){ o = fin(texture(tSrc, vUv)); }', { tSrc: { value: null } });
  }
  setSize(w, h) {
    this.w = w; this.h = h;
    const lv = [2, 4, 8];
    for (let i = 0; i < 3; i++) { this.b[i * 2].setSize(Math.max(1, w / lv[i]) | 0, Math.max(1, h / lv[i]) | 0); this.b[i * 2 + 1].setSize(Math.max(1, w / lv[i]) | 0, Math.max(1, h / lv[i]) | 0); }
    this.bloom.setSize(w / 2 | 0, h / 2 | 0);
    for (const t of this.ao) t.setSize(w / 2 | 0, h / 2 | 0);
    for (const t of this.dof) t.setSize(w / 2 | 0, h / 2 | 0);
  }
  pass(mesh, target) { this.scene.children.length = 0; this.scene.add(mesh); this.r.setRenderTarget(target); this.r.render(this.scene, this.cam); }
  blurInto(src, ping, pong, radius = 1) {
    const u = this.blur.material.uniforms;
    u.uTexel.value.set(radius / ping.width, radius / ping.height);
    u.tSrc.value = src.texture ?? src; u.uDir.value.set(1, 0); this.pass(this.blur, ping);
    u.tSrc.value = ping.texture; u.uDir.value.set(0, 1); this.pass(this.blur, pong);
  }
  run({ color, pre, camera, threshold = 1.0, exposure = 1.25, aoRadius = 0.5, pixA = 0.001, wantBloom = true, wantAO = true, wantDof = true }) {
    const r = this.r, prevAuto = r.autoClear; r.autoClear = true;
    if (wantBloom) {
      Object.assign(this.bright.material.uniforms, {});
      this.bright.material.uniforms.tSrc.value = color.texture; this.bright.material.uniforms.uThreshold.value = threshold; this.bright.material.uniforms.uExposure.value = exposure;
      this.pass(this.bright, this.b[0]);
      this.blurInto(this.b[0], this.b[1], this.b[0], 1.5);
      this.copy.material.uniforms.tSrc.value = this.b[0].texture; this.pass(this.copy, this.b[2]);
      this.blurInto(this.b[2], this.b[3], this.b[2], 1.5);
      this.copy.material.uniforms.tSrc.value = this.b[2].texture; this.pass(this.copy, this.b[4]);
      this.blurInto(this.b[4], this.b[5], this.b[4], 1.5);
      Object.assign(this.add.material.uniforms, { t1: { value: this.b[0].texture }, t2: { value: this.b[2].texture }, t3: { value: this.b[4].texture } });
      this.pass(this.add, this.bloom);
    }
    if (wantAO) {
      const u = this.aoq.material.uniforms;
      u.tND.value = pre.textures[0]; u.tW.value = pre.textures[1];
      u.uViewToWorld.value.setFromMatrix4(camera.matrixWorld);
      u.uRes.value.set(this.ao[0].width, this.ao[0].height); u.uRadius.value = aoRadius; u.uPixA.value = pixA * (this.w / this.ao[0].width);
      this.pass(this.aoq, this.ao[0]);
      this.blurInto(this.ao[0], this.ao[1], this.ao[0], 1);
    }
    if (wantDof) {
      this.copy.material.uniforms.tSrc.value = color.texture; this.pass(this.copy, this.dof[0]);
      this.blurInto(this.dof[0], this.dof[1], this.dof[0], 2.2);
    }
    r.autoClear = prevAuto;
    return { bloom: this.bloom.texture, ao: this.ao[0].texture, dof: this.dof[0].texture };
  }
}

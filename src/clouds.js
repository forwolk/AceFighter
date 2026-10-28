import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Ray-marched volumetric cloud layer (Nubis / Horizon Zero Dawn lineage):
//  - density = Perlin-Worley base shape, remapped by a weather map (coverage, type) and a height
//    gradient, eroded at the edges by high-frequency Worley detail;
//  - lighting = Beer-Lambert transmittance toward the sun (6 cone samples) with the "powder" term
//    for darker edges, a two-lobe Henyey-Greenstein phase, and a height-graded ambient;
//  - rendered at half resolution against the scene depth, then composited over the scene.
// World convention matches main.js: the sea/terrain stream toward +z, so a world-fixed cloud sample
// uses (x, y, dist - z).

const MARCH = /* glsl */`
  precision highp float; precision highp sampler3D;
  uniform sampler2D tDepth, uWeather;
  uniform sampler3D uBase, uDetail;
  uniform mat4 uInvProj, uCamWorld;
  uniform vec3 uCamPos, uSunDir, uSunCol, uAmbTop, uAmbBot, uFogCol;
  uniform vec2 uRes;
  uniform float uNear, uFar, uDist, uTime, uBottom, uTop, uCoverage, uDensity, uFogNear, uFogFar, uWeatherScale, uBaseScale, uDetailScale, uSigma, uPowder, uDetailStr, uAmbMul, uBaseContrast, uCovSoft, uTopRound, uHJitter;
  uniform vec3 uHg;
  varying vec2 vUv;

  const float PI = 3.14159265;
  float remap(float v, float lo, float hi, float nlo, float nhi) { return nlo + (v - lo) / (hi - lo) * (nhi - nlo); }
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }
  float heightFrac(float y) { return clamp((y - uBottom) / (uTop - uBottom), 0.0, 1.0); }
  float heightFracJ(float y, float jitter) { float b = uBottom + jitter; return clamp((y - b) / (uTop - uBottom), 0.0, 1.0); }   // whole column shifts: bases and tops both break up

  // p is world-fixed (already shifted by uDist)
  float density(vec3 p, float hf, bool cheap) {
    vec3 w = texture(uWeather, p.xz / uWeatherScale + vec2(0.5)).rgb;
    float wj = texture(uWeather, p.xz / (uWeatherScale * 0.61) + vec2(0.17, 0.43)).g;   // decorrelated from coverage: tops vary cell to cell
    hf = heightFracJ(p.y, (wj - 0.5) * uHJitter * (uTop - uBottom));
    // weather red channel is a 0..1 noise. A *soft* band (uCovSoft wide) turns it into a gradual
    // coverage field, so the cloud silhouette is decided by the 3D noise threshold below, not by the
    // weather map (a steep band here produces flat-topped plateaus the shape of the weather blobs).
    float c0 = 1.0 - uCoverage * 1.1;
    float coverage = smoothstep(c0 - uCovSoft, c0 + uCovSoft, w.r);
    float type = w.g;
    // height gradient: hard flat base, rounded top (uTopRound), taller for cumulus type
    float topF = mix(0.35, 0.95, type);
    float g = remap(hf, 0.0, 0.07, 0.0, 1.0) * pow(clamp(remap(hf, topF * 0.45, topF, 1.0, 0.0), 0.0, 1.0), uTopRound);
    vec4 n = texture(uBase, p * uBaseScale + vec3(uTime * 0.004, 0.0, uTime * 0.002));
    // boost the Perlin-Worley contrast so the noise actually carves the shape
    float pw = clamp((n.r - 0.5) * uBaseContrast + 0.5, 0.0, 1.0);
    float fbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
    float base = clamp(remap(pw, fbm - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0) * g;
    base = clamp(remap(base, 1.0 - coverage, 1.0, 0.0, 1.0), 0.0, 1.0) * coverage;
    if (cheap || base <= 0.001) return base;
    vec3 d = texture(uDetail, p * uDetailScale + vec3(uTime * 0.01, -uTime * 0.006, 0.0)).rgb;
    float dfbm = d.r * 0.625 + d.g * 0.25 + d.b * 0.125;
    float dmod = mix(dfbm, 1.0 - dfbm, clamp(hf * 8.0, 0.0, 1.0));   // wispy bases, billowy tops
    base = clamp(remap(base, dmod * uDetailStr, 1.0, 0.0, 1.0), 0.0, 1.0);
    return base;
  }

  // optical depth toward the sun: 6 samples in a widening cone
  float sunDepth(vec3 p) {
    float od = 0.0;
    float step = (uTop - uBottom) * 0.18;
    vec3 offs[6];
    offs[0] = vec3( 0.2, 0.1,-0.1); offs[1] = vec3(-0.3, 0.2, 0.2); offs[2] = vec3( 0.1,-0.2, 0.3);
    offs[3] = vec3(-0.2,-0.1,-0.3); offs[4] = vec3( 0.3, 0.3, 0.1); offs[5] = vec3( 0.0, 0.0, 0.0);
    for (int i = 0; i < 6; i++) {
      float fi = float(i) + 1.0;
      vec3 q = p + uSunDir * step * fi + offs[i] * step * fi * 0.35;
      if (q.y > uTop || q.y < uBottom) break;
      od += density(q, heightFrac(q.y), i > 3) * step;
    }
    return od;
  }

  float upDepth(vec3 p) {
    float od = 0.0, step = (uTop - p.y) * 0.3;
    if (step <= 1.0) return 0.0;
    for (int i = 1; i <= 3; i++) { vec3 q = p + vec3(0.0, step * float(i), 0.0); od += density(q, heightFrac(q.y), true) * step; }
    return od;
  }

  void main() {
    // reconstruct the view ray
    vec2 ndc = vUv * 2.0 - 1.0;
    vec4 v = uInvProj * vec4(ndc, 1.0, 1.0); v /= v.w;
    vec3 dv = normalize(v.xyz);
    vec3 rd = normalize((uCamWorld * vec4(dv, 0.0)).xyz);
    vec3 ro = uCamPos;
    // scene distance along the ray from the depth buffer
    float z = texture(tDepth, vUv).x;
    float viewZ = (uNear * uFar) / ((uFar - uNear) * z - uFar);
    float sceneDist = z >= 0.9999 ? 1e9 : viewZ / dv.z;

    // slab intersection
    float t0, t1;
    // march the slab plus the jitter margin, so shifted columns can poke above uTop / hang below uBottom
    float hJ = 0.5 * uHJitter * (uTop - uBottom);
    float slabB = uBottom - hJ, slabT = uTop + hJ;
    if (abs(rd.y) < 1e-4) { if (ro.y < slabB || ro.y > slabT) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; } t0 = 0.0; t1 = 6000.0; }
    else {
      float ta = (slabB - ro.y) / rd.y, tb = (slabT - ro.y) / rd.y;
      t0 = max(min(ta, tb), 0.0); t1 = max(ta, tb);
    }
    t1 = min(t1, sceneDist);
    t1 = min(t1, t0 + 7000.0);
    if (t1 <= t0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

    const int STEPS = 56;
    float len = t1 - t0;
    float step = len / float(STEPS);
    float jitter = hash12(gl_FragCoord.xy + fract(uTime) * 17.0);
    float t = t0 + step * jitter;
    float trans = 1.0;
    vec3 col = vec3(0.0);
    float cosA = dot(rd, uSunDir);
    float phase = mix(hg(cosA, uHg.x), hg(cosA, uHg.y), uHg.z) * 4.0 * PI;   // normalised so phase≈1 is isotropic
    float sigma = uSigma * uDensity;
    int zeroRun = 0;
    for (int i = 0; i < STEPS; i++) {
      if (trans < 0.02 || t > t1) break;
      vec3 p = ro + rd * t;
      vec3 q = vec3(p.x, p.y, uDist - p.z);
      float hf = heightFrac(p.y);
      float dens = density(q, hf, true);          // cheap base shape first
      if (dens > 0.001) dens = density(q, hf, false); // full detail only inside clouds
      if (dens > 0.001) {
        zeroRun = 0;
        float od = sunDepth(q) * sigma;
        float beer = exp(-od);
        float powder = 1.0 - exp(-od * 2.0 - dens * step * sigma * 2.0);
        float sun = beer * mix(1.0, powder, uPowder) * phase;
        // cloud bases under a daytime sky are light grey, not black: keep the ambient floor high
        float skyOcc = exp(-upDepth(q) * sigma * 0.6);          // thin spots glow, thick bases darken
        vec3 amb = mix(uAmbBot, uAmbTop, hf) * mix(0.6, 1.0, skyOcc) * uAmbMul;
        vec3 lit = uSunCol * sun + amb;
        // aerial perspective on the clouds themselves; distant cloud also fades out so the slab's flat
        // base does not read as hard horizontal strips along the horizon
        lit = mix(lit, uFogCol, smoothstep(uFogNear, uFogFar, t) * 0.85);
        dens *= 1.0 - smoothstep(uFogNear * 1.2, uFogFar, t) * 0.8;
        float a = 1.0 - exp(-dens * step * sigma);
        col += trans * a * lit;
        trans *= 1.0 - a;
      } else {
        zeroRun++;
      }
      t += step;
    }
    gl_FragColor = vec4(col, trans);
  }
`;

const COMPOSITE = /* glsl */`
  uniform sampler2D tDiffuse, tCloud;
  varying vec2 vUv;
  void main() {
    vec4 s = texture2D(tDiffuse, vUv);
    vec4 c = texture2D(tCloud, vUv);
    gl_FragColor = vec4(s.rgb * c.a + c.rgb, s.a);
  }
`;

const QUAD_VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

function volume(data, size, channels) {
  let rgba = data;
  if (channels === 3) {
    rgba = new Uint8Array(size * size * size * 4);
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) { rgba[j] = data[i]; rgba[j + 1] = data[i + 1]; rgba[j + 2] = data[i + 2]; rgba[j + 3] = 255; }
  }
  const t = new THREE.Data3DTexture(rgba, size, size, size);
  t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

export class CloudPass extends Pass {
  constructor({ camera, baseData, detailData, weatherTex, width, height, depthTexture = null }) {
    super();
    this.depthTexture = depthTexture;   // scene depth when the composer buffers carry none
    this.camera = camera;
    this.enabledClouds = true;
    this.rt = new THREE.WebGLRenderTarget(Math.max(1, width >> 1), Math.max(1, height >> 1), { type: THREE.HalfFloatType, depthBuffer: false });
    weatherTex.wrapS = weatherTex.wrapT = THREE.RepeatWrapping;
    this.u = {
      tDepth: { value: null }, uWeather: { value: weatherTex },
      uBase: { value: volume(baseData, 64, 4) }, uDetail: { value: volume(detailData, 32, 3) },
      uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Color(1, 1, 1) }, uAmbTop: { value: new THREE.Color(0.7, 0.8, 1.0) }, uAmbBot: { value: new THREE.Color(0.25, 0.3, 0.4) },
      uFogCol: { value: new THREE.Color(0.6, 0.7, 0.8) }, uRes: { value: new THREE.Vector2(width, height) },
      uNear: { value: camera.near }, uFar: { value: camera.far }, uDist: { value: 0 }, uTime: { value: 0 },
      uBottom: { value: 140 }, uTop: { value: 650 }, uCoverage: { value: 0.5 }, uDensity: { value: 1 },
      uFogNear: { value: 1500 }, uFogFar: { value: 7000 },
      uWeatherScale: { value: 5000 }, uBaseScale: { value: 1 / 700 }, uDetailScale: { value: 1 / 160 },
      uSigma: { value: 0.0115 }, uPowder: { value: 0.65 }, uDetailStr: { value: 0.38 }, uAmbMul: { value: 1.3 }, uHg: { value: new THREE.Vector3(0.45, -0.22, 0.42) },
      uBaseContrast: { value: 2.2 }, uCovSoft: { value: 0.16 }, uTopRound: { value: 1.6 }, uHJitter: { value: 0.22 },
    };
    // three.js compiles as GLSL ES 3.0 on WebGL2 (texture2D -> texture), so sampler3D works in a plain ShaderMaterial
    this.marchMat = new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: QUAD_VERT, fragmentShader: MARCH, depthTest: false, depthWrite: false });
    this.compMat = new THREE.ShaderMaterial({ uniforms: { tDiffuse: { value: null }, tCloud: { value: this.rt.texture } }, vertexShader: QUAD_VERT, fragmentShader: COMPOSITE, depthTest: false, depthWrite: false });
    this.quad = new FullScreenQuad(this.marchMat);
    this.needsSwap = true;
  }
  setSize(w, h) { this.rt.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1)); this.u.uRes.value.set(w, h); }
  render(renderer, writeBuffer, readBuffer) {
    const depth = this.depthTexture || readBuffer.depthTexture;
    if (this.enabledClouds && depth) {
      const cam = this.camera;
      this.u.tDepth.value = depth;
      this.u.uInvProj.value.copy(cam.projectionMatrixInverse);
      this.u.uCamWorld.value.copy(cam.matrixWorld);
      this.u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
      this.u.uNear.value = cam.near; this.u.uFar.value = cam.far;
      this.quad.material = this.marchMat;
      renderer.setRenderTarget(this.rt);
      this.quad.render(renderer);
      this.compMat.uniforms.tDiffuse.value = readBuffer.texture;
      this.quad.material = this.compMat;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      this.quad.render(renderer);
    } else {
      // pass-through
      this.compMat.uniforms.tDiffuse.value = readBuffer.texture;
      this.quad.material = this.compMat;
      renderer.setRenderTarget(this.rt); renderer.clear();
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      this.quad.render(renderer);
    }
  }
}

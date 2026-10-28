import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createOcean } from './ocean.js';
import { CloudPass } from './clouds.js';
import { createDevTools } from './devtools.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const SFX = window.SFX;

// ============================================================ constants
// Game space: x = lateral, y = altitude, d = distance ahead of the player (metres).
// The player always sits at d = 0 and the world streams toward them; three.js z = -d.
const W = 1280, H = 720;                      // HUD virtual resolution
const X_LIM = 220, Y_MIN = 12, Y_MAX = 175;
const SPD_BASE = 380, SPD_BOOST = 640, SPD_BRAKE = 230;
const FAR = 2400, RANGE = 3000, AIM_D = 380, LOCK_R = 160, MAX_LOCKS = 6;
const MAX_MSL = 40, ROLL_DUR = 0.75, STAGE_LEN = 50, BULLET_SPD = 1900;
const CAM_BACK = 22, CAM_UP = 4.8, FOV = 60;  // ~50% screen-width wingspan, like the reference
const FONT = "'Russo One', 'Arial Black', Impact, sans-serif";
const PLANE_NAME = 'SF-22 SEA LANCER';

const params = new URLSearchParams(location.search);
// Deterministic Math.random (mulberry32) for harness shots, so scenery placement repeats exactly.
function seedRandom(seed) {
  let a = (seed >>> 0) || 1;
  Math.random = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
if (params.has('seed')) seedRandom(Number(params.get('seed')));
const START_STAGE = clampInt(Number(params.get('stage')) - 1 || 0, 0, 7);

// ============================================================ helpers
function clampInt(v, a, b) { return Math.max(a, Math.min(b, Math.floor(v))); }
const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const sign = () => (Math.random() < 0.5 ? -1 : 1);
const pad = (n, l) => String(Math.max(0, Math.floor(n))).padStart(l, '0');
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function weighted(tbl) {
  let tot = 0;
  for (const k in tbl) tot += tbl[k];
  let r = Math.random() * tot;
  for (const k in tbl) { r -= tbl[k]; if (r <= 0) return k; }
  return Object.keys(tbl)[0];
}
function sweep(arr, key = 'dead') {
  let j = 0;
  for (let i = 0; i < arr.length; i++) if (!arr[i][key]) arr[j++] = arr[i];
  arr.length = j;
}
function store(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch (e) { /* storage unavailable (private mode etc.) */ }
  return null;
}
function randDir() {
  const u = rand(-1, 1), th = rand(0, Math.PI * 2), r = Math.sqrt(1 - u * u);
  return [r * Math.cos(th), u, r * Math.sin(th)];
}

// ============================================================ renderer
const wrapEl = document.getElementById('wrap');
const glCanvas = document.getElementById('gl');
const hud = document.getElementById('hud');
const hc = hud.getContext('2d');
const bootEl = document.getElementById('boot');

const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, powerPreference: 'high-performance' });
const PR = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(PR);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.info.autoReset = false; // the harness bench reads whole-frame stats; reset manually
const EXPOSURE = 0.8; // stage `exposure` values multiply this
const SKY_BRIGHT = 0.62; // panorama background scale: keeps the sky deep blue instead of near-white
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.5, 12000);
camera.rotation.order = 'YXZ';

// The scene is drawn into a 4x MSAA HalfFloat target (without it every thin line — trails, wing edges,
// lock boxes — aliases) and resolved once into the composer's plain ping-pong buffers. Making the
// composer itself multisampled cost every full-screen pass an MSAA write + resolve (~8 ms at 720p).
const sceneDepth = new THREE.DepthTexture(1, 1);
sceneDepth.type = THREE.UnsignedIntType;
const sceneRT = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType, depthTexture: sceneDepth });
class ScenePass extends Pass {
  constructor(scene, camera, target) {
    super();
    this.scene = scene; this.camera = camera; this.target = target;
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({ ...CopyShader, uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms), depthTest: false, depthWrite: false }));
    this.quad.material.uniforms.tDiffuse.value = target.texture;
  }
  setSize(w, h) { this.target.setSize(w, h); }
  render(renderer, writeBuffer) {
    renderReflection(renderer);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.target); renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);   // resolves the MSAA target
    renderer.autoClear = autoClear;
  }
}
// Planar water reflection: the scene mirrored through the water plane into a half-res target, which the
// ocean shader samples with the wave normal as distortion (fjord walls, islands and the jet reflect; the
// sky dome alone made the water read as a pale mirror next to dark terrain). Oblique near plane = water
// plane (Lengyel), so what is under the surface never shows in the mirror. Reuses this frame's shadow maps.
const reflRT = new THREE.WebGLRenderTarget(640, 360, { type: THREE.HalfFloatType });
const reflCam = new THREE.PerspectiveCamera();
const _rm = new THREE.Matrix4(), _rv = new THREE.Vector3(), _ru = new THREE.Vector3(), _rq = new THREE.Vector4(), _rc = new THREE.Vector4(), _rp = new THREE.Plane();
function renderReflection(renderer) {
  const on = ocean && ocean.mesh.visible && !G.noReflection && camera.position.y > ocean.mesh.position.y + 0.5;
  if (ocean) ocean.uniforms.uReflMix.value = on ? 1 : 0;
  if (!on) return;
  const planeY = ocean.mesh.position.y, cp = camera.position;
  _rm.extractRotation(camera.matrixWorld);
  _rv.set(0, 0, -1).applyMatrix4(_rm).add(cp); _rv.y = 2 * planeY - _rv.y;
  _ru.set(0, 1, 0).applyMatrix4(_rm); _ru.y = -_ru.y;
  reflCam.position.set(cp.x, 2 * planeY - cp.y, cp.z);
  reflCam.up.copy(_ru); reflCam.lookAt(_rv);
  reflCam.near = camera.near; reflCam.far = camera.far; reflCam.fov = camera.fov; reflCam.aspect = camera.aspect;
  reflCam.updateProjectionMatrix(); reflCam.updateMatrixWorld();
  _rp.set(new THREE.Vector3(0, 1, 0), -planeY).applyMatrix4(reflCam.matrixWorldInverse);
  _rc.set(_rp.normal.x, _rp.normal.y, _rp.normal.z, _rp.constant);
  const e = reflCam.projectionMatrix.elements;
  _rq.set((Math.sign(_rc.x) + e[8]) / e[0], (Math.sign(_rc.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
  _rc.multiplyScalar(2 / _rc.dot(_rq));
  e[2] = _rc.x; e[6] = _rc.y; e[10] = _rc.z + 1; e[14] = _rc.w;
  ocean.uniforms.uReflMat.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(reflCam.projectionMatrix).multiply(reflCam.matrixWorldInverse);
  ocean.uniforms.uRefl.value = reflRT.texture;
  ocean.mesh.visible = false;
  const shadowAuto = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;
  renderer.setRenderTarget(reflRT); renderer.clear();
  renderer.render(scene, reflCam);
  renderer.shadowMap.autoUpdate = shadowAuto;
  ocean.mesh.visible = true;
}
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
composer.addPass(new ScenePass(scene, camera, sceneRT));
let cloudPass = null; // inserted after assets load (needs the 3D noise volumes)
// Threshold 1.0 in linear HDR: only true emitters (fire, afterburner cores, sparks) bloom, never lit surfaces or sky.
const bloom = new UnrealBloomPass(new THREE.Vector2(320, 180), 0.45, 0.4, 1.0);
// EffectComposer.setSize would re-size the bloom chain to half the frame; a soft glow does not need that,
// so pin the chain to a 320x180 base (UnrealBloomPass halves what it is given) — ~5 ms saved at 720p.
bloom.setSize = () => UnrealBloomPass.prototype.setSize.call(bloom, 640, 360);
bloom.setSize();
composer.addPass(bloom);
// Radial speed blur: streaks the screen edges outward from the centre, stronger on afterburner.
const speedBlur = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uStrength: { value: 0 }, uCenter: { value: new THREE.Vector2(0.5, 0.45) } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uStrength; uniform vec2 uCenter; varying vec2 vUv;
    void main(){
      vec2 dir = vUv - uCenter;
      float amt = uStrength * smoothstep(0.12, 0.75, length(dir));
      vec4 c = vec4(0.0);
      for (int i = 0; i < 10; i++) c += texture2D(tDiffuse, vUv - dir * amt * (float(i) / 9.0));
      gl_FragColor = c / 10.0;
    }`,
});
composer.addPass(speedBlur);
composer.addPass(new OutputPass());
// Display-space finishing (after tone mapping, so it can't blow highlights): a gentle S-curve for
// contrast that keeps black and white fixed, a touch of saturation, and a soft vignette.
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uSat: { value: 1.12 }, uCurve: { value: 0.38 }, uVig: { value: 0.22 }, uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uSat, uCurve, uVig; uniform vec2 uTexel; varying vec2 vUv;
    void main(){
      // slight 5-tap soften: takes the digital edge off without blurring detail
      vec4 t = texture2D(tDiffuse, vUv) * 0.6
             + (texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)) + texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0))
             +  texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)) + texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y))) * 0.1;
      vec3 c = clamp(t.rgb, 0.0, 1.0);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = clamp(mix(vec3(l), c, uSat), 0.0, 1.0);
      c = mix(c, c * c * (3.0 - 2.0 * c), uCurve);
      float v = smoothstep(1.0, 0.35, length((vUv - 0.5) * vec2(1.0, 0.8)));
      c *= mix(1.0 - uVig, 1.0, v);
      gl_FragColor = vec4(c, t.a);
    }`,
});
composer.addPass(grade);

const pointUniforms = { uScale: { value: 300 }, uTex: { value: null } };
let hudScale = 1;
function resize() {
  const vw = window.innerWidth, vh = window.innerHeight;
  let w = vw, h = Math.round(vw * 9 / 16);
  if (h > vh) { h = vh; w = Math.round(vh * 16 / 9); }
  wrapEl.style.width = w + 'px'; wrapEl.style.height = h + 'px';
  renderer.setSize(w, h, false);
  composer.setPixelRatio(PR);
  composer.setSize(w, h);
  if (cloudPass) cloudPass.setSize(Math.round(w * PR), Math.round(h * PR));
  hud.width = Math.round(w * PR); hud.height = Math.round(h * PR);
  grade.uniforms.uTexel.value.set(1 / (w * PR), 1 / (h * PR));
  hudScale = hud.width / W;
  pointUniforms.uScale.value = (h * PR) / (2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2));
}
window.addEventListener('resize', resize);
resize();

// ============================================================ asset manifest (generated with Scenario)
// Model yaw/size were measured from the Tripo GLBs so every nose points down -Z; nozzles are in metres.
const MODEL_CFG = {
  // Rodin Gen-2.5 (150k tris, PBR + normal maps), built from 3 views each; yaw π puts the nose on -Z.
  player: { url: 'assets/models/player.glb', yaw: Math.PI, len: 19, flame: 1.35, nozzles: [[-1.79, -1.36, 9.4], [1.79, -1.36, 9.4]] },
  enemy: { url: 'assets/models/enemy.glb', yaw: Math.PI, len: 18, flame: 1.4, nozzles: [[0, -1.21, 9.05]] },
  boss: { url: 'assets/models/boss.glb', yaw: Math.PI, len: 48, flame: 2.6, nozzles: [[-19.0, -5.0, 2.9], [-11.9, -5.0, -0.1], [11.9, -5.0, -0.1], [19.0, -5.0, 2.9]] },
};
// Ground props as GLBs (Meshy T2.5 Smart Topology, ~8k tris, PBR). len = longest horizontal extent in metres.
const PROP_MODELS = {
  warehouse: { url: 'assets/models/prop_warehouse.glb', len: 150 },
  tanks: { url: 'assets/models/prop_tanks.glb', len: 90 },
  radar: { url: 'assets/models/prop_radar.glb', len: 70 },
};
// Equirectangular skies: horizon colour (for fog) and sun position in texture UV were sampled from the images.
const SKIES = {
  // sunI is the directional sun; hemi the ambient fill (kept to roughly a third so surfaces have a shadow side).
  day: { url: 'assets/sky/day.jpg', hor: '#9ab6d6', sun: [0.977, 0.31], sunCol: '#fff4e0', sunI: 4.4, hemi: 0.3 },   // v lowered from 0.148: lights from ~34 deg, like the reference
  sunset: { url: 'assets/sky/sunset.jpg', hor: '#c08080', sun: [0.174, 0.464], sunCol: '#ffb070', sunI: 2.8, hemi: 0.32, flare: 0.45, sat: 0.7 },
  storm: { url: 'assets/sky/storm.jpg', hor: '#43525e', sun: [0.301, 0.421], sunCol: '#b0c0d0', sunI: 1.4, hemi: 1.1, flare: 0, bright: 1.6, sat: 1.0 },
  space: { url: 'assets/sky/space.jpg', hor: '#5d7fa8', sun: [0.758, 0.499], sunCol: '#ffffff', sunI: 3.4, hemi: 0.4, bright: 0.9 },
};
const UI_FILES = ['emblem', 'bar', 'gauge', 'logo', 'missile', 'panel'];
// Offline-eroded heightmaps (see scratch gen_terrain.py): _h.png = 16-bit height in R,G + river in B;
// _n.jpg = world normal; _m.jpg = sediment / exposed rock / water flow masks; .json = scale.
const TERRAIN_BIOMES = ['valley', 'canyon', 'alpine', 'dunes'];
// Seamless aerial terrain textures (Scenario Texture), sampled in world space by the terrain shader.
const TERRAIN_FILES = ['meadow', 'rock', 'canyon', 'dunes', 'snow', 'forest', 'tundra', 'cliff', 'desert', 'sand', 'moss'];

const TEMPLATES = {}, SKY_TEX = {}, ENV_TEX = {}, UI = {}, TERRAIN_TEX = {}, TERRAIN_NRM = {}, TERRAIN_RGH = {}, OCEAN_TEX = {}, BIOMES = {}, CLOUD_DATA = {};

async function loadAssets() {
  const gltfLoader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const jobs = [];
  let done = 0;
  const tick = p => p.then(v => { done++; setBoot(`LOADING ${Math.round(done / jobs.length * 100)}%`); return v; });
  for (const [key, c] of Object.entries(MODEL_CFG)) jobs.push(tick(gltfLoader.loadAsync(c.url)).then(g => prepModel(key, g)));
  for (const [key, c] of Object.entries(PROP_MODELS)) jobs.push(tick(gltfLoader.loadAsync(c.url)).then(g => prepProp(key, g)));
  for (const [key, s] of Object.entries(SKIES)) {
    jobs.push(tick(texLoader.loadAsync(s.url)).then(t => {
      t.mapping = THREE.EquirectangularReflectionMapping;
      t.colorSpace = THREE.SRGBColorSpace;
      SKY_TEX[key] = t;
    }));
  }
  for (const n of UI_FILES) {
    jobs.push(tick(new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im); im.onerror = () => rej(new Error('failed to load ui/' + n));
      im.src = `assets/ui/${n}.png`;
    })).then(im => { UI[n] = im; }));
  }
  const repeatTex = (t, srgb) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return t;
  };
  for (const n of TERRAIN_FILES) {
    jobs.push(tick(texLoader.loadAsync(`assets/textures/${n}.jpg`)).then(t => { TERRAIN_TEX[n] = repeatTex(t, true); }));
    jobs.push(tick(texLoader.loadAsync(`assets/textures/${n}_n.jpg`)).then(t => { TERRAIN_NRM[n] = repeatTex(t, false); }));
    jobs.push(tick(texLoader.loadAsync(`assets/textures/${n}_r.jpg`)).then(t => { TERRAIN_RGH[n] = repeatTex(t, false); }));
  }
  jobs.push(tick(texLoader.loadAsync('assets/textures/ocean_n0.jpg')).then(t => { OCEAN_TEX.n0 = repeatTex(t, false); }));
  jobs.push(tick(texLoader.loadAsync('assets/textures/ocean_n1.jpg')).then(t => { OCEAN_TEX.n1 = repeatTex(t, false); }));
  const imgLoader = new THREE.ImageLoader();
  for (const b of TERRAIN_BIOMES) {
    const biome = BIOMES[b] = {};
    jobs.push(tick(fetch(`assets/terrain/${b}.json`).then(r => r.json())).then(meta => Object.assign(biome, meta)));
    jobs.push(tick(imgLoader.loadAsync(`assets/terrain/${b}_h.png`)).then(img => {
      // CPU copy for gameplay queries (player floor, shadows, props) + GPU texture for displacement
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, img.width, img.height).data;
      const h = new Float32Array(img.width * img.height);
      for (let i = 0, j = 0; i < h.length; i++, j += 4) h[i] = (px[j] * 256 + px[j + 1]) / 65535;
      biome.h = h; biome.w = img.width; biome.l = img.height;
      const t = new THREE.Texture(img); t.flipY = false; t.generateMipmaps = false;
      t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
      biome.hTex = t;
    }));
    jobs.push(tick(texLoader.loadAsync(`assets/terrain/${b}_n.jpg`)).then(t => { biome.nTex = repeatTex(t, false); t.flipY = false; t.needsUpdate = true; }));
    jobs.push(tick(texLoader.loadAsync(`assets/terrain/${b}_m.jpg`)).then(t => { biome.mTex = repeatTex(t, false); t.flipY = false; t.needsUpdate = true; }));
  }
  jobs.push(tick(fetch('assets/clouds/cloud_base.bin').then(r => r.arrayBuffer())).then(b => { CLOUD_DATA.base = new Uint8Array(b); }));
  jobs.push(tick(fetch('assets/clouds/cloud_detail.bin').then(r => r.arrayBuffer())).then(b => { CLOUD_DATA.detail = new Uint8Array(b); }));
  jobs.push(tick(texLoader.loadAsync('assets/clouds/cloud_weather.png')).then(t => { CLOUD_DATA.weather = repeatTex(t, false); }));
  jobs.push(tick(texLoader.loadAsync('assets/textures/ocean_foam.jpg')).then(t => { OCEAN_TEX.foam = repeatTex(t, false); }));

  setBoot('LOADING 0%');
  await Promise.all(jobs);
  const pmrem = new THREE.PMREMGenerator(renderer);
  for (const [k, t] of Object.entries(SKY_TEX)) ENV_TEX[k] = pmrem.fromEquirectangular(t).texture;
  pmrem.dispose();
}
function setBoot(text) {
  if (bootEl) bootEl.firstElementChild.textContent = text;
}

function prepModel(key, gltf) {
  const c = MODEL_CFG[key];
  const inner = gltf.scene;
  inner.rotation.y = c.yaw;
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  inner.scale.setScalar(c.len / (box.max.z - box.min.z));
  inner.updateMatrixWorld(true);
  box.setFromObject(inner);
  inner.position.sub(box.getCenter(new THREE.Vector3()));
  const size = box.getSize(new THREE.Vector3());
  c.span = size.x;
  inner.traverse(o => {
    if (o.isMesh) { o.material.envMapIntensity = 0.35; o.frustumCulled = true; o.castShadow = true; o.receiveShadow = true; }
  });
  const proto = new THREE.Group();
  proto.add(inner);
  TEMPLATES[key] = proto;
}

function prepProp(key, gltf) {
  const c = PROP_MODELS[key], inner = gltf.scene;
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  inner.scale.setScalar(c.len / Math.max(size.x, size.z));
  inner.updateMatrixWorld(true);
  box.setFromObject(inner);
  const ctr = box.getCenter(new THREE.Vector3());
  inner.position.set(-ctr.x, -box.min.y, -ctr.z);   // footprint centred, base on the ground
  inner.traverse(o => { if (o.isMesh) { o.material.envMapIntensity = 0.4; o.castShadow = true; o.receiveShadow = true; } });
  const proto = new THREE.Group();
  proto.add(inner);
  TEMPLATES[key] = proto;
}

// ============================================================ textures (procedural)
const ANISO = renderer.capabilities.getMaxAnisotropy();
function canvasTex(size, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = ANISO;
  return t;
}
// Draw at every wrapped offset so the texture tiles seamlessly.
function tiled(S, fn) { for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) fn(ox, oy); }
function blobs(g, S, n, colors, rmin, rmax, squash = 1) {
  for (let i = 0; i < n; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = rand(rmin, rmax), c = pick(colors);
    g.fillStyle = c;
    tiled(S, (ox, oy) => { g.beginPath(); g.ellipse(x + ox, y + oy, r, r * squash, 0, 0, Math.PI * 2); g.fill(); });
  }
}
function streaks(g, S, n, rgb, wmin, wmax, amin, amax) {
  for (let i = 0; i < n; i++) {
    const x = Math.random() * S, y = Math.random() * S, w = rand(wmin, wmax);
    g.fillStyle = `rgba(${rgb},${rand(amin, amax)})`;
    tiled(S, (ox, oy) => g.fillRect(x + ox, y + oy, w, rand(1, 2.2)));
  }
}
function softBlobs(g, S, n, rgb, rmin, rmax, a) {
  for (let i = 0; i < n; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = rand(rmin, rmax);
    tiled(S, (ox, oy) => {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, `rgba(${rgb},${a})`); gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr; g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    });
  }
}

const GROUND_GEN = {
  sand(g, S) {
    g.fillStyle = '#d6a45e'; g.fillRect(0, 0, S, S);
    softBlobs(g, S, 25, '240,200,130', 40, 120, 0.4);
    softBlobs(g, S, 20, '170,110,50', 30, 100, 0.25);
    g.lineWidth = 3;
    for (let i = 0; i < 36; i++) {
      const y0 = (i / 36) * S, ph = Math.random() * 6;
      for (const [col, off] of [['rgba(130,80,30,0.2)', 0], ['rgba(255,235,190,0.22)', 3]]) {
        g.strokeStyle = col;
        for (const oy of [-S, 0, S]) {
          g.beginPath();
          for (let x = 0; x <= S; x += 8) {
            const y = y0 + oy + off + 5 * Math.sin((x / S) * Math.PI * 2 * 3 + ph) + 3 * Math.sin((x / S) * Math.PI * 2 * 7);
            x ? g.lineTo(x, y) : g.moveTo(x, y);
          }
          g.stroke();
        }
      }
    }
    streaks(g, S, 600, '120,70,30', 1, 3, 0.1, 0.3);
  },
  grass(g, S) {
    const cell = S / 8, cols = ['#4f8f3a', '#3f7f33', '#6a9a3c', '#7d9c42', '#5a8a2e', '#9a9a52', '#3b6e2f'];
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      g.fillStyle = pick(cols); g.fillRect(i * cell, j * cell, cell, cell);
      g.strokeStyle = 'rgba(0,0,0,0.07)'; g.lineWidth = 2;
      const vertical = Math.random() < 0.5;
      for (let k = 6; k < cell; k += 8) {
        g.beginPath();
        if (vertical) { g.moveTo(i * cell + k, j * cell); g.lineTo(i * cell + k, j * cell + cell); }
        else { g.moveTo(i * cell, j * cell + k); g.lineTo(i * cell + cell, j * cell + k); }
        g.stroke();
      }
    }
    softBlobs(g, S, 40, '30,60,20', 20, 60, 0.35);
    blobs(g, S, 220, ['#2b5a26', '#24502a'], 2, 6);
  },
  rock(g, S) {
    g.fillStyle = '#a65a33'; g.fillRect(0, 0, S, S);
    softBlobs(g, S, 40, '120,50,25', 30, 100, 0.45);
    softBlobs(g, S, 30, '210,140,90', 20, 70, 0.35);
    blobs(g, S, 300, ['rgba(80,30,10,0.25)', 'rgba(230,170,120,0.2)'], 2, 6);
    streaks(g, S, 300, '70,25,5', 10, 40, 0.1, 0.25);
  },
  city(g, S) {
    g.fillStyle = '#121024'; g.fillRect(0, 0, S, S);
    blobs(g, S, 900, ['rgba(255,210,120,0.55)', 'rgba(120,230,255,0.45)', 'rgba(255,255,255,0.3)'], 0.8, 1.8);
    const step = S / 4;
    for (let i = 0; i < 4; i++) {
      g.fillStyle = '#1e1b38';
      g.fillRect(i * step - 7, 0, 14, S); g.fillRect(0, i * step - 7, S, 14);
      g.fillStyle = i % 2 ? 'rgba(255,70,190,0.95)' : 'rgba(80,220,255,0.95)';
      g.fillRect(i * step - 1.5, 0, 3, S); g.fillRect(0, i * step - 1.5, S, 3);
    }
  },
  ice(g, S) {
    g.fillStyle = '#d8ebf6'; g.fillRect(0, 0, S, S);
    softBlobs(g, S, 40, '150,190,225', 30, 110, 0.4);
    softBlobs(g, S, 30, '255,255,255', 30, 90, 0.6);
    g.strokeStyle = 'rgba(60,110,160,0.22)'; g.lineWidth = 1.2;
    for (let i = 0; i < 40; i++) {
      let x = Math.random() * S, y = Math.random() * S;
      const pts = [[x, y]];
      for (let k = 0; k < 8; k++) { x += rand(-25, 25); y += rand(-25, 25); pts.push([x, y]); }
      tiled(S, (ox, oy) => { g.beginPath(); pts.forEach(([px, py], n) => (n ? g.lineTo(px + ox, py + oy) : g.moveTo(px + ox, py + oy))); g.stroke(); });
    }
  },
  cloud(g, S) {
    g.fillStyle = '#c7d2e8'; g.fillRect(0, 0, S, S);
    softBlobs(g, S, 90, '255,255,255', 30, 90, 0.75);
    softBlobs(g, S, 40, '140,155,190', 30, 80, 0.3);
  },
};
const groundTexCache = {};
function groundTexture(kind) {
  return groundTexCache[kind] || (groundTexCache[kind] = canvasTex(512, GROUND_GEN[kind]));
}


// 2x2 atlas of billowy puffs (alpha = density, rgb = fine detail). Lighting is applied in the
// particle shader so it stays upright while each puff rotates.
const puffTex = canvasTex(256, (g, S) => {
  const C = S / 2;
  for (let cell = 0; cell < 4; cell++) {
    const c = document.createElement('canvas'); c.width = c.height = C;
    const q = c.getContext('2d');
    for (let i = 0; i < 36; i++) {
      const a = rand(0, Math.PI * 2), rr = Math.pow(Math.random(), 0.7) * C * 0.25;
      const x = C / 2 + Math.cos(a) * rr, y = C / 2 + Math.sin(a) * rr, r = rand(C * 0.1, C * 0.22);
      const gr = q.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.7)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.3)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      q.fillStyle = gr; q.fillRect(0, 0, C, C);
    }
    q.globalCompositeOperation = 'source-atop';
    q.fillStyle = '#ffffff'; q.fillRect(0, 0, C, C);
    for (let i = 0; i < 70; i++) { // soft, low-contrast internal variation (avoids a dotted look)
      const x = rand(0, C), y = rand(0, C), r = rand(6, 16), v = Math.round(rand(205, 245));
      const gr = q.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(${v},${v},${v},0.8)`); gr.addColorStop(1, `rgba(${v},${v},${v},0)`);
      q.fillStyle = gr; q.fillRect(x - r, y - r, r * 2, r * 2);
    }
    g.drawImage(c, (cell % 2) * C, Math.floor(cell / 2) * C);
  }
}, false);
pointUniforms.uTex.value = puffTex;

const glowTex = canvasTex(128, (g, S) => {
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.18, 'rgba(255,230,180,0.9)');
  gr.addColorStop(0.45, 'rgba(255,140,60,0.35)'); gr.addColorStop(1, 'rgba(255,90,20,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
}, false);

const shadowTex = canvasTex(128, (g, S) => {
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(0,0,0,0.6)'); gr.addColorStop(0.5, 'rgba(0,0,0,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
}, false);

const windowTex = canvasTex(64, (g, S) => {
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  for (let x = 0; x < 6; x++) for (let y = 0; y < 12; y++) {
    if (Math.random() < 0.45) continue;
    g.fillStyle = Math.random() < 0.7 ? '#ffd27a' : '#7ae6ff';
    g.fillRect(4 + x * 10, 3 + y * 5.2, 6, 3);
  }
});

// ============================================================ sky (fallback shader for the night city), lights
const skyU = {
  top: { value: new THREE.Color() }, mid: { value: new THREE.Color() }, hor: { value: new THREE.Color() },
  sunDir: { value: new THREE.Vector3(0, 0.2, -1) }, sunCol: { value: new THREE.Color() },
  stars: { value: 0 }, flash: { value: 0 },
  // panorama mode
  uTex: { value: null }, uMode: { value: 0 }, uSat: { value: 1.45 }, uBright: { value: 0.62 }, uZenith: { value: 0.8 }, uYaw: { value: 0 },
};
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(9000, 32, 16), new THREE.ShaderMaterial({
  uniforms: skyU, side: THREE.BackSide, depthWrite: false, fog: false,
  vertexShader: `varying vec3 vDir;
    void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform vec3 top, mid, hor, sunCol, sunDir; uniform float stars, flash, uMode, uSat, uBright, uZenith, uYaw; uniform sampler2D uTex; varying vec3 vDir;
    float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
    void main(){
      vec3 d = normalize(vDir);
      if (uMode > 0.5) {
        // equirect panorama, yaw-rotated like scene.backgroundRotation, with saturation / brightness /
        // zenith-darkening controls (the reference sky is a deep saturated blue; the photo is paler)
        float cy = cos(uYaw), sy = sin(uYaw);
        vec3 r = vec3(cy * d.x - sy * d.z, d.y, sy * d.x + cy * d.z);
        vec2 uv = vec2(atan(r.z, r.x) * 0.15915494 + 0.5, asin(clamp(r.y, -1.0, 1.0)) * 0.31830989 + 0.5);
        vec3 c = textureLod(uTex, uv, 0.0).rgb;   // explicit LOD: auto mip selection draws a seam at the u-wrap
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = max(mix(vec3(l), c, uSat), 0.0);
        c *= uBright * mix(1.0, uZenith, smoothstep(0.05, 0.7, d.y));
        gl_FragColor = vec4(c + vec3(flash), 1.0);
        return;
      }
      float h = d.y;
      vec3 c = mix(hor, mid, smoothstep(0.0, 0.16, h));
      c = mix(c, top, smoothstep(0.16, 0.75, h));
      if (h < 0.0) c = hor;
      float s = max(dot(d, normalize(sunDir)), 0.0);
      c += sunCol * (pow(s, 1200.0) * 4.0 + pow(s, 60.0) * 0.4 + pow(s, 6.0) * 0.15);
      if (stars > 0.0) {
        float st = step(0.9978, hash(floor(d * 420.0)));
        c += vec3(st) * stars * smoothstep(0.03, 0.3, h);
      }
      c += vec3(flash);
      gl_FragColor = vec4(c, 1.0);
    }`,
}));
skyDome.frustumCulled = false;
skyDome.renderOrder = -10;
scene.add(skyDome);

const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
const sunLight = new THREE.DirectionalLight(0xffffff, 2);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(4096, 4096);
sunLight.shadow.camera.near = 1; sunLight.shadow.camera.far = 2200;
sunLight.shadow.camera.left = sunLight.shadow.camera.bottom = -380;
sunLight.shadow.camera.right = sunLight.shadow.camera.top = 380;
sunLight.shadow.bias = -0.0004; sunLight.shadow.normalBias = 0.6;
scene.add(hemi, sunLight, sunLight.target);
// Keep the 760 m shadow frustum centred ahead of the player so the jet, nearby enemies and the
// terrain walls beside the corridor all cast and receive.
function updateSunShadow() {
  const cx = P.x, cy = 40, cz = -220;
  sunLight.target.position.set(cx, cy, cz);
  sunLight.position.set(cx + sunDir.x * 900, cy + sunDir.y * 900, cz + sunDir.z * 900);
}
scene.fog = new THREE.Fog(0xffffff, 500, 2600);
THREE.ShaderChunk.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying float vFogHeight;
  uniform float fogNear;
  uniform float fogFar;
#endif`;
THREE.ShaderChunk.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
  varying float vFogDepth;
  varying float vFogHeight;
#endif`;
THREE.ShaderChunk.fog_vertex = /* glsl */`
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogHeight = (inverse(viewMatrix) * mvPosition).y;
#endif`;
THREE.ShaderChunk.fog_fragment = /* glsl */`
#ifdef USE_FOG
  // Aerial perspective: optical depth grows with distance and falls off with the height of the
  // point being shaded (thick haze hugs the ground; peaks and high jets stay clear). Colour first
  // loses saturation toward a cool grey, then lifts toward the horizon colour.
  float hz = exp(-max(vFogHeight, 0.0) / 420.0);
  float od = smoothstep(fogNear, fogFar, vFogDepth);
  float fogFactor = clamp(od * (0.55 + 0.45 * hz), 0.0, 1.0);
  float lum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 cool = mix(vec3(lum), gl_FragColor.rgb, 0.35) * vec3(0.9, 0.96, 1.08);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, cool, smoothstep(0.0, 0.6, fogFactor));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor * fogFactor * 0.92);
#endif`;
const sunDir = new THREE.Vector3(0, 0.5, -1).normalize();

// Rotate a sky so its sun sits ahead-left of the flight path; returns the world-space sun direction.
function orientSky(sky) {
  const [u, v] = sky.sun;
  const phi = (u - 0.5) * Math.PI * 2, lat = (0.5 - v) * Math.PI;
  const target = Math.atan2(-1, -0.42);
  const yaw = phi - target;
  skyYaw = yaw;
  skyU.uYaw.value = yaw;
  scene.backgroundRotation.set(0, yaw, 0);
  scene.environmentRotation.set(0, yaw, 0);
  return new THREE.Vector3(Math.cos(target) * Math.cos(lat), Math.sin(lat), Math.sin(target) * Math.cos(lat)).normalize();
}

// ============================================================ terrain (offline-eroded heightmap, scrolls with distance flown)
// The heightmap is periodic along the flight axis; world x in [-worldW/2, worldW/2] -> u, along-distance w -> v.
const terrainU = {
  uDist: { value: 0 }, uAmp: { value: 1 },
  uHeight: { value: null }, uTNormal: { value: null }, uMasks: { value: null },
  uHMax: { value: 500 }, uWorldW: { value: 5200 }, uWorldL: { value: 10400 },
  uRock: { value: new THREE.Color('#ffffff') }, uSnow: { value: -1000 },
  uRockMap: { value: null }, uTile: { value: 260 }, uRockTile: { value: 160 },
  uGndNrm: { value: null }, uRockNrm: { value: null }, uGndRgh: { value: null }, uRockRgh: { value: null },
  uForestMap: { value: null }, uForestNrm: { value: null }, uForestTile: { value: 110 },   // PATINA conifer canopy, ~110 m per repeat
  uSnowMap: { value: null }, uSnowNrm: { value: null }, uSnowTile: { value: 90 },           // PATINA wind-packed snow
  uWeather: { value: null }, uWeatherScale: { value: 5000 }, uCloudP: { value: new THREE.Vector4(0, 0.16, 500, 0) },   // cloud shadow: coverage, softness, layer mid height, strength
  uRghInv: { value: 0 }, uNrmStr: { value: 1 },
  uForest: { value: new THREE.Vector2(-1, -1) }, uRiverCol: { value: new THREE.Color('#1d4a5e') }, uForestDark: { value: 0.75 }, uSunDirW: { value: new THREE.Vector3(0, 1, 0) }, uTShadow: { value: 1 },
  // dynamic range: lit faces brighter, shadowed slopes darker (the reference spans p5≈1 .. p95≈98)
  uAlbedo: { value: 1.0 }, uAmbScale: { value: 0.7 },
};
const FLAT_NRM = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
const FLAT_RGH = new THREE.DataTexture(new Uint8Array([235, 235, 235, 255]), 1, 1);
FLAT_NRM.needsUpdate = FLAT_RGH.needsUpdate = true;
let activeBiome = null;
// CPU height lookup (bilinear, periodic) used for the player floor, enemy ground clamp, shadows and props.
function terrainH(x, w) {
  const b = activeBiome;
  if (!b || !b.h) return 0;
  let u = x / b.worldW + 0.5, v = w / b.worldL;
  u -= Math.floor(u); v -= Math.floor(v);
  const fx = u * b.w - 0.5, fy = v * b.l - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const X0 = ((x0 % b.w) + b.w) % b.w, X1 = (X0 + 1) % b.w, Y0 = ((y0 % b.l) + b.l) % b.l, Y1 = (Y0 + 1) % b.l;
  const h = b.h;
  const top = h[Y0 * b.w + X0] * (1 - tx) + h[Y0 * b.w + X1] * tx;
  const bot = h[Y1 * b.w + X0] * (1 - tx) + h[Y1 * b.w + X1] * tx;
  return (top * (1 - ty) + bot * ty) * b.hmax * terrainU.uAmp.value;
}
const TERRAIN_GLSL = `
  uniform float uDist, uAmp, uHMax, uWorldW, uWorldL;
  uniform sampler2D uHeight;
  vec2 terrainUV(float x, float w) { return vec2(x / uWorldW + 0.5, w / uWorldL); }
  float terrainH(float x, float w) {
    vec4 t = texture2D(uHeight, terrainUV(x, w));
    return (t.r * 65280.0 + t.g * 255.0) / 65535.0 * uHMax * uAmp;
  }
  varying float vTH;
  varying vec3 vTW;
  varying vec2 vTUV;
`;
// PBR terrain: heightmap displacement in the vertex shader; in the fragment shader the baked world
// normal (sharp ridges and gullies) is combined with PATINA detail normals, and materials are zoned by
// slope, altitude and the erosion masks: sediment -> soil/grass on valley floors, exposed rock on
// eroded faces, dark conifer band at mid altitude, snow above a line (never on steep faces), wet
// streaks along water flow, and the river on the corridor floor.
function terrainMaterial(opts) {
  const m = new THREE.MeshStandardMaterial({ metalness: 0, roughness: 1, envMapIntensity: 0.25, ...opts });
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, terrainU);
    sh.vertexShader = TERRAIN_GLSL + sh.vertexShader
      .replace('#include <beginnormal_vertex>', `
        float tw = -position.z + uDist;
        vTUV = terrainUV(position.x, tw);
        float th = terrainH(position.x, tw);
        vec3 objectNormal = vec3(0.0, 1.0, 0.0);
        vTH = th;
        vTW = vec3(position.x, th, position.z - uDist);
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(1.0, 0.0, 0.0);
        #endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position.x, th, position.z);');
    sh.fragmentShader = `uniform vec3 uRock, uRiverCol; uniform vec2 uForest; uniform vec3 uSunDirW; uniform float uTShadow, uAmp, uWorldW, uWorldL, uForestTile, uSnowTile, uWeatherScale; uniform vec4 uCloudP; uniform float uSnow, uTile, uRockTile, uRghInv, uNrmStr, uHMax, uForestDark, uAlbedo, uAmbScale;
      uniform sampler2D uRockMap, uGndNrm, uRockNrm, uGndRgh, uRockRgh, uTNormal, uMasks, uHeight, uForestMap, uForestNrm, uSnowMap, uSnowNrm, uWeather;
      varying float vTH; varying vec3 vTW; varying vec2 vTUV;\n` + sh.fragmentShader
      .replace('#include <map_fragment>', `
        // terrain self-shadowing: march the heightmap toward the sun (soft, penumbra widens with distance);
        // the shadow map only covers the near field, this is what puts the far valley walls in shade
        float tShadow = 1.0;
        if (uSunDirW.y > 0.03 && uTShadow > 0.001) {
          float tt = 14.0;
          for (int i = 0; i < 14; i++) {
            vec3 q = vec3(uSunDirW.x, uSunDirW.y, -uSunDirW.z) * tt;   // world +z is -w in heightmap space
            vec4 ht = texture2D(uHeight, vTUV + vec2(q.x / uWorldW, q.z / uWorldL));
            float hh = (ht.r * 65280.0 + ht.g * 255.0) / 65535.0 * uHMax * uAmp;
            tShadow = min(tShadow, 1.0 - clamp((hh - (vTH + q.y)) / (6.0 + 0.06 * tt), 0.0, 1.0));
            tt *= 1.42;
          }
          tShadow = mix(1.0, tShadow, uTShadow);
        }
        // cloud shadows: the weather map (same lookup as the cloud march) projected along the sun onto the ground
        if (uCloudP.w > 0.001 && uSunDirW.y > 0.05) {
          float tc = max(uCloudP.z - vTH, 0.0) / uSunDirW.y;
          vec2 cq = vec2(vTW.x + uSunDirW.x * tc, -vTW.z - uSunDirW.z * tc);   // cloud space: (x, w)
          float wc = texture2D(uWeather, cq / uWeatherScale + vec2(0.5)).r;
          float c0 = 1.0 - uCloudP.x * 1.1;
          tShadow *= 1.0 - smoothstep(c0 - uCloudP.y, c0 + uCloudP.y, wc) * uCloudP.w;
        }
        vec3 P = vTW;
        vec3 tn = texture2D(uTNormal, vTUV).xyz * 2.0 - 1.0;
        vec3 Ng = normalize(vec3(tn.x, max(tn.y, 0.05), -tn.z));
        vec3 masks = texture2D(uMasks, vTUV).rgb;      // sediment, exposed rock, flow
        float river = texture2D(uHeight, vTUV).b;
        float slope = 1.0 - Ng.y;
        vec3 tnM = textureLod(uTNormal, vTUV, 2.5).xyz * 2.0 - 1.0;   // macro normal (~30 m) for zoning
        float mslope = 1.0 - normalize(vec3(tnM.x, max(tnM.y, 0.05), -tnM.z)).y;
        vec3 bw = pow(abs(Ng), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
        float nearF = 1.0 - smoothstep(200.0, 1600.0, length(vViewPosition));
        vec2 guv = P.xz / uTile;
        vec2 ruv = mat2(0.7986, 0.6018, -0.6018, 0.7986) * P.xz / (uTile * 1.73) + vec2(0.37, 0.11);
        vec3 g1 = texture2D(map, guv).rgb * bw.y + texture2D(map, P.zy / uTile).rgb * bw.x + texture2D(map, P.xy / uTile).rgb * bw.z;   // triplanar albedo
        vec3 g1r = texture2D(map, ruv).rgb;
        vec3 g2 = texture2D(map, guv * 0.21 + vec2(0.37, 0.11)).rgb;
        vec3 gd = texture2D(map, guv * 5.3).rgb;
        float mixw = smoothstep(0.35, 0.65, fract(sin(dot(floor(P.xz / 180.0), vec2(12.9898, 78.233))) * 43758.5453));
        vec3 ground = mix(g1, g1r, mixw) * mix(0.8, 1.2, dot(g2, vec3(0.333)));
        ground *= mix(1.0, 0.55 + 0.9 * dot(gd, vec3(0.333)), nearF * 0.55);
        // sediment (eroded soil deposited on floors) reads greener / lighter than bare slopes
        ground = mix(ground, ground * vec3(1.08, 1.12, 0.92), masks.r * 0.6);
        // forest band
        float forestAmt = uForest.x >= 0.0 ? smoothstep(uForest.x, uForest.x + 30.0, vTH) * (1.0 - smoothstep(uForest.y, uForest.y + 70.0, vTH)) * (1.0 - smoothstep(0.55, 0.8, mslope)) : 0.0;
        forestAmt *= mix(1.0, smoothstep(0.3, 0.6, 1.0 - g2.g) * 0.4, masks.r);   // dense on slopes, patchy clearings on sediment floors
        // conifer canopy texture (two rotated copies so the repeat never reads), uForestDark = canopy brightness
        vec2 fuv = P.xz / uForestTile;
        // canopy triplanar on the first copy: a top-down canopy projected on a 60-degree wall smears into vertical streaks
        vec3 fcolA = texture2D(uForestMap, fuv).rgb * bw.y + texture2D(uForestMap, P.zy / uForestTile).rgb * bw.x + texture2D(uForestMap, P.xy / uForestTile).rgb * bw.z;
        vec3 fcol = mix(fcolA, texture2D(uForestMap, mat2(0.7986, 0.6018, -0.6018, 0.7986) * fuv * 0.83 + vec2(0.21, 0.57)).rgb, mixw * 0.6);
        ground = mix(ground, fcol * vec3(0.72, 0.88, 0.98) * uForestDark * (0.85 + 0.3 * g2.g), forestAmt);
        // rock: steep faces and eroded (mask) faces, strata texture triplanar
        vec2 ux = P.zy / uRockTile, uy = P.xz / uRockTile, uz = P.xy / uRockTile;
        vec3 rockA = texture2D(uRockMap, ux).rgb * bw.x + texture2D(uRockMap, uy).rgb * bw.y + texture2D(uRockMap, uz).rgb * bw.z;
        mat2 rr2 = mat2(0.7986, 0.6018, -0.6018, 0.7986);
        vec3 rockB = texture2D(uRockMap, rr2 * ux * 0.71 + 0.3).rgb * bw.x + texture2D(uRockMap, rr2 * uy * 0.71 + 0.3).rgb * bw.y + texture2D(uRockMap, rr2 * uz * 0.71 + 0.3).rgb * bw.z;
        vec3 rock = mix(rockA, rockB, mixw);   // two rotated copies so the strata repeat never lines up
        float macro = dot(g2, vec3(0.333));
        float rockAmt = clamp(smoothstep(0.5, 0.75, mslope + (macro - 0.5) * 0.25) + masks.g * 0.35 * smoothstep(0.3, 0.5, slope), 0.0, 1.0);   // forest holds the slopes; rock on cliff faces, patchy at macro scale
        // water flow darkens gullies (wet rock / scree)
        rock *= 1.0 - masks.b * 0.35;
        // snow above the line, not on steep faces, thinner where water flows
        // snow lies in gullies (flow mask) and on the lighter strata, broken by dark rock bands and steep faces
        float snowAmt = uSnow > -999.0 ? smoothstep(uSnow, uSnow + 60.0, vTH) * (1.0 - smoothstep(0.35, 0.62, slope)) * clamp(0.78 + masks.b * 0.6 + (rock.r - 0.5) * 1.0, 0.0, 1.0) : 0.0;
        vec3 tcol = mix(ground, rock * uRock * 0.85, rockAmt);
        vec2 suv = P.xz / uSnowTile;
        vec3 snowCol = mix(texture2D(uSnowMap, suv).rgb, texture2D(uSnowMap, mat2(0.7986, 0.6018, -0.6018, 0.7986) * suv * 0.77 + vec2(0.13, 0.49)).rgb, mixw);
        tcol = mix(tcol, snowCol * vec3(0.96, 0.98, 1.0) * 0.85, snowAmt);
        float riverAmt = river * (1.0 - smoothstep(0.1, 0.3, slope));
        tcol = mix(tcol, uRiverCol * (0.8 + 0.5 * g1.b), riverAmt);
        diffuseColor.rgb *= tcol * mix(uAlbedo, 1.0, snowAmt);`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= uAmbScale;`)
      .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replaceAll('RE_Direct( directLight,', 'directLight.color *= tShadow; RE_Direct( directLight,'))
      .replace('#include <roughnessmap_fragment>', `
        float rg = texture2D(uGndRgh, guv).r;
        float rr = texture2D(uRockRgh, ux).r * bw.x + texture2D(uRockRgh, uy).r * bw.y + texture2D(uRockRgh, uz).r * bw.z;
        if (uRghInv > 0.5) { rg = 1.0 - rg; rr = 1.0 - rr; }
        float roughnessFactor = mix(mix(mix(0.62 + 0.38 * rg, 0.9, forestAmt), 0.7 + 0.3 * rr, rockAmt), 0.5, snowAmt);
        roughnessFactor = mix(roughnessFactor, 0.12, riverAmt);`)
      .replace('#include <normal_fragment_begin>', `
        vec3 tnG = texture2D(uGndNrm, guv).xyz * 2.0 - 1.0;
        tnG = mix(tnG, texture2D(uForestNrm, P.xz / uForestTile).xyz * 2.0 - 1.0, forestAmt);
        vec3 tnX = texture2D(uRockNrm, ux).xyz * 2.0 - 1.0;
        vec3 tnY = texture2D(uRockNrm, uy).xyz * 2.0 - 1.0;
        vec3 tnZ = texture2D(uRockNrm, uz).xyz * 2.0 - 1.0;
        float nearD = 1.0 - smoothstep(30.0, 260.0, length(vViewPosition));   // sub-metre crust for low passes: the same maps 6-7x finer
        if (nearD > 0.001) {
          tnG.xy += (texture2D(uGndNrm, guv * 7.0).xy * 2.0 - 1.0) * 0.55 * nearD;
          tnX.xy += (texture2D(uRockNrm, ux * 6.0).xy * 2.0 - 1.0) * 0.55 * nearD;
          tnY.xy += (texture2D(uRockNrm, uy * 6.0).xy * 2.0 - 1.0) * 0.55 * nearD;
          tnZ.xy += (texture2D(uRockNrm, uz * 6.0).xy * 2.0 - 1.0) * 0.55 * nearD;
        }
        tnG.xy *= uNrmStr * nearF; tnX.xy *= uNrmStr; tnY.xy *= uNrmStr; tnZ.xy *= uNrmStr;
        vec3 wx = vec3(tnX.xy + Ng.zy, abs(tnX.z) * Ng.x);
        vec3 wy = vec3(tnY.xy + Ng.xz, abs(tnY.z) * Ng.y);
        vec3 wz = vec3(tnZ.xy + Ng.xy, abs(tnZ.z) * Ng.z);
        vec3 rockN = normalize(wx.zyx * bw.x + wy.xzy * bw.y + wz.xyz * bw.z);
        vec3 gN = normalize(vec3(tnG.xy + Ng.xz, abs(tnG.z) * Ng.y).xzy);
        vec3 tnS = texture2D(uSnowNrm, P.xz / uSnowTile).xyz * 2.0 - 1.0; tnS.xy *= uNrmStr * 0.7;
        vec3 sN = normalize(vec3(tnS.xy + Ng.xz, abs(tnS.z) * Ng.y).xzy);
        vec3 worldN = normalize(mix(mix(mix(gN, rockN, rockAmt), sN, snowAmt), Ng, riverAmt));
        vec3 normal = normalize((viewMatrix * vec4(worldN, 0.0)).xyz);
        vec3 nonPerturbedNormal = normal;`)
      .replace('#include <normal_fragment_maps>', '')
      .replace('#include <emissivemap_fragment>', `
        #ifdef USE_EMISSIVEMAP
          totalEmissiveRadiance *= texture2D(emissiveMap, guv).rgb;
        #endif`);
  };
  return m;
}
const TERRAIN_W = 5200, TERRAIN_D = 5400, TILE = 260;
// Terrain grid dense near the camera and along the corridor (power-curve spacing), sparse far away.
function terrainGrid(nx, nz) {
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= nz; j++) {
    const t = j / nz, z = 300 - TERRAIN_D * Math.pow(t, 1.55);
    for (let i = 0; i <= nx; i++) {
      const sx = i / nx * 2 - 1, x = Math.sign(sx) * Math.pow(Math.abs(sx), 1.35) * TERRAIN_W / 2;
      pos.push(x, 0, z); uv.push(i / nx, j / nz);
    }
  }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    idx.push(a, b, c, b, d, c); // counter-clockwise seen from above (+y)
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
const terrainGeo = terrainGrid(360, 420);
const terrain = new THREE.Mesh(terrainGeo, terrainMaterial({}));
terrain.frustumCulled = false;
terrain.receiveShadow = true;
terrain.castShadow = true;
// Shadow pass needs the same displacement, or cliffs would cast from the flat plane.
terrain.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
terrain.customDepthMaterial.onBeforeCompile = sh => {
  Object.assign(sh.uniforms, terrainU);
  sh.vertexShader = TERRAIN_GLSL + sh.vertexShader.replace('#include <begin_vertex>',
    'float tw = -position.z + uDist; vec3 transformed = vec3(position.x, terrainH(position.x, tw), position.z);');
};
scene.add(terrain);

// ============================================================ ocean (see ocean.js)
let ocean = null;
let skyYaw = 0;

// ============================================================ geometry helpers (scenery props)
// Merge primitive parts into one vertex-coloured geometry so each prop is a single draw call.
function partsGeo(parts) {
  const list = parts.map(([geo, col, x = 0, y = 0, z = 0, rz = 0]) => {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    const c = new THREE.Color(col), n = g.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    g.clearGroups();
    return g;
  });
  const merged = mergeGeometries(list, false);
  merged.computeVertexNormals();
  return merged;
}
const Cyl = (a, b, h, s) => new THREE.CylinderGeometry(a, b, h, s);
const Cone = (r, h, s) => new THREE.ConeGeometry(r, h, s);
const glowMat = (r, g, b, opacity = 1) => new THREE.MeshBasicMaterial({
  color: new THREE.Color().setRGB(r, g, b), transparent: true, opacity,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
const NAV_GEO = new THREE.SphereGeometry(0.28, 6, 4);
const BEACON = glowMat(5, 0.5, 0.8);
const NEON = glowMat(3, 0.6, 3.2);

// ============================================================ aircraft
const FLAME_GEO = new THREE.ConeGeometry(0.5, 1, 12, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
// Afterburner like the reference: orange-hot nozzle ring (glow sprite + core) and a long blue-violet plume.
const FLAME_OUT = glowMat(0.35, 0.55, 1.6, 0.45);
const FLAME_CORE = glowMat(1.3, 1.5, 2.1, 0.8);

function makeModel(key) {
  const c = MODEL_CFG[key === 'tanker' ? 'boss' : key];
  const g = new THREE.Group();
  g.rotation.order = 'YXZ';
  const body = TEMPLATES[key === 'tanker' ? 'boss' : key].clone(true);
  const mats = [];
  body.traverse(o => {
    if (!o.isMesh) return;
    o.material = o.material.clone();
    if (key === 'tanker') o.material.color.setRGB(2.4, 2.45, 2.6); // repaint the bomber as a light-grey tanker
    mats.push(o.material);
  });
  g.add(body);
  const flames = [], glows = [];
  for (const [x, y, z] of c.nozzles) {
    const o = new THREE.Mesh(FLAME_GEO, FLAME_OUT); o.position.set(x, y, z);
    const k = new THREE.Mesh(FLAME_GEO, FLAME_CORE); k.position.set(x, y, z);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x9fc4ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    sp.position.set(x, y, z + 0.3);
    g.add(o, k, sp);
    flames.push(o, k); glows.push(sp);
  }
  if (key === 'tanker') {
    const a = 0.45, len = 18;
    const boom = new THREE.Mesh(Cyl(0.35, 0.35, len, 8).rotateX(Math.PI / 2 + a), new THREE.MeshStandardMaterial({ color: '#c8ced6', metalness: 0.6, roughness: 0.4 }));
    boom.position.set(0, -4 - Math.sin(a) * len / 2, 16 + Math.cos(a) * len / 2);
    g.add(boom);
  }
  const base = key === 'tanker' ? [2.4, 2.45, 2.6] : key === 'player' ? [0.42, 0.45, 0.5] : [1, 1, 1];
  g.userData = { mats, flames, glows, base, span: c.span, len: c.len, flameScale: c.flame };
  return g;
}
function makeSam() {
  const a = 0.6;
  const geo = partsGeo([
    [new THREE.BoxGeometry(9, 3, 7), '#4d5a3a', 0, 1.5, 0],
    [new THREE.BoxGeometry(3.2, 2.4, 3), '#3b452c', 0, 4.2, 2],
    [Cyl(0.55, 0.55, 7, 8).rotateX(a - Math.PI / 2), '#d9d9d9', 1, 5.5, -1],
    [Cyl(0.55, 0.55, 7, 8).rotateX(a - Math.PI / 2), '#d9d9d9', -1, 5.5, -1],
    [new THREE.BoxGeometry(1.2, 1.4, 8), '#2a2f22', 4.6, 0.7, 0],
    [new THREE.BoxGeometry(1.2, 1.4, 8), '#2a2f22', -4.6, 0.7, 0],
  ]);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, metalness: 0.2, roughness: 0.8 });
  const g = new THREE.Group();
  const sm = new THREE.Mesh(geo, mat); sm.castShadow = sm.receiveShadow = true;
  g.add(sm);
  g.userData = { mats: [mat], flames: [], glows: [], base: [1, 1, 1], span: 10, len: 8, flameScale: 1 };
  return g;
}
function setFlame(g, len) {
  const { flames, glows, flameScale: s } = g.userData;
  for (let i = 0; i < flames.length; i += 2) {
    const l = len * (G.harness ? 1 : rand(0.85, 1.15));
    flames[i].scale.set(s * 0.8, s * 0.8, Math.max(0.01, l * 1.4 * s));
    flames[i + 1].scale.set(s * 0.55, s * 0.55, Math.max(0.01, l * 0.9 * s));
    flames[i].visible = flames[i + 1].visible = len > 0.05;
  }
  for (const sp of glows) {
    sp.visible = len > 0.05;
    sp.scale.setScalar(s * (0.55 + len * 0.35) * (G.harness ? 1 : rand(0.94, 1.06)));
    sp.material.opacity = clamp(0.2 + len * 0.25, 0, 0.5);
  }
}
function setFlash(g, on) { for (const m of g.userData.mats) m.emissive.setScalar(on ? 0.8 : 0); }

const pools = {};
function acquire(key) {
  const pool = pools[key] || (pools[key] = []);
  const o = pool.pop() || (key === 'sam' ? makeSam() : makeModel(key));
  o.userData.key = key;
  o.rotation.set(0, 0, 0);
  setFlash(o, false);
  for (const m of o.userData.mats) m.color.setRGB(...o.userData.base);
  scene.add(o);
  return o;
}
function release(o) {
  if (!o) return;
  scene.remove(o);
  (pools[o.userData.key] || (pools[o.userData.key] = [])).push(o);
}

// Blob shadows under aircraft
const SHADOW_GEO = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const shadowPool = [];
function getShadow() {
  const s = shadowPool.pop() || new THREE.Mesh(SHADOW_GEO, new THREE.MeshBasicMaterial({
    map: shadowTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
  }));
  scene.add(s);
  return s;
}
function dropShadow(s) { if (s) { scene.remove(s); shadowPool.push(s); } }
function placeShadow(s, x, y, d, span, len) {
  const gy = groundAt(x, d);
  const alt = y - gy;
  const a = clamp(1 - alt / 220, 0, 1) * (STG().water ? 0.8 : 0.3);
  s.visible = a > 0.02 && d < FAR;
  s.position.set(x, gy + 0.6, -d);
  const grow = 1 + alt / 200;
  s.scale.set(span * grow, 1, len * grow);
  s.material.opacity = a;
}
const groundAt = (x, d) => {
  const st = STG();
  if (st.water) return 0;
  const h = terrainH(x, d + G.dist);
  return st.terrain && st.terrain.sea != null ? Math.max(h, st.terrain.sea) : h;   // flooded valley floor
};

// ============================================================ scenery props
const VC_LAM = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
let ISLAND_MAT = null; // built once the Scenario meadow texture has loaded
const TOWER_MAT = new THREE.MeshLambertMaterial({ color: '#3a3b40', emissive: '#ffffff', emissiveMap: windowTex, emissiveIntensity: 1.1 });
const hemiDome = r => new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);

// Each generator returns a geometry variant (or a ready Object3D) plus placement hints.
const PROP_GEN = {
  // Irregular forested island: noise-displaced dome wearing the Scenario meadow/rock texture,
  // ringed by a sand beach and a turquoise shallows band.
  warehouse: () => ({ tall: true, obj: TEMPLATES.warehouse.clone(true) }),
  tanks: () => ({ tall: true, obj: TEMPLATES.tanks.clone(true) }),
  radar: () => ({ tall: true, obj: TEMPLATES.radar.clone(true) }),
  island: () => {
    const rx = rand(160, 360), rz = rx * rand(0.55, 0.9), h = rand(45, 120);
    const dome = new THREE.SphereGeometry(1, 48, 20, 0, Math.PI * 2, 0, Math.PI / 2);
    const pos = dome.attributes.position, ph = rand(0, 6);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), a = Math.atan2(z, x);
      const n = 1 + 0.22 * Math.sin(a * 3 + ph) + 0.12 * Math.sin(a * 7 + ph * 2) + 0.06 * Math.sin(a * 13);
      const ridge = 1 + 0.25 * Math.sin(x * 9 + ph) * Math.cos(z * 7);
      pos.setXYZ(i, x * rx * n, Math.pow(Math.max(y, 0), 1.4) * h * ridge, z * rz * n);
    }
    dome.computeVertexNormals();
    const g = new THREE.Group();
    const land = new THREE.Mesh(dome, ISLAND_MAT || VC_LAM); land.position.y = 0.5;
    const beach = new THREE.Mesh(Cyl(1, 1.04, 1, 48).scale(rx * 1.1, 1.2, rz * 1.1), new THREE.MeshLambertMaterial({ color: '#e9d8a6' }));
    const shallows = new THREE.Mesh(Cyl(1, 1, 1, 48).scale(rx * 1.35, 0.4, rz * 1.35), new THREE.MeshLambertMaterial({ color: '#3fc6c8', transparent: true, opacity: 0.55 }));
    shallows.position.y = 0.1;
    g.add(land, beach, shallows);
    stageGeos.push(dome);
    return { wide: true, minX: rx * 1.35 + 240, obj: g };
  },
  seaRock: () => ({ geo: partsGeo([[new THREE.DodecahedronGeometry(rand(8, 18), 1).scale(1, rand(0.9, 1.8), 1), '#59616b', 0, 3, 0]]) }),
  cactus: () => ({ geo: partsGeo([
    [Cyl(1.1, 1.3, 12, 8), '#3d7a3a', 0, 6, 0],
    [Cyl(0.8, 0.8, 5, 8), '#3d7a3a', 2.4, 8, 0], [Cyl(0.8, 0.8, 2.6, 8), '#3d7a3a', 1.3, 5.6, 0, Math.PI / 2],
    [Cyl(0.8, 0.8, 4, 8), '#3d7a3a', -2.4, 7, 0], [Cyl(0.8, 0.8, 2.6, 8), '#3d7a3a', -1.3, 5, 0, Math.PI / 2],
  ]) }),
  trees: () => {
    const parts = [];
    for (let i = 0, n = randi(6, 12); i < n; i++) {
      const h = rand(10, 22), r = rand(3.5, 6), x = rand(-30, 30), z = rand(-30, 30);
      parts.push([Cone(r, h, 7), pick(['#1f5a2a', '#2a6e32', '#356f2a', '#24603a']), x, h / 2 + 1.5, z]);
      parts.push([Cyl(0.6, 0.8, 3, 5), '#5a3b22', x, 1.5, z]);
    }
    return { geo: partsGeo(parts) };
  },
  house: () => ({ geo: partsGeo([
    [new THREE.BoxGeometry(10, 6, 8), pick(['#d8c7a5', '#e6e0d0', '#c9b48e']), 0, 3, 0],
    [Cone(7.5, 4, 4).rotateY(Math.PI / 4).scale(1, 1, 0.8), pick(['#9b3b2a', '#6b4a3a', '#3a5a8a']), 0, 8, 0],
  ]) }),
  rockSmall: () => ({ geo: partsGeo([[new THREE.DodecahedronGeometry(rand(6, 14), 1), '#8f4a2c', 0, 3, 0]]) }),
  tower: () => {
    const w = rand(28, 55), h = rand(70, 240);
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, w).translate(0, h / 2, 0), TOWER_MAT);
    const beacon = new THREE.Mesh(NAV_GEO, BEACON); beacon.scale.setScalar(5); beacon.position.y = h + 2;
    g.add(body, beacon);
    return { tall: true, obj: g };
  },
  block: () => {
    const w = rand(60, 100), h = rand(14, 34), dpt = rand(40, 60);
    const g = new THREE.Group();
    g.add(new THREE.Mesh(partsGeo([[new THREE.BoxGeometry(w, h, dpt), '#26244a', 0, h / 2, 0]]), VC_LAM));
    const strip = new THREE.Mesh(new THREE.BoxGeometry(w + 1, 1.2, dpt + 1), NEON); strip.position.y = h;
    g.add(strip);
    return { tall: true, obj: g };
  },
  berg: () => ({ geo: partsGeo([
    [new THREE.IcosahedronGeometry(1, 1).scale(rand(30, 70), rand(14, 40), rand(30, 70)), '#f2f9ff', 0, 0, 0],
    [new THREE.IcosahedronGeometry(1, 1).scale(rand(15, 35), rand(10, 25), rand(15, 35)), '#bfe0f5', rand(-30, 30), 0, rand(-20, 20)],
  ]) }),
  puff: () => ({ geo: partsGeo([
    [new THREE.SphereGeometry(1, 18, 10).scale(rand(60, 140), rand(18, 40), rand(60, 140)), '#f4f7ff', 0, 0, 0],
    [new THREE.SphereGeometry(1, 18, 10).scale(rand(40, 80), rand(20, 35), rand(40, 80)), '#e6ecf8', rand(-60, 60), 4, rand(-40, 40)],
  ]) }),
};

// ============================================================ stages
// sky: a Scenario panorama key, or a gradient (night city). terrain: amplitude/corridor of the GPU mountains.
const STAGES = [
  { name: 'BLUE PACIFIC', sky: 'day', fog: [1800, 7000], water: '#2c5080', shallow: '#2a8a90', props: { island: 1 }, propCount: 7,
    cloudLayer: { coverage: 0.22, bottom: 300, top: 640 }, enemies: { fighter: 4, chaser: 3, swoop: 2 }, boss: 'SKY LEVIATHAN' },
  { name: 'DUNE SEA', sky: 'day', fog: [600, 2900], ground: 'sand', terrain: { biome: 'dunes', amp: 1, rock: '#ffe0b0', tex: 'sand', rockTex: 'canyon', tile: 120, rockTile: 200 , amb: 1.0 , alb: 0.55 },
    props: { cactus: 1 }, propCount: 0, cloudLayer: { coverage: 0.2, bottom: 450, top: 820 }, enemies: { fighter: 3, chaser: 3, swoop: 2, sam: 2 }, boss: 'SANDSTORM' },
  { name: 'EMERALD VALLEY', sky: 'day', fog: [650, 3400], ground: 'grass', terrain: { biome: 'valley', amp: 1, rock: '#ffffff', snow: 330, forest: [0, 300], sea: 21, seaCol: '#2e4458', riverCol: '#1e4f66', tex: 'moss', rockTex: 'cliff', tile: 420, rockTile: 110 },
    props: { trees: 1 }, propCount: 0, cloudLayer: { coverage: 0.2, bottom: 340, top: 720 }, enemies: { fighter: 3, chaser: 4, swoop: 2, sam: 1 }, boss: 'IRON HERON' },
  { name: 'RED CANYON', sky: 'sunset', fog: [350, 2300], ground: 'rock', terrain: { biome: 'canyon', amp: 1, rock: '#ffffff', riverCol: '#5a4a30', tex: 'desert', rockTex: 'canyon', tile: 160, rockTile: 130, nrm: 0.9 , amb: 0.9 , alb: 0.85 }, exposure: 1.0,
    props: { rockSmall: 1 }, propCount: 26, cloudLayer: { coverage: 0.3, bottom: 380, top: 820 }, enemies: { fighter: 3, chaser: 3, swoop: 1, sam: 2 }, boss: 'CANYON KING' },
  { name: 'HARBOR DUSK', sky: 'sunset', fog: [500, 3000], ground: 'sand', terrain: { biome: 'dunes', amp: 0.45, rock: '#ffffff', tex: 'sand', rockTex: 'canyon', tile: 120, rockTile: 200, nrm: 0.6 , amb: 1.2 , alb: 0.6, sea: 3, seaCol: '#3a4a58' },
    props: { warehouse: 3, tanks: 3, radar: 2, tower: 1 }, propCount: 70, cloudLayer: { coverage: 0.16, bottom: 520, top: 900 }, stars: 1, enemies: { fighter: 3, chaser: 4, swoop: 3, sam: 1 }, boss: 'NIGHT CROWN' },
  { name: 'STORM FRONT', sky: 'storm', fog: [600, 3600], exposure: 1.1, water: '#5a7080', shallow: '#3d6a74', props: { seaRock: 1 }, propCount: 0,
    // the storm panorama already is the overcast; the volumetric layer is just low ragged scud under it
    cloudLayer: { coverage: 0.3, bottom: 160, top: 700, density: 1.3, sun: 0.5, amb: 2.2, hj: 0.6 }, storm: true, enemies: { fighter: 4, chaser: 4, swoop: 2 }, boss: 'THUNDERHEAD' },
  { name: 'GLACIER LINE', sky: 'day', fog: [700, 3600], ground: 'ice', terrain: { biome: 'alpine', amp: 1, rock: '#9aa6b4', snow: 240, forest: [0, 210], sea: 17, seaCol: '#2a3e50', riverCol: '#2a4858', tex: 'tundra', rockTex: 'cliff', tile: 360, rockTile: 110 },
    props: { berg: 1 }, propCount: 0, cloudLayer: { coverage: 0.22, bottom: 360, top: 760 }, exposure: 0.8, enemies: { fighter: 4, chaser: 4, swoop: 2, sam: 2 }, boss: 'POLAR WARDEN' },
  // No ground at all: a dense volumetric cloud deck just below the jet stands in for the surface.
  { name: 'EDGE OF SPACE', sky: 'space', fog: [900, 3400], ground: 'cloud', noGround: true, terrain: { biome: 'dunes', amp: 0, rock: '#ffffff' },
    props: { puff: 1 }, propCount: 0, cloudLayer: { coverage: 0.97, bottom: -420, top: -4, density: 2.2 }, enemies: { fighter: 4, chaser: 5, swoop: 3 }, boss: 'ORBITAL ACE' },
];
const STG = () => STAGES[G.stageIdx];

// Distant island / headland silhouettes ringing the horizon (ocean stages): flat, fog-tinted, far
// enough to read as haze-softened landmasses like the reference's skyline.
const horizonGroup = new THREE.Group();
scene.add(horizonGroup);
function buildHorizon(st) {
  horizonGroup.clear();
  if (!st.water) return;
  const col = new THREE.Color(scene.fog.color).lerp(new THREE.Color('#1c2a38'), st.storm ? 0.3 : 0.42);
  const mat = new THREE.MeshBasicMaterial({ color: col, fog: true });
  for (let i = 0; i < 16; i++) {
    const w = rand(600, 2000), h = rand(40, 150);
    const g = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(w, h, w * 0.4), mat);
    const ang = rand(-0.7, 0.7), dist = rand(5200, 6600);
    g.position.set(Math.sin(ang) * dist, -2, -Math.cos(ang) * dist);
    g.rotation.y = rand(0, 6);
    horizonGroup.add(g);
  }
}
const propGroup = new THREE.Group();
const cloudGroup = new THREE.Group();
scene.add(propGroup, cloudGroup);
let props = [], clouds = [], stageGeos = [];

// Rain streaks for the storm stage
const RAIN_N = 700;
const rainPos = new Float32Array(RAIN_N * 6);
const rainGeo = new THREE.BufferGeometry();
rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3).setUsage(THREE.DynamicDrawUsage));
const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xaab4c8, transparent: true, opacity: 0.4, fog: false }));
rain.frustumCulled = false;
scene.add(rain);
const drops = Array.from({ length: RAIN_N }, () => ({ x: 0, y: 0, d: 0 }));
function resetDrop(r, anywhere) {
  r.x = cam.x + rand(-160, 160);
  r.y = cam.y + rand(-70, 90);
  r.d = anywhere ? rand(-30, 320) : rand(250, 320);
}

function buildStage(st) {
  // sky + image-based lighting
  if (st.sky) {
    const sky = SKIES[st.sky];
    scene.background = null;
    scene.environment = ENV_TEX[st.sky];
    G.skyBright = SKY_BRIGHT * (sky.bright ?? 1);
    sunDir.copy(orientSky(sky));
    skyU.uMode.value = 1; skyU.uTex.value = SKY_TEX[st.sky]; skyU.uBright.value = G.skyBright;
    skyU.uSat.value = sky.sat ?? 2.6; skyU.uZenith.value = sky.zenith ?? 0.85; skyU.stars.value = 0;
    scene.fog.color.set(sky.hor).multiplyScalar(G.skyBright * 0.9);
    sunLight.color.set(sky.sunCol); sunLight.intensity = sky.sunI;
    hemi.color.set('#ffffff'); hemi.groundColor.set(st.water ? '#2a4a6a' : '#6a5a40'); hemi.intensity = sky.hemi;
    skyDome.visible = true;
  } else {
    skyU.uMode.value = 0;
    scene.background = null;
    scene.environment = ENV_TEX[st.env];
    skyU.top.value.set(st.grad[0]); skyU.mid.value.set(st.grad[1]); skyU.hor.value.set(st.grad[2]);
    sunDir.set(...st.sun).normalize();
    skyU.sunDir.value.copy(sunDir);
    skyU.sunCol.value.set(st.sunCol);
    skyU.stars.value = st.stars || 0;
    scene.fog.color.set(st.grad[2]).multiplyScalar(0.8);
    sunLight.color.set(st.sunCol); sunLight.intensity = st.sunI;
    hemi.color.set(st.hemi[0]); hemi.groundColor.set(st.hemi[1]); hemi.intensity = st.hemi[2];
    skyDome.visible = true;
  }
  G.hemiBase = hemi.intensity;
  G.fogBase = scene.fog.color.clone();
  scene.fog.near = st.fog[0]; scene.fog.far = st.fog[1];
  renderer.toneMappingExposure = EXPOSURE * (st.exposure || 1);

  // ground: ocean or displaced terrain
  // open sea, or a fjord / lake flooding the valley floor of a terrain stage (st.terrain.sea = water level)
  const sea = st.water ? 0 : st.terrain && st.terrain.sea;
  if (st.water || sea != null) {
    if (!ocean) { ocean = createOcean({ n0: OCEAN_TEX.n0, n1: OCEAN_TEX.n1, foamMap: OCEAN_TEX.foam }); scene.add(ocean.mesh); }
    ocean.mesh.visible = true;
    ocean.mesh.position.y = sea || 0;
    const fjord = !st.water;
    const u = ocean.uniforms, sky = SKIES[st.sky];
    ocean.setSky(SKY_TEX[st.sky], skyYaw);
    u.uSunDir.value.copy(sunDir);
    u.uSunColor.value.set(sky.sunCol);
    u.uDeep.value.set(st.water || st.terrain.seaCol || '#3b5468'); u.uShallow.value.set(st.shallow || '#2a8a90');
    u.uAmp.value = st.storm ? 2.4 : fjord ? 0.25 : 1;
    u.uFoamAmt.value = st.storm ? 0.7 : fjord ? 0 : 0.22;
    u.uSkyMix.value = st.storm ? 0.7 : fjord ? 0.6 : 1;
    u.uRoughBase.value = st.storm ? 0.16 : fjord ? 0.07 : 0.09;
    // sky reflection share: the reference sea keeps a saturated blue body; only the storm sea is mostly sky
    u.uFresMul.value = st.storm ? 4.0 : fjord ? 2.0 : (st.fresnel ?? 1.5);
    u.uDetailMul.value = st.storm ? 1 : fjord ? 1 : 1.6;
    u.uWind.value.set(st.storm ? 2.5 : 0.9, st.storm ? 7 : 3);
    u.uSunStrength.value = st.storm ? 0.12 : 1;
    u.uSkyTint.value.set(st.storm ? '#c8d0d8' : '#ffffff');
  } else if (ocean) ocean.mesh.visible = false;
  if (st.water) {
    terrain.visible = false;
  } else {
    terrain.visible = !st.noGround;
    activeBiome = null;
    const t = st.terrain || { amp: 1, rock: '#ffffff', biome: 'dunes' };
    activeBiome = st.noGround ? null : BIOMES[t.biome || 'valley'];
    terrainU.uAmp.value = t.amp ?? 1;
    const bt = activeBiome || BIOMES[t.biome || 'valley'];
    terrainU.uHeight.value = bt.hTex; terrainU.uTNormal.value = bt.nTex; terrainU.uMasks.value = bt.mTex;
    terrainU.uHMax.value = bt.hmax; terrainU.uWorldW.value = bt.worldW; terrainU.uWorldL.value = bt.worldL;
    terrainU.uRock.value.set(t.rock); terrainU.uSnow.value = t.snow ?? -1000;
    // Scenario aerial textures where the stage names one, procedural canvas textures otherwise.
    const tex = TERRAIN_TEX[t.tex] || groundTexture(st.ground);
    terrainU.uRockMap.value = TERRAIN_TEX[t.rockTex] || tex;
    terrainU.uTile.value = t.tile || TILE;
    terrainU.uRockTile.value = t.rockTile || 160;
    terrainU.uGndNrm.value = TERRAIN_NRM[t.tex] || FLAT_NRM;
    terrainU.uRockNrm.value = TERRAIN_NRM[t.rockTex] || TERRAIN_NRM[t.tex] || FLAT_NRM;
    terrainU.uGndRgh.value = TERRAIN_RGH[t.tex] || FLAT_RGH;
    terrainU.uForestMap.value = TERRAIN_TEX.forest; terrainU.uForestNrm.value = TERRAIN_NRM.forest;
    terrainU.uSnowMap.value = TERRAIN_TEX.snow; terrainU.uSnowNrm.value = TERRAIN_NRM.snow;
    terrainU.uRockRgh.value = TERRAIN_RGH[t.rockTex] || TERRAIN_RGH[t.tex] || FLAT_RGH;
    terrainU.uNrmStr.value = t.nrm ?? 1.1;
    terrainU.uAmbScale.value = t.amb ?? 0.7;   // fjords are hard-lit; desert / dusk stages keep a hazy fill
    terrainU.uAlbedo.value = t.alb ?? 1.0;        // pale sand / clay would blow out under the full sun
    terrainU.uRghInv.value = TERRAIN_RGH[t.tex] ? 1 : 0; // PATINA returns smoothness, not roughness
    terrainU.uForest.value.set(t.forest ? t.forest[0] : -1, t.forest ? t.forest[1] : -1);
    terrainU.uRiverCol.value.set(t.riverCol || '#1d4a5e');
    terrainU.uSunDirW.value.copy(sunDir);
    const old = terrain.material;
    terrain.material = terrainMaterial(st.city
      ? { map: tex, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.9 }
      : { map: tex });
    old.dispose();
  }

  // props
  if (!ISLAND_MAT && TERRAIN_TEX.meadow) {
    const t = TERRAIN_TEX.meadow.clone();
    t.repeat.set(3, 3); t.needsUpdate = true;
    ISLAND_MAT = new THREE.MeshLambertMaterial({ map: t });
  }
  propGroup.clear(); cloudGroup.clear();
  for (const g of stageGeos) g.dispose();
  stageGeos = [];
  const variants = {};
  for (const k of Object.keys(st.props)) {
    variants[k] = [];
    for (let i = 0; i < 5; i++) {
      const v = PROP_GEN[k]();
      if (v.geo) stageGeos.push(v.geo);
      variants[k].push(v);
    }
  }
  props = [];
  for (let i = 0; i < st.propCount; i++) {
    const kind = weighted(st.props);
    const v = pick(variants[kind]);
    const obj = v.obj ? v.obj.clone() : new THREE.Mesh(v.geo, VC_LAM);
    propGroup.add(obj);
    const p = { obj, kind, tall: v.tall, wide: v.wide, minX: v.minX || 0, x: 0, y: 0, d: 0 };
    placeProp(p, rand(-CAM_BACK, RANGE - CAM_BACK));
    props.push(p);
  }

  // clouds
  // Volumetric cloud layer (clouds.js): coverage / altitude band / lighting per stage.
  clouds = [];
  if (cloudPass) {
    const cu = cloudPass.u, cl = st.cloudLayer || { coverage: 0, bottom: 300, top: 800 };
    cloudPass.enabledClouds = cl.coverage > 0.01;
    cu.uCoverage.value = cl.coverage; cu.uBottom.value = cl.bottom; cu.uTop.value = cl.top; cu.uDensity.value = cl.density ?? 1; cu.uHJitter.value = cl.hj ?? 0.22;
    // Energy-sane cloud lighting: sun ≈1.5× the sky's sun colour, ambient ≈ horizon→white. Values above
    // ~3 linear saturate the tonemapper and turn clouds into featureless white (the r2 regression).
    const sunC = new THREE.Color(st.sky ? SKIES[st.sky].sunCol : st.sunCol).multiplyScalar(cl.sun ?? (st.storm ? 0.6 : 1.5));
    cu.uSunCol.value.copy(sunC); cloudPass.sunBase = sunC.clone();
    cu.uSunDir.value.copy(sunDir);
    const hor = new THREE.Color(scene.fog.color);
    cu.uAmbTop.value.copy(hor).lerp(new THREE.Color('#ffffff'), 0.35).multiplyScalar(0.85);
    cu.uAmbBot.value.copy(hor).lerp(new THREE.Color('#8c9ab4'), 0.5).multiplyScalar(0.8);
    cu.uAmbMul.value = cl.amb ?? 1.3;
    cu.uFogCol.value.copy(scene.fog.color);
    cu.uFogNear.value = st.fog[0] * 0.8; cu.uFogFar.value = st.fog[1] * 0.9;
    // cloud shadows on terrain and water (weather map projected along the sun); off when the layer is off or below us
    const shadowOn = cloudPass.enabledClouds && !st.noGround && cl.bottom > 0;
    const cp = [cl.coverage, cu.uCovSoft.value, (cl.bottom + cl.top) * 0.5, shadowOn ? (cl.shadow ?? 0.7) : 0];
    terrainU.uWeather.value = CLOUD_DATA.weather; terrainU.uWeatherScale.value = cu.uWeatherScale.value; terrainU.uCloudP.value.set(...cp);
    if (ocean) { const u = ocean.uniforms; u.uWeather.value = CLOUD_DATA.weather; u.uWeatherScale.value = cu.uWeatherScale.value; u.uCloudP.value.set(...cp); }
  }

  buildHorizon(st);
  rain.visible = !!st.storm;
  if (st.storm) for (const r of drops) resetDrop(r, true);
}

function placeProp(p, d) {
  p.d = d;
  let x = rand(-1400, 1400);
  // Keep a clear flight corridor (player lane is |x| <= X_LIM) free of anything tall.
  if (p.minX && Math.abs(x) < p.minX) x = sign() * rand(p.minX, p.minX + 1000);
  else if (p.wide && Math.abs(x) < 420) x = sign() * rand(420, 1400);
  else if (p.tall && Math.abs(x) < 300) x = sign() * rand(300, 1400);
  const st = STG(), sea = st.terrain && st.terrain.sea;
  if (sea != null) for (let i = 0; i < 6 && terrainH(x, d + G.dist) < sea + 1; i++) x = sign() * rand(p.tall ? 300 : 120, 1400);   // not in the harbour water
  p.x = x;
  p.y = groundAt(x, d) - (st.terrain ? 1.5 : 0);
  p.obj.rotation.y = rand(0, Math.PI * 2);
}

// ============================================================ particles
// pextra = (rotation, atlas variant [4 = soft round], shading amount)
const PV = `attribute float psize; attribute vec4 pcolor; attribute vec3 pextra; uniform float uScale;
  varying vec4 vC; varying vec3 vX;
  void main(){ vC = pcolor; vX = pextra; vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = min(psize * uScale / max(-mv.z, 0.5), 1400.0); gl_Position = projectionMatrix * mv; }`;
const PF = `uniform sampler2D uTex; varying vec4 vC; varying vec3 vX;
  void main(){
    vec2 p = gl_PointCoord - 0.5;
    if (vX.y > 3.5) {
      float a = clamp(1.0 - dot(p, p) * 4.0, 0.0, 1.0); a *= a;
      if (a * vC.a < 0.01) discard;
      gl_FragColor = vec4(vC.rgb, vC.a * a); return;
    }
    float c = cos(vX.x), s = sin(vX.x);
    vec2 q = vec2(c * p.x - s * p.y, s * p.x + c * p.y) + 0.5;
    if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) discard;
    vec2 cell = vec2(mod(vX.y, 2.0), floor(vX.y / 2.0));
    vec4 t = texture2D(uTex, (q + cell) * 0.5);
    float a = t.a * vC.a;
    if (a < 0.01) discard;
    // light from above (gl_PointCoord y grows downward), unaffected by the puff's rotation
    float shade = mix(1.0, 1.15 - 0.75 * smoothstep(-0.45, 0.45, p.y * 0.9 + p.x * 0.3), vX.z);
    gl_FragColor = vec4(vC.rgb * t.rgb * shade, a);
  }`;
class FXLayer {
  constructor(max, blending) {
    this.max = max; this.list = [];
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max); this.extra = new Float32Array(max * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pextra', new THREE.BufferAttribute(this.extra, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    const m = new THREE.ShaderMaterial({ uniforms: pointUniforms, vertexShader: PV, fragmentShader: PF, transparent: true, depthWrite: false, blending });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
}
const ADD = new FXLayer(2500, THREE.AdditiveBlending);   // flashes, sparks, engine/missile glows
const SMOKE = new FXLayer(10000, THREE.NormalBlending);   // fire, smoke, trails, debris (depth-sorted)
ADD.points.renderOrder = 2;
SMOKE.points.renderOrder = 1;
const KF = 0, KS = 1, KG = 2, KM = 3, KD = 4; // fire, spark, glow, smoke, debris
const SHADE = [0.35, 0, 0, 0.7, 0.4];

function fx(L, kind, x, y, d, vx, vy, vd, life, size, r = 1, g = 1, b = 1, a = 1) {
  if (G.noFx) return;
  if (kind === KF || kind === KD) L = SMOKE; // fire is drawn solid (HDR colours still bloom)
  if (L.list.length >= L.max) return;
  const round = kind === KS || kind === KG;
  L.list.push({ kind, x, y, d, vx, vy, vd, life, max: life, size, r, g, b, a,
    rot: rand(0, Math.PI * 2), rv: rand(-0.7, 0.7), v: round ? 4 : randi(0, 3) });
}
function updateFX(L, dt) {
  const list = L.list;
  let j = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    p.life -= dt;
    if (p.life <= 0) continue;
    if (p.kind !== KG) {
      // drag toward "still air", which streams past at the player's speed
      const k = damp(p.kind === KD ? 0.8 : p.kind === KM ? 1.3 : 2.2, dt);
      p.vx -= p.vx * k; p.vy -= p.vy * k; p.vd += (-G.speed - p.vd) * k;
      if (p.kind === KD) p.vy -= 60 * dt;
      else if (p.kind === KM || p.kind === KF) p.vy += 4 * dt; // hot smoke rises
    }
    p.x += p.vx * dt; p.y += p.vy * dt; p.d += p.vd * dt;
    p.rot += p.rv * dt;
    if (p.d < -CAM_BACK - 5) continue;
    list[j++] = p;
  }
  list.length = j;
}
function writeFX(L) {
  const { list, pos, col, size, extra } = L;
  if (L === SMOKE) list.sort((a, b) => b.d - a.d); // back-to-front for correct alpha blending
  for (let i = 0; i < list.length; i++) {
    const p = list[i], a = p.life / p.max, t = 1 - a;
    pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = -p.d;
    let r, g, b, al, s;
    switch (p.kind) {
      case KF: { // white-hot -> orange -> dark red -> soot
        let u;
        if (t < 0.12) { r = 4.5; g = 3.8; b = 2.4; }
        else if (t < 0.45) { u = (t - 0.12) / 0.33; r = lerp(4.5, 3.3, u); g = lerp(3.8, 1.2, u); b = lerp(2.4, 0.25, u); }
        else if (t < 0.75) { u = (t - 0.45) / 0.3; r = lerp(3.3, 0.55, u); g = lerp(1.2, 0.17, u); b = lerp(0.25, 0.06, u); }
        else { u = (t - 0.75) / 0.25; r = lerp(0.55, 0.09, u); g = lerp(0.17, 0.075, u); b = 0.06; }
        al = Math.min(1, a * 2.4); s = p.size * (0.55 + t * 1.7); break;
      }
      case KS: r = 3.5; g = 2.6; b = 1.2; al = a; s = p.size; break;
      case KG: r = p.r; g = p.g; b = p.b; al = a * p.a; s = p.size; break;
      case KM: r = p.r; g = p.g; b = p.b; al = p.a * Math.min(1, a * 1.6); s = p.size * (1 + t * 2.2); break;
      default: r = 0.05; g = 0.045; b = 0.04; al = Math.min(1, a * 2); s = p.size;
    }
    al *= clamp((p.d + CAM_BACK - 2) / 25, 0, 1);
    col[i * 4] = r; col[i * 4 + 1] = g; col[i * 4 + 2] = b; col[i * 4 + 3] = al;
    size[i] = s;
    extra[i * 3] = p.rot; extra[i * 3 + 1] = p.v; extra[i * 3 + 2] = SHADE[p.kind];
  }
  L.geo.setDrawRange(0, list.length);
  for (const k of ['position', 'pcolor', 'psize', 'pextra']) L.geo.attributes[k].needsUpdate = true;
}
// Multi-stage blast: flash -> billowing fireball -> lingering dark smoke, plus sparks and debris.
function explode(x, y, d, s = 1, vx = 0, vy = 0, vd = 0) {
  fx(ADD, KG, x, y, d, vx * 0.5, vy * 0.5, vd * 0.5, 0.18, 75 * s, 4, 3.2, 2.2, 1);
  const nf = Math.round(16 * s);
  for (let i = 0; i < nf; i++) {
    const [ux, uy, uz] = randDir(), sp = rand(8, 38) * s;
    fx(SMOKE, KF, x + ux * 3 * s, y + uy * 3 * s, d + uz * 3 * s, vx * 0.6 + ux * sp, vy * 0.6 + uy * sp + 4, vd * 0.85 + uz * sp, rand(0.8, 1.4), rand(9, 16) * s);
  }
  const ns = Math.round(16 * s);
  for (let i = 0; i < ns; i++) {
    const [ux, uy, uz] = randDir(), dk = rand(0.06, 0.11);
    fx(SMOKE, KM, x + ux * 4 * s, y + uy * 4 * s, d + uz * 4 * s, vx * 0.4 + ux * 12 * s, vy * 0.4 + uy * 8 * s + 6, vd * 0.7 + uz * 12 * s,
      rand(2.8, 4.8), rand(8, 14) * s, dk, dk * 0.85, dk * 0.72, 0.92);
  }
  for (let i = 0; i < 14 * s; i++) {
    const [ux, uy, uz] = randDir(), sp = rand(80, 220) * s;
    fx(ADD, KS, x, y, d, vx + ux * sp, vy + uy * sp, vd + uz * sp, rand(0.3, 0.7), rand(0.8, 1.6));
  }
  for (let i = 0; i < 7 * s; i++) {
    const [ux, uy, uz] = randDir(), sp = rand(30, 90);
    fx(SMOKE, KD, x, y, d, vx + ux * sp, vy + Math.abs(uy) * sp + 20, vd + uz * sp, rand(1.2, 2), rand(1, 2.4));
  }
}
// Continuous smoke trail: emit puffs every `step` metres along the path flown since last frame.
function emitTrail(m, x0, y0, d0, step, life, size, c, a) {
  const dx = m.x - x0, dy = m.y - y0, dd = m.d - d0, L = Math.hypot(dx, dy, dd);
  if (L <= 0) return;
  m.trailAcc = (m.trailAcc || 0) + L;
  while (m.trailAcc >= step) {
    m.trailAcc -= step;
    const f = 1 - m.trailAcc / L;
    fx(SMOKE, KM, x0 + dx * f, y0 + dy * f, d0 + dd * f, rand(-1.5, 1.5), rand(-1.5, 1.5), -G.speed, life * rand(0.85, 1.15), size, c, c, c * 1.02, a);
  }
}

// ============================================================ instanced shots
const dummy = new THREE.Object3D();
function makeInst(geo, mat, max) {
  const m = new THREE.InstancedMesh(geo, mat, max);
  m.frustumCulled = false;
  m.count = 0;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(m);
  return m;
}
const tracerMesh = makeInst(new THREE.BoxGeometry(0.35, 0.35, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(5, 3.6, 1.2) }), 300);
const ebMesh = makeInst(new THREE.IcosahedronGeometry(1.4, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(5, 1.6, 0.4) }), 200);
const MISSILE_GEO = Cyl(0.24, 0.24, 3.2, 8).rotateX(Math.PI / 2);
const pmMesh = makeInst(MISSILE_GEO, new THREE.MeshStandardMaterial({ color: '#e8e8e8', roughness: 0.4 }), 80);
const emMesh = makeInst(MISSILE_GEO, new THREE.MeshStandardMaterial({ color: '#d03030', roughness: 0.4 }), 80);
function syncInst(mesh, list) {
  let n = 0;
  const max = mesh.instanceMatrix.count;
  for (const o of list) {
    if (n >= max) break;
    dummy.position.set(o.x, o.y, -o.d);
    dummy.lookAt(o.x + o.vx, o.y + o.vy, -(o.d + o.vd));
    dummy.updateMatrix();
    mesh.setMatrixAt(n++, dummy.matrix);
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
}

// ============================================================ game state
const cam = { x: 0, y: 140, pitch: 0, roll: 0, shake: 0 };
const P = {
  alive: true, x: 0, y: 60, vx: 0, vy: 0, bank: 0, rollAng: 0, rollT: 0, rollCd: 0, rollDir: 1,
  hull: 100, inv: 0, gunT: 0, gunSide: 1, mslT: 0, mslSide: 1, missiles: MAX_MSL, lockCd: 0, locks: [],
  fuel: 100, fuelLock: false, obj: null, shadow: null,
};

const G = {
  state: 'title', phase: 'fly', paused: false, demo: true, auto: params.has('auto') || params.has('bot'), god: params.has('auto'),
  t: 0, stageIdx: 0, loop: 0, stageTime: 0, spawnT: 2, bossSpawned: false, boss: null,
  score: 0, hi: Number(store('acefighter.hi')) || 50000, newHi: false, lives: 3, stageKills: 0, stageSpawned: 0, stageScore0: 0,
  combo: 0, comboT: 0, comboPop: 0,
  speed: SPD_BASE, dist: 0, diff: 1, hemiBase: 1,
  enemies: [], pb: [], pm: [], em: [], eb: [], pops: [],
  msgs: [], alerts: [], hurt: 0, whiteout: 0, lightning: 0, fade: 0,
  alert: false, alarmT: 0, ct: 0, tanker: null, tally: null, deadT: 0, goT: 0, wreck: null,
  invertY: store('acefighter.invert') === '1', musicOn: store('acefighter.music') !== '0',
  cross: { x: W / 2, y: H / 2 }, err: null,
};
SFX.setMusic(G.musicOn);
const snd = (name, ...a) => { if (!G.demo) SFX[name](...a); };

function addMsg(text, sub, dur = 2.5, color = '#ffffff') {
  if (G.demo) return;
  G.msgs.push({ text, sub, dur, color, t: 0 });
}
function addAlert(text, color = '#ff6060', dur = 1.4) {
  if (G.demo || G.alerts.some(a => a.text === text)) return;
  G.alerts.push({ text, color, dur, t: 0 });
}
function addScore(n, at) {
  if (G.demo) return;
  G.score += n;
  if (at) G.pops.push({ x: at.x, y: at.y + 6, d: at.d, text: String(n), t: 0 });
}

// ============================================================ enemies
const DEF = {
  fighter: { hp: 3, rx: 8.5, ry: 4.5, score: 500, model: 'enemy' },
  chaser: { hp: 5, rx: 8.5, ry: 4.5, score: 1000, model: 'enemy' },
  swoop: { hp: 2, rx: 8.5, ry: 5, score: 400, model: 'enemy' },
  sam: { hp: 2, rx: 7, ry: 6, score: 300, model: 'sam' },
  boss: { hp: 120, rx: 26, ry: 8, score: 10000, model: 'boss' },
};
function addEnemy(type, o) {
  const e = Object.assign({ type, t: 0, vx: 0, vy: 0, vd: 0, flash: 0, fireT: rand(1, 2), dead: false, gone: false, inbound: 0, lockT: 0 }, DEF[type], o);
  e.maxHp = e.hp;
  e.obj = acquire(e.model);
  e.shadow = type === 'sam' ? null : getShadow();
  G.enemies.push(e);
  if (!G.demo) G.stageSpawned++;
  return e;
}
function releaseEnemy(e) { release(e.obj); dropShadow(e.shadow); e.obj = e.shadow = null; }

function spawnWave() {
  const st = STG(), d = G.diff;
  const type = weighted(st.enemies);
  if (type === 'fighter') {
    // a third of the groups come straight down the player's line for close head-on fly-bys
    const flyby = Math.random() < 0.33;
    const n = flyby ? randi(1, 2) : randi(3, Math.min(8, 4 + Math.floor(d * 1.5)));
    const bx = flyby ? P.x + sign() * rand(18, 40) : P.x * 0.5 + rand(-160, 160);
    const by = flyby ? clamp(P.y + rand(-12, 12), Y_MIN + 10, Y_MAX) : rand(Y_MIN + 25, Y_MAX - 15), vee = Math.random() < 0.5;
    for (let i = 0; i < n; i++) {
      const off = i - (n - 1) / 2;
      addEnemy('fighter', {
        x: bx + off * (vee ? 40 : 50), y: by + (vee ? -Math.abs(off) * 6 : 0), d: FAR + (vee ? Math.abs(off) * 70 : 0),
        spd: rand(180, 260) + d * 15, amp: flyby ? rand(2, 8) : rand(20, 70), w: rand(0.8, 1.6), ph: rand(0, 6), fireD: rand(700, 1100),
      });
    }
  } else if (type === 'chaser') {
    const n = randi(1, Math.min(4, 1 + Math.floor(d + 0.5)));
    for (let i = 0; i < n; i++) {
      addEnemy('chaser', {
        x: P.x + rand(-160, 160), y: clamp(P.y + rand(20, 60), Y_MIN, Y_MAX + 50), d: rand(-150, -60) - i * 60,
        holdD: rand(280, 520), holdY: rand(Y_MIN + 20, Y_MAX - 10), offX: rand(-110, 110), state: 'in',
      });
    }
    addAlert('TAIL WARNING');
    if (Math.random() < 0.25 + d * 0.1) spawnEM(P.x + rand(-80, 80), P.y + rand(-20, 30), -560);
  } else if (type === 'swoop') {
    const n = randi(4, 7), dir = sign(), dd = rand(450, 800), y = rand(Y_MIN + 30, Y_MAX);
    for (let i = 0; i < n; i++) {
      addEnemy('swoop', { x: cam.x - dir * (900 + i * 85), y: y + i * 8, d: dd + i * 30, dir, spdx: rand(380, 460), ph: i * 0.6 });
    }
  } else if (type === 'sam') {
    for (let i = 0, n = randi(2, 3); i < n; i++) {
      const x = cam.x + rand(-350, 350), dd = FAR - i * rand(60, 160);
      addEnemy('sam', { x, y: groundAt(x, dd) + 1, d: dd, shots: 1 + (Math.random() < d - 1 ? 1 : 0), fireT: rand(0, 1) });
    }
  }
}
function spawnBoss() {
  G.bossSpawned = true;
  const st = STG();
  G.boss = addEnemy('boss', {
    x: P.x, y: Math.min(P.y + 45, Y_MAX + 60), d: -140, state: 'in',
    hp: 110 + G.stageIdx * 15 + G.loop * 60, mslT: 3, flakT: 2, fightT: 0, name: st.boss,
  });
  G.boss.maxHp = G.boss.hp;
  addMsg('WARNING', 'BOSS APPROACHING · ' + st.boss, 3, '#ff4040');
  snd('warning');
}
function spawnEM(x, y, d, up = false) {
  const spd = 300 + G.diff * 40;
  const dx = P.x - x, dy = P.y - y, dd = -d, L = Math.hypot(dx, dy, dd) || 1;
  const m = { x, y, d, vx: dx / L * spd, vy: dy / L * spd, vd: dd / L * spd, spd, t: 0, homing: true, side: Math.sign(d) || 1, turn: 1.6 + G.diff * 0.35, trailT: 0 };
  if (up) { m.vy = spd * 0.8; m.vx *= 0.3; m.vd *= 0.5; }
  G.em.push(m);
}
function fireFlak(e, n) {
  const spd = 380, dx = P.x - e.x, dy = P.y - e.y, dd = -e.d, L = Math.hypot(dx, dy, dd) || 1, tt = L / spd;
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * 9;
    G.eb.push({ x: e.x, y: e.y - 2, d: e.d, vx: (dx + off) / tt, vy: (dy + Math.abs(off) * 0.3) / tt, vd: dd / tt, t: 0, side: 1 });
  }
}

function updateEnemy(e, dt) {
  if (e.wreckT !== undefined) { updateWreck(e, dt); return; }
  e.t += dt; e.flash -= dt; e.lockT += dt;
  const d = G.diff;
  switch (e.type) {
    case 'fighter':
      e.vd = -(G.speed + e.spd);
      e.vx = Math.cos(e.t * e.w + e.ph) * e.amp * e.w;
      e.vy = Math.cos(e.t * e.w * 0.7 + e.ph) * e.amp * 0.35 * e.w + (P.y - e.y) * 0.25;
      if (!e.fired && e.d < e.fireD) { e.fired = true; if (P.alive && Math.random() < 0.35 + 0.15 * d) spawnEM(e.x, e.y, e.d - 6); }
      break;
    case 'chaser': {
      const tx = P.x + e.offX + Math.sin(e.t * 1.3) * 75;
      if (e.state === 'in') {
        e.vd = clamp((e.holdD - e.d) * 1.4, 70, 520);
        e.vx = clamp((tx - e.x) * 1.0, -230, 230);
        e.vy = clamp((e.holdY - e.y) * 1.2, -140, 140);
        if (e.d > e.holdD - 25) { e.state = 'hold'; e.holdT = rand(4, 7); e.fireT = rand(0.6, 1.4); }
      } else if (e.state === 'hold') {
        e.vd = (e.holdD + Math.sin(e.t * 0.9) * 50 - e.d) * 1.5;
        e.vx = clamp((tx - e.x) * 1.1, -220, 220);
        e.vy = clamp((e.holdY + Math.sin(e.t * 1.7) * 22 - e.y) * 1.5, -140, 140);
        e.fireT -= dt;
        if (e.fireT <= 0) { e.fireT = rand(2.0, 3.2) / d; if (P.alive) spawnEM(e.x, e.y, e.d); }
        e.holdT -= dt;
        if (e.holdT <= 0) e.state = 'out';
      } else { e.vd += 450 * dt; e.vy += 80 * dt; e.vx *= 0.98; }
      break;
    }
    case 'swoop':
      e.vx = e.dir * e.spdx; e.vd = -40; e.vy = Math.sin(e.t * 2 + e.ph) * 40;
      if (!e.fired && Math.abs(e.x - P.x) < 80 && Math.random() < 0.03 * d) { e.fired = true; fireFlak(e, 3); }
      if ((e.x - cam.x) * e.dir > 1000) e.gone = true;
      break;
    case 'sam':
      e.vd = -G.speed; e.vx = e.vy = 0;
      if (e.shots > 0 && e.d < 1300 && e.d > 300) {
        e.fireT -= dt;
        if (e.fireT <= 0) { e.shots--; e.fireT = 1.2; if (P.alive) spawnEM(e.x, e.y + 8, e.d, true); }
      }
      break;
    case 'boss':
      if (e.dying > 0) {
        e.dying -= dt; e.vd = -30; e.vy = -45; e.vx *= 0.98; e.spin = (e.spin || 0) + dt * 0.35;
        e.boomT -= dt;
        if (e.boomT <= 0) { e.boomT = 0.12; explode(e.x + rand(-24, 24), e.y + rand(-4, 4), e.d + rand(-15, 15), 1.1, 0, 0, e.vd); snd('explode', false); }
        if (e.dying <= 0) { explode(e.x, e.y, e.d, 3.5, 0, 0, e.vd); snd('explode', true); cam.shake = 1; e.gone = true; }
        break;
      }
      if (e.state === 'in') {
        e.vd = clamp((650 - e.d) * 0.9, 80, 420);
        e.vx = (P.x - e.x) * 0.5;
        e.vy = (85 - e.y) * 0.6;
        if (e.d > 600) e.state = 'fight';
      } else if (e.state === 'fight') {
        e.fightT += dt;
        const bx = cam.x * 0.6 + Math.sin(e.t * 0.45) * 170, by = 85 + Math.sin(e.t * 0.8) * 40, bd = 650 + Math.sin(e.t * 0.35) * 120;
        e.vx = clamp((bx - e.x) * 0.9, -170, 170); e.vy = (by - e.y) * 1.2; e.vd = (bd - e.d) * 1.0;
        e.mslT -= dt;
        if (e.mslT <= 0 && P.alive) {
          e.mslT = rand(2.6, 3.4) / Math.sqrt(d);
          const n = 2 + Math.min(3, Math.floor(G.stageIdx / 2));
          for (let i = 0; i < n; i++) spawnEM(e.x + (i - (n - 1) / 2) * 12, e.y - 4, e.d - 10);
        }
        e.flakT -= dt;
        if (e.flakT <= 0 && P.alive) { e.flakT = rand(1.3, 1.9) / Math.sqrt(d); fireFlak(e, 5 + Math.floor(G.stageIdx / 3) * 2); }
        if (e.fightT > 45) { e.state = 'out'; addMsg('TARGET ESCAPED', null, 2, '#ffb060'); }
      } else {
        e.vd += 300 * dt; e.vy += 40 * dt;
        if (e.d > FAR + 400) e.gone = true;
      }
      break;
  }
  e.x += e.vx * dt; e.y += e.vy * dt; e.d += e.vd * dt;
  if (e.type !== 'sam') e.y = Math.max(e.y, groundAt(e.x, e.d) + 15);

  // ramming
  if (P.alive && !e.dead && e.type !== 'sam' && Math.abs(e.d) < 8 && Math.abs(e.x - P.x) < e.rx * 0.8 && Math.abs(e.y - P.y) < e.ry * 1.3) {
    damagePlayer(50);
    if (e.type !== 'boss') hurtEnemy(e, 99);
  }
  // Bosses and chasers spawn behind the camera and overtake, so only cull ones that are falling back.
  if ((e.d < -CAM_BACK - 100 && e.vd <= 0) || e.d < -CAM_BACK - 600 || e.d > FAR + 900) e.gone = true;

  // sync 3D
  const o = e.obj;
  o.position.set(e.x, e.y, -e.d);
  switch (e.type) {
    case 'fighter': o.rotation.set(clamp(e.vy * 0.004, -0.5, 0.5), Math.PI, clamp(e.vx * 0.006, -1, 1)); break;
    case 'chaser': o.rotation.set(clamp(e.vy * 0.004, -0.4, 0.4), -e.vx * 0.0015, -clamp(e.vx * 0.006, -1.1, 1.1)); break;
    case 'swoop': o.rotation.set(0, e.dir > 0 ? -Math.PI / 2 : Math.PI / 2, -e.dir * 0.6 + Math.sin(e.t * 2) * 0.1); break;
    case 'boss': o.rotation.set(e.dying > 0 ? -0.12 : 0, 0, -clamp(e.vx * 0.002, -0.3, 0.3) - (e.spin || 0)); break;
  }
  if (e.type !== 'sam') setFlame(o, e.type === 'fighter' ? 0 : 0.9);
  setFlash(o, e.flash > 0);
  if (e.shadow) placeShadow(e.shadow, e.x, e.y, e.d, o.userData.span, o.userData.len);
}

function hurtEnemy(e, dmg) {
  if (e.dead) return;
  e.hp -= dmg; e.flash = 0.06;
  if (e.hp > 0) return;
  e.dead = true;
  G.combo++; G.comboT = 3; G.comboPop = 1;
  addScore(Math.round(e.score * (1 + Math.min(G.combo, 30) * 0.1)), e);
  G.stageKills++;
  if (e.type === 'boss') {
    e.dying = 2.4; e.boomT = 0; e.killed = true;
    addMsg('TARGET DESTROYED', e.name, 2.5, '#7fffb0');
    snd('explode', true);
    return;
  }
  explode(e.x, e.y, e.d, e.type === 'sam' ? 1.3 : 1.6, e.vx * 0.4, e.vy * 0.4, e.vd);
  snd('explode', false);
  if (e.type === 'sam') { e.gone = true; return; }
  // Shot-down jets don't vanish: they tumble away burning, trailing smoke, until they hit the ground.
  e.wreckT = rand(2.6, 3.6);
  e.vy += rand(5, 20); e.vx += rand(-40, 40);
  e.spinX = rand(-2, 2); e.spinZ = rand(-5, 5); e.trailT = 0;
  for (const m of e.obj.userData.mats) m.color.setScalar(0.22);
  setFlame(e.obj, 0);
}
function updateWreck(e, dt) {
  e.wreckT -= dt;
  e.vd += (-G.speed - e.vd) * damp(0.5, dt); // airframe loses speed relative to the player
  e.vy -= 30 * dt; e.vx *= 1 - 0.4 * dt;
  const px = e.x, py = e.y, pd = e.d;
  e.x += e.vx * dt; e.y += e.vy * dt; e.d += e.vd * dt;
  e.obj.position.set(e.x, e.y, -e.d);
  e.obj.rotation.x += e.spinX * dt;
  e.obj.rotation.z += e.spinZ * dt;
  emitTrail(e, px, py, pd, 4, 2.6, 2.8, 0.07, 0.85);
  e.trailT -= dt;
  if (e.trailT <= 0) {
    e.trailT = 0.03;
    fx(SMOKE, KF, e.x + rand(-2, 2), e.y + rand(-1, 1), e.d + rand(-2, 2), rand(-4, 4), rand(0, 6), e.vd * 0.5, rand(0.35, 0.6), rand(3.5, 6));
  }
  if (e.shadow) placeShadow(e.shadow, e.x, e.y, e.d, e.obj.userData.span, e.obj.userData.len);
  if (e.y <= groundAt(e.x, e.d) + 2) { explode(e.x, e.y, e.d, 0.9, 0, 0, -G.speed); e.gone = true; }
  else if (e.wreckT <= 0 || e.d < -CAM_BACK - 60) e.gone = true;
}

// ============================================================ player
function damagePlayer(n) {
  if (!P.alive || P.inv > 0 || G.demo || G.god || G.phase !== 'fly') return;
  P.hull -= n;
  G.hurt = 1; cam.shake = Math.max(cam.shake, 0.6);
  G.combo = 0;
  snd('hit');
  for (let i = 0; i < 20; i++) {
    const [ux, uy, uz] = randDir();
    fx(ADD, KS, P.x, P.y, 0, ux * 60, uy * 60, uz * 60 - G.speed * 0.2, 0.5, 1.2);
  }
  if (P.hull <= 0) killPlayer();
  else P.inv = 0.7;
}
function killPlayer() {
  P.alive = false; P.hull = 0;
  G.phase = 'dying'; G.deadT = 0; G.combo = 0;
  explode(P.x, P.y, 0, 2.2, P.vx * 0.3, 0, -G.speed * 0.2);
  G.wreck = { x: P.x, y: P.y, d: 0, vx: P.vx * 0.5, vy: 5, spin: P.bank, smokeT: 0 };
  for (const m of P.obj.userData.mats) m.color.setScalar(0.3);
  P.locks.length = 0;
  snd('explode', true);
  cam.shake = 1.2;
}
function resetPlayer() {
  Object.assign(P, { alive: true, x: 0, y: 60, vx: 0, vy: 0, bank: 0, rollAng: 0, rollT: 0, rollCd: 0, hull: 100, inv: 2, gunT: 0, mslT: 0, lockCd: 0, fuel: 100, fuelLock: false });
  P.locks = [];
  P.obj.visible = true;
  for (const m of P.obj.userData.mats) m.color.setRGB(...P.obj.userData.base);
  G.wreck = null;
}

function fireGun() {
  P.gunSide = -P.gunSide;
  const ox = P.x + P.gunSide * 1.6, oy = P.y - 0.3, od = 9;
  let vx = 0, vy = 0, best = 1e9;
  const consider = (tx, ty, td, tvx, tvy, tvd, r) => {
    if (td < 60 || td > 1600) return;
    const tf = (td - od) / (BULLET_SPD - tvd);
    if (tf <= 0) return;
    const ex = tx + tvx * tf, ey = ty + tvy * tf, ddx = ex - P.x, ddy = ey - P.y, tol = 14 + r;
    if (Math.abs(ddx) < tol && Math.abs(ddy) < tol * 0.85) {
      const sc = ddx * ddx + ddy * ddy + td * 0.5;
      if (sc < best) { best = sc; vx = (ex - ox) / tf; vy = (ey - oy) / tf; }
    }
  };
  for (const e of G.enemies) if (!e.dead) consider(e.x, e.y, e.d, e.vx, e.vy, e.vd, e.rx);
  for (const m of G.em) consider(m.x, m.y, m.d, m.vx, m.vy, m.vd, 4);
  G.pb.push({ x: ox, y: oy, d: od, pd: od, vx: vx + rand(-4, 4), vy: vy + rand(-4, 4), vd: BULLET_SPD, life: 0.95 });
  fx(ADD, KG, ox, oy, od, 0, 0, 0, 0.05, 2.4, 4, 3, 1.5, 1);
  snd('gun');
}
// Salvo: one missile per locked target, dropped from alternating pylons and fanned out sideways.
function fireSalvo() {
  const targets = P.locks.filter(e => !e.dead);
  const n = Math.max(1, Math.min(targets.length, G.demo ? 99 : Math.floor(P.missiles)));
  for (let i = 0; i < n; i++) {
    const target = targets[i] || null;
    if (target) target.inbound++;
    P.mslSide = -P.mslSide;
    const fan = n > 1 ? (i - (n - 1) / 2) / ((n - 1) / 2) : 0;
    G.pm.push({ x: P.x + P.mslSide * (2.5 + Math.abs(fan) * 3), y: P.y - 1.4, d: 2 + i * 1.5, vx: P.vx * 0.5 + fan * 90, vy: -25 - Math.abs(fan) * 15, vd: 60, t: -i * 0.04, target });
    if (!G.demo) P.missiles = Math.max(0, P.missiles - 1);
  }
  snd('missile');
}

function updatePlayer(dt, c) {
  const ySign = G.invertY ? -1 : 1;
  let tvx = c.ix * 270;
  const tvy = c.iy * ySign * 175;
  if (P.rollT > 0) {
    P.rollT -= dt;
    tvx = P.rollDir * 420;
    P.rollAng = P.rollT > 0 ? P.rollDir * Math.PI * 2 * (1 - P.rollT / ROLL_DUR) : 0;
  }
  P.vx = lerp(P.vx, tvx, damp(6, dt));
  P.vy = lerp(P.vy, tvy, damp(6, dt));
  P.x += P.vx * dt; P.y += P.vy * dt;
  const floor = Math.max(Y_MIN, groundAt(P.x, 0) + 14); // skim waves / valley floors
  if (P.x < -X_LIM) { P.x = -X_LIM; P.vx = Math.max(0, P.vx); }
  if (P.x > X_LIM) { P.x = X_LIM; P.vx = Math.min(0, P.vx); }
  if (P.y < floor) { P.y = floor; P.vy = Math.max(0, P.vy); }
  if (P.y > Y_MAX) { P.y = Y_MAX; P.vy = Math.min(0, P.vy); }
  P.bank = lerp(P.bank, clamp(P.vx / 270 * 1.6, -1.5, 1.5), damp(5, dt)); // up to ~85° in hard turns
  P.rollCd -= dt; P.inv -= dt;
  if ((c.rollL || c.rollR) && P.rollCd <= 0) {
    P.rollDir = c.rollL ? -1 : 1; P.rollT = ROLL_DUR; P.rollCd = ROLL_DUR + 0.35;
    snd('roll');
  }
  P.gunT -= dt;
  if (c.fire && P.gunT <= 0) { fireGun(); P.gunT = 1 / 14; }
  P.mslT -= dt;
  if (c.missile && P.mslT <= 0 && P.missiles >= 1) { fireSalvo(); P.mslT = 0.55; }

  // afterburner fuel: drains while boosting, recovers otherwise; empty tank locks boost until 30%
  if (G.boosting) { P.fuel = Math.max(0, P.fuel - dt * 22); if (P.fuel <= 0) P.fuelLock = true; }
  else { P.fuel = Math.min(100, P.fuel + dt * 11); if (P.fuel > 30) P.fuelLock = false; }

  // wingtip vapour when pulling hard or on afterburner
  const thrust = clamp((G.speed - SPD_BRAKE) / (SPD_BOOST - SPD_BRAKE), 0, 1);
  if (Math.abs(P.vx) > 170 || Math.abs(P.vy) > 140 || thrust > 0.75) {
    const a = -(P.bank + P.rollAng), hs = MODEL_CFG.player.span * 0.5, cx = Math.cos(a) * hs, cy = Math.sin(a) * hs;
    fx(SMOKE, KM, P.x + cx, P.y + cy, -3, 0, 0, -G.speed, 0.4, 0.55, 1, 1, 1, 0.4);
    fx(SMOKE, KM, P.x - cx, P.y - cy, -3, 0, 0, -G.speed, 0.4, 0.55, 1, 1, 1, 0.4);
  }
  // white spray kicked up off the sea when skimming the waves
  if (STG().water && P.y < 34) {
    const k = clamp(1 - (P.y - Y_MIN) / 22, 0, 1);
    for (let i = 0; i < 3; i++) {
      fx(SMOKE, KM, P.x + rand(-5, 5), 0.8, rand(-14, -4), rand(-12, 12), rand(8, 22) * k, -G.speed * 0.4,
        rand(0.5, 0.9), rand(2, 3.5), 0.95, 0.97, 1, 0.5 * k);
    }
  }
  // engine heat trail
  if (thrust > 0.3) for (const [nx, ny] of MODEL_CFG.player.nozzles) fx(SMOKE, KM, P.x + nx, P.y + ny, -9.5, 0, 0, -G.speed, 0.3, 0.9, 0.95, 0.95, 1, 0.12 * thrust);
}

// ============================================================ shots
function updateShots(dt) {
  // player cannon
  for (const b of G.pb) {
    b.pd = b.d;
    b.x += b.vx * dt; b.y += b.vy * dt; b.d += b.vd * dt; b.life -= dt;
    if (b.life <= 0) { b.dead = true; continue; }
    for (const e of G.enemies) {
      if (e.dead) continue;
      const slack = Math.abs(e.vd) * dt + 6;
      if (e.d < b.pd - slack || e.d > b.d + slack) continue;
      if (Math.abs(b.x - e.x) < e.rx && Math.abs(b.y - e.y) < e.ry) {
        hurtEnemy(e, 1); b.dead = true;
        for (let i = 0; i < 4; i++) { const [ux, uy, uz] = randDir(); fx(ADD, KS, b.x, b.y, e.d, ux * 80, uy * 80, e.vd + uz * 80, 0.25, 1); }
        break;
      }
    }
    if (b.dead) continue;
    for (const m of G.em) {
      if (m.dead || m.d < b.pd - 15 || m.d > b.d + 15) continue;
      if (Math.abs(b.x - m.x) < 6 && Math.abs(b.y - m.y) < 6) {
        m.dead = true; b.dead = true;
        explode(m.x, m.y, m.d, 0.5, 0, 0, m.vd * 0.3);
        snd('small'); addScore(100, m);
        break;
      }
    }
  }
  sweep(G.pb);

  // player missiles
  for (const m of G.pm) {
    m.t += dt;
    const tg = m.target && !m.target.dead ? m.target : null;
    if (m.t < 0.15) m.vy -= 60 * dt;
    else {
      const spd = Math.min(1500, 350 + (m.t - 0.15) * 3200);
      let dx, dy, dd;
      if (tg) { dx = tg.x - m.x; dy = tg.y - m.y; dd = tg.d - m.d; } else { dx = m.vx; dy = m.vy; dd = Math.max(m.vd, 50); }
      const L = Math.hypot(dx, dy, dd) || 1, k = damp(tg ? 10 : 2, dt);
      m.vx = lerp(m.vx, dx / L * spd, k); m.vy = lerp(m.vy, dy / L * spd, k); m.vd = lerp(m.vd, dd / L * spd, k);
      fx(ADD, KG, m.x, m.y, m.d, 0, 0, 0, 0.03, 3.2, 4, 2.4, 0.8, 1);
    }
    const px = m.x, py = m.y, pd = m.d;
    m.x += m.vx * dt; m.y += m.vy * dt; m.d += m.vd * dt;
    if (m.t >= 0.12) emitTrail(m, px, py, pd, 3, 1.6, 3.4, 0.96, 0.6); // thick white trail
    for (const e of G.enemies) {
      if (e.dead) continue;
      const slack = Math.abs(m.vd - e.vd) * dt + 6;
      if (Math.abs(m.x - e.x) < e.rx + 3 && Math.abs(m.y - e.y) < e.ry + 3 && Math.abs(m.d - e.d) < slack) {
        explode(m.x, m.y, m.d, 0.6, 0, 0, e.vd);
        hurtEnemy(e, 6);
        m.dead = true;
        break;
      }
    }
    if (m.t > 4 || m.d > FAR + 300 || m.d < -40) m.dead = true;
    if (m.dead && m.target) m.target.inbound--;
  }
  sweep(G.pm);

  // enemy missiles
  let alert = false;
  for (const m of G.em) {
    m.t += dt;
    if (m.homing) {
      if (!P.alive || Math.abs(m.d) < 90 || m.t > 6) m.homing = false;
      else {
        const tgo = Math.abs(m.d) / Math.max(60, Math.abs(m.vd));
        const tx = P.x + P.vx * tgo * 0.85, ty = P.y + P.vy * tgo * 0.85;
        const dx = tx - m.x, dy = ty - m.y, dd = -m.d, L = Math.hypot(dx, dy, dd) || 1, k = damp(m.turn, dt);
        m.vx = lerp(m.vx, dx / L * m.spd, k); m.vy = lerp(m.vy, dy / L * m.spd, k); m.vd = lerp(m.vd, dd / L * m.spd, k);
        alert = true;
      }
    }
    const px = m.x, py = m.y, pd = m.d;
    m.x += m.vx * dt; m.y += m.vy * dt; m.d += m.vd * dt;
    emitTrail(m, px, py, pd, 2.5, 2.0, 3.2, 0.9, 0.58);
    const side = Math.sign(m.d) || 1;
    if (side !== m.side && !m.passed) {
      m.passed = true;
      if (P.alive && Math.abs(m.x - P.x) < 9 && Math.abs(m.y - P.y) < 7) {
        if (P.rollT > 0.05 || P.inv > 0 || G.demo || G.god) { addAlert('EVADED', '#7fffb0', 0.8); snd('evade'); }
        else { damagePlayer(34); explode(m.x, m.y, m.d, 0.7, 0, 0, 0); m.dead = true; }
      }
    }
    m.side = side;
    fx(ADD, KG, m.x, m.y, m.d, 0, 0, 0, 0.03, 4, 4, 1.4, 0.4, 1);
    if (m.t > 8 || m.d < -CAM_BACK - 200 || m.d > FAR + 600) m.dead = true;
  }
  sweep(G.em);
  G.alert = alert && P.alive;

  // enemy flak
  for (const b of G.eb) {
    b.t += dt;
    b.x += b.vx * dt; b.y += b.vy * dt; b.d += b.vd * dt;
    const side = Math.sign(b.d) || 1;
    if (side !== b.side && !b.passed) {
      b.passed = true;
      if (P.alive && Math.abs(b.x - P.x) < 6 && Math.abs(b.y - P.y) < 5 && P.rollT <= 0.05) { damagePlayer(12); b.dead = true; }
    }
    b.side = side;
    if (b.t > 4 || b.d < -CAM_BACK - 50) b.dead = true;
  }
  sweep(G.eb);
}

// ============================================================ lock-on
const _v = new THREE.Vector3();
function toScreen(x, y, d, out = { x: 0, y: 0, ok: false }) {
  _v.set(x, y, -d).project(camera);
  out.x = (_v.x + 1) * 0.5 * W;
  out.y = (1 - _v.y) * 0.5 * H;
  out.ok = d > -CAM_BACK + 2 && _v.z < 1;
  return out;
}
const _s = { x: 0, y: 0, ok: false };
function screenDist(e) {
  toScreen(e.x, e.y, e.d, _s);
  return _s.ok ? Math.hypot(_s.x - G.cross.x, _s.y - G.cross.y) : 1e9;
}
function updateLocks(dt) {
  toScreen(P.x, P.y, AIM_D, _s);
  G.cross.x = _s.x; G.cross.y = _s.y;
  const inRange = e => !e.dead && e.d > 80 && e.d < 1600 && !(e.type === 'boss' && e.state === 'in');
  P.locks = P.locks.filter(e => inRange(e) && screenDist(e) < LOCK_R * 1.8);
  P.lockCd -= dt;
  if (!P.alive || P.lockCd > 0 || P.locks.length >= MAX_LOCKS) return;
  let best = null, bd = LOCK_R;
  for (const e of G.enemies) {
    if (!inRange(e) || P.locks.includes(e)) continue;
    const sd = screenDist(e);
    if (sd < bd) { bd = sd; best = e; }
  }
  if (best) { P.locks.push(best); best.lockT = 0; P.lockCd = 0.07; snd('lock'); }
}

// ============================================================ flow
function startStage(i) {
  G.stageIdx = i; G.stageTime = 0; G.spawnT = 2.5; G.bossSpawned = false; G.boss = null;
  G.stageKills = 0; G.stageSpawned = 0; G.stageScore0 = G.score;
  G.diff = 1 + i * 0.12 + G.loop * 0.45;
  for (const e of G.enemies) releaseEnemy(e);
  G.enemies.length = 0;
  G.em.length = 0; G.eb.length = 0; G.pm.length = 0; G.pb.length = 0;
  if (G.tanker) { release(G.tanker.obj); G.tanker = null; }
  G.tally = null; G.phase = 'fly';
  P.locks.length = 0;
  buildStage(STAGES[i]);
  G.fade = 1;
  addMsg(`STAGE ${pad(i + 1, 2)}`, STAGES[i].name, 3);
  if (params.has('boss')) G.stageTime = STAGE_LEN;
}
function newGame() {
  G.state = 'play'; G.demo = false; G.paused = false;
  G.score = 0; G.lives = 3; G.loop = 0; G.combo = 0;
  G.msgs.length = 0; G.alerts.length = 0;
  resetPlayer(); P.missiles = MAX_MSL;
  cam.x = 0; cam.y = P.y + CAM_UP;
  startStage(START_STAGE);
  SFX.select();
}
function startDemo() {
  G.state = 'title'; G.demo = true; G.paused = false; G.loop = 0;
  G.msgs.length = 0; G.alerts.length = 0;
  resetPlayer(); P.missiles = MAX_MSL;
  startStage(pick([0, 1, 2, 3, 5]));
}
function respawn() {
  resetPlayer(); P.inv = 3; P.missiles = Math.max(P.missiles, 20);
  G.phase = 'fly'; G.em.length = 0; G.eb.length = 0;
  addMsg('READY', `${G.lives} ${G.lives === 1 ? 'PLANE' : 'PLANES'} LEFT`, 1.6, '#9fd3ff');
}
function gameOver() {
  G.state = 'gameover'; G.phase = 'over'; G.goT = 0;
  G.newHi = G.score > G.hi;
  if (G.newHi) { G.hi = G.score; store('acefighter.hi', String(G.hi)); }
  SFX.gameover();
}
function stageClear(killed) {
  if (G.phase !== 'fly') return;
  G.phase = 'clear'; G.ct = 0;
  for (const e of G.enemies) if (e.type === 'chaser') e.state = 'out';
  for (const m of G.em) explode(m.x, m.y, m.d, 0.4, 0, 0, m.vd * 0.3);
  G.em.length = 0; G.eb.length = 0;
  const kb = G.stageKills * 100 * (1 + G.loop), bb = killed ? 20000 * (1 + G.loop) : 0;
  if (!G.demo) G.score += kb + bb;
  G.tally = { kills: G.stageKills, spawned: Math.max(G.stageSpawned, G.stageKills), kb, bb, stageScore: G.score - G.stageScore0 };
  addMsg(killed ? 'STAGE CLEAR' : 'STAGE COMPLETE', STG().name, 2.6, '#ffe27a');
  snd('jingle');
}
function nextStage() {
  let i = G.stageIdx + 1;
  if (i >= STAGES.length) {
    i = 0; G.loop++;
    addMsg('MISSION COMPLETE', `ROUND ${G.loop + 1} · ENEMY FORCES REINFORCED`, 4, '#ffd36b');
  }
  P.missiles = MAX_MSL;
  startStage(i);
}

function updateDirector(dt) {
  if (G.noSpawn) return;
  G.stageTime += dt;
  let alive = 0;
  for (const e of G.enemies) if (!e.dead) alive++;
  if (G.stageTime < STAGE_LEN) {
    G.spawnT -= dt;
    if (G.spawnT <= 0 && alive < 14 + G.diff * 2) { spawnWave(); G.spawnT = rand(0.9, 1.7) / Math.sqrt(G.diff); }
  } else if (!G.bossSpawned) {
    if (alive === 0 || G.stageTime > STAGE_LEN + 5) spawnBoss();
  } else if (G.boss && G.boss.gone) {
    stageClear(!!G.boss.killed);
  } else if (G.boss && !G.boss.dead) {
    G.spawnT -= dt;
    if (G.spawnT <= 0 && alive < 4) {
      G.spawnT = rand(4, 6);
      addEnemy('chaser', { x: P.x + rand(-160, 160), y: clamp(P.y + 30, Y_MIN, Y_MAX), d: -120, holdD: rand(250, 400), holdY: rand(Y_MIN + 20, Y_MAX - 10), offX: rand(-110, 110), state: 'in' });
    }
  }
}
function updateClear(dt) {
  G.ct += dt;
  if (G.ct > 2.6 && !G.tanker) {
    G.tanker = { x: P.x, y: P.y + 34, d: -160, vd: 0, state: 'in', obj: acquire('tanker') };
    addMsg('RESUPPLY', 'HOLD STEADY BEHIND THE TANKER', 3, '#9fd3ff');
  }
  const tk = G.tanker;
  if (tk) {
    if (tk.state === 'in') { tk.vd = clamp((90 - tk.d) * 1.2, 25, 300); if (G.ct > 8.4) tk.state = 'out'; }
    else tk.vd += 250 * dt;
    tk.d += tk.vd * dt;
    tk.x = lerp(tk.x, P.x, damp(1.5, dt));
    tk.y = lerp(tk.y, Math.min(P.y + 34, Y_MAX + 40), damp(1.5, dt));
    tk.obj.position.set(tk.x, tk.y, -tk.d);
    setFlame(tk.obj, 0.7);
    if (G.ct > 4.5 && G.ct < 8.2 && P.alive) {
      const before = Math.floor(P.missiles);
      P.missiles = Math.min(MAX_MSL, P.missiles + dt * 20);
      P.hull = Math.min(100, P.hull + dt * 40);
      P.fuel = 100;
      if (Math.floor(P.missiles) !== before) snd('blip');
    }
  }
  if (G.ct > 10.5) nextStage();
}
function updateDying(dt) {
  G.deadT += dt;
  const w = G.wreck;
  if (w) {
    w.vy -= 30 * dt; w.y += w.vy * dt; w.x += w.vx * dt; w.d -= 25 * dt; w.spin += dt * 4;
    w.smokeT -= dt;
    if (w.smokeT <= 0) {
      w.smokeT = 0.02;
      fx(SMOKE, KM, w.x, w.y, w.d, 0, 0, -G.speed, 1.6, 3, 0.12, 0.11, 0.1, 0.8);
      fx(ADD, KF, w.x, w.y, w.d, rand(-5, 5), rand(-5, 5), -G.speed * 0.3, 0.4, 3);
    }
    P.obj.position.set(w.x, w.y, -w.d);
    P.obj.rotation.set(-0.4, 0, -w.spin);
    setFlame(P.obj, 0);
    if (w.y <= groundAt(w.x, w.d) + 2) { explode(w.x, w.y, w.d, 2, 0, 0, -G.speed); snd('explode', true); P.obj.visible = false; G.wreck = null; }
  }
  if (G.deadT > 3) {
    G.lives--;
    if (G.lives > 0) respawn(); else gameOver();
  }
}

// ============================================================ autopilot (attract mode)
function autopilot() {
  const c = { ix: 0, iy: 0, fire: true, missile: false, boost: false, brake: false, rollL: false, rollR: false };
  let tgt = null, best = 1e9;
  for (const e of G.enemies) {
    if (e.dead || e.d < 100 || e.d > 1300 || e.type === 'sam') continue;
    const sc = e.d + Math.abs(e.x - P.x) * 2;
    if (sc < best) { best = sc; tgt = e; }
  }
  let tx = Math.sin(G.t * 0.3) * 120, ty = 55 + Math.sin(G.t * 0.5) * 35;
  if (tgt) { tx = tgt.x; ty = tgt.y; }
  for (const m of G.em) if (!m.passed && Math.abs(m.d) < 300) { tx = P.x + (m.x < P.x ? 1 : -1) * 150; break; }
  c.ix = clamp((tx - P.x) / 50, -1, 1);
  c.iy = clamp((ty - P.y) / 40, -1, 1) * (G.invertY ? -1 : 1);
  c.missile = P.locks.length > 0 && Math.random() < 0.06;
  c.boost = Math.sin(G.t * 0.2) > 0.7;
  return c;
}

// ============================================================ world step
function stepWorld(dt, c) {
  G.t += dt;
  G.boosting = P.alive && c.boost && !P.fuelLock && P.fuel > 0;
  const target = !P.alive ? SPD_BASE * 0.8 : G.boosting ? SPD_BOOST : c.brake ? SPD_BRAKE : SPD_BASE;
  G.speed = lerp(G.speed, target, damp(2, dt));
  G.dist += G.speed * dt;
  if (P.alive) updatePlayer(dt, c);
  updateCamera(dt);

  if (G.phase === 'fly') updateDirector(dt);
  else if (G.phase === 'clear') updateClear(dt);
  else if (G.phase === 'dying') updateDying(dt);

  for (const e of G.enemies) updateEnemy(e, dt);
  for (const e of G.enemies) if (e.gone) releaseEnemy(e);
  sweep(G.enemies, 'gone');
  if (G.tanker && G.tanker.d > FAR) { release(G.tanker.obj); G.tanker = null; }

  updateShots(dt);
  updateLocks(dt);
  updateScenery(dt);
  updateFX(ADD, dt); updateFX(SMOKE, dt);

  for (const p of G.pops) { p.t += dt; p.d -= G.speed * 0.15 * dt; }
  G.pops = G.pops.filter(p => p.t < 1);
  if (G.msgs.length) { G.msgs[0].t += dt; if (G.msgs[0].t > G.msgs[0].dur) G.msgs.shift(); }
  for (const a of G.alerts) a.t += dt;
  G.alerts = G.alerts.filter(a => a.t < a.dur);
  if (G.combo > 0) { G.comboT -= dt; if (G.comboT <= 0) G.combo = 0; }
  G.comboPop = Math.max(0, G.comboPop - dt * 4);

  cam.shake = Math.max(0, cam.shake - dt * 1.8);
  G.hurt = Math.max(0, G.hurt - dt * 2.5);
  G.whiteout = Math.max(0, G.whiteout - dt * 1.6);
  G.fade = Math.max(0, G.fade - dt * 1.4);
  G.lightning = Math.max(0, G.lightning - dt * 2.5);
  if (STG().storm && Math.random() < dt * 0.25) { G.lightning = 0.7; snd('thunder'); }

  if (G.alert) { G.alarmT -= dt; if (G.alarmT <= 0) { G.alarmT = 0.35; snd('alarm'); } }
  const thrust = clamp((G.speed - SPD_BRAKE) / (SPD_BOOST - SPD_BRAKE), 0, 1);
  SFX.engine(G.demo ? 0.25 : P.alive ? 1 : 0.2, thrust);
}

function updateCamera(dt) {
  if (G.camOverride) { // harness: fixed camera
    const c = G.camOverride;
    camera.position.set(...c.pos); camera.up.set(0, 1, 0); camera.lookAt(...c.look);
    if (c.roll) camera.rotateZ(-c.roll);
    if (c.fov && camera.fov !== c.fov) { camera.fov = c.fov; camera.updateProjectionMatrix(); }
    camera.updateMatrixWorld(); updateSunShadow(); return;
  }
  const k = damp(6, dt);
  // Deliberate lag, like the reference: while manoeuvring the jet swings toward the left/right
  // third of the screen, then eases back to centre as it straightens out. It's derived from the
  // (already smoothed) player velocity and clamped, so the jet can never leave the frame — an
  // eased positional follow would lag ~v/k metres and lose it at this close range.
  if (P.alive) {
    cam.lagX = lerp(cam.lagX || 0, clamp(P.vx * 0.026, -6.5, 6.5), damp(3, dt));
    cam.lagY = lerp(cam.lagY || 0, clamp(P.vy * 0.02, -3, 3), damp(3, dt));
    cam.x = P.x - cam.lagX;
    cam.y = P.y + CAM_UP - cam.lagY;
  } else {
    cam.y = lerp(cam.y, Math.max(cam.y, 40), k);
  }
  cam.pitch = lerp(cam.pitch, P.alive ? P.vy * 0.05 : 0, damp(4, dt));
  // Horizon tilts with the bank (~40° at full bank), on top of which the jet itself rolls on screen.
  cam.roll = lerp(cam.roll, P.alive ? P.bank * 0.48 + Math.sin(P.rollAng) * 0.3 : 0, damp(4, dt));
  const sh = G.harness ? 0 : cam.shake * 1.2;
  camera.position.set(cam.x + rand(-sh, sh), cam.y + rand(-sh, sh), CAM_BACK);
  camera.lookAt(lerp(cam.x, P.x, 0.25), cam.y - 4 + cam.pitch, -140);
  camera.rotateZ(-cam.roll);
  const fovT = FOV + clamp((G.speed - SPD_BASE) / (SPD_BOOST - SPD_BASE), 0, 1) * 14;
  if (Math.abs(camera.fov - fovT) > 0.05) { camera.fov = lerp(camera.fov, fovT, damp(3, dt)); camera.updateProjectionMatrix(); }
  const boostAmt = clamp((G.speed - SPD_BASE) / (SPD_BOOST - SPD_BASE), 0, 1);
  speedBlur.uniforms.uStrength.value = lerp(speedBlur.uniforms.uStrength.value, boostAmt * 0.085, damp(4, dt));
  speedBlur.enabled = speedBlur.uniforms.uStrength.value > 0.004; // skip the 10-tap pass when not boosting
  camera.updateMatrixWorld();
  updateSunShadow();
}

function updateScenery(dt) {
  const mv = G.speed * dt;
  for (const p of props) {
    p.d -= mv;
    if (p.d < -CAM_BACK - 120) placeProp(p, p.d + RANGE);
    p.obj.position.set(p.x, p.y, -p.d);
  }
  if (cloudPass) { cloudPass.u.uDist.value = G.dist; cloudPass.u.uTime.value += dt; }
  terrainU.uDist.value = G.dist;
  if (ocean && ocean.mesh.visible) ocean.update(dt, G.dist);
  if (rain.visible) {
    for (let i = 0; i < RAIN_N; i++) {
      const r = drops[i];
      r.y -= 90 * dt; r.d -= mv;
      if (r.d < -CAM_BACK + 2 || r.y < cam.y - 80) resetDrop(r, false);
      const o = i * 6;
      rainPos[o] = r.x; rainPos[o + 1] = r.y; rainPos[o + 2] = -r.d;
      rainPos[o + 3] = r.x; rainPos[o + 4] = r.y + 2.5; rainPos[o + 5] = -(r.d + G.speed * 0.02);
    }
    rainGeo.attributes.position.needsUpdate = true;
  }
  skyDome.position.copy(camera.position);
  skyU.flash.value = G.lightning * 0.8;
  hemi.intensity = G.hemiBase + G.lightning * 3;
  skyU.uBright.value = (G.skyBright || SKY_BRIGHT) * (1 + G.lightning * 1.5);
}

function syncPlayer() {
  if (!P.alive) return;
  P.obj.visible = !(P.inv > 0 && Math.floor(G.t * 14) % 2 === 0);
  P.obj.position.set(P.x, P.y, 0);
  P.obj.rotation.set(clamp(P.vy * 0.0018, -0.35, 0.35), -P.vx * 0.0006, -(P.bank + P.rollAng));
  const thrust = clamp((G.speed - SPD_BRAKE) / (SPD_BOOST - SPD_BRAKE), 0, 1);
  setFlame(P.obj, 0.3 + thrust * 1.1);
  placeShadow(P.shadow, P.x, P.y, 0, MODEL_CFG.player.span, 19);
}

// ============================================================ input
const keys = Object.create(null);
let tapped = Object.create(null);
const lastTap = { L: 0, R: 0 };
const BLOCK = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
function wakeAudio() {
  SFX.init();
  if (G.musicOn) SFX.startMusic();
}
window.addEventListener('keydown', e => {
  if (BLOCK.has(e.code)) e.preventDefault();
  wakeAudio();
  if (!e.repeat) {
    tapped[e.code] = true;
    const now = performance.now();
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') { if (now - lastTap.L < 260) tapped.dblL = true; lastTap.L = now; }
    if (e.code === 'ArrowRight' || e.code === 'KeyD') { if (now - lastTap.R < 260) tapped.dblR = true; lastTap.R = now; }
  }
  keys[e.code] = true;
});
window.addEventListener('keyup', e => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
document.addEventListener('visibilitychange', () => { if (document.hidden && G.state === 'play') G.paused = true; });

// touch
const touch = { on: false, stick: null, ox: 0, oy: 0, x: 0, y: 0, btn: Object.create(null) };
const BTNS = [
  { id: 'fire', x: W - 140, y: H - 300, r: 74, label: 'FIRE' },
  { id: 'msl', x: W - 300, y: H - 250, r: 54, label: 'MSL' },
  { id: 'boost', x: W - 290, y: H - 390, r: 44, label: 'BOOST' },
  { id: 'roll', x: W - 120, y: H - 450, r: 40, label: 'ROLL' },
];
function toHud(t) {
  const r = hud.getBoundingClientRect();
  return { x: (t.clientX - r.left) / r.width * W, y: (t.clientY - r.top) / r.height * H };
}
wrapEl.addEventListener('touchstart', e => {
  e.preventDefault();
  touch.on = true;
  wakeAudio();
  for (const t of e.changedTouches) {
    const p = toHud(t);
    if (G.state !== 'play') { tapped.Enter = true; continue; }
    if (p.x > W / 2 - 60 && p.x < W / 2 + 60 && p.y < 90) { tapped.KeyP = true; continue; }
    const b = BTNS.find(b => Math.hypot(p.x - b.x, p.y - b.y) < b.r * 1.25);
    if (b) {
      touch.btn[t.identifier] = b.id;
      if (b.id === 'roll') tapped.tRoll = true;
    } else if (p.x < W * 0.6 && touch.stick === null) {
      touch.stick = t.identifier; touch.ox = touch.x = p.x; touch.oy = touch.y = p.y;
    }
  }
}, { passive: false });
wrapEl.addEventListener('touchmove', e => {
  e.preventDefault();
  for (const t of e.changedTouches) if (t.identifier === touch.stick) { const p = toHud(t); touch.x = p.x; touch.y = p.y; }
}, { passive: false });
const endTouch = e => {
  for (const t of e.changedTouches) {
    if (t.identifier === touch.stick) touch.stick = null;
    delete touch.btn[t.identifier];
  }
};
wrapEl.addEventListener('touchend', endTouch);
wrapEl.addEventListener('touchcancel', endTouch);
wrapEl.addEventListener('mousedown', () => { wakeAudio(); if (G.state !== 'play') tapped.Enter = true; });

let padPrev = [];
function readInput() {
  const k = keys;
  const c = {
    ix: (k.ArrowRight || k.KeyD ? 1 : 0) - (k.ArrowLeft || k.KeyA ? 1 : 0),
    iy: (k.ArrowUp || k.KeyW ? 1 : 0) - (k.ArrowDown || k.KeyS ? 1 : 0),
    fire: !!(k.Space || k.KeyJ || k.KeyZ),
    missile: !!(k.KeyK || k.KeyX),
    boost: !!(k.ShiftLeft || k.ShiftRight || k.KeyL),
    brake: !!(k.KeyC || k.Semicolon),
    rollL: !!(tapped.KeyQ || tapped.dblL),
    rollR: !!(tapped.KeyE || tapped.dblR),
    start: !!(tapped.Enter || tapped.NumpadEnter || tapped.Space),
    pause: !!(tapped.KeyP || tapped.Escape),
  };
  // gamepad
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let pad = null;
  for (const p of pads) if (p && p.connected) { pad = p; break; }
  if (pad) {
    const b = i => !!(pad.buttons[i] && pad.buttons[i].pressed);
    const edge = i => b(i) && !padPrev[i];
    const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
    if (Math.abs(ax) > 0.18) c.ix = ax;
    if (Math.abs(ay) > 0.18) c.iy = -ay;
    if (b(14)) c.ix = -1; if (b(15)) c.ix = 1; if (b(12)) c.iy = 1; if (b(13)) c.iy = -1;
    c.fire ||= b(0);
    c.missile ||= b(1) || b(2);
    c.boost ||= b(7);
    c.brake ||= b(6);
    c.rollL ||= edge(4);
    c.rollR ||= edge(5);
    c.start ||= edge(9) || edge(0);
    c.pause ||= edge(9);
    if (edge(0) || edge(9)) wakeAudio();
    padPrev = pad.buttons.map(x => x.pressed);
  }
  // touch
  if (touch.stick !== null) {
    c.ix = clamp((touch.x - touch.ox) / 80, -1, 1);
    c.iy = clamp(-(touch.y - touch.oy) / 80, -1, 1);
  }
  const held = Object.values(touch.btn);
  if (held.includes('fire')) c.fire = true;
  if (held.includes('msl')) c.missile = true;
  if (held.includes('boost')) c.boost = true;
  if (tapped.tRoll) { if (c.ix < 0) c.rollL = true; else c.rollR = true; }

  if (tapped.KeyM) { G.musicOn = !G.musicOn; SFX.setMusic(G.musicOn); store('acefighter.music', G.musicOn ? '1' : '0'); }
  if (tapped.KeyI) { G.invertY = !G.invertY; store('acefighter.invert', G.invertY ? '1' : '0'); addAlert(G.invertY ? 'INVERT Y: ON' : 'INVERT Y: OFF', '#9fd3ff'); }
  if (tapped.KeyF) {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }
  tapped = Object.create(null);
  return c;
}

// ============================================================ update
function update(dt) {
  const inp = readInput();
  if (G.state === 'title') {
    if (inp.start) newGame();
  } else if (G.state === 'gameover') {
    G.goT += dt;
    if ((inp.start && G.goT > 1.5) || G.goT > 15) startDemo();
  } else if (inp.pause) {
    G.paused = !G.paused;
  }
  if (G.paused) { SFX.engine(0, 0); return; }
  stepWorld(dt, G.demo || G.auto ? autopilot() : inp);
}

// ============================================================ HUD (arcade style, built around the Scenario UI art)
const SKEW = -0.2;
function setFont(size) { hc.font = `${size}px ${FONT}`; }
// Polished-gold digits with a dark rim, like classic arcade score counters.
function goldText(s, x, y, size, align = 'left', alpha = 1) {
  hc.save();
  hc.globalAlpha = alpha;
  hc.translate(x, y); hc.transform(1, 0, SKEW, 1, 0, 0);
  setFont(size); hc.textAlign = align; hc.lineJoin = 'round';
  const g = hc.createLinearGradient(0, -size * 0.8, 0, size * 0.1);
  g.addColorStop(0, '#fffbe6'); g.addColorStop(0.32, '#ffe27a'); g.addColorStop(0.55, '#d08a12');
  g.addColorStop(0.72, '#ffeaa0'); g.addColorStop(1, '#a8640a');
  hc.lineWidth = size * 0.2; hc.strokeStyle = '#1b1206'; hc.strokeText(s, 0, 0);
  hc.lineWidth = size * 0.07; hc.strokeStyle = 'rgba(255,250,230,0.9)'; hc.strokeText(s, 0, 0);
  hc.fillStyle = g; hc.fillText(s, 0, 0);
  hc.restore();
}
// Chrome-white label with a navy rim (SCORE / STAGE / COMBO).
function chromeText(s, x, y, size, align = 'left', alpha = 1, tint = '#bfe2ff') {
  hc.save();
  hc.globalAlpha = alpha;
  hc.translate(x, y); hc.transform(1, 0, SKEW, 1, 0, 0);
  setFont(size); hc.textAlign = align; hc.lineJoin = 'round';
  const g = hc.createLinearGradient(0, -size * 0.8, 0, size * 0.1);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.5, '#ffffff'); g.addColorStop(0.55, tint); g.addColorStop(1, '#ffffff');
  hc.lineWidth = size * 0.22; hc.strokeStyle = '#0c1f4a'; hc.strokeText(s, 0, 0);
  hc.fillStyle = g; hc.fillText(s, 0, 0);
  hc.restore();
}
function txt(s, x, y, size, color, align = 'left', alpha = 1) {
  hc.save();
  hc.globalAlpha = alpha;
  hc.translate(x, y); hc.transform(1, 0, SKEW * 0.6, 1, 0, 0);
  setFont(size); hc.textAlign = align; hc.lineJoin = 'round';
  hc.lineWidth = Math.max(3, size * 0.18); hc.strokeStyle = 'rgba(5,15,40,0.75)';
  hc.strokeText(s, 0, 0);
  hc.fillStyle = color; hc.fillText(s, 0, 0);
  hc.restore();
}
function drawImg(im, x, y, w, flip = false, alpha = 1) {
  const h = w * im.height / im.width;
  hc.save();
  hc.globalAlpha = alpha;
  if (flip) { hc.translate(x + w, y); hc.scale(-1, 1); hc.drawImage(im, 0, 0, w, h); }
  else hc.drawImage(im, x, y, w, h);
  hc.restore();
  return h;
}
function miniJet(x, y, s, color) {
  hc.save(); hc.translate(x, y); hc.scale(s, s); hc.fillStyle = color;
  hc.beginPath();
  hc.moveTo(0, -10); hc.lineTo(2, -3); hc.lineTo(10, 3); hc.lineTo(10, 5); hc.lineTo(2, 3);
  hc.lineTo(3, 8); hc.lineTo(-3, 8); hc.lineTo(-2, 3); hc.lineTo(-10, 5); hc.lineTo(-10, 3); hc.lineTo(-2, -3);
  hc.closePath(); hc.fill(); hc.restore();
}

// Gauge bar: fill sits inside the measured slot of bar.png (x 223..1016, y 32..85 of 1100x114).
function gaugeBar(x, y, w, frac, stops, label, labelColor) {
  const h = w * UI.bar.height / UI.bar.width, sx = w / 1100, sy = h / 114;
  const x0 = x + 226 * sx, x1 = x + 1013 * sx, y0 = y + 35 * sy, y1 = y + 82 * sy;
  const fw = (x1 - x0) * clamp(frac, 0, 1), sl = (y1 - y0) * 0.35;
  hc.fillStyle = 'rgba(8,16,40,0.55)';
  hc.beginPath(); hc.moveTo(x0 + sl, y0); hc.lineTo(x1, y0); hc.lineTo(x1 - sl, y1); hc.lineTo(x0, y1); hc.closePath(); hc.fill();
  if (fw > 1) {
    const g = hc.createLinearGradient(x0, 0, x1, 0);
    stops.forEach(([o, c]) => g.addColorStop(o, c));
    hc.fillStyle = g;
    hc.beginPath(); hc.moveTo(x0 + sl, y0); hc.lineTo(x0 + fw, y0); hc.lineTo(x0 + fw - sl, y1); hc.lineTo(x0, y1); hc.closePath(); hc.fill();
    hc.fillStyle = 'rgba(255,255,255,0.35)';
    hc.fillRect(x0 + sl, y0, Math.max(0, fw - sl), (y1 - y0) * 0.3);
  }
  drawImg(UI.bar, x, y, w);
  chromeText(label, x + 105 * sx + 8, y + h * 0.66, Math.round(h * 0.46), 'center', 1, labelColor);
}

function drawTopFrame() {
  // thin cockpit-glass arcs across the top, echoing the emblems
  hc.save();
  hc.strokeStyle = 'rgba(255,255,255,0.55)'; hc.lineWidth = 2;
  hc.beginPath(); hc.moveTo(0, 104); hc.quadraticCurveTo(W / 2, -40, W, 104); hc.stroke();
  hc.strokeStyle = 'rgba(160,200,255,0.35)'; hc.lineWidth = 1.5;
  hc.beginPath(); hc.moveTo(W / 2 - 230, 4); hc.lineTo(W / 2 - 200, 20); hc.lineTo(W / 2 + 200, 20); hc.lineTo(W / 2 + 230, 4); hc.stroke();
  hc.restore();
}

function drawReticle() {
  const { x, y } = G.cross;
  const s = 15, l = 7;
  hc.save();
  hc.strokeStyle = 'rgba(230,255,240,0.95)'; hc.lineWidth = 2;
  hc.shadowColor = 'rgba(0,30,10,0.8)'; hc.shadowBlur = 3;
  hc.beginPath();
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    hc.moveTo(x + sx * s, y + sy * (s - l)); hc.lineTo(x + sx * s, y + sy * s); hc.lineTo(x + sx * (s - l), y + sy * s);
  }
  hc.moveTo(x - 5, y); hc.lineTo(x + 5, y); hc.moveTo(x, y - 5); hc.lineTo(x, y + 5);
  hc.stroke();
  hc.restore();
  for (const e of P.locks) {
    toScreen(e.x, e.y, e.d, _s);
    if (!_s.ok) continue;
    const sz = 18 + 14 * Math.max(0, 1 - e.lockT * 4);
    hc.save(); hc.translate(_s.x, _s.y); hc.rotate(G.t * 1.5);
    hc.strokeStyle = '#ff2a2a'; hc.lineWidth = 3;
    hc.beginPath();
    for (let i = 0; i < 4; i++) {
      hc.rotate(Math.PI / 2);
      hc.moveTo(-sz, -sz + 9); hc.lineTo(-sz, -sz); hc.lineTo(-sz + 9, -sz);
    }
    hc.stroke(); hc.restore();
    txt('LOCK', _s.x, _s.y - sz - 6, 13, '#ff5a5a', 'center');
  }
  if (G.alert) {
    for (const m of G.em) {
      if (!m.homing) continue;
      toScreen(m.x, m.y, m.d, _s);
      if (!_s.ok) continue;
      hc.strokeStyle = Math.floor(G.t * 10) % 2 ? '#ff3030' : '#ffd040'; hc.lineWidth = 2;
      hc.beginPath(); hc.arc(_s.x, _s.y, 14, 0, Math.PI * 2); hc.stroke();
    }
  }
}

// Lens flare drawn on the HUD layer: sun glow + starburst + ghosts mirrored through screen centre.
function drawLensFlare() {
  const st = STG();
  const k = (G.noFlare ? 0 : st.sky ? (SKIES[st.sky].flare ?? 1) : 0.5) * (G.flareMul ?? 1);
  if (!k) return;
  const R = 6000;
  toScreen(camera.position.x + sunDir.x * R, camera.position.y + sunDir.y * R, -(camera.position.z + sunDir.z * R), _s);
  if (!_s.ok) return;
  const off = Math.max(0, -_s.x, _s.x - W, -_s.y, _s.y - H);
  const vis = clamp(1 - off / 260, 0, 1) * k * (1 - G.whiteout);
  if (vis <= 0.01) return;
  const sx = _s.x, sy = _s.y, cx = W / 2, cy = H / 2;
  hc.save();
  hc.globalCompositeOperation = 'lighter';
  let g = hc.createRadialGradient(sx, sy, 0, sx, sy, 300);
  g.addColorStop(0, `rgba(255,250,235,${0.34 * vis})`); g.addColorStop(0.12, `rgba(255,240,210,${0.16 * vis})`); g.addColorStop(0.45, `rgba(240,225,200,${0.05 * vis})`); g.addColorStop(1, 'rgba(230,215,200,0)');
  hc.fillStyle = g; hc.fillRect(sx - 300, sy - 300, 600, 600);
  const ghosts = [[0.35, 26, '255,210,140'], [0.62, 12, '150,220,255'], [0.95, 44, '160,255,200'], [1.25, 18, '255,170,120'], [1.6, 70, '140,170,255']];
  for (const [t, r, c] of ghosts) {
    const gx = sx + (cx - sx) * t * 2, gy = sy + (cy - sy) * t * 2;
    g = hc.createRadialGradient(gx, gy, 0, gx, gy, r);
    g.addColorStop(0, `rgba(${c},${0.05 * vis})`); g.addColorStop(0.75, `rgba(${c},${0.12 * vis})`); g.addColorStop(1, `rgba(${c},0)`);
    hc.fillStyle = g; hc.beginPath(); hc.arc(gx, gy, r, 0, Math.PI * 2); hc.fill();
  }
  hc.restore();
}

function drawRadar(cx, cy) {
  const R = 38, RANGE_R = 1600;
  hc.save(); hc.translate(cx, cy);
  hc.globalAlpha = 0.85;
  hc.fillStyle = 'rgba(0,25,45,0.5)'; hc.beginPath(); hc.arc(0, 0, R, 0, Math.PI * 2); hc.fill();
  hc.strokeStyle = 'rgba(190,230,255,0.7)'; hc.lineWidth = 2; hc.stroke();
  hc.strokeStyle = 'rgba(190,230,255,0.2)'; hc.lineWidth = 1;
  hc.beginPath(); hc.arc(0, 0, R / 2, 0, Math.PI * 2); hc.moveTo(-R, 0); hc.lineTo(R, 0); hc.moveTo(0, -R); hc.lineTo(0, R); hc.stroke();
  const blip = (dx, dd, r, color) => {
    let bx = dx / RANGE_R * R, by = -dd / RANGE_R * R;
    const l = Math.hypot(bx, by);
    if (l > R - 3) { bx *= (R - 3) / l; by *= (R - 3) / l; }
    hc.fillStyle = color; hc.beginPath(); hc.arc(bx, by, r, 0, Math.PI * 2); hc.fill();
  };
  for (const e of G.enemies) if (!e.dead) blip(e.x - P.x, e.d, e.type === 'boss' ? 5 : 2.8, e.type === 'sam' ? '#ffb040' : '#ff4a4a');
  if (Math.floor(G.t * 8) % 2) for (const m of G.em) blip(m.x - P.x, m.d, 2, '#ffe040');
  hc.fillStyle = '#ffffff';
  hc.beginPath(); hc.moveTo(0, -5); hc.lineTo(4, 4); hc.lineTo(-4, 4); hc.closePath(); hc.fill();
  hc.restore();
}

function drawArmor(x, y, size) {
  // Chrome ring bezel (gauge.png): hole centre (260,260) r≈181 of 520px. Armor arc drawn inside.
  const cx = x + size / 2, cy = y + size / 2, r = size * 0.29;
  const frac = clamp(P.hull / 100, 0, 1);
  hc.save();
  hc.fillStyle = 'rgba(5,20,30,0.45)'; hc.beginPath(); hc.arc(cx, cy, size * 0.35, 0, Math.PI * 2); hc.fill();
  hc.lineCap = 'butt'; hc.lineWidth = size * 0.1;
  hc.strokeStyle = 'rgba(0,0,0,0.4)'; hc.beginPath(); hc.arc(cx, cy, r, 0, Math.PI * 2); hc.stroke();
  const col = frac > 0.6 ? ['#e8ff70', '#6ed020'] : frac > 0.3 ? ['#fff070', '#e0a010'] : ['#ff9080', '#d02010'];
  const g = hc.createLinearGradient(cx, cy - r, cx, cy + r);
  g.addColorStop(0, col[0]); g.addColorStop(1, col[1]);
  hc.strokeStyle = (frac <= 0.3 && Math.floor(G.t * 6) % 2) ? '#ffffff' : g;
  hc.beginPath(); hc.arc(cx, cy, r, -Math.PI / 2 - Math.PI * 2 * frac, -Math.PI / 2); hc.stroke();
  hc.restore();
  drawImg(UI.gauge, x, y, size);
  goldText(String(Math.round(P.hull)), cx + 4, cy + size * 0.04, Math.round(size * 0.2), 'center');
  goldText('%', cx + size * 0.2, cy + size * 0.04, Math.round(size * 0.1), 'center');
  chromeText('ARMOR', cx, cy + size * 0.18, Math.round(size * 0.09), 'center', 1, '#ffc0c0');
}

function drawHUD() {
  const st = STG();
  drawTopFrame();
  // score block (left) and stage block (right)
  drawImg(UI.emblem, 6, 4, 150);
  hc.fillStyle = '#e02828';
  hc.beginPath(); hc.moveTo(160, 52); hc.lineTo(300, 52); hc.lineTo(294, 56); hc.lineTo(156, 56); hc.closePath(); hc.fill();
  chromeText('SCORE', 156, 46, 30);
  goldText(pad(G.score, 8), 162, 96, 44);
  drawImg(UI.emblem, W - 156, 4, 150, true);
  hc.fillStyle = '#e02828';
  hc.beginPath(); hc.moveTo(W - 300, 52); hc.lineTo(W - 160, 52); hc.lineTo(W - 166, 56); hc.lineTo(W - 304, 56); hc.closePath(); hc.fill();
  chromeText('STAGE', W - 156, 46, 30, 'right');
  goldText(pad(G.stageIdx + 1, 2), W - 170, 96, 44, 'right');
  if (G.loop) chromeText(`ROUND ${G.loop + 1}`, W - 170, 122, 16, 'right');

  // boss health / stage progress (top centre)
  const b = G.boss;
  if (b && !b.gone && G.phase === 'fly') {
    chromeText(b.name, W / 2, 46, 18, 'center', 1, '#ffb0b0');
    gaugeBar(W / 2 - 170, 52, 340, b.hp / b.maxHp, [[0, '#ff6040'], [1, '#ff2050']], 'BOSS', '#ffb0b0');
  } else if (G.phase === 'fly') {
    hc.fillStyle = 'rgba(0,20,50,0.45)'; hc.fillRect(W / 2 - 120, 30, 240, 4);
    hc.fillStyle = '#9fe0ff'; hc.fillRect(W / 2 - 120, 30, 240 * clamp(G.stageTime / STAGE_LEN, 0, 1), 4);
  }

  // combo counter
  if (G.combo >= 2) {
    const a = clamp(G.comboT / 0.6, 0, 1), sc = 1 + G.comboPop * 0.35, size = Math.round(78 * sc);
    if (G.combo >= 10) goldText(String(G.combo), 92, 214, size, 'center', a);
    else chromeText(String(G.combo), 92, 214, size, 'center', a, '#3a9cff');
    chromeText('C O M B O', 92, 244, 20, 'center', a);
  }

  // missiles: one icon per 4 missiles, highlighted ones = ready to fire
  const icons = Math.ceil(MAX_MSL / 4), have = P.missiles / 4;
  for (let i = 0; i < icons; i++) {
    const full = i < Math.floor(have), part = !full && i < have;
    const big = i < Math.max(1, P.locks.length) && full;
    const h = big ? 54 : 44, w = h * UI.missile.width / UI.missile.height;
    drawImg(UI.missile, 24 + i * 19, H - 128 - h, w, false, full ? 1 : part ? 0.55 : 0.18);
  }
  txt(`×${pad(P.missiles, 2)}`, 24 + icons * 19 + 8, H - 136, 18, P.missiles < 6 ? '#ff7070' : '#ffffff');

  // boost fuel + speed bars
  const boostStops = P.fuelLock ? [[0, '#803040'], [1, '#c04060']] : [[0, '#b040ff'], [0.6, '#7a6cff'], [1, '#40b0ff']];
  gaugeBar(18, H - 112, 380, P.fuel / 100, boostStops, 'BOOST', '#e0c0ff');
  const sp = clamp((G.speed - SPD_BRAKE * 0.8) / (SPD_BOOST - SPD_BRAKE * 0.8), 0, 1);
  gaugeBar(36, H - 66, 380, sp, [[0, '#2050ff'], [0.45, '#30a0ff'], [0.62, '#ffe040'], [0.85, '#ff6020'], [1, '#ff2050']], 'SPEED', '#fff0a0');

  // armor ring, plane name, lives
  drawArmor(W - 194, H - 196, 186);
  for (let i = 0; i < 1; i++) miniJet(W - 312, H - 92, 1.5, '#ffffff');
  goldText('×' + G.lives, W - 292, H - 80, 30);
  txt(PLANE_NAME, W - 200, H - 30, 20, '#ff4a4a', 'right');

  drawRadar(92, 320); // left side under the combo counter — keeps the jet's area clear

  if (G.alert && Math.floor(G.t * 6) % 2 === 0) chromeText('MISSILE ALERT', W / 2, 150, 32, 'center', 1, '#ff8080');
  G.alerts.forEach((a, i) => txt(a.text, W / 2, 186 + i * 28, 20, a.color, 'center', Math.min(1, (a.dur - a.t) * 4)));

  for (const p of G.pops) {
    toScreen(p.x, p.y, p.d, _s);
    if (_s.ok) goldText(p.text, _s.x, _s.y - p.t * 30, 18, 'center', 1 - p.t);
  }

  const m = G.msgs[0];
  if (m) {
    const a = Math.min(1, m.t * 4, (m.dur - m.t) * 3), sc = 1 + Math.max(0, 0.25 - m.t) * 1.6;
    const mx = G.phase === 'clear' && G.ct > 2.4 ? 900 : W / 2, small = mx !== W / 2 ? 0.7 : 1;
    if (m.color === '#ffffff' || m.color === '#ffe27a' || m.color === '#ffd36b') goldText(m.text, mx, 270, Math.round(70 * sc * small), 'center', a);
    else chromeText(m.text, mx, 270, Math.round(64 * sc * small), 'center', a, m.color);
    if (m.sub) chromeText(m.sub, mx, 310, Math.round(24 * small), 'center', a);
  }

  if (G.phase === 'clear' && G.tally && G.ct > 2.4 && G.ct < 10) drawResult();
  if (touch.on) drawTouch();
}

function drawResult() {
  const t = G.tally;
  const slide = clamp((G.ct - 2.4) * 3, 0, 1), out = clamp((10 - G.ct) * 3, 0, 1);
  const w = 520, x = 34 - (1 - slide) * 600, y = 150;
  hc.save();
  hc.globalAlpha = out;
  // panel.png divider lines sit at ~24% and ~70% of its height; labels go just above them
  const h = drawImg(UI.panel, x, y, w);
  chromeText('STAGE RESULT', x + w / 2, y + h * 0.105, 30, 'center', 1, '#9fd8ff');
  chromeText('STAGE SCORE', x + 80, y + h * 0.215, 22, 'left', 1, '#cfe8ff');
  goldText(pad(t.stageScore, 8), x + w / 2 + 10, y + h * 0.5, 60, 'center');
  if (G.ct > 3.0) {
    chromeText('DOWNED', x + 80, y + h * 0.68, 22, 'left', 1, '#cfe8ff');
    const pct = t.spawned ? Math.round(t.kills / t.spawned * 100) : 0;
    chromeText(`${pad(t.kills, 3)}/${pad(t.spawned, 3)} (${String(pct).padStart(3, ' ')}%)`, x + w / 2 + 10, y + h * 0.9, 40, 'center');
  }
  hc.restore();
}

function drawTouch() {
  hc.lineWidth = 3;
  for (const b of BTNS) {
    const held = Object.values(touch.btn).includes(b.id);
    hc.fillStyle = held ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.1)';
    hc.strokeStyle = 'rgba(255,255,255,0.45)';
    hc.beginPath(); hc.arc(b.x, b.y, b.r, 0, Math.PI * 2); hc.fill(); hc.stroke();
    txt(b.label, b.x, b.y + 6, 16, '#ffffff', 'center', 0.85);
  }
  if (touch.stick !== null) {
    hc.strokeStyle = 'rgba(255,255,255,0.4)';
    hc.beginPath(); hc.arc(touch.ox, touch.oy, 80, 0, Math.PI * 2); hc.stroke();
    hc.fillStyle = 'rgba(255,255,255,0.3)';
    const dx = clamp(touch.x - touch.ox, -80, 80), dy = clamp(touch.y - touch.oy, -80, 80);
    hc.beginPath(); hc.arc(touch.ox + dx, touch.oy + dy, 32, 0, Math.PI * 2); hc.fill();
  }
}

function drawTitle() {
  const g = hc.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(0,10,40,0.45)'); g.addColorStop(0.45, 'rgba(0,10,40,0)'); g.addColorStop(1, 'rgba(0,10,40,0.6)');
  hc.fillStyle = g; hc.fillRect(0, 0, W, H);
  const bob = Math.sin(G.t * 1.5) * 4;
  drawImg(UI.logo, W / 2 - 340, 12 + bob, 680);
  if (Math.floor(G.t * 2) % 2 === 0) chromeText(touch.on ? 'TAP TO FLY' : 'PRESS ENTER TO FLY', W / 2, 410, 36, 'center');
  chromeText('HI SCORE', W / 2 - 20, 452, 20, 'right');
  goldText(pad(G.hi, 8), W / 2, 454, 26);

  const rows = [
    ['STEER', 'ARROWS / WASD'], ['CANNON', 'SPACE / J / Z  (HOLD)'], ['MISSILE', 'K / X  (LOCK ON FIRST)'],
    ['AFTERBURNER', 'SHIFT / L'], ['BRAKE', 'C'], ['BARREL ROLL', 'Q / E  OR DOUBLE-TAP ← →'],
  ];
  hc.fillStyle = 'rgba(0,30,80,0.5)'; hc.fillRect(W / 2 - 300, 478, 600, 190);
  hc.strokeStyle = 'rgba(160,210,255,0.5)'; hc.lineWidth = 1.5; hc.strokeRect(W / 2 - 300, 478, 600, 190);
  rows.forEach(([a, b], i) => {
    txt(a, W / 2 - 270, 508 + i * 27, 16, '#9fd8ff');
    txt(b, W / 2 + 270, 508 + i * 27, 16, '#ffffff', 'right');
  });
  txt(`M MUSIC ${G.musicOn ? 'ON' : 'OFF'} · I INVERT Y ${G.invertY ? 'ON' : 'OFF'} · F FULLSCREEN · P PAUSE · GAMEPAD OK`, W / 2, 698, 14, '#c0d4ee', 'center');
}

function render() {
  if (P.alive && !G.hideJet) syncPlayer();
  else if (G.hideJet) P.obj.visible = false;
  syncInst(tracerMesh, G.pb);
  syncInst(ebMesh, G.eb);
  syncInst(pmMesh, G.pm);
  syncInst(emMesh, G.em);
  writeFX(ADD); writeFX(SMOKE);
  if (G.bench) {
    // GPU-inclusive frame cost. Prefer a GPU timer query (EXT_disjoint_timer_query_webgl2); otherwise
    // force a pipeline sync with a 1x1 readback (finish() alone does not block under ANGLE/Metal).
    renderer.info.reset();
    const gl = renderer.getContext();
    const ext = G.benchExt === undefined ? (G.benchExt = gl.getExtension('EXT_disjoint_timer_query_webgl2')) : G.benchExt;
    if (ext) {
      G.benchQueries = G.benchQueries || [];
      for (let i = G.benchQueries.length - 1; i >= 0; i--) {
        const q = G.benchQueries[i];
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT)) {
          G.benchTimes.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(q); G.benchQueries.splice(i, 1);
        }
      }
      const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      composer.render();
      gl.endQuery(ext.TIME_ELAPSED_EXT); G.benchQueries.push(q);
    } else {
      const t0 = performance.now();
      composer.render();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      G.benchTimes.push(performance.now() - t0);
    }
    G.benchInfo = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, timer: !!ext };
  } else composer.render();

  hc.setTransform(hudScale, 0, 0, hudScale, 0, 0);
  hc.clearRect(0, 0, W, H);
  // speed lines on afterburner
  const boostAmt = clamp((G.speed - SPD_BASE) / (SPD_BOOST - SPD_BASE), 0, 1);
  if (boostAmt > 0.05) {
    hc.strokeStyle = `rgba(255,255,255,${0.22 * boostAmt})`; hc.lineWidth = 2; hc.beginPath();
    for (let i = 0; i < 26; i++) {
      const a = rand(0, Math.PI * 2), r1 = rand(300, 540), r2 = r1 + rand(80, 240) * boostAmt;
      hc.moveTo(W / 2 + Math.cos(a) * r1, H / 2 + Math.sin(a) * r1 * 0.6);
      hc.lineTo(W / 2 + Math.cos(a) * r2, H / 2 + Math.sin(a) * r2 * 0.6);
    }
    hc.stroke();
  }
  drawLensFlare();
  if (G.whiteout > 0) { hc.fillStyle = `rgba(255,255,255,${G.whiteout * 0.85})`; hc.fillRect(0, 0, W, H); }
  if (G.hurt > 0) {
    const g = hc.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.9);
    g.addColorStop(0, 'rgba(255,0,0,0)'); g.addColorStop(1, `rgba(255,0,0,${G.hurt * 0.55})`);
    hc.fillStyle = g; hc.fillRect(0, 0, W, H);
  }

  if (G.noHud) return;
  if (G.state === 'title') drawTitle();
  else {
    if (P.alive && G.phase !== 'clear') drawReticle();
    drawHUD();
  }
  if (G.state === 'gameover') {
    hc.fillStyle = 'rgba(0,0,20,0.5)'; hc.fillRect(0, 0, W, H);
    chromeText('GAME OVER', W / 2, 300, 84, 'center', 1, '#ff9080');
    chromeText('FINAL SCORE', W / 2 - 20, 362, 26, 'right');
    goldText(pad(G.score, 8), W / 2, 366, 36);
    if (G.newHi && Math.floor(G.t * 3) % 2) goldText('NEW HIGH SCORE!', W / 2, 420, 30, 'center');
    if (G.goT > 1.5) chromeText(touch.on ? 'TAP TO CONTINUE' : 'PRESS ENTER', W / 2, 480, 24, 'center');
  }
  if (G.paused) {
    hc.fillStyle = 'rgba(0,0,20,0.55)'; hc.fillRect(0, 0, W, H);
    chromeText('PAUSED', W / 2, 330, 76, 'center');
    chromeText('P / ESC TO RESUME', W / 2, 382, 20, 'center');
  }
  if (G.fade > 0) { hc.fillStyle = `rgba(255,255,255,${G.fade})`; hc.fillRect(0, 0, W, H); }
  if (G.err) {
    hc.fillStyle = 'rgba(80,0,0,0.85)'; hc.fillRect(0, H - 120, W, 120);
    hc.fillStyle = '#fff'; hc.font = '14px monospace'; hc.textAlign = 'left';
    G.err.split('\n').slice(0, 6).forEach((l, i) => hc.fillText(l, 12, H - 98 + i * 17));
  }
}

// ============================================================ boot
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  try {
    update(dt);
    render();
  } catch (err) {
    if (!G.err) console.error(err);
    G.err = String((err && err.stack) || err);
  }
}

// Harness helpers: bring camera/scenery/player in line with the current state without advancing the sim.
function syncFrame() {
  updateCamera(1 / 60);
  updateScenery(0);
  if (cloudPass) cloudPass.u.uDist.value = G.dist;
  if (ocean) ocean.update(0, G.dist);
  if (P.alive) syncPlayer();
}
// Region masks for the scorer: surface (terrain / ocean / props) and jet, rendered with a flat white
// override so the result is independent of lighting. Clouds are a post pass and therefore count as sky.
function renderMasks() {
  const w = Math.round(renderer.domElement.width / 2), h = Math.round(renderer.domElement.height / 2);
  const rt = new THREE.WebGLRenderTarget(w, h);
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
  const saved = { bg: scene.background, fog: scene.fog, vis: new Map() };
  scene.traverse(o => { if (o.visible !== undefined) saved.vis.set(o, o.visible); });
  const readout = () => {
    const px = new Uint8Array(w * h * 4);
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(scene, camera);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    renderer.setRenderTarget(null);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const im = c.getContext('2d').createImageData(w, h);
    for (let y = 0; y < h; y++) im.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    c.getContext('2d').putImageData(im, 0, 0);
    return c.toDataURL('image/png');
  };
  scene.background = null; scene.fog = null; scene.overrideMaterial = white;
  const isUnder = (o, root) => { for (let p = o; p; p = p.parent) if (p === root) return true; return false; };
  const show = pred => scene.traverse(o => { if (saved.vis.has(o)) o.visible = o === scene || pred(o); });
  show(o => o === terrain || (ocean && o === ocean.mesh) || isUnder(o, propGroup) || isUnder(o, horizonGroup));
  const surface = readout();
  show(o => isUnder(o, P.obj) && !o.isSprite && o !== P.obj.userData.flames[0] && o !== P.obj.userData.flames[1]);
  const jet = readout();
  scene.overrideMaterial = null; scene.background = saved.bg; scene.fog = saved.fog;
  for (const [o, v] of saved.vis) o.visible = v;
  rt.dispose(); white.dispose();
  return { surface, jet, width: w, height: h };
}

async function boot() {
  if (document.fonts) document.fonts.load(`40px 'Russo One'`).catch(() => {});
  try {
    await loadAssets();
  } catch (err) {
    setBoot('FAILED TO LOAD ASSETS — ' + err.message);
    throw err;
  }
  cloudPass = new CloudPass({ camera, baseData: CLOUD_DATA.base, detailData: CLOUD_DATA.detail, weatherTex: CLOUD_DATA.weather, width: 1280, height: 720, depthTexture: sceneDepth });
  composer.insertPass(cloudPass, 1);
  resize();
  P.obj = makeModel('player');
  for (const m of P.obj.userData.mats) { m.roughness = 0.7; m.metalness = 0.25; m.envMapIntensity = 0.9; m.color.setRGB(...P.obj.userData.base); } // grey airframe that picks up sky/sea tint, like the reference
  scene.add(P.obj);
  P.shadow = getShadow();
  bootEl?.remove();
  startDemo();
  if (G.auto) newGame();
  // Debug: ?ff=SECONDS fast-forwards the simulation (used for automated screenshots).
  for (let i = 0, n = Math.round((Number(params.get('ff')) || 0) * 60); i < n; i++) update(1 / 60);
  const dev = createDevTools(() => ({
    G, P, cam, camera, scene, renderer, composer, bloom, grade, speedBlur, sunLight, hemi, sunDir, cloudPass, ocean, terrain, terrainU, skyU,
    STAGES, SKIES, SPD_BASE, update, startStage, resetPlayer, seedRandom, syncFrame, renderMasks,
  }));
  window.__ace = { G, P, scene, camera, renderer, update, killPlayer, terrain, propGroup, STG, terrainU, FLAT_NRM, FLAT_RGH, ...dev,
    get cloudPass() { return cloudPass; }, get ocean() { return ocean; }, composer, skyU,
    dbg: () => ({ stage: STG().name, terrainVis: terrain.visible, oceanVis: !!(ocean && ocean.mesh.visible), biome: activeBiome && activeBiome.hmax, props: propGroup.children.length, hTex: !!terrainU.uHeight.value, clouds: cloudPass && cloudPass.enabledClouds }) };
  if (params.has('shot')) await dev.shot(params.get('shot'));
  if (params.has('set')) dev.tuneString(params.get('set'));
  requestAnimationFrame(frame);
}
boot();

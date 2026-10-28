import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Water } from 'three/addons/objects/Water.js';
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
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.5, 12000);
camera.rotation.order = 'YXZ';

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(640, 360), 0.75, 0.55, 0.82);
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
// Arcade colour grade (in linear HDR, before tone mapping): punchier saturation/contrast + vignette.
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uSat: { value: 1.22 }, uContrast: { value: 1.1 }, uVig: { value: 0.28 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uSat, uContrast, uVig; varying vec2 vUv;
    void main(){
      vec4 t = texture2D(tDiffuse, vUv);
      vec3 c = max(t.rgb, 0.0);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = max(mix(vec3(l), c, uSat), 0.0);
      c = pow(c / 0.18, vec3(uContrast)) * 0.18;
      float v = smoothstep(0.95, 0.3, length((vUv - 0.5) * vec2(1.0, 0.8)));
      c *= mix(1.0 - uVig, 1.0, v);
      gl_FragColor = vec4(c, t.a);
    }`,
});
composer.addPass(grade);
composer.addPass(new OutputPass());

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
  hud.width = Math.round(w * PR); hud.height = Math.round(h * PR);
  hudScale = hud.width / W;
  pointUniforms.uScale.value = (h * PR) / (2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2));
}
window.addEventListener('resize', resize);
resize();

// ============================================================ asset manifest (generated with Scenario)
// Model yaw/size were measured from the Tripo GLBs so every nose points down -Z; nozzles are in metres.
const MODEL_CFG = {
  player: { url: 'assets/models/player.glb', yaw: -Math.PI / 2, len: 19, flame: 1.25, nozzles: [[-2.0, -1.4, 8.9], [1.15, -1.4, 8.9]] },
  enemy: { url: 'assets/models/enemy.glb', yaw: -2.737, len: 18, flame: 1.4, nozzles: [[0, -0.75, 7.6]] },
  boss: { url: 'assets/models/boss.glb', yaw: Math.PI, len: 48, flame: 2.3, nozzles: [[-18.7, -4.6, 5.0], [-11.6, -4.6, 2.0], [11.6, -4.6, 2.0], [18.7, -4.6, 5.0]] },
};
// Equirectangular skies: horizon colour (for fog) and sun position in texture UV were sampled from the images.
const SKIES = {
  day: { url: 'assets/sky/day.jpg', hor: '#9ab6d6', sun: [0.977, 0.148], sunCol: '#fff4e0', sunI: 2.6, hemi: 0.9 },
  sunset: { url: 'assets/sky/sunset.jpg', hor: '#c08080', sun: [0.174, 0.464], sunCol: '#ffb070', sunI: 2.4, hemi: 0.8 },
  storm: { url: 'assets/sky/storm.jpg', hor: '#43525e', sun: [0.301, 0.421], sunCol: '#b0c0d0', sunI: 1.0, hemi: 0.9, flare: 0 },
  space: { url: 'assets/sky/space.jpg', hor: '#5d7fa8', sun: [0.758, 0.499], sunCol: '#ffffff', sunI: 2.8, hemi: 0.8 },
};
const UI_FILES = ['emblem', 'bar', 'gauge', 'logo', 'missile', 'panel'];
// Seamless aerial terrain textures (Scenario Texture), sampled in world space by the terrain shader.
const TERRAIN_FILES = ['meadow', 'rock', 'canyon', 'dunes', 'snow'];

const TEMPLATES = {}, SKY_TEX = {}, ENV_TEX = {}, UI = {}, TERRAIN_TEX = {};
let waterNormals = null;

async function loadAssets() {
  const gltfLoader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const jobs = [];
  let done = 0;
  const tick = p => p.then(v => { done++; setBoot(`LOADING ${Math.round(done / jobs.length * 100)}%`); return v; });
  for (const [key, c] of Object.entries(MODEL_CFG)) jobs.push(tick(gltfLoader.loadAsync(c.url)).then(g => prepModel(key, g)));
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
  for (const n of TERRAIN_FILES) {
    jobs.push(tick(texLoader.loadAsync(`assets/textures/${n}.jpg`)).then(t => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      TERRAIN_TEX[n] = t;
    }));
  }
  jobs.push(tick(texLoader.loadAsync('assets/textures/waternormals.png')).then(t => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    waterNormals = t;
  }));
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
    if (o.isMesh) { o.material.envMapIntensity = 1.15; o.frustumCulled = true; }
  });
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

const cloudTex = canvasTex(256, (g, S) => {
  for (let i = 0; i < 16; i++) {
    const x = rand(S * 0.25, S * 0.75), y = rand(S * 0.38, S * 0.62), r = rand(S * 0.12, S * 0.24);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  }
}, false);

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
};
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(9000, 32, 16), new THREE.ShaderMaterial({
  uniforms: skyU, side: THREE.BackSide, depthWrite: false, fog: false,
  vertexShader: `varying vec3 vDir;
    void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform vec3 top, mid, hor, sunCol, sunDir; uniform float stars, flash; varying vec3 vDir;
    float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
    void main(){
      vec3 d = normalize(vDir);
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
scene.add(hemi, sunLight, sunLight.target);
scene.fog = new THREE.Fog(0xffffff, 500, 2600);
const sunDir = new THREE.Vector3(0, 0.5, -1).normalize();

// Rotate a sky so its sun sits ahead-left of the flight path; returns the world-space sun direction.
function orientSky(sky) {
  const [u, v] = sky.sun;
  const phi = (u - 0.5) * Math.PI * 2, lat = (0.5 - v) * Math.PI;
  const target = Math.atan2(-1, -0.42);
  const yaw = phi - target;
  scene.backgroundRotation.set(0, yaw, 0);
  scene.environmentRotation.set(0, yaw, 0);
  return new THREE.Vector3(Math.cos(target) * Math.cos(lat), Math.sin(lat), Math.sin(target) * Math.cos(lat)).normalize();
}

// ============================================================ terrain (GPU-displaced, scrolls with distance flown)
// Same height function in JS (for placing props/shadows) and GLSL (for the mesh).
const terrainU = {
  uDist: { value: 0 }, uAmp: { value: 1 }, uCorr: { value: 270 }, uEdge: { value: 420 },
  uRock: { value: new THREE.Color('#ffffff') }, uSnow: { value: -1 },
  uRockMap: { value: null }, uTile: { value: 260 }, uRockTile: { value: 160 },
};
function terrainH(x, w) {
  const amp = terrainU.uAmp.value;
  if (amp === 0) return 0;
  const ax = Math.abs(x), corr = terrainU.uCorr.value;
  const side = smoothstep(corr, corr + terrainU.uEdge.value, ax);
  const big = (0.6 + 0.4 * Math.sin(w * 0.0021 + x * 0.0037) * Math.sin(w * 0.0047 - x * 0.0013 + 1.3)) * (230 + 130 * Math.sin(x * 0.0011 + w * 0.0017));
  const ridges = Math.abs(Math.sin(w * 0.011 + x * 0.009)) * 45 + Math.abs(Math.sin(w * 0.027 - x * 0.019 + 2.0)) * 18 + Math.abs(Math.sin(w * 0.061 + x * 0.047)) * 6;
  const inner = (Math.sin(w * 0.013) * Math.sin(x * 0.021 + 0.7) + 1) * 4;
  return amp * (side * (big + ridges) + inner * (1 - side));
}
const TERRAIN_GLSL = `
  uniform float uDist, uAmp, uCorr, uEdge;
  float terrainH(float x, float w) {
    float ax = abs(x);
    float side = smoothstep(uCorr, uCorr + uEdge, ax);
    float big = (0.6 + 0.4 * sin(w * 0.0021 + x * 0.0037) * sin(w * 0.0047 - x * 0.0013 + 1.3)) * (230.0 + 130.0 * sin(x * 0.0011 + w * 0.0017));
    float ridges = abs(sin(w * 0.011 + x * 0.009)) * 45.0 + abs(sin(w * 0.027 - x * 0.019 + 2.0)) * 18.0 + abs(sin(w * 0.061 + x * 0.047)) * 6.0;
    float inner = (sin(w * 0.013) * sin(x * 0.021 + 0.7) + 1.0) * 4.0;
    return uAmp * (side * (big + ridges) + inner * (1.0 - side));
  }
  varying float vTH;
  varying float vTSlope;
  varying vec3 vTW;
  varying vec3 vTN;
`;
function terrainMaterial(opts) {
  const m = new THREE.MeshLambertMaterial(opts);
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, terrainU);
    sh.vertexShader = TERRAIN_GLSL + sh.vertexShader
      .replace('#include <beginnormal_vertex>', `
        float tw = -position.z + uDist;
        float th = terrainH(position.x, tw);
        float te = 4.0;
        float tdx = terrainH(position.x + te, tw) - terrainH(position.x - te, tw);
        float tdw = terrainH(position.x, tw + te) - terrainH(position.x, tw - te);
        vec3 objectNormal = normalize(vec3(-tdx / (2.0 * te), 1.0, tdw / (2.0 * te)));
        vTH = th;
        vTSlope = 1.0 - objectNormal.y;
        vTW = vec3(position.x, th, tw);
        vTN = objectNormal;
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(1.0, 0.0, 0.0);
        #endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position.x, th, position.z);');
    // World-space texturing (scrolls with distance flown): ground sampled at two scales to hide
    // tiling, triplanar rock on steep slopes so cliffs aren't smeared, snow above a height line.
    sh.fragmentShader = `uniform vec3 uRock; uniform float uSnow, uTile, uRockTile; uniform sampler2D uRockMap;
      varying float vTH; varying float vTSlope; varying vec3 vTW; varying vec3 vTN;\n` + sh.fragmentShader
      .replace('#include <map_fragment>', `
        vec2 tuv = vTW.xz / uTile;
        vec3 g1 = texture2D(map, tuv).rgb;
        vec3 g2 = texture2D(map, tuv * 0.21 + vec2(0.37, 0.11)).rgb;
        vec3 ground = g1 * mix(0.7, 1.3, dot(g2, vec3(0.333)));
        vec3 bw = pow(abs(vTN), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
        vec3 rock = texture2D(uRockMap, vTW.zy / uRockTile).rgb * bw.x
                  + texture2D(uRockMap, vTW.xz / uRockTile).rgb * bw.y
                  + texture2D(uRockMap, vTW.xy / uRockTile).rgb * bw.z;
        vec3 tcol = mix(ground, rock * uRock, smoothstep(0.2, 0.5, vTSlope));
        if (uSnow >= 0.0) tcol = mix(tcol, vec3(0.92, 0.95, 1.0) * (0.85 + 0.15 * g1.r), smoothstep(uSnow, uSnow + 45.0, vTH) * (1.0 - smoothstep(0.5, 0.75, vTSlope)));
        diffuseColor.rgb *= tcol;`)
      .replace('#include <emissivemap_fragment>', `
        #ifdef USE_EMISSIVEMAP
          totalEmissiveRadiance *= texture2D(emissiveMap, tuv).rgb;
        #endif`);
  };
  return m;
}
const TERRAIN_W = 5200, TERRAIN_D = 5400, TILE = 260;
const terrainGeo = new THREE.PlaneGeometry(TERRAIN_W, TERRAIN_D, 230, 240);
terrainGeo.rotateX(-Math.PI / 2);
terrainGeo.translate(0, 0, -TERRAIN_D / 2 + 300);
const terrain = new THREE.Mesh(terrainGeo, terrainMaterial({}));
terrain.frustumCulled = false;
scene.add(terrain);

// ============================================================ ocean (three.js Water with scrolling waves)
let water = null;
function makeWater() {
  const w = new Water(new THREE.PlaneGeometry(9000, 9000), {
    textureWidth: 512, textureHeight: 512, waterNormals,
    sunDirection: sunDir.clone(), sunColor: 0xffffff, waterColor: 0x0b4f8a, distortionScale: 3.2, fog: true,
  });
  w.rotation.x = -Math.PI / 2;
  w.position.set(0, 0, -4000);
  const m = w.material;
  m.uniforms.uScroll = { value: new THREE.Vector2() };
  m.uniforms.size.value = 2.4;
  // Scroll the wave pattern with distance flown, and tone the stock mirror-like Fresnel down
  // to a deep saturated blue (low-altitude grazing angles otherwise reflect almost pure sky).
  m.fragmentShader = m.fragmentShader
    .replace('uniform float size;', 'uniform float size;\nuniform vec2 uScroll;')
    .replace('getNoise( worldPosition.xz * size )', 'getNoise( ( worldPosition.xz + uScroll ) * size )')
    .replace('float rf0 = 0.3;', 'float rf0 = 0.02;')
    .replace('sunColor * diffuseLight * 0.3', 'sunColor * diffuseLight * 0.06')
    .replace('sunLight( surfaceNormal, eyeDirection, 100.0, 2.0, 0.5, diffuseLight, specularLight );',
      'sunLight( surfaceNormal, eyeDirection, 380.0, 7.0, 0.5, diffuseLight, specularLight );')
    .replace('vec3 outgoingLight = albedo;', 'vec3 outgoingLight = albedo + specularLight * 0.45;')
    .replace('pow( ( 1.0 - theta ), 5.0 );', 'pow( ( 1.0 - theta ), 5.0 ) * 0.5;')
    .replace('vec3 scatter = max( 0.0, dot( surfaceNormal, eyeDirection ) ) * waterColor;',
      'vec3 scatter = ( 0.5 + 0.5 * max( 0.0, dot( surfaceNormal, eyeDirection ) ) ) * waterColor * 1.5;');
  scene.add(w);
  return w;
}

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
const FLAME_OUT = glowMat(0.9, 0.8, 3.4, 0.55);
const FLAME_CORE = glowMat(4, 2.4, 1.6, 1);

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
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffa060, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
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
  const base = key === 'tanker' ? [2.4, 2.45, 2.6] : [1, 1, 1];
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
  g.add(new THREE.Mesh(geo, mat));
  g.userData = { mats: [mat], flames: [], glows: [], base: [1, 1, 1], span: 10, len: 8, flameScale: 1 };
  return g;
}
function setFlame(g, len) {
  const { flames, glows, flameScale: s } = g.userData;
  for (let i = 0; i < flames.length; i += 2) {
    const l = len * rand(0.85, 1.15);
    flames[i].scale.set(s * 0.85, s * 0.85, Math.max(0.01, l * 3.6 * s));
    flames[i + 1].scale.set(s * 0.62, s * 0.62, Math.max(0.01, l * 0.9 * s));
    flames[i].visible = flames[i + 1].visible = len > 0.05;
  }
  for (const sp of glows) {
    sp.visible = len > 0.05;
    sp.scale.setScalar(s * (1.1 + len * 1.3) * rand(0.92, 1.08));
    sp.material.opacity = clamp(0.3 + len * 0.4, 0, 0.85);
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
  const a = clamp(1 - alt / 220, 0, 1) * 0.8;
  s.visible = a > 0.02 && d < FAR;
  s.position.set(x, gy + 0.6, -d);
  const grow = 1 + alt / 200;
  s.scale.set(span * grow, 1, len * grow);
  s.material.opacity = a;
}
const groundAt = (x, d) => (STG().water ? 0 : terrainH(x, d + G.dist));

// ============================================================ scenery props
const VC_LAM = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
let ISLAND_MAT = null; // built once the Scenario meadow texture has loaded
const TOWER_MAT = new THREE.MeshLambertMaterial({ color: '#2a2850', emissive: '#ffffff', emissiveMap: windowTex, emissiveIntensity: 1.4 });
const hemiDome = r => new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);

// Each generator returns a geometry variant (or a ready Object3D) plus placement hints.
const PROP_GEN = {
  // Irregular forested island: noise-displaced dome wearing the Scenario meadow/rock texture,
  // ringed by a sand beach and a turquoise shallows band.
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
  { name: 'BLUE PACIFIC', sky: 'day', fog: [1800, 7000], water: '#0b5aa8', props: { island: 2, seaRock: 3 }, propCount: 14,
    clouds: 16, enemies: { fighter: 4, chaser: 3, swoop: 2 }, boss: 'SKY LEVIATHAN' },
  { name: 'DUNE SEA', sky: 'day', fog: [600, 2900], ground: 'sand', terrain: { amp: 0.55, corr: 300, edge: 520, rock: '#ffe0b0', tex: 'dunes', rockTex: 'canyon', tile: 240, rockTile: 200 },
    props: { cactus: 1 }, propCount: 70, clouds: 4, enemies: { fighter: 3, chaser: 3, swoop: 2, sam: 2 }, boss: 'SANDSTORM' },
  { name: 'EMERALD VALLEY', sky: 'day', fog: [450, 2600], ground: 'grass', terrain: { amp: 1.0, corr: 280, edge: 420, rock: '#ffffff', snow: 270, tex: 'meadow', rockTex: 'rock', tile: 420, rockTile: 170 },
    props: { trees: 6, house: 1 }, propCount: 90, clouds: 14, enemies: { fighter: 3, chaser: 4, swoop: 2, sam: 1 }, boss: 'IRON HERON' },
  { name: 'RED CANYON', sky: 'sunset', fog: [350, 2300], ground: 'rock', terrain: { amp: 1.5, corr: 250, edge: 140, rock: '#ffffff', tex: 'canyon', rockTex: 'canyon', tile: 300, rockTile: 150 },
    props: { rockSmall: 1 }, propCount: 26, clouds: 3, enemies: { fighter: 3, chaser: 3, swoop: 1, sam: 2 }, boss: 'CANYON KING' },
  { name: 'NEON HARBOR', sky: null, grad: ['#0b0626', '#3b1460', '#ff5f8f'], fog: [400, 2400], ground: 'city', city: true,
    sun: [0, 0.06, -1], sunCol: '#ff8a5b', sunI: 1.0, hemi: ['#8060ff', '#200a30', 0.8], env: 'sunset',
    props: { tower: 5, block: 3 }, propCount: 120, clouds: 0, stars: 1, enemies: { fighter: 3, chaser: 4, swoop: 3, sam: 1 }, boss: 'NIGHT CROWN' },
  { name: 'STORM FRONT', sky: 'storm', fog: [600, 3600], water: '#123848', props: { seaRock: 2 }, propCount: 14,
    clouds: 26, cloudCol: '#59606f', storm: true, enemies: { fighter: 4, chaser: 4, swoop: 2 }, boss: 'THUNDERHEAD' },
  { name: 'GLACIER LINE', sky: 'day', fog: [600, 2900], ground: 'ice', terrain: { amp: 1.2, corr: 290, edge: 380, rock: '#b8c6d6', snow: 170, tex: 'snow', rockTex: 'rock', tile: 360, rockTile: 160 },
    props: { berg: 1 }, propCount: 0, clouds: 10, exposure: 0.72, enemies: { fighter: 4, chaser: 4, swoop: 2, sam: 2 }, boss: 'POLAR WARDEN' },
  { name: 'EDGE OF SPACE', sky: 'space', fog: [900, 3400], ground: 'cloud', terrain: { amp: 0.12, corr: 0, edge: 600, rock: '#ffffff' },
    props: { puff: 5 }, propCount: 60, clouds: 0, enemies: { fighter: 4, chaser: 5, swoop: 3 }, boss: 'ORBITAL ACE' },
];
const STG = () => STAGES[G.stageIdx];

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
    scene.background = SKY_TEX[st.sky];
    scene.environment = ENV_TEX[st.sky];
    scene.backgroundIntensity = 1;
    sunDir.copy(orientSky(sky));
    scene.fog.color.set(sky.hor);
    sunLight.color.set(sky.sunCol); sunLight.intensity = sky.sunI;
    hemi.color.set('#ffffff'); hemi.groundColor.set(st.water ? '#2a4a6a' : '#6a5a40'); hemi.intensity = sky.hemi;
    skyDome.visible = false;
  } else {
    scene.background = null;
    scene.environment = ENV_TEX[st.env];
    skyU.top.value.set(st.grad[0]); skyU.mid.value.set(st.grad[1]); skyU.hor.value.set(st.grad[2]);
    sunDir.set(...st.sun).normalize();
    skyU.sunDir.value.copy(sunDir);
    skyU.sunCol.value.set(st.sunCol);
    skyU.stars.value = st.stars || 0;
    scene.fog.color.set(st.grad[2]);
    sunLight.color.set(st.sunCol); sunLight.intensity = st.sunI;
    hemi.color.set(st.hemi[0]); hemi.groundColor.set(st.hemi[1]); hemi.intensity = st.hemi[2];
    skyDome.visible = true;
  }
  G.hemiBase = hemi.intensity;
  scene.fog.near = st.fog[0]; scene.fog.far = st.fog[1];
  sunLight.position.copy(sunDir).multiplyScalar(1000);
  renderer.toneMappingExposure = st.exposure || 1;

  // ground: ocean or displaced terrain
  if (st.water) {
    if (!water) water = makeWater();
    water.visible = true;
    water.material.uniforms.waterColor.value.set(st.water);
    water.material.uniforms.sunDirection.value.copy(sunDir);
    water.material.uniforms.sunColor.value.set(st.storm ? '#8090a0' : '#ffffff');
    water.material.uniforms.distortionScale.value = st.storm ? 6 : 3.2;
    terrain.visible = false;
  } else {
    if (water) water.visible = false;
    terrain.visible = true;
    const t = st.terrain || { amp: 0, corr: 0, edge: 400, rock: '#ffffff' };
    terrainU.uAmp.value = t.amp; terrainU.uCorr.value = t.corr; terrainU.uEdge.value = t.edge;
    terrainU.uRock.value.set(t.rock); terrainU.uSnow.value = t.snow ?? -1;
    // Scenario aerial textures where the stage names one, procedural canvas textures otherwise.
    const tex = TERRAIN_TEX[t.tex] || groundTexture(st.ground);
    terrainU.uRockMap.value = TERRAIN_TEX[t.rockTex] || tex;
    terrainU.uTile.value = t.tile || TILE;
    terrainU.uRockTile.value = t.rockTile || 160;
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
  clouds = [];
  for (let i = 0; i < (st.clouds || 0); i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: cloudTex, color: st.cloudCol || '#ffffff', transparent: true, depthWrite: false, opacity: st.storm ? 0.95 : 0.85,
    }));
    cloudGroup.add(sp);
    const c = { obj: sp, x: 0, y: 0, d: 0, size: 0 };
    placeCloud(c, rand(0, RANGE));
    clouds.push(c);
  }

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
  p.x = x;
  p.y = groundAt(x, d) - (STG().terrain ? 1.5 : 0);
  p.obj.rotation.y = rand(0, Math.PI * 2);
}
function placeCloud(c, d) {
  c.d = d;
  c.x = cam.x + rand(-900, 900);
  c.y = Math.random() < 0.4 ? rand(Y_MIN + 10, Y_MAX) : rand(240, 520);
  c.size = rand(120, 280);
  c.obj.scale.set(c.size, c.size * 0.55, 1);
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
  for (const m of P.obj.userData.mats) m.color.setScalar(1);
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
  const sh = cam.shake * 1.2;
  camera.position.set(cam.x + rand(-sh, sh), cam.y + rand(-sh, sh), CAM_BACK);
  camera.lookAt(lerp(cam.x, P.x, 0.25), cam.y - 4 + cam.pitch, -140);
  camera.rotateZ(-cam.roll);
  const fovT = FOV + clamp((G.speed - SPD_BASE) / (SPD_BOOST - SPD_BASE), 0, 1) * 14;
  if (Math.abs(camera.fov - fovT) > 0.05) { camera.fov = lerp(camera.fov, fovT, damp(3, dt)); camera.updateProjectionMatrix(); }
  const boostAmt = clamp((G.speed - SPD_BASE) / (SPD_BOOST - SPD_BASE), 0, 1);
  speedBlur.uniforms.uStrength.value = lerp(speedBlur.uniforms.uStrength.value, 0.018 + boostAmt * 0.075, damp(4, dt));
  camera.updateMatrixWorld();
}

function updateScenery(dt) {
  const mv = G.speed * dt;
  for (const p of props) {
    p.d -= mv;
    if (p.d < -CAM_BACK - 120) placeProp(p, p.d + RANGE);
    p.obj.position.set(p.x, p.y, -p.d);
  }
  for (const c of clouds) {
    const pd = c.d;
    c.d -= mv;
    if (P.alive && pd >= 0 && c.d < 0 && Math.abs(c.x - P.x) < c.size * 0.35 && Math.abs(c.y - P.y) < c.size * 0.18) G.whiteout = Math.max(G.whiteout, 0.9);
    if (c.d < -CAM_BACK - 60) placeCloud(c, c.d + RANGE);
    c.obj.position.set(c.x, c.y, -c.d);
    c.obj.material.opacity = (STG().storm ? 0.95 : 0.85) * clamp((c.d + CAM_BACK) / 120, 0, 1);
  }
  terrainU.uDist.value = G.dist;
  if (water && water.visible) {
    water.material.uniforms.time.value += dt * 0.6;
    water.material.uniforms.uScroll.value.set(0, -G.dist);
  }
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
  scene.backgroundIntensity = 1 + G.lightning * 1.5;
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
  const k = st.sky ? (SKIES[st.sky].flare ?? 1) : 0.5;
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
  let g = hc.createRadialGradient(sx, sy, 0, sx, sy, 260);
  g.addColorStop(0, `rgba(255,248,225,${0.55 * vis})`); g.addColorStop(0.25, `rgba(255,220,170,${0.18 * vis})`); g.addColorStop(1, 'rgba(255,200,150,0)');
  hc.fillStyle = g; hc.fillRect(sx - 260, sy - 260, 520, 520);
  hc.strokeStyle = `rgba(255,245,220,${0.35 * vis})`; hc.lineWidth = 2;
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3 + 0.3, l = 120 + (i % 2) * 90;
    hc.beginPath(); hc.moveTo(sx - Math.cos(a) * l, sy - Math.sin(a) * l); hc.lineTo(sx + Math.cos(a) * l, sy + Math.sin(a) * l); hc.stroke();
  }
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
  if (P.alive) syncPlayer();
  syncInst(tracerMesh, G.pb);
  syncInst(ebMesh, G.eb);
  syncInst(pmMesh, G.pm);
  syncInst(emMesh, G.em);
  writeFX(ADD); writeFX(SMOKE);
  composer.render();

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

async function boot() {
  if (document.fonts) document.fonts.load(`40px 'Russo One'`).catch(() => {});
  try {
    await loadAssets();
  } catch (err) {
    setBoot('FAILED TO LOAD ASSETS — ' + err.message);
    throw err;
  }
  P.obj = makeModel('player');
  for (const m of P.obj.userData.mats) { m.roughness = 0.42; m.envMapIntensity = 1.7; } // glossier carrier-jet finish
  scene.add(P.obj);
  P.shadow = getShadow();
  bootEl?.remove();
  startDemo();
  if (G.auto) newGame();
  // Debug: ?ff=SECONDS fast-forwards the simulation (used for automated screenshots).
  for (let i = 0, n = Math.round((Number(params.get('ff')) || 0) * 60); i < n; i++) update(1 / 60);
  window.__ace = { G, P, scene, camera, renderer, update, killPlayer }; // debug handle
  requestAnimationFrame(frame);
}
boot();

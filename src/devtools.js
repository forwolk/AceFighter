import * as THREE from 'three';

// Developer / harness hooks. Everything here is driven from the page console or from
// harness/render.js through window.__ace; nothing in the game loop depends on it.
//
//   shot(nameOrSpec)   pose a deterministic, HUD-free still (stage, position, camera, scroll phase)
//   tune(key, value)   change a rendering parameter live (see TUNABLES)
//   ablate(name, on)   switch a subsystem on/off (clouds, shadows, post, terrainDetail, flare, jet)
//   masks()            render sky / surface / jet masks for the current view (data URLs)
//   bench(frames)      measure render time per frame
//   waitFrames(n)      promise that resolves after n animation frames

function parseColor(v) {
  if (typeof v === 'string' && v.includes(',')) { const [r, g, b] = v.split(',').map(Number); return new THREE.Color(r, g, b); }
  return new THREE.Color(v);
}

export function createDevTools(refs) {
  const R = refs; // live getter: R() returns the current game objects
  let shotsDoc = null;

  const TUNABLES = {
    // exposure / lighting
    'exposure': v => { R().renderer.toneMappingExposure = v; },
    'skyBright': v => { const { G, skyU } = R(); G.skyBright = v; skyU.uBright.value = v; },
    'sky.sat': v => { R().skyU.uSat.value = v; },
    'sky.zenith': v => { R().skyU.uZenith.value = v; },
    'sun': v => { R().sunLight.intensity = v; },
    'hemi': v => { const { G, hemi } = R(); G.hemiBase = v; hemi.intensity = v; },
    'fog.near': v => { const { scene, cloudPass } = R(); scene.fog.near = v; if (cloudPass) cloudPass.u.uFogNear.value = v * 0.8; },
    'fog.far': v => { const { scene, cloudPass } = R(); scene.fog.far = v; if (cloudPass) cloudPass.u.uFogFar.value = v * 0.9; },
    'fog.mul': v => { const { G, scene, cloudPass } = R(); if (G.fogBase) scene.fog.color.copy(G.fogBase).multiplyScalar(v); if (cloudPass) cloudPass.u.uFogCol.value.copy(scene.fog.color); },
    // post
    'bloom.strength': v => { R().bloom.strength = v; },
    'bloom.threshold': v => { R().bloom.threshold = v; },
    'bloom.radius': v => { R().bloom.radius = v; },
    'grade.sat': v => { R().grade.uniforms.uSat.value = v; },
    'grade.curve': v => { R().grade.uniforms.uCurve.value = v; },
    'grade.vig': v => { R().grade.uniforms.uVig.value = v; },
    // clouds
    'cloud.coverage': v => { R().cloudPass.u.uCoverage.value = v; },
    'cloud.bottom': v => { R().cloudPass.u.uBottom.value = v; },
    'cloud.top': v => { R().cloudPass.u.uTop.value = v; },
    'cloud.density': v => { R().cloudPass.u.uDensity.value = v; },
    'cloud.sigma': v => { R().cloudPass.u.uSigma.value = v; },
    'cloud.powder': v => { R().cloudPass.u.uPowder.value = v; },
    'cloud.hgFwd': v => { R().cloudPass.u.uHg.value.x = v; },
    'cloud.hgBack': v => { R().cloudPass.u.uHg.value.y = v; },
    'cloud.hgMix': v => { R().cloudPass.u.uHg.value.z = v; },
    'cloud.detail': v => { R().cloudPass.u.uDetailStr.value = v; },
    'cloud.sunMul': v => { const cp = R().cloudPass; cp.u.uSunCol.value.copy(cp.sunBase || cp.u.uSunCol.value).multiplyScalar(v); },
    'cloud.ambMul': v => { R().cloudPass.u.uAmbMul.value = v; },
    'cloud.baseScale': v => { R().cloudPass.u.uBaseScale.value = 1 / v; },
    'cloud.detailScale': v => { R().cloudPass.u.uDetailScale.value = 1 / v; },
    'cloud.weatherScale': v => { R().cloudPass.u.uWeatherScale.value = v; },
    'cloud.contrast': v => { R().cloudPass.u.uBaseContrast.value = v; },
    'cloud.covSoft': v => { R().cloudPass.u.uCovSoft.value = v; },
    'cloud.topRound': v => { R().cloudPass.u.uTopRound.value = v; },
    'cloud.hJitter': v => { R().cloudPass.u.uHJitter.value = v; },
    // ocean
    'ocean.deep': v => { R().ocean.uniforms.uDeep.value.copy(parseColor(v)); },
    'ocean.shallow': v => { R().ocean.uniforms.uShallow.value.copy(parseColor(v)); },
    'ocean.fresnel': v => { R().ocean.uniforms.uFresMul.value = v; },
    'ocean.rough': v => { R().ocean.uniforms.uRoughBase.value = v; },
    'ocean.skyMix': v => { R().ocean.uniforms.uSkyMix.value = v; },
    'ocean.amp': v => { R().ocean.uniforms.uAmp.value = v; },
    'ocean.detail': v => { R().ocean.uniforms.uDetailMul.value = v; },
    'ocean.sun': v => { R().ocean.uniforms.uSunStrength.value = v; },
    'ocean.windX': v => { R().ocean.uniforms.uWind.value.x = v; },
    'ocean.windZ': v => { R().ocean.uniforms.uWind.value.y = v; },
    // terrain
    'terrain.nrm': v => { R().terrainU.uNrmStr.value = v; },
    'terrain.tile': v => { R().terrainU.uTile.value = v; },
    'terrain.rockTile': v => { R().terrainU.uRockTile.value = v; },
    'terrain.rock': v => { R().terrainU.uRock.value.copy(parseColor(v)); },
    'terrain.snow': v => { R().terrainU.uSnow.value = v; },
    'terrain.forest0': v => { R().terrainU.uForest.value.x = v; },
    'terrain.forest1': v => { R().terrainU.uForest.value.y = v; },
    'terrain.forestDark': v => { R().terrainU.uForestDark.value = v; },
    'terrain.albedo': v => { R().terrainU.uAlbedo.value = v; },
    'terrain.amb': v => { R().terrainU.uAmbScale.value = v; },
    'terrain.env': v => { R().terrain.material.envMapIntensity = v; },
    'terrain.shadow': v => { R().terrainU.uTShadow.value = v; },
    'terrain.sea': v => { const o = R().ocean; if (!o) return; o.mesh.visible = v > -999; o.mesh.position.y = Math.max(v, 0); },   // fjord water level; < -999 hides it
    // jet
    'jet.env': v => { for (const m of R().P.obj.userData.mats) m.envMapIntensity = v; },
    'jet.rough': v => { for (const m of R().P.obj.userData.mats) m.roughness = v; },
    'jet.color': v => { for (const m of R().P.obj.userData.mats) m.color.setScalar(v); },
    'jet.metal': v => { for (const m of R().P.obj.userData.mats) m.metalness = v; },
    // switches
    'flare': v => { R().G.noFlare = !Number(v); },
    'flareMul': v => { R().G.flareMul = v; },
    'reflection': v => { R().G.noReflection = !Number(v); },
    'clouds': v => ablate('clouds', !!Number(v)),
    'shadows': v => ablate('shadows', !!Number(v)),
    'post': v => ablate('post', !!Number(v)),
  };

  function tune(key, value) {
    const f = TUNABLES[key];
    if (!f) { console.warn('[devtools] unknown tunable', key); return false; }
    f(typeof value === 'string' && !isNaN(Number(value)) && !/[,#]/.test(value) ? Number(value) : value);
    return true;
  }
  function tuneAll(obj) { for (const k in obj) tune(k, obj[k]); }
  // "a=b;c=d" or "a=b,c=d" (commas inside colour values are only used with the r,g,b form, so use ';' then)
  function tuneString(str) {
    if (!str) return;
    const sep = str.includes(';') ? ';' : ',';
    for (const kv of str.split(sep)) { const i = kv.indexOf('='); if (i > 0) tune(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); }
  }

  function ablate(name, on) {
    const r = R();
    switch (name) {
      case 'clouds': if (r.cloudPass) r.cloudPass.enabledClouds = on; break;
      case 'shadows':
        r.renderer.shadowMap.enabled = on; r.sunLight.castShadow = on;
        r.scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
        break;
      case 'post': r.bloom.enabled = on; r.speedBlur.enabled = on; r.grade.enabled = on; break;
      case 'bloom': r.bloom.enabled = on; break;
      case 'blur': r.speedBlur.enabled = on; break;
      case 'grade': r.grade.enabled = on; break;
      case 'terrainDetail': r.terrainU.uNrmStr.value = on ? 1.2 : 0; break;
      case 'flare': r.G.noFlare = !on; break;
      case 'jet': r.P.obj.visible = on; r.G.hideJet = !on; break;
      case 'reflection': r.G.noReflection = !on; break;
      default: console.warn('[devtools] unknown ablation', name); return false;
    }
    return true;
  }

  async function loadShots() {
    if (!shotsDoc) shotsDoc = await (await fetch('harness/shots.json')).json();
    return shotsDoc;
  }

  // Pose a still. The sim is advanced a few frames so camera lag / flame scale settle, then frozen.
  async function shot(spec) {
    if (typeof spec === 'string') {
      const doc = await loadShots();
      const found = doc.shots.find(s => s.name === spec);
      if (!found) throw new Error('unknown shot ' + spec);
      spec = found;
    }
    const r = R();
    const { G, P, cam } = r;
    r.seedRandom(spec.seed ?? 7);
    G.harness = true; G.noHud = true; G.noSpawn = true; G.noFx = true;
    G.state = 'play'; G.demo = false; G.paused = false; G.god = true;
    r.resetPlayer();
    r.startStage((spec.stage || 1) - 1);
    G.fade = 0; G.msgs.length = 0; G.alerts.length = 0;
    P.x = spec.x ?? 0; P.y = spec.y ?? 60; P.vx = 0; P.vy = 0; P.bank = spec.bank ?? 0; P.inv = 0;
    cam.lagX = cam.lagY = 0; cam.shake = 0; cam.pitch = 0; cam.roll = (spec.bank ?? 0) * 0.48;
    G.speed = r.SPD_BASE;
    G.camOverride = spec.cam && spec.cam !== 'chase' ? spec.cam : null;
    for (let i = 0; i < 12; i++) r.update(1 / 60);
    P.x = spec.x ?? 0; P.y = spec.y ?? 60; P.vx = 0; P.vy = 0; P.bank = spec.bank ?? 0;
    G.dist = spec.dist ?? 1000;
    const t = spec.time ?? 30;
    if (r.cloudPass) r.cloudPass.u.uTime.value = t;
    if (r.ocean) r.ocean.uniforms.uTime.value = t;
    r.syncFrame();
    G.paused = true;
    if (spec.set) tuneAll(spec.set);
    for (const a of spec.ablate || []) ablate(a, false);
    await waitFrames(2);
    return spec.name || 'custom';
  }

  function waitFrames(n) {
    return new Promise(res => { const step = () => (--n <= 0 ? res() : requestAnimationFrame(step)); requestAnimationFrame(step); });
  }

  async function bench(frames = 120) {
    const { G } = R();
    const wasPaused = G.paused;
    G.paused = false; G.noSpawn = true; G.bench = true; G.benchTimes = [];
    await waitFrames(frames + 5);
    G.bench = false; G.paused = wasPaused;
    const t = G.benchTimes.slice(5).sort((a, b) => a - b);
    const info = G.benchInfo || { calls: 0, triangles: 0 };
    const avg = t.reduce((a, b) => a + b, 0) / Math.max(1, t.length);
    return { frames: t.length, renderMsAvg: +avg.toFixed(2), renderMsP95: +(t[Math.floor(t.length * 0.95)] || 0).toFixed(2), calls: info.calls, triangles: info.triangles, method: info.timer ? 'gpu-timer' : 'readback' };
  }

  return { tune, tuneAll, tuneString, ablate, shot, bench, waitFrames, TUNABLES: Object.keys(TUNABLES), masks: () => R().renderMasks() };
}

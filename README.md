# Ace Fighter

An original arcade jet-combat game in the classic behind-the-jet, horizon-rolling style.
Built with [three.js](https://threejs.org) (r170, loaded from jsDelivr via an import map) — no build step.

## Run

ES modules and the GLB assets need to be served over HTTP (opening `index.html` from disk won't work):

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

First load pulls ~55 MB of assets (150k-triangle aircraft, 2048² PBR terrain/ocean textures, skies, UI art).

## Controls

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Steer | Arrows / WASD | Left stick / D-pad |
| Cannon (hold) | Space / J / Z | A |
| Missile (lock targets first) | K / X | B / X |
| Afterburner (uses BOOST fuel) | Shift / L | RT |
| Brake | C | LT |
| Barrel roll (dodges missiles) | Q / E or double-tap ← → | LB / RB |
| Pause | P / Esc | Start |
| Music / invert Y / fullscreen | M / I / F | |

Touch devices get an on-screen stick and buttons. Chaining kills builds a **combo** that multiplies score.

Visual overhaul progress against the reference footage is tracked in `PLAN.md`.
Rendering quality is measured with the harness in `harness/` (deterministic shots, scored against reference frames on the real GPU) — see `harness/README.md`.

## Structure

- `src/main.js` — renderer (sun shadow maps, aerial-perspective fog, MSAA + bloom + filmic finish), PBR terrain, cloud banks, stages, gameplay, HUD
- `src/ocean.js` — ocean: Phillips-spectrum normal cascades, GGX sun band, sky Fresnel, gentle Gerstner swell
- `src/clouds.js` — ray-marched volumetric cloud layer (Perlin-Worley density, Beer-Lambert + powder, Henyey-Greenstein)
- `src/devtools.js` — `window.__ace` hooks: shot posing, ~50 live tunables, ablations, GPU bench, region masks
- `src/audio.js` — WebAudio-synthesized SFX and music (no audio files)
- `assets/models/` — player, enemy and boss aircraft (GLB)
- `assets/sky/` — 360° equirectangular sky panoramas (also used for image-based lighting)
- `assets/ui/` — HUD art: emblem, gauge bar, armor ring, missile icon, result panel, title logo
- `assets/textures/` — 2048² seamless terrain albedo + normal (`_n`) + smoothness (`_r`) maps; ocean spectrum normals (`ocean_n0/n1`) + foam
- `assets/terrain/` — offline-eroded heightmaps per biome (`_h.png` 16-bit height + river, `_n.jpg` normals, `_m.jpg` sediment/rock/flow masks)
- `assets/clouds/` — 3D noise volumes (`cloud_base.bin` 64³ RGBA, `cloud_detail.bin` 32³ RGB) and the weather map

### Asset provenance

Aircraft, skies and UI art were generated with [Scenario](https://scenario.com):
concept renders + extra views with GPT Image 2.5 → 150k-tri PBR meshes with Rodin Gen-2.5 (image-to-3D);
skies with Scenario Skybox Flux; HUD art with GPT Image 2.5 (transparent PNGs);
terrain/ocean textures with Scenario Texture (seamless, 2048²) and PBR maps with PATINA Image-to-Maps.
Heightmaps, cloud noise and ocean spectra are generated offline by Python scripts (numpy/numba) — see PLAN.md §8.
Per-model yaw/scale/nozzle positions live in `MODEL_CFG` in `src/main.js`.

## Debug URL params

`?stage=N` start at stage N · `?boss` skip to the boss · `?auto` invulnerable autopilot ·
`?bot` vulnerable autopilot · `?ff=SECONDS` fast-forward the simulation on load

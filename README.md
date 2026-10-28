# Ace Fighter

An original arcade jet-combat game in the classic behind-the-jet, horizon-rolling style.
Built with [three.js](https://threejs.org) (r170, loaded from jsDelivr via an import map) — no build step.

## Run

ES modules and the GLB assets need to be served over HTTP (opening `index.html` from disk won't work):

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

First load pulls ~21 MB of assets (aircraft models, skies, terrain textures, UI art).

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

## Structure

- `src/main.js` — renderer, terrain/ocean, stages, gameplay, HUD
- `src/audio.js` — WebAudio-synthesized SFX and music (no audio files)
- `assets/models/` — player, enemy and boss aircraft (GLB)
- `assets/sky/` — 360° equirectangular sky panoramas (also used for image-based lighting)
- `assets/ui/` — HUD art: emblem, gauge bar, armor ring, missile icon, result panel, title logo
- `assets/textures/` — seamless aerial terrain textures (meadow, rock, canyon, dunes, snow) + procedural ocean normal map

### Asset provenance

Aircraft, skies and UI art were generated with [Scenario](https://scenario.com):
concept renders with GPT Image 2.5 → meshes with Tripo P2 (image-to-3D);
skies with Scenario Skybox Flux; HUD art with GPT Image 2.5 (transparent PNGs);
terrain textures with Scenario Texture (seamless).
Per-model yaw/scale/nozzle positions live in `MODEL_CFG` in `src/main.js`.

## Debug URL params

`?stage=N` start at stage N · `?boss` skip to the boss · `?auto` invulnerable autopilot ·
`?bot` vulnerable autopilot · `?ff=SECONDS` fast-forward the simulation on load

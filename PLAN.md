# Ace Fighter — Visual Overhaul Plan

Goal: close the gap between the current build and the reference recording (`Rererences/Reference.mp4`).
Findings come from frame-by-frame study of the recording (overview every 15 s, full-res stills, 5 fps motion bursts).

Legend: `[ ]` todo · `[x]` done · `[~]` partially done / follow-up noted

---

## 1. Camera & sense of speed  *(biggest gap)*

- [x] Move camera closer so the jet's wingspan fills ~50% of screen width (currently ~30%)
- [x] Much stronger camera roll coupled to bank — horizon tilts 30–50° in hard turns (currently ~1/3 of that)
- [x] Allow harder player bank (60–80°) when turning
- [x] Deliberate camera lag: jet swings toward left/right third of the screen while maneuvering, eases back to centre (without ever leaving frame)
- [x] Lower default flight altitude and floor — skim waves, river beds and canyon floors
- [x] Faster perceived ground streaming (speed/scale tuning) + stronger FOV kick on boost
- [x] Radial speed blur / streaks when boosting

## 2. Explosions, smoke & trails  *(second biggest gap)*

- [x] Volumetric-looking fireballs (large, textured, multi-stage: flash → fire → dark smoke)
- [x] Lingering dark brown-black smoke clouds (several seconds)
- [x] Shot-down jets tumble away burning with a smoke trail instead of vanishing
- [x] Thick, curving white missile trails that linger
- [x] Missile salvos fan out visibly (multi-lock volleys)

## 3. Ground realism

- [x] Photo-like seamless terrain textures via Scenario: canyon rock, forest/grass slopes, snow-rock, desert sand
- [x] Replace the artificial checkerboard farm fields
- [x] Macro variation so tiling isn't obvious (detail + large-scale blend)
- [x] Coastline islands / shoreline for the ocean stage

## 4. Lighting & post-processing

- [x] Colour grade: higher contrast and saturation
- [x] Sun glow + lens flare
- [x] Heavier bloom on highlights, subtle vignette
- [x] Mid-distance haze tuned per stage for depth
- [x] Ocean sun glitter (sparkle) + white spray behind the jet when flying low over water

## 5. Afterburners, jet finish & enemy density

- [x] Afterburner: bright orange ring + long blue-violet flame cone
- [x] Glossier metallic finish on the player jet
- [x] Denser enemy waves (6–10 on screen), larger formations, close fly-bys

## 6. Photoreal water, terrain & high-poly fighters  *(round 2)*

- [ ] Plan textures: 2048×2048+ seamless, PBR maps (albedo + normal + roughness/height) per surface
- [ ] Ocean: Scenario-generated 2048 wave textures → normal maps (two scales)
- [ ] Ocean shader: Gerstner wave displacement, layered scrolling normals, Fresnel sky reflection from the panorama, sun glitter, subsurface colour in crests, crest foam, distance-based detail fade
- [ ] Terrain: 2048 albedo per biome + extracted normal/roughness maps
- [ ] Terrain shader: PBR (MeshStandardMaterial) with triplanar albedo + normal mapping, macro/detail blending, slope/height material layering
- [ ] Fighters: regenerate player / enemy / boss at a much higher face count (and better texture fidelity)
- [ ] Re-measure orientation, scale and nozzle positions for the new meshes
- [ ] Verify all stages + flows; note frame-rate cost

---

## Progress log

- **Section 1 done** — camera 31→22 m behind (wingspan ≈50% of screen), FOV 60° (+14° on boost),
  bank up to ~85° with ~40° horizon tilt, clamped velocity-driven camera lag (jet drifts to the screen
  thirds and recentres), floor lowered to 14 m above ground / 12 m over water, base speed 340→380 m/s,
  radial speed-blur pass (always subtle, strong on afterburner). Radar moved left so it no longer sits on the jet.
- **Section 2 done** — particle atlas of rotating billowy puffs with shader lighting; fire now solid
  (normal-blended HDR ramp white-hot → orange → soot, still blooms) and depth-sorted; explosions are
  flash → 16 fire puffs → 16 lingering dark smoke clouds (3–5 s) + sparks/debris, jet kills 1.6× bigger;
  shot-down jets become darkened tumbling wrecks trailing fire/smoke until they hit the ground;
  missile trails emitted along the flight path (continuous thick plumes); one press fires a fanned
  salvo, one missile per lock (max locks 4 → 6).
- **Section 3 done** — five seamless aerial textures generated with Scenario Texture (meadow/forest,
  mountain rock, red canyon sandstone, desert dunes, snowy rock; ~165 CU). Terrain shader now samples
  them in world space (scrolls with distance), modulates with a 0.21× macro sample to hide tiling,
  uses triplanar rock on steep slopes and a height-based snow line. Checkerboard fields are gone.
  Ocean stage islands are now noise-displaced forested landmasses with beach + shallows, kept clear
  of the flight corridor by their own radius.
- **Section 4 done** — linear-HDR colour grade pass (saturation 1.22, contrast 1.1, vignette),
  bloom 0.55→0.75 / threshold 0.9→0.82, HUD-layer lens flare (glow, starburst, ghosts; off in the
  storm), more haze in valley/canyon, sharper ocean sun glitter, white spray when skimming water.
- **Section 5 done** — afterburner = orange nozzle glow + long blue-violet plume; glossier player
  paint (roughness 0.42, env reflections 1.7×); waves spawn ~1.7× more often with up to 8-ship
  formations and 4–7-ship crossings, plus head-on close fly-bys down the player's line.

### Follow-ups worth considering
- [ ] Tune difficulty for the denser waves with real play (only tested with autopilot)
- [ ] Check frame rate on real hardware (ocean reflection pass + 10k sorted particles + 3 post passes)
- [ ] Volumetric cloud banks to fly through (reference stage 2) — current clouds are sprites

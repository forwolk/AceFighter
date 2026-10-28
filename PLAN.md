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

- [x] Plan textures: 2048×2048+ seamless, PBR maps (albedo + normal + roughness/height) per surface
- [x] Ocean: Scenario-generated 2048 wave textures → normal maps (two scales)
- [x] Ocean shader: Gerstner wave displacement, layered scrolling normals, Fresnel sky reflection from the panorama, sun glitter, subsurface colour in crests, crest foam, distance-based detail fade
- [x] Terrain: 2048 albedo per biome + extracted normal/roughness maps
- [x] Terrain shader: PBR (MeshStandardMaterial) with triplanar albedo + normal mapping, macro/detail blending, slope/height material layering
- [x] Fighters: regenerate player / enemy / boss at a much higher face count (and better texture fidelity)
- [x] Re-measure orientation, scale and nozzle positions for the new meshes
- [x] Verify all stages + flows; note frame-rate cost

## 7. Rendering parity: lighting, exposure, shadows  *(round 3 — measured against the reference)*

Measured gap (ocean/valley frames): sky RGB ref 0.42/0.59/0.89 vs ours 0.82/0.84/0.88; blown pixels
ref 1% vs ours 11.6%; deep-shadow pixels (valley) ref 30% vs ours 0.9%; jet luma spread ref 0.21–0.33 vs
ours 0.10–0.19. Root cause: fill light ≈ sun, bloom on ordinary surfaces, midtone-lifting grade, no shadows.

- [x] A. Lighting/exposure rebuild: sun dominant, ambient + IBL ≈ ⅓, exposure ~0.65, bloom only on emitters,
      grade → gentle post-tonemap filmic curve. Targets: blown < 2%, valley dark > 20%, sky sat > 0.4
- [x] B. Sun shadow maps: jet self-shadowing, terrain/cliff shadows into valleys
- [x] C. Afterburner: nozzle-width, short, blue-white core; glow ~¼ size
- [x] D. Ocean: darker deep colour, less grazing reflection, fine ripples to the horizon, stronger sun path,
      crisp horizon, irregular swell, distant island silhouettes
- [x] E. Terrain: steeper/taller corridor walls, river on valley floors, zoned materials by height+slope with
      real contrast, rotated second sample vs repetition
- [x] F. Aerial perspective: height/distance haze with separate desaturation, replacing flat fog
- [x] G. Volumetric-style cloud banks (sun-shaded undersides, flyable) replacing sprites
- [x] H. Anti-aliasing / soft filter pass

## 8. Rebuild clouds, terrain, water on industry techniques  *(round 4 — technique, not tuning)*

Findings: reference clouds are soft wispy layers flown through (trueSKY / Nubis-style ray-marched
volumetrics); reference terrain has DEM-like ridgelines, strata, snow caps, forest bands (eroded
heightmaps); reference sea is desaturated navy with a broad soft sun band (wind spectrum + microfacet sun).
Sprite clusters, sine-wave heightfields and tiled bump maps cannot produce these, whatever the tuning.

- [x] A. Volumetric clouds: ray-marched slab (3D Perlin-Worley base + Worley detail erosion, coverage/weather
      map, height gradient), Beer-Lambert + powder, dual-lobe Henyey-Greenstein, cone-sampled sun shadow,
      half-res with depth-aware composite; in-cloud fog instead of white flash. Sprite banks removed.
- [x] B. Terrain: offline eroded heightmaps (ridged fBM + domain warp + droplet hydraulic erosion) with
      carved flight corridor and river; normal map + erosion/sediment/flow masks; GPU heightmap sampling;
      materials driven by slope/height/sediment (rock strata, forest band, snow with slope limit)
- [x] C. Ocean: Phillips-spectrum normal cascades (offline FFT) scrolling with wind, GGX sun glitter with
      distance-dependent roughness, navy desaturated body colour, mild Fresnel, soft horizon band,
      Gerstner swell reduced to subtle; whitecaps only near shore / storm
- [x] D. Side-by-side verification against the reference frames

## 9. Render-quality harness  *(so every change is measured against the reference)*

- [x] Deterministic shots: seeded RNG, HUD/enemies/particles off, fixed stage/position/camera/scroll
      phase/cloud time (`harness/shots.json`, `__ace.shot()`)
- [x] Matched reference frames via ffmpeg + hand-set sky/surface split lines, HUD crops/excludes
      (`harness/extract_refs.py`, overlays in `harness/ref/*_overlay.png`)
- [x] Headless renderer: one page load, all shots, PNG + depth-derived region masks, optional bench
      (`harness/render.js`)
- [x] Scorer: per-region EMD on luminance / chroma / hue / local contrast / multi-scale gradient
      structure vs reference, raw scalars both sides, HTML report + contact sheet + history with deltas
      (`harness/score.py`)
- [x] ~45 live tunables + ablations (`src/devtools.js`), URL `?set=`, `harness/sweep.py` ranks values
- [x] Baseline run scored; per-shot worst regions identified → drive Section 10 from the numbers

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
- **Section 6 done** (round 2: photoreal water/terrain, high-poly fighters, ~830 CU)
  - Textures (Scenario Texture, 2048², seam-erased): ocean wave height → seamless normal map (wrap-around
    Sobel), ocean foam, and new meadow / rock / canyon / dunes / snow albedos. PATINA Image-to-Maps
    extracted 2048² normal + smoothness maps for each terrain; tilt re-centred and meadow/canyon seams
    cross-faded so they tile.
  - Ocean (`src/ocean.js`, replaces three.js Water): 4 Gerstner swells displacing a 320² grid, three
    scrolling normal layers with distance fade, Fresnel reflection sampled from the sky panorama,
    subsurface turquoise in sun-facing crests, sharp sun glitter, texture-driven crest foam; storm preset.
  - Terrain: MeshStandardMaterial (IBL from the sky) with triplanar rock albedo + whiteout-blended
    triplanar normals, ground normal map, PATINA roughness remapped to a natural 0.62–1 range, three-scale
    ground albedo (macro / base / near detail), snow layer; grid density 230×240 → 320×330.
  - Fighters: Rodin Gen-2.5 Extreme-High, 150k triangles each (was 15–30k), 4K PBR textures, built from
    three views each (extra rear-3/4 and side views generated with GPT Image 2.5 from the originals).
    Textures repacked PNG→JPEG inside the GLBs (56 MB → 21.6 MB). Orientation/nozzles re-measured.
  - Removed primitive cone trees / cacti now that the textures carry vegetation.

### Follow-ups (round 2)
- [ ] Frame rate on real GPUs: three 150k-tri jets per enemy model in waves of up to 8 — consider a
      decimated LOD (~25k) for enemies beyond ~300 m
- [ ] First load is now ~55 MB; consider KTX2/Basis texture compression for the 2048² maps
- **Section 7 A–C done** — bloom threshold 0.82→1.0 (emitters only), post-tonemap S-curve grade replaces
  the HDR contrast lift, exposure 0.8, sky panorama ×0.62 with matching fog colour, sun 3.2 / ambient 0.38
  / IBL 0.35 (was 2.6 / 0.9 / 0.9–1.15). 4096² PCF-soft sun shadow map following the player; terrain casts
  via a displaced depth material. Afterburner: blue-white translucent core, glow ¼ size.
  Measured (ocean frame): blown 11.6%→0.2% (ref 1%), sky sat 0.09→0.37 (ref 0.53), jet luma std
  0.10→0.25 (ref 0.21), jet p5 0.68→0.21 (ref 0.22). Valley still lacks deep shadow (1.6% vs 30%) → item E.
- **Section 7 D–H done** — Ocean: 6 non-harmonic Gerstner swells with slow amplitude groups, 4th
  far-field normal layer so ripple texture survives to the horizon, Fresnel capped at 0.5, stronger sun
  path, hazy horizon landmasses. Terrain: corridor walls ramp steeply (pow) into 300–470 m massifs,
  winding river on the valley floor (dark glossy water), height-banded conifer forest zone, rock faces
  ×0.85, rotated/hashed second albedo sample kills grid repetition. Aerial perspective: global
  fog-chunk override — optical depth falls with height, desaturates toward cool grey before lifting to
  the horizon colour. Clouds: 6–10-puff banks with sun-side/underside shading, fade in/out, flyable.
  AA: 4× MSAA composer target + 5-tap soften in the finishing pass. Sea-rock props removed.
  Measured vs reference (ocean / valley / canyon / snow / storm): blown 0.3/0.1/0.2/0.6/0.6% (ref 1/3/2.5/7/0.1);
  deep-shadow 1.2/2.3/38/0.5/31% (ref 0.8/30/18/0/0.1); sat 0.32/0.25/0.69/0.26/0.43 (ref 0.42/0.52/0.46/0.25/0.10).
  Canyon now darker than the reference and the storm darker than its (flat-lit) reference frame; the
  valley's deep-shadow share is still well below the reference because our sun sits behind the camera
  in most frames, where the reference frame has the sun ahead casting the near wall into shadow.

### Follow-ups (round 3)
- [ ] Valley: per-stage sun azimuth so one corridor wall is in shadow (reference stage-6 look)
- [ ] Canyon/storm: lift ambient slightly (both now exceed the reference's shadow share)
- [ ] Frame rate on real GPUs with MSAA + shadow map + 150k-tri jets — profile before tuning further
- **Section 8 done** (round 4 — technique rebuild, no Scenario credits)
  - Clouds (`src/clouds.js`): ray-marched slab, 56 steps at half resolution, depth-aware composite.
    Density = 64³ Perlin-Worley base (+3 Worley octaves) remapped by a 256² weather map (coverage,
    type) and a type-dependent height gradient, eroded by 32³ Worley detail (wispy bases, billowy
    tops). Lighting = Beer-Lambert with 6-sample cone toward the sun, powder term, two-lobe
    Henyey-Greenstein (g 0.62 / −0.22), height-graded ambient, aerial perspective on the clouds.
    Per-stage coverage/altitude; stage 8 is a solid deck below the jet. Sprite banks removed.
  - Terrain: four offline heightmaps (1024×2048, 5.2×10.4 km, periodic) — domain-warped ridged
    multifractal + fBM, redistribution, carved wandering flight corridor with river, 400–700k droplet
    hydraulic erosion + thermal erosion (numba). Exported 16-bit height + river, world normal, and
    sediment/exposed-rock/flow masks. GPU displacement on a 360×420 grid with power-curve density
    near the camera; materials zoned by slope, altitude and erosion masks (sediment soil on floors,
    rock on eroded faces, forest band, snow with slope limit, wet gullies, river). CPU bilinear height
    for gameplay. Sine-wave heightfield deleted.
  - Ocean (`src/ocean.js`): two Phillips/Tessendorf spectrum normal cascades baked offline (320 m and
    48 m, wind-aligned, slope RMS 0.14 / 0.10) + a rotated copy to kill tiling; Fresnel ×1.9 against
    a distance-blurred sky lookup; GGX sun term with distance-growing roughness (broad soft band);
    desaturated navy body; Gerstner swell reduced to 4 gentle components; foam only in the storm.
  - Fixed along the way: terrain grid winding (back-face culled → invisible), GLSL3 flag on the cloud
    material, cloud coverage remap, stage-8 cloud layer at player altitude (white-out).
  - `Rererences/comparison_round4.jpg` has the side-by-side. Valley/canyon/snow now carry real
    landform; ocean reads as sea; clouds are soft volumes with lit tops and shaded bases.

### Follow-ups (round 4)
- [ ] Ocean body is darker than the reference frame (dark 26% vs 1%): lift uDeep / sky mix a touch
- [ ] Cloud undersides could be darker still; add in-cloud fog (currently the whiteout flash is disabled)
- [ ] Half-res cloud pass shows jitter noise in motion — add temporal reprojection or a 3×3 blur
- [ ] Terrain near-camera detail: a 3rd (0.25 m) detail normal layer for low passes
- [ ] Frame rate on real GPUs: cloud march + 4× MSAA + shadow map + 150k-tri jets — profile
- **Section 9 (harness) done** — `harness/` renders 12 deterministic shots on the real GPU (ANGLE/Metal,
  ~30 s for a full run) and scores them against matched reference frames. Baseline 85.1%.
  Findings so far, driven by the numbers:
  - frame cost ~15 ms @1280×720 on M1 Pro; post stack is ~7 ms of it, clouds and shadows ~1 ms each
  - clear-sky blue already matches the reference (chroma 46 vs 47); sky-region deficit = cloud cover
  - sea: pale grey-blue body wins monotonically (#163f68 → #86a6c4, +2.7); stronger Fresnel wins
  - clouds: slabs were caused by low-contrast base noise + steep coverage remap (shape followed the
    weather map); lighting must stay ≲1.5× sun / ambient ~1 or ACES blows them out (r2 lesson);
    cloud undersides need a high ambient floor + vertical occlusion; storm = sparse scud under the
    panorama, not a blanket layer (+10.4 on storm_sky)
  - terrain: darker/smoother wins slightly (sun, hemi, detail normals); forest darkness 0.35–0.4
  - the scorer is insensitive to cloud *silhouette*; judge that from `sheet.png`, not the number
- **Harness-driven tuning, runs r1–r7** (baseline 85.1% → r7 86.8%; ocean_low 83→90, storm_sky 82→90,
  clouds_inside 94→96; valley/alpine/snow 80–84 flat; city_night 73 unchanged)
  - fixed via the numbers: ocean normal-map swizzle (up component added to z → flat slab sea; +3.7 on
    ocean_low once fixed), resetPlayer() wiping the jet tint, sky background path (replaced by a dome
    shader with saturation/zenith), storm layer blanketing the panorama, cloud lighting overshoot (ACES)
  - lessons: the scorer is sharp for tone/colour and blind to silhouette; sweep results depend on the
    state they were measured in (the "brighter clouds" verdict flipped once shapes changed)
  - current frame cost 16–18 ms @1280×720 on M1 Pro (post ≈ 7 ms of it)

### Follow-ups (round 5)
- [x] Terrain dynamic range: reference has sunlit faces/snow at p95 ≈ 98 and forest blacks at p5 ≈ 1;
      ours compresses to 10–45. Needs brighter lit albedo + darker shadowed forest, not a global exposure move
- [x] Cloud silhouettes: judge from sheets — bases still read as straight lines; add base-height jitter by
      weather and taper the layer with distance more aggressively
- [x] city_night: our neon-synthwave concept does not match the reference (realistic dusk coastal base) —
      restyle or drop the shot from scoring
- [x] Post stack ≈ 7 ms: bloom at quarter res / fewer mips, merge speed-blur + grade into one pass
- [x] Jet: chroma 7 vs 20 — reference airframe picks up environment tint; raise metalness on the paint

### Harness rounds r8–r18 (87.4% → 89.1%; sheet: `Rererences/comparison_round6_harness.jpg`)
- [x] **Terrain zoning on a macro slope** (`textureLod` of the baked normal, ~30 m footprint): conifers now
      hold the whole fjord wall up to ~70°, bare rock only on cliff faces; forest darkness 0.15. Before this
      the fine-slope test rejected every steep texel, so the walls were bright meadow (forestDark sweep had
      no effect on them — the number that exposed it).
- [x] **Fjord water**: `terrain.sea` floods the valley floor with the ocean mesh (EMERALD VALLEY lakes at 21 m,
      GLACIER LINE fjord at 17 m; calm, dark, sky-mix 0.6). Matches the reference stage-06 fjord; valley +1.5,
      alpine +1.8. `groundAt()` clamps to the water level so props/SAMs/floor sit on it.
- [x] **Sun elevation**: the day sun was taken from the panorama (63°); the reference lights from ~34° ahead.
      Lowered (`SKIES.day.sun[1] = 0.31`) → cast shadows across the water and walls, glitter path, blown rims;
      land shots +0.7…+1.9. Terrain also marches the heightmap toward the sun for self-shadow beyond the
      shadow-map range (`terrain.shadow`), subtle at 34° but free.
- [x] **Cloud tops**: the storm slab's dead-straight top was the weather map — coverage and the height-jitter
      channel were correlated, so every cloudy cell topped out at `uTop`. Jitter now comes from a second,
      offset weather lookup and the march bounds include the jitter margin; storm_sky 89.7 → 93.1.
- [x] Storm layer thicker and sparser (160–700 m, cov 0.3, dens 1.3, jitter 0.6); sunset sky sat 0.7 (city +3.0).
- [x] Sea glitter soft-limited (`spec/(1+0.2 spec)`): a low sun had blown the near sea white. Forward scatter
      lobe 0.62 → 0.45 (less whiteout around the sun through cloud).
- [x] Post: scene now renders into its own 4× MSAA target and is resolved once (`ScenePass`); bloom chain
      pinned to a 320×180 base. The GPU timer query (ANGLE/Metal) attributes ~10 ms to bloom, but the
      wall-clock frame interval is 16.7 ms with or without it — the timer is not trustworthy for per-pass
      cost on this backend; use frame-interval A/B (`pp/fpsprobe.js`) for perf decisions.
- [x] Regression flows re-run headless (title, `?auto&ff=200`, `?bot&ff=6&die`): no page errors, fjord
      stage reached with terrain + water visible.
- Sweeps that did **not** move the number (left as is): jet paint 0.27–0.7 and metalness; terrain.amb/hemi;
  cloud.hJitter 0.1–0.9 (visual only); ocean.rough / ocean.sun / ocean.fresnel at the current sea colour.

### Follow-ups (round 6)
- [x] Sea colour: re-swept with normals + sun fixed — deep `#2c5080` with Fresnel share 1.5 (was `#86a6c4` / 4.0)
      gives the reference's saturated blue; fjord 2.0 with a darker body, storm unchanged (r18: ocean_high +1.0)
- [ ] Snow floor blows out to flat white at sun 3.8 (reference keeps blue shadow texture); per-stage exposure or
      snow albedo 0.85
- [x] HARBOR DUSK props are still boxes with dot windows; needs real base/harbour meshes (Scenario) to match the
      reference's industrial dusk coast
- [ ] Cloud march cost grows with the jitter margin; profile with frame-interval A/B, not the timer query

### Round 7 — "terrain still sucks and water still looks unnatural" (r19–r24, 88.7%)
Diagnosed from 1:1 crops against the reference rather than the score (which prefers the brighter, flatter look):
- [x] **Planar water reflections** (`renderReflection`, `ScenePass`): the scene mirrored through the water plane
      into a 640×360 target with an oblique near plane (Lengyel) so nothing below the surface shows; the ocean
      shader samples it with the wave normal as distortion. Fjord water now shows the dark walls and the jet
      instead of a pale sky mirror next to black terrain — the single biggest "unnatural" cue. +~2 ms/frame.
- [x] Sea: Fresnel share tapers with distance (far sea stays blue instead of horizon haze), wave faces toward the
      sun read lighter, glitter clamp relaxed, near-field normal detail ×1.6 on open sea.
- [x] **Real forest**: PATINA Material conifer canopy (2048², albedo + normal + roughness) replaces the darkened
      meadow on the forest band — two rotated copies, 110 m repeat; canopy normal blended into the ground normal.
      Alpine ground above the treeline is a PATINA tundra/scree material instead of meadow.
- [x] Valley ground above the tree line is tundra/scree too (the meadow read as a chartreuse blanket on the
      wall tops in play); canopy tinted cool (×0.72/0.88/0.98, brightness 0.75) toward the reference's blue-black.
- [x] Sea wavelets: mid cascade ×0.5, mirror distortion doubled, sun shading 0.4 + 0.75·N·L, sparse whitecaps
      (0.22) on the open day sea — the 1:1 crop now shows the reference's rippled light/dark pattern and glints.
- [x] Hard fjord lighting: terrain ambient 1.2 → 0.7 (per stage: dunes 1.0, canyon 0.9, dusk 1.2), sun 3.8 → 4.4,
      hemi 0.3, ground albedo 1.0; detail normals held out to 1.6 km; snow broken by strata/gullies; valley fog
      pushed out (650–3400 / 700–3600).
- Scorer note: these moves cost ~0.3 on the number (it rewards brightness) while the sheets moved toward the
  reference — when the two disagree, the sheet wins. `Rererences/comparison_round7_harness.jpg`.

### Follow-ups (round 7)
- [ ] Valley floors: the meadow banks still read as bright yellow-green; a darker moss/grass PATINA material
      (or tundra for the clearings) would match the reference's black-green shoreline
- [x] Sea glitter is physically placed (mirror point below frame at a 34° sun); the reference shows a stylised
      glitter band near the horizon — consider an anisotropic highlight stretched toward the sun
- [ ] Reflection pass skips the volumetric clouds (painted sky only) — acceptable; revisit if cloud shadows on
      water are added
- [ ] Rock on the fjord walls is still smooth at ridge scale; a sharper ridged pass in gen_terrain (less thermal
      erosion for alpine) would give the reference's craggy skyline

### Round 8 — "terrain textures still look pretty bad" (r25–r27, 89.1%)
Diagnosed from 1:1 crops: the old textures were *aerial photos with landforms baked in* (dune ridges, snowy
mountains, boulder fields) tiled at 150–420 m and projected flat onto slopes — so walls smeared into
streaks, the baked forms repeated as wallpaper, and the colour map fought the real heightmap shading.
- [x] **Material set regenerated with Scenario PATINA Material** (2048², albedo + normal + roughness + height):
      `cliff` (granite strata — fjord walls), `canyon` (red sandstone strata — canyon walls), `desert` (cracked
      clay floor), `sand` (wind ripples, no dunes), `snow` (sastrugi). These are *surfaces*; the landform comes
      from the heightmap. `scratchpad/convert_patina.py` bakes height-derived cavity AO into the albedo and
      stores roughness as smoothness like the other PATINA maps.
- [x] Shader: ground and canopy albedo are triplanar (planar XZ smeared every wall), rock uses two rotated
      copies so the strata repeat never lines up, snow is a real material (albedo + normal) instead of a flat
      colour, the rock/ground boundary is moved by macro variation so exposure is patchy, per-stage `alb`
      (pale sand/clay blew out under the full sun) and `amb`.
- [x] Rock tiles 110–130 m, sand 120 m, desert 160 m; snow brightness 0.85.
- Score +0.3 overall (city/dusk +4.5 from the sand floor, canyon +0.7); the crops moved more than the number.
  `Rererences/comparison_round8_harness.jpg`.

### Follow-ups (round 8)
- [x] The near field (< 150 m) still has no sub-metre detail layer: a third, 2–4 m detail normal for low passes
- [x] `meadow` is unused now (valley floors are tundra); a darker moss/grass PATINA material for the EMERALD
      VALLEY banks would keep the stage name honest
- [x] Craggier ridgelines: regenerate alpine/valley heightmaps with less thermal erosion and a sharper ridged pass
- [x] Cloud shadows on terrain (project the weather map along the sun) — the reference has moving cloud shadows

### Round 9 — the follow-up list, worked through (r28–r31)
- [x] **Cloud shadows** on terrain and water: the cloud march's weather lookup projected along the sun from the
      ground point up to the layer's mid height (`uCloudP`: coverage, softness, height, strength); multiplies the
      sun term only, so shadowed ground keeps its sky light. Off when the layer is off or below the player.
- [x] **Near-field detail**: the same ground / rock normal maps sampled 6–7× finer inside 260 m (sub-metre crust
      for low passes), faded out with distance.
- [x] **Craggier skylines**: `gen_terrain_v2.py` — more ridge weight (0.86 / 0.92), sharper crests, 9 octaves,
      talus 1.6–1.8 with 2–3 thermal passes instead of 5–6. Alpine hmax 795 → 873, valley 677 → 738; the corridor
      floor still sits at 15–21 m so the fjord levels (17 / 21 m) hold.
- [x] **Moss shoreline** (PATINA) for the EMERALD VALLEY banks instead of tundra.
- [x] **Sun glitter path** on water: glints gather along the azimuth toward the sun near the horizon, using a
      low "glitter sun" so the band sits where the reference puts it; cloud-shadowed.
- [x] **HARBOR DUSK props**: three Meshy T2.5 Smart-Topology GLBs (warehouse + gantry crane, fuel-tank farm, control
      tower + radar; ~8k tris, 2K PBR) replace the neon boxes; shallow harbour water (sea 3 m) with props kept
      out of it. `prepProp()` scales to a footprint and grounds each model.
- Real frame interval stays 16.7 ms on every stage (vsync); the GPU timer's 20–28 ms numbers remain
  over-reports on ANGLE/Metal. `Rererences/comparison_round9_harness.jpg`.

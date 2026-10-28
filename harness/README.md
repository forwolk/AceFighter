# Render-quality harness

Closes the loop between a code change and "does it look more like the reference?".

```
harness/
  shots.json       deterministic shot list: stage, position, camera, scroll/animation phase,
                   matched reference timestamp, sky/surface split, which regions to score
  extract_refs.py  pulls the reference frames (ffmpeg) + overlay images to check the split lines
  render.js        headless Chrome: poses every shot in one page load, saves PNG + region masks
  score.py         style-statistics distance vs reference per region → scores.json, report.html, sheet.png
  sweep.py         render + score a list of values for one tunable, rank them
  run.sh           render + score in one command
  out/<run>/       results; out/history.json tracks every scored run
```

## Use

```sh
npm install --prefix harness          # once (puppeteer-core)
pip install numpy pillow              # once
harness/run.sh baseline               # render + score all shots
harness/run.sh try1 --set "cloud.coverage=0.4;ocean.deep=#1a4a7a"
harness/run.sh noclouds --ablate clouds,shadows --bench
python3 harness/sweep.py --param cloud.sigma --values 0.006,0.009,0.012,0.016 --shots clouds_above,ocean_high
open harness/out/try1/report.html
```

`score.py` prints the overall similarity, the delta against the previous run, and per shot which
region/metric is worst. The HTML report shows ours vs reference with the raw numbers (mean luminance,
p5/p95, blown/crushed %, chroma, local contrast, high-frequency ratio) for both, so each gap reads as a
direction: darker, flatter, noisier, more saturated.

## In the game

With the page open (any URL), the same hooks are on `window.__ace`:

```js
__ace.shot('valley_floor')             // pose a shot (HUD off, enemies off, sim frozen)
__ace.tune('cloud.coverage', 0.4)      // live parameter; __ace.TUNABLES lists them
__ace.ablate('clouds', false)          // clouds / shadows / post / terrainDetail / flare / jet
await __ace.bench(120)                 // render ms per frame on *this* machine
```

URL form: `index.html?seed=7&shot=ocean_low&set=exposure=0.7;cloud.coverage=0.35`.

## Metric notes

Our camera sits closer to the jet than the reference's and the compositions never match, so the
scorer deliberately avoids pixel-aligned metrics. It compares distributions (earth-mover distance)
of luminance, chroma, hue, local contrast and multi-scale gradient magnitude, per region. Region
masks for our render come from the depth buffer (surface / jet / everything else = sky incl.
clouds); for the reference they come from the hand-set `horizon` polylines in `shots.json` — check
`harness/ref/*_overlay.png` after editing them.

`render.js` runs headless Chrome on the real GPU (ANGLE/Metal on macOS), so `--bench` frame times are
representative of this machine. Set `HARNESS_SOFTWARE=1` to force SwiftShader on a machine without a GPU.

#!/usr/bin/env node
// Render the harness shots with headless Chrome.
//   node harness/render.js --run NAME [--shots a,b] [--set k=v;k=v] [--ablate clouds,shadows] [--bench] [--port 8765]
// Loads the game once, poses each shot in-page, saves harness/out/<run>/<shot>.png (+ _surface.png, _jet.png masks)
// and harness/out/<run>/meta.json. Requires `npm install` in harness/ (puppeteer-core) and Google Chrome.
const puppeteer = require('puppeteer-core');
const fs = require('fs'); const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => { if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]); return acc; }, []));
const HERE = __dirname;
const run = args.run || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const port = args.port || 8765;
const outDir = path.join(HERE, 'out', run);
fs.mkdirSync(outDir, { recursive: true });
const doc = JSON.parse(fs.readFileSync(path.join(HERE, 'shots.json'), 'utf8'));
const wanted = args.shots ? String(args.shots).split(',') : doc.shots.map(s => s.name);
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

(async () => {
  // Real GPU (ANGLE/Metal on macOS) by default; HARNESS_SOFTWARE=1 forces SwiftShader for machines without one.
  const gpuArgs = process.env.HARNESS_SOFTWARE ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: [...gpuArgs, '--window-size=1280,720'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/GPU stall|GL Driver|404/.test(m.text())) errors.push(m.text().slice(0, 300)); });
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/index.html?seed=7&harness=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ace && window.__ace.shot, { timeout: 300000, polling: 500 });
  const gpu = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl && gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
  console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s on ${gpu}`);
  const meta = { run, time: new Date().toISOString(), gpu, set: args.set || null, ablate: args.ablate || null, shots: {}, errors };
  for (const name of wanted) {
    const spec = doc.shots.find(s => s.name === name);
    if (!spec) { console.log('unknown shot', name); continue; }
    const ts = Date.now();
    await page.evaluate(async n => { await window.__ace.shot(n); }, name);
    if (args.set) await page.evaluate(s => window.__ace.tuneString(s), String(args.set));
    if (args.ablate) await page.evaluate(list => { for (const a of list.split(',')) window.__ace.ablate(a, false); }, String(args.ablate));
    await page.evaluate(() => window.__ace.waitFrames(3));
    const wrap = await page.$('#wrap');
    await wrap.screenshot({ path: path.join(outDir, `${name}.png`) });
    const masks = await page.evaluate(() => window.__ace.masks());
    for (const k of ['surface', 'jet']) fs.writeFileSync(path.join(outDir, `${name}_${k}.png`), Buffer.from(masks[k].split(',')[1], 'base64'));
    const entry = { desc: spec.desc, ref: spec.ref, ms: Date.now() - ts };
    if (args.bench) entry.bench = await page.evaluate(n => window.__ace.bench(n), Number(args.bench) > 1 ? Number(args.bench) : 40);
    meta.shots[name] = entry;
    console.log(`${name.padEnd(14)} ${(entry.ms / 1000).toFixed(1)}s${entry.bench ? `  render ${entry.bench.renderMsAvg} ms (p95 ${entry.bench.renderMsP95}), ${entry.bench.calls} calls, ${(entry.bench.triangles / 1e6).toFixed(2)} Mtri` : ''}`);
  }
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  if (errors.length) console.log('errors:\n  ' + [...new Set(errors)].slice(0, 10).join('\n  '));
  await browser.close();
  console.log('wrote', outDir);
})().catch(e => { console.error(e); process.exit(1); });

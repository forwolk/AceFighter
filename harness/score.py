#!/usr/bin/env python3
"""Score a rendered run against the matched reference frames.

  python3 harness/score.py --run NAME [--compare PREV|auto] [--shots a,b]

Per shot and per region (sky / surface / jet) the scorer compares alignment-free *style statistics*
of our render with the reference frame — the compositions differ, so pixel metrics (SSIM, PSNR) would
be meaningless. Distances are 1-D earth-mover distances between histograms, normalised to 0..1:

  lum       luminance (Lab L) distribution         — exposure, dynamic range
  chroma    Lab chroma distribution                 — saturation
  hue       chroma-weighted hue distribution        — colour cast
  contrast  local contrast (std of L in 8x8 tiles)  — flat vs punchy
  structure gradient-magnitude distribution at 3 scales — softness vs detail / noise

  total = 0.30 lum + 0.20 chroma + 0.10 hue + 0.20 contrast + 0.20 structure   (lower is better)
  similarity = 100 * (1 - total)

Raw scalars (mean L, p5/p95, blown %, crushed %, mean chroma, high-frequency ratio) are shown for both
images so the *direction* of a gap is readable (too dark / too flat / too noisy ...).
Writes harness/out/<run>/scores.json, report.html, sheet.png and appends to harness/out/history.json.
"""
import argparse, json, os, sys, datetime
import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
WEIGHTS = {'lum': 0.30, 'chroma': 0.20, 'hue': 0.10, 'contrast': 0.20, 'structure': 0.20}

# ------------------------------------------------------------------ colour
def srgb_to_lab(img):
    c = img.astype(np.float32) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]], np.float32)
    xyz = lin @ M.T
    xyz /= np.array([0.95047, 1.0, 1.08883], np.float32)
    eps, kappa = 216 / 24389, 24389 / 27
    f = np.where(xyz > eps, np.cbrt(xyz), (kappa * xyz + 16) / 116)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return L, a, b

# ------------------------------------------------------------------ stats
def hist(values, weights, lo, hi, bins):
    h, _ = np.histogram(np.clip(values, lo, hi), bins=bins, range=(lo, hi), weights=weights)
    s = h.sum()
    return h / s if s > 0 else h

def emd(h1, h2):
    """1-D EMD between normalised histograms on the same grid, normalised to 0..1 (1 = all mass moved end to end)."""
    if h1.sum() == 0 or h2.sum() == 0: return 1.0
    c = np.cumsum(h1) - np.cumsum(h2)
    return float(np.abs(c).sum() / (len(h1) - 1))

def circ_emd(h1, h2):
    if h1.sum() == 0 or h2.sum() == 0: return 1.0
    best = 1e9
    n = len(h1)
    for shift in range(n):
        c = np.cumsum(np.roll(h1, shift)) - np.cumsum(h2)
        best = min(best, np.abs(c).sum() / (n - 1))
    return float(min(best, 1.0))

def downsample(a, f):
    h, w = (a.shape[0] // f) * f, (a.shape[1] // f) * f
    return a[:h, :w].reshape(h // f, f, w // f, f).mean((1, 3))

def grad_mag(L):
    gx = np.zeros_like(L); gy = np.zeros_like(L)
    gx[:, 1:-1] = (L[:, 2:] - L[:, :-2]) * 0.5
    gy[1:-1, :] = (L[2:, :] - L[:-2, :]) * 0.5
    return np.sqrt(gx * gx + gy * gy)

def local_std(L, t=8):
    h, w = (L.shape[0] // t) * t, (L.shape[1] // t) * t
    b = L[:h, :w].reshape(h // t, t, w // t, t)
    return b.std((1, 3))

def features(rgb, mask):
    """mask: bool HxW. Returns dict of histograms + scalars for the masked region."""
    L, a, b = srgb_to_lab(rgb)
    m = mask.astype(np.float32)
    if m.sum() < 200: return None
    chroma = np.sqrt(a * a + b * b)
    hue = (np.degrees(np.arctan2(b, a)) + 360) % 360
    out = {}
    out['h_lum'] = hist(L, m, 0, 100, 40)
    out['h_chroma'] = hist(chroma, m, 0, 80, 32)
    out['h_hue'] = hist(hue, m * chroma, 0, 360, 36)
    # local contrast on the masked region (tiles need >60% coverage)
    ls = local_std(L); mt = downsample(m, 8) > 0.6
    out['h_contrast'] = hist(ls, mt.astype(np.float32), 0, 30, 30)
    # multi-scale gradient structure
    gh = []
    Ls, ms = L, m
    for s in (1, 2, 4):
        g = grad_mag(Ls)
        gh.append(hist(np.log1p(g * 4), ms, 0, np.log1p(60 * 4), 32))
        Ls = downsample(Ls, 2); ms = downsample(ms, 2)
    out['h_grad'] = gh
    w = m / m.sum()
    e1 = float((grad_mag(L) ** 2 * m).sum() / m.sum()); L4 = downsample(L, 4); m4 = downsample(m, 4)
    e4 = float((grad_mag(L4) ** 2 * m4).sum() / max(m4.sum(), 1))
    out['scalars'] = {
        'meanL': float((L * w).sum()), 'p5': float(np.percentile(L[mask], 5)), 'p95': float(np.percentile(L[mask], 95)),
        'blown%': float((L[mask] > 95).mean() * 100), 'crushed%': float((L[mask] < 8).mean() * 100),
        'meanChroma': float((chroma * w).sum()), 'localContrast': float(ls[mt].mean()) if mt.any() else 0.0,
        'hfRatio': float(e1 / (e4 + 1e-6)),
    }
    return out

def compare(fr, fo):
    d = {
        'lum': emd(fr['h_lum'], fo['h_lum']),
        'chroma': emd(fr['h_chroma'], fo['h_chroma']),
        'hue': circ_emd(fr['h_hue'], fo['h_hue']),
        'contrast': emd(fr['h_contrast'], fo['h_contrast']),
        'structure': float(np.mean([emd(a, b) for a, b in zip(fr['h_grad'], fo['h_grad'])])),
    }
    d['total'] = float(sum(WEIGHTS[k] * d[k] for k in WEIGHTS))
    return d

# ------------------------------------------------------------------ masks
def polyline_mask(h, w, pts):
    """True above the polyline (sky)."""
    pts = sorted(pts)
    xs = np.arange(w)
    ys = np.interp(xs, [p[0] for p in pts], [p[1] for p in pts])
    yy = np.arange(h)[:, None]
    return yy < ys[None, :]

def load_ref(shot, doc):
    p = os.path.join(HERE, 'ref', f"{shot['name']}.png")
    if not os.path.exists(p): return None
    im = np.asarray(Image.open(p).convert('RGB'))
    h, w = im.shape[:2]
    valid = np.zeros((h, w), bool); x0, y0, x1, y1 = doc['refCrop']; valid[y0:y1, x0:x1] = True
    for ex in doc.get('refExclude', []) + shot.get('exclude', []): valid[ex[1]:ex[3], ex[0]:ex[2]] = False
    sky = polyline_mask(h, w, shot['horizon']) & valid
    surface = (~polyline_mask(h, w, shot['horizon'])) & valid
    # jet: the reference jet is centred low-mid; use a fixed box (reference HUD-free area), scored loosely
    jet = np.zeros((h, w), bool); jet[330:600, 420:900] = True; jet &= valid
    return im, {'sky': sky, 'surface': surface, 'jet': jet, 'all': valid}

def load_ours(run, shot, doc):
    p = os.path.join(OUT, run, f"{shot['name']}.png")
    if not os.path.exists(p): return None
    im = np.asarray(Image.open(p).convert('RGB'))
    h, w = im.shape[:2]
    def mask(k):
        mp = os.path.join(OUT, run, f"{shot['name']}_{k}.png")
        m = np.asarray(Image.open(mp).convert('L').resize((w, h), Image.NEAREST)) > 128
        return m
    surf = mask('surface'); jet = mask('jet')
    valid = np.zeros((h, w), bool); x0, y0, x1, y1 = doc['refCrop']; valid[y0:y1, x0:x1] = True
    return im, {'sky': (~surf) & (~jet) & valid, 'surface': surf & (~jet) & valid, 'jet': jet & valid, 'all': valid}

# ------------------------------------------------------------------ report
def tint(im, masks):
    o = im.astype(np.float32).copy()
    for k, col in (('sky', (0, 0, 255)), ('surface', (0, 255, 0)), ('jet', (255, 0, 0))):
        m = masks[k]
        o[m] = o[m] * 0.6 + np.array(col) * 0.4
    return Image.fromarray(o.clip(0, 255).astype(np.uint8))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--run', required=True); ap.add_argument('--compare', default='auto'); ap.add_argument('--shots', default=None)
    args = ap.parse_args()
    doc = json.load(open(os.path.join(HERE, 'shots.json')))
    run_dir = os.path.join(OUT, args.run)
    meta = json.load(open(os.path.join(run_dir, 'meta.json'))) if os.path.exists(os.path.join(run_dir, 'meta.json')) else {}
    wanted = args.shots.split(',') if args.shots else None
    results = {}
    tiles = []
    for shot in doc['shots']:
        if wanted and shot['name'] not in wanted: continue
        ours = load_ours(args.run, shot, doc)
        if ours is None: continue
        ref = load_ref(shot, doc) if shot.get('ref') else None
        entry = {'desc': shot['desc'], 'regions': {}, 'bench': meta.get('shots', {}).get(shot['name'], {}).get('bench')}
        if ref is not None:
            tot, n = 0.0, 0
            for region in shot.get('regions', []):
                fr = features(ref[0], ref[1][region]); fo = features(ours[0], ours[1][region])
                if fr is None or fo is None: continue
                d = compare(fr, fo)
                entry['regions'][region] = {'dist': d, 'ref': fr['scalars'], 'ours': fo['scalars']}
                tot += d['total']; n += 1
            entry['total'] = tot / n if n else None
            entry['similarity'] = 100 * (1 - entry['total']) if n else None
        results[shot['name']] = entry
        # contact-sheet tile
        W, H = 426, 240
        row = Image.new('RGB', (W * 3, H + 22), 'black'); d = ImageDraw.Draw(row)
        row.paste(Image.fromarray(ours[0]).resize((W, H)), (0, 22))
        if ref is not None:
            row.paste(Image.fromarray(ref[0]).resize((W, H)), (W, 22))
            row.paste(tint(ours[0], ours[1]).resize((W, H)), (W * 2, 22))
        sim = f"  similarity {entry['similarity']:.1f}%" if entry.get('similarity') is not None else '  (no reference)'
        d.text((4, 4), f"{shot['name']}: OURS | REFERENCE {shot.get('ref') or ''} | regions{sim}", fill='yellow')
        tiles.append(row)
    scored = [r['total'] for r in results.values() if r.get('total') is not None]
    summary = {'run': args.run, 'time': datetime.datetime.now().isoformat(timespec='seconds'), 'set': meta.get('set'), 'ablate': meta.get('ablate'),
               'total': float(np.mean(scored)) if scored else None, 'similarity': float(100 * (1 - np.mean(scored))) if scored else None,
               'shots': {k: v.get('total') for k, v in results.items()}}
    json.dump({'summary': summary, 'results': results}, open(os.path.join(run_dir, 'scores.json'), 'w'), indent=1)
    if tiles:
        sheet = Image.new('RGB', (tiles[0].width, sum(t.height for t in tiles)), 'black'); y = 0
        for t in tiles: sheet.paste(t, (0, y)); y += t.height
        sheet.save(os.path.join(run_dir, 'sheet.png'))
    # history + comparison
    hist_p = os.path.join(OUT, 'history.json')
    history = []
    if os.path.exists(hist_p):
        try: history = json.load(open(hist_p))
        except json.JSONDecodeError: history = []
    prev = None
    if args.compare == 'auto':
        prev = next((h for h in reversed(history) if h['run'] != args.run), None)
    elif args.compare:
        prev = next((h for h in history if h['run'] == args.compare), None)
    history = [h for h in history if h['run'] != args.run] + [summary]
    tmp = hist_p + f'.{os.getpid()}.tmp'   # atomic replace: parallel sweeps must never see a half-written file
    json.dump(history, open(tmp, 'w'), indent=1); os.replace(tmp, hist_p)
    write_report(run_dir, doc, results, summary, prev)
    # console
    print(f"run {args.run}: similarity {summary['similarity']:.1f}%" if summary['similarity'] is not None else f"run {args.run}: no scored shots",
          (f"  (prev {prev['run']}: {prev['similarity']:.1f}%, Δ {summary['similarity'] - prev['similarity']:+.1f})" if prev and prev.get('similarity') is not None and summary['similarity'] is not None else ''))
    for name, r in results.items():
        if r.get('total') is None: print(f"  {name:14s} (no reference)"); continue
        parts = []
        for region, rr in r['regions'].items():
            d = rr['dist']; worst = max((k for k in WEIGHTS), key=lambda k: WEIGHTS[k] * d[k])
            parts.append(f"{region}:{100 * (1 - d['total']):.0f}% (worst {worst})")
        delta = ''
        if prev and prev['shots'].get(name) is not None: delta = f"  Δ {100 * (prev['shots'][name] - r['total']):+.1f}"
        print(f"  {name:14s} {r['similarity']:5.1f}%{delta}   " + '  '.join(parts))

def write_report(run_dir, doc, results, summary, prev):
    rows = []
    for name, r in results.items():
        shot = next(s for s in doc['shots'] if s['name'] == name)
        regions_html = ''
        for region, rr in r['regions'].items():
            d, a, b = rr['dist'], rr['ref'], rr['ours']
            dist_cells = ''.join(f"<td class=d style='--v:{d[k]:.2f}'>{k} {d[k]:.2f}</td>" for k in WEIGHTS)
            sc = ''.join(f"<tr><td>{k}</td><td>{a[k]:.1f}</td><td>{b[k]:.1f}</td><td class=dl>{b[k] - a[k]:+.1f}</td></tr>" for k in a)
            regions_html += f"<div class=region><b>{region}</b> similarity {100 * (1 - d['total']):.1f}%<table class=dist><tr>{dist_cells}</tr></table><table class=sc><tr><th></th><th>ref</th><th>ours</th><th>Δ</th></tr>{sc}</table></div>"
        bench = r.get('bench')
        bench_html = f"<div class=bench>render {bench['renderMsAvg']} ms avg / {bench['renderMsP95']} p95 · {bench['calls']} draw calls · {bench['triangles'] / 1e6:.2f} Mtri</div>" if bench else ''
        sim = f"{r['similarity']:.1f}%" if r.get('similarity') is not None else 'n/a'
        rows.append(f"""<section><h2>{name} <small>{shot['desc']}</small> <span class=sim>{sim}</span></h2>
<div class=imgs><figure><img src='{name}.png'><figcaption>ours</figcaption></figure>
<figure>{f"<img src='../../ref/{name}.png'><figcaption>reference {shot.get('ref')}</figcaption>" if shot.get('ref') else '<figcaption>no reference</figcaption>'}</figure></div>
{bench_html}{regions_html}</section>""")
    prev_html = f"<p>previous run <b>{prev['run']}</b>: {prev['similarity']:.1f}% (Δ {summary['similarity'] - prev['similarity']:+.1f})</p>" if prev and prev.get('similarity') is not None and summary.get('similarity') is not None else ''
    html = f"""<!doctype html><meta charset=utf-8><title>Ace Fighter render harness — {summary['run']}</title>
<style>body{{font:14px system-ui;background:#111;color:#ddd;margin:20px}} h1 small,h2 small{{color:#888;font-weight:normal;font-size:.7em}} .sim{{float:right;color:#ffd36b}}
section{{border-top:1px solid #333;padding:16px 0}} .imgs{{display:flex;gap:12px}} figure{{margin:0;flex:1}} img{{width:100%;border-radius:4px}} figcaption{{color:#888;font-size:12px}}
.region{{display:inline-block;vertical-align:top;background:#1a1a1a;padding:8px 12px;margin:8px 8px 0 0;border-radius:6px}}
table{{border-collapse:collapse;font-size:12px}} td,th{{padding:2px 8px;text-align:right}} td.d{{background:linear-gradient(90deg,#3a6 calc((1 - var(--v)) * 100%),#333 0)}} td.dl{{color:#9cf}}
.bench{{color:#9fb;font-size:12px;margin-top:6px}}</style>
<h1>Ace Fighter render harness <small>run {summary['run']} · {summary['time']} · set: {summary.get('set') or '—'} · ablate: {summary.get('ablate') or '—'}</small></h1>
<p>Overall similarity to reference: <b style='font-size:1.4em;color:#ffd36b'>{f"{summary['similarity']:.1f}%" if summary.get('similarity') is not None else 'n/a'}</b> (mean over scored shots; 100% = identical style statistics)</p>{prev_html}
<p><img src='sheet.png' style='width:100%'></p>{''.join(rows)}"""
    open(os.path.join(run_dir, 'report.html'), 'w').write(html)

if __name__ == '__main__':
    main()

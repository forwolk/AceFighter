#!/usr/bin/env python3
"""Extract the reference frames named in shots.json from the reference recording.
Usage: python3 harness/extract_refs.py [path/to/Reference.mp4]
Writes harness/ref/<shot>.png (full 1280x720 frame) and harness/ref/<shot>_overlay.png (horizon + crop check).
"""
import json, os, subprocess, sys
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
video = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'Rererences', 'Reference.mp4')
ffmpeg = os.environ.get('FFMPEG', '/opt/homebrew/bin/ffmpeg' if os.path.exists('/opt/homebrew/bin/ffmpeg') else 'ffmpeg')
doc = json.load(open(os.path.join(HERE, 'shots.json')))
out = os.path.join(HERE, 'ref'); os.makedirs(out, exist_ok=True)
x0, y0, x1, y1 = doc['refCrop']
for s in doc['shots']:
    if not s.get('ref'): continue
    png = os.path.join(out, f"{s['name']}.png")
    subprocess.run([ffmpeg, '-v', 'error', '-y', '-ss', s['ref'], '-i', video, '-frames:v', '1', png], check=True)
    im = Image.open(png).convert('RGB'); d = ImageDraw.Draw(im)
    d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=(255, 255, 0), width=2)
    for ex in doc.get('refExclude', []) + s.get('exclude', []): d.rectangle(ex, outline=(255, 0, 0), width=2)
    pts = [tuple(p) for p in s.get('horizon', [])]
    if len(pts) > 1: d.line(pts, fill=(0, 255, 0), width=3)
    im.save(os.path.join(out, f"{s['name']}_overlay.png"))
    print('ref', s['name'], s['ref'])

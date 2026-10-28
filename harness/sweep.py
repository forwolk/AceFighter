#!/usr/bin/env python3
"""Parameter sweep: render + score each value of a tunable and rank them.

  python3 harness/sweep.py --param cloud.coverage --values 0.3,0.4,0.5 [--shots clouds_above,ocean_low] [--base "k=v;k=v"]

Each value becomes a run named sweep_<param>_<value>; results are summarised at the end. Values may be
numbers or colours (#rrggbb). Needs the dev server running (harness/run.sh starts it).
"""
import argparse, json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument('--param', required=True); ap.add_argument('--values', required=True)
ap.add_argument('--shots', default=None); ap.add_argument('--base', default=None); ap.add_argument('--port', default='8765')
a = ap.parse_args()
py = sys.executable
rows = []
for v in a.values.split(','):
    run = f"sweep_{a.param.replace('.', '_')}_{v.replace('#', '')}"
    setting = f"{a.param}={v}" + (f";{a.base}" if a.base else '')
    cmd = ['node', os.path.join(HERE, 'render.js'), '--run', run, '--set', setting, '--port', a.port]
    if a.shots: cmd += ['--shots', a.shots]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
    cmd = [py, os.path.join(HERE, 'score.py'), '--run', run, '--compare', '']
    if a.shots: cmd += ['--shots', a.shots]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
    s = json.load(open(os.path.join(HERE, 'out', run, 'scores.json')))['summary']
    rows.append((v, s['similarity'], s['shots']))
    print(f"{a.param} = {v:>8}  similarity {s['similarity']:.2f}%")
best = max(rows, key=lambda r: r[1] or -1)
print(f"\nbest: {a.param} = {best[0]}  ({best[1]:.2f}%)")
names = sorted({k for r in rows for k in r[2]})
print('per shot:'); print('  value    ' + ' '.join(f"{n[:12]:>12}" for n in names))
for v, sim, shots in rows:
    print(f"  {v:>8} " + ' '.join(f"{100 * (1 - shots[n]):>11.1f}%" if shots.get(n) is not None else f"{'-':>12}" for n in names))

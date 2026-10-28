#!/usr/bin/env bash
# One-shot evaluation: start the dev server if needed, render all shots, score them, print the summary.
#   harness/run.sh [RUN_NAME] [extra render.js args, e.g. --set "cloud.coverage=0.4" --ablate clouds --bench]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$HERE")"
RUN="${1:-$(date +%Y%m%d-%H%M%S)}"; shift || true
PORT="${PORT:-8765}"; PY="${PY:-python3}"
if ! curl -s "http://localhost:$PORT/index.html" >/dev/null; then
  (cd "$ROOT" && python3 -m http.server "$PORT" >/dev/null 2>&1 &)
  sleep 1
fi
[ -d "$HERE/ref" ] || "$PY" "$HERE/extract_refs.py"
[ -d "$HERE/node_modules" ] || (cd "$HERE" && npm install --silent)
node "$HERE/render.js" --run "$RUN" --port "$PORT" "$@"
"$PY" "$HERE/score.py" --run "$RUN"
echo "report: $HERE/out/$RUN/report.html"

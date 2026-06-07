#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Build React frontend if source is newer than the last build
FRONTEND="$ROOT/frontend"
BUILD="$ROOT/static/app/index.html"
if [ -d "$FRONTEND" ] && { [ ! -f "$BUILD" ] || find "$FRONTEND/src" -newer "$BUILD" -name "*.tsx" -o -name "*.ts" -o -name "*.css" | grep -q .; }; then
  echo "→ Building frontend..."
  cd "$FRONTEND" && npm run build
  cd "$ROOT"
fi

# Find Python: prefer venv's real interpreter, fall back to system python3
PYTHON=""
for candidate in "$ROOT/venv_mac/bin/python3.9" "$ROOT/venv/bin/python3" "$ROOT/venv/bin/python" python3 python; do
  if [ -f "$candidate" ] && file "$candidate" | grep -q "Mach-O\|ELF"; then
    PYTHON="$candidate"
    break
  elif command -v "$candidate" &>/dev/null 2>&1; then
    PYTHON="$candidate"
    break
  fi
done
PYTHON="${PYTHON:-python3}"

# Make sure backend package is importable
export PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-5001}"

echo "→ Starting TeleCloud on http://$HOST:$PORT"
exec "$PYTHON" -m uvicorn backend.main:app --host "$HOST" --port "$PORT"

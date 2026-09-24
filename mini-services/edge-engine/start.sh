#!/usr/bin/env bash
# edge-engine startup script — auto-installs Python deps if missing, then launches.
set -e
PY=/home/z/.venv/bin/python3
PIP="$PY -m pip"

# Check if required packages are importable; install if missing
if ! $PY -c "import fastembed, qdrant_edge" 2>/dev/null; then
  echo "[edge-engine] installing dependencies (fastembed + qdrant-edge-py)..."
  $PIP install --quiet qdrant-edge-py fastembed 2>&1 | tail -3
  echo "[edge-engine] dependencies installed."
fi

# Launch the single-threaded http.server
cd "$(dirname "$0")/src"
exec $PY main.py

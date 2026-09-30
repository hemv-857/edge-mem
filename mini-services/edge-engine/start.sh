#!/usr/bin/env bash
# edge-engine startup script.
# Resolves a Python interpreter that has qdrant-edge-py + fastembed, bootstrapping
# a local venv when the default interpreter doesn't. Previously this hard-coded
# /home/z/.venv (a container-only path) and failed everywhere else.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
VENV="${EDGE_VENV:-$ROOT/.venv}"

# --- Qdrant Server (the centralized cloud) --------------------------------
# The engine prefers a real Qdrant Server for the shared cloud. Bootstrap the
# binary on first run (same policy as the venv bootstrap) and leave the engine
# to fall back to the embedded cloud when no server can be started.
QD_HOME="${QDRANT_HOME_DIR:-$ROOT/.qdrant}"
QD_URL="${QDRANT_URL:-http://localhost:6333}"

qdrant_up() { curl -sf --max-time 1 "$QD_URL/healthz" >/dev/null 2>&1; }

ensure_qdrant() {
	qdrant_up && return 0
	local bin="$QD_HOME/qdrant" ver="${QDRANT_VERSION:-v1.19.1}" arch="" sha=""
	# SHA-256 of the v1.19.1 release tarballs (GitHub release asset digests).
	# Another QDRANT_VERSION needs its own QDRANT_SHA256.
	case "$(uname -sm)" in
		"Darwin arm64")    arch=aarch64-apple-darwin;      sha=e060209dfefc9d977ddcec48521349f505f8fd1ce21f2a3db444140870522fe4 ;;
		"Darwin x86_64")   arch=x86_64-apple-darwin;       sha=ba7cbada9a90aefdbd7f92de4e093cd25328206bd65e9e96657bd6133d272637 ;;
		"Linux x86_64")    arch=x86_64-unknown-linux-gnu;  sha=eef986e769d4d3e806dd2d546e1b4ecdd416211e54d34b4ed764fac7c58e1085 ;;
		"Linux aarch64")   arch=aarch64-unknown-linux-musl; sha=0e607c11705fab22f7d667f4749bc0b6b60a8fa9e91de71880a6ebafbbda1b26 ;;
		*) echo "[edge-engine] no qdrant build for $(uname -sm)" >&2; return 1 ;;
	esac
	[ "$ver" = v1.19.1 ] || sha="${QDRANT_SHA256:-}"
	if [ ! -x "$bin" ]; then
		if [ -z "$sha" ]; then
			echo "[edge-engine] set QDRANT_SHA256 for qdrant $ver ($arch)" >&2
			return 1
		fi
		echo "[edge-engine] bootstrapping qdrant $ver ($arch) into $QD_HOME..."
		mkdir -p "$QD_HOME" || return 1
		local tgz="$QD_HOME/qdrant-$arch.tar.gz"
		curl -fsSL -o "$tgz" "https://github.com/qdrant/qdrant/releases/download/$ver/qdrant-$arch.tar.gz" || return 1
		local got
		got="$({ sha256sum "$tgz" 2>/dev/null || shasum -a 256 "$tgz"; } | cut -d' ' -f1)"
		if [ "$got" != "$sha" ]; then
			echo "[edge-engine] qdrant tarball sha256 mismatch — refusing to run it" >&2
			rm -f "$tgz"
			return 1
		fi
		tar -xzf "$tgz" -C "$QD_HOME" qdrant && rm -f "$tgz" || return 1
	fi
	# loopback only: the cloud is reached by the engines on this host; anything
	# remote should use its own secured QDRANT_URL. QDRANT_API_KEY (optional)
	# turns on Qdrant auth and is also presented by cloud_qdrant.py.
	( cd "$QD_HOME" && env QDRANT__STORAGE__STORAGE_PATH="$QD_HOME/storage" \
		QDRANT__SERVICE__HOST=127.0.0.1 \
		${QDRANT_API_KEY:+"QDRANT__SERVICE__API_KEY=$QDRANT_API_KEY"} \
		nohup "$bin" >"$QD_HOME/qdrant.log" 2>&1 & ) || return 1
	# we own a fresh local server now — ignore any operator-supplied URL that
	# was already unreachable, otherwise the engine would probe that instead
	QD_URL="http://127.0.0.1:6333"
	for _ in $(seq 1 60); do
		qdrant_up && return 0
		sleep 0.5
	done
	return 1
}

if ensure_qdrant; then
	export QDRANT_URL="$QD_URL"
	export QDRANT_STORAGE="$QD_HOME/storage"
	echo "[edge-engine] cloud: Qdrant Server at $QDRANT_URL"
else
	echo "[edge-engine] cloud: Qdrant Server unavailable — using embedded cloud" >&2
	export QDRANT_URL="$QD_URL"
fi

have_deps() { [ -x "$1" ] && "$1" -c 'import fastembed, qdrant_edge, qdrant_client' 2>/dev/null; }

if [ -n "${PYTHON:-}" ]; then
	PY="$PYTHON"
elif have_deps /home/z/.venv/bin/python3; then
	PY=/home/z/.venv/bin/python3
elif have_deps "$VENV/bin/python3"; then
	PY="$VENV/bin/python3"
else
	PY="$(command -v python3.13 || command -v python3 || true)"
	if [ -z "$PY" ]; then
		echo "[edge-engine] ERROR: no python3 interpreter found (set PYTHON=/path/to/python)" >&2
		exit 1
	fi
	if ! have_deps "$PY"; then
		echo "[edge-engine] bootstrapping $VENV from requirements.txt with $PY..."
		"$PY" -m venv "$VENV"
		"$VENV/bin/pip" install --quiet --upgrade pip
		"$VENV/bin/pip" install --quiet -r requirements.txt
		PY="$VENV/bin/python3"
	fi
fi

# Render buildCommand runs this with EDGE_WARMUP=1: the qdrant binary (above)
# and the embedding models are cached during the build, whose disk survives into
# runtime — so boot never races the health-check window on a cold, ephemeral
# disk. No servers are started here.
if [ "${EDGE_WARMUP:-0}" = "1" ]; then
	echo "[edge-engine] warmup: caching embedding models..."
	PYTHONPATH=src "$PY" -c 'import embed; embed.get_dense(); embed.get_bm25()'
	echo "[edge-engine] warmup complete"
	exit 0
fi

# --- federated peer: a second real device on its own port + data dir -------
# device-alpha is this process; device-beta is a genuinely separate engine
# holding its own memory, reaching the same Qdrant Server. The fleet panel
# probes it live (FEDERATED_PEERS) instead of rendering a stub.
# The peer is addressed purely by URL, so it can sit on another machine:
#   EDGE_PEER_HOST=192.168.1.50 ./start.sh
PEER_PORT="${EDGE_PEER_PORT:-3031}"
PEER_HOST="${EDGE_PEER_HOST:-localhost}"
PEER_URL="http://$PEER_HOST:$PEER_PORT"
peer_up() { curl -sf --max-time 1 "$PEER_URL/api/edge/health" >/dev/null 2>&1; }
# only spawn the peer locally — a remote one has to be started on its own host
if [ "${EDGE_FEDERATION_AUTO:-1}" = "1" ] && [ "$PEER_HOST" = "localhost" ] && ! peer_up; then
	echo "[edge-engine] starting federated peer device-beta on :$PEER_PORT"
	EDGE_PORT="$PEER_PORT" \
	EDGE_DEVICE=device-beta \
	EDGE_DATA_DIR="$ROOT/mini-services/edge-engine/data-beta" \
	EDGE_MODEL_DIR="${EDGE_MODEL_DIR:-$ROOT/mini-services/edge-engine/data/models}" \
	FEDERATED_PEERS= \
	nohup "$PY" src/main.py >"$ROOT/mini-services/edge-engine/data-beta.log" 2>&1 &
fi
export FEDERATED_PEERS="${FEDERATED_PEERS:-device-beta=$PEER_URL}"

echo "[edge-engine] interpreter: $PY"
exec "$PY" src/main.py

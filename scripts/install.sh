#!/usr/bin/env bash
# Installs everything Flakifier needs on macOS: Node for the app, plus mflux, pixal3d.cpp
# and the model weights for the local pipeline. Safe to re-run; finished steps are skipped.
#
#   scripts/install.sh              everything (about 45 GB of downloads on first run)
#   scripts/install.sh --cloud-only only Node; skip the local pipeline
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIXAL3D_REPO="https://github.com/LighthausInc/pixal3d.cpp"
PIXAL3D_DIR="$ROOT/vendor/pixal3d.cpp"
TRELLIS_WEIGHTS_REPO="ilintar/trellis2-gguf"
TRELLIS_WEIGHTS_DIR="$ROOT/models/trellis2"
TRELLIS_QUANT="q8"
KONTEXT_URL="https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev"
NODE_MAJOR_MIN=22
MFLUX_PYTHON="3.12"
MFLUX_MIN_VERSION="0.21"

CLOUD_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --cloud-only) CLOUD_ONLY=1 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok() { printf '    %s\n' "$1"; }
die() { printf '\033[31mError:\033[0m %s\n' "$1" >&2; exit 1; }
hf() { uvx --from huggingface_hub hf "$@"; }

[[ "$(uname -s)" == "Darwin" ]] || die "This script supports macOS only."
if [[ "$CLOUD_ONLY" == 0 && "$(uname -m)" != "arm64" ]]; then
  die "The local pipeline needs an Apple Silicon Mac. Re-run with --cloud-only."
fi

step "Xcode command line tools"
if xcode-select -p >/dev/null 2>&1; then
  ok "installed"
else
  xcode-select --install || true
  die "Finish the Xcode command line tools installer that just opened, then re-run this script."
fi

step "Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [[ -x "$candidate" ]] && eval "$("$candidate" shellenv)" && break
  done
fi
if command -v brew >/dev/null 2>&1; then
  ok "installed"
else
  echo "    Homebrew is missing. Installing it with the official installer (asks for your password)."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
fi

brew_install() {
  if brew list --formula "$1" >/dev/null 2>&1; then ok "$1 already installed"; else brew install "$1"; fi
}

step "Node $NODE_MAJOR_MIN or newer"
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if (( $(node_major) >= NODE_MAJOR_MIN )); then
  ok "node $(node --version)"
else
  brew_install node
  (( $(node_major) >= NODE_MAJOR_MIN )) || die "node on PATH is $(node --version 2>/dev/null || echo missing); need $NODE_MAJOR_MIN+."
  ok "node $(node --version)"
fi

if [[ "$CLOUD_ONLY" == 1 ]]; then
  step "Done (cloud pipelines only)"
  [[ -f "$ROOT/.env" ]] || echo "    Next: cp .env.example .env and add your API keys."
  echo "    Start with: scripts/start.sh"
  exit 0
fi

step "Build tools for the local pipeline (uv, cmake, ninja)"
brew_install uv
brew_install cmake
brew_install ninja

step "mflux (FLUX.1 Kontext on Apple Silicon)"
# Pin the Python: without it uv may pick the system Python 3.9 and silently resolve an
# ancient mflux that has no Kontext command. uv downloads Python 3.12 if needed.
if ! uv tool install --upgrade --python "$MFLUX_PYTHON" "mflux>=$MFLUX_MIN_VERSION"; then
  uv tool uninstall mflux >/dev/null 2>&1 || true
  uv tool install --python "$MFLUX_PYTHON" "mflux>=$MFLUX_MIN_VERSION"
fi
export PATH="$HOME/.local/bin:$PATH"
command -v mflux-generate-kontext >/dev/null 2>&1 || die "mflux-generate-kontext not found after install."
ok "$(command -v mflux-generate-kontext)"

step "pixal3d.cpp (image to 3D)"
if [[ -d "$PIXAL3D_DIR/.git" ]]; then
  git -C "$PIXAL3D_DIR" pull --ff-only
else
  mkdir -p "$(dirname "$PIXAL3D_DIR")"
  git clone --depth 1 "$PIXAL3D_REPO" "$PIXAL3D_DIR"
fi
# ggml is a submodule (a patched fork). Fetch only the pinned commit when the server
# allows it, otherwise fall back to the full history.
git -C "$PIXAL3D_DIR" submodule update --init --recursive --depth 1 \
  || git -C "$PIXAL3D_DIR" submodule update --init --recursive
cmake -S "$PIXAL3D_DIR" -B "$PIXAL3D_DIR/build" -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build "$PIXAL3D_DIR/build" -j
[[ -x "$PIXAL3D_DIR/build/trellis-server" ]] || die "trellis-server was not built."
ok "$PIXAL3D_DIR/build/trellis-server"

step "Hugging Face login"
if hf auth whoami >/dev/null 2>&1; then
  ok "logged in as $(hf auth whoami 2>/dev/null | head -1)"
else
  echo "    Create a read token at https://huggingface.co/settings/tokens and paste it below."
  hf auth login
fi

step "TRELLIS.2 weights ($TRELLIS_QUANT, about 11 GB)"
hf download "$TRELLIS_WEIGHTS_REPO" --include "$TRELLIS_QUANT/*" --local-dir "$TRELLIS_WEIGHTS_DIR"
ok "$TRELLIS_WEIGHTS_DIR/$TRELLIS_QUANT"

step "FLUX.1 Kontext weights (about 34 GB)"
echo "    FLUX.1 Kontext [dev] is gated. Open $KONTEXT_URL,"
echo "    sign in with the same account and accept the licence (non-commercial use)."
read -r -p "    Press Enter once you have accepted it... " _
# Probe one small file so a missing licence or token permission fails here, with a clear
# message, instead of deep inside mflux.
PROBE_DIR="$(mktemp -d)"
until hf download black-forest-labs/FLUX.1-Kontext-dev model_index.json \
    --local-dir "$PROBE_DIR" >/dev/null 2>&1; do
  echo "    No access yet for $(hf auth whoami 2>/dev/null | head -1). Check that:"
  echo "      - the model page shows 'You have been granted access' for this account"
  echo "      - a fine-grained token has 'Read access to contents of all public gated repos'"
  echo "        (or log in again with a classic read token: hf auth login --force)"
  read -r -p "    Press Enter to retry, or Ctrl-C to stop... " _
done
rm -rf "$PROBE_DIR"
# A one-step edit of a tiny image makes mflux download and cache the weights now, so the
# first bust doesn't stall on a 34 GB download.
WARMUP_DIR="$(mktemp -d)"
trap 'rm -rf "$WARMUP_DIR"' EXIT
node -e '
  const { crc32, deflateSync } = require("node:zlib");
  const size = 64;
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(size * (1 + size * 3), 200);
  for (let y = 0; y < size; y++) rows[y * (1 + size * 3)] = 0;
  process.stdout.write(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]));
' > "$WARMUP_DIR/in.png"
mflux-generate-kontext --image-path "$WARMUP_DIR/in.png" --prompt "Make it white" \
  --steps 1 --width 256 --height 256 -q 8 --output "$WARMUP_DIR/out.png"
[[ -f "$WARMUP_DIR/out.png" ]] || die "mflux did not produce an image; check the licence was accepted and try again."
ok "cached"

step "Done"
[[ -f "$ROOT/.env" ]] || echo "    Optional: cp .env.example .env and add API keys for the cloud pipelines."
echo "    Start with: scripts/start.sh"

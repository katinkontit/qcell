#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${QCELL_REPOSITORY:-katinkontit/qcell}"
REF="${QCELL_REF:-main}"
INSTALL_DIR="${QCELL_INSTALL_DIR:-$HOME/.local/lib/qcell}"
BIN_DIR="${QCELL_BIN_DIR:-$HOME/.local/bin}"

fail() {
  printf 'qcell install: %s\n' "$*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

require node
require npm

node -e '
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`qcell requires Node.js 20 or newer; found ${process.versions.node}`);
  process.exit(1);
}
'

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

SCRIPT_PATH="${BASH_SOURCE:-}"
SCRIPT_DIR=""
if [[ -n "$SCRIPT_PATH" ]]; then
  SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" 2>/dev/null && pwd || true)"
fi
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/qcell.mjs" && -f "$SCRIPT_DIR/kernel_helper.py" && -f "$SCRIPT_DIR/package-lock.json" ]]; then
  SOURCE_DIR="$SCRIPT_DIR"
else
  require curl
  require tar
  SOURCE_DIR="$TEMP_DIR/source"
  mkdir -p "$SOURCE_DIR"
  curl --fail --silent --show-error --location \
    "https://github.com/$REPOSITORY/archive/$REF.tar.gz" \
    | tar -xz --strip-components=1 -C "$SOURCE_DIR"
fi

mkdir -p "$INSTALL_DIR" "$BIN_DIR"
SOURCE_REAL="$(cd "$SOURCE_DIR" && pwd -P)"
INSTALL_REAL="$(cd "$INSTALL_DIR" && pwd -P)"

if [[ "$SOURCE_REAL" != "$INSTALL_REAL" ]]; then
  install -m 755 "$SOURCE_DIR/qcell.mjs" "$INSTALL_DIR/qcell.mjs"
  install -m 644 "$SOURCE_DIR/kernel_helper.py" "$INSTALL_DIR/kernel_helper.py"
  install -m 644 "$SOURCE_DIR/package.json" "$INSTALL_DIR/package.json"
  install -m 644 "$SOURCE_DIR/package-lock.json" "$INSTALL_DIR/package-lock.json"
else
  chmod 755 "$INSTALL_DIR/qcell.mjs"
fi

(
  cd "$INSTALL_DIR"
  npm ci --omit=dev
)

LINK="$BIN_DIR/qcell"
if [[ -e "$LINK" && ! -L "$LINK" ]]; then
  fail "refusing to replace non-symlink: $LINK"
fi
ln -sfn "$INSTALL_DIR/qcell.mjs" "$LINK"

printf '\nInstalled qcell:\n  program: %s\n  command: %s\n' "$INSTALL_DIR/qcell.mjs" "$LINK"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '\nAdd this directory to PATH:\n  export PATH="%s:$PATH"\n' "$BIN_DIR" ;;
esac

printf '\nFor each Quarto Python environment, install:\n  uv pip install ipykernel jupyter-client jupyter-cache\n\n'

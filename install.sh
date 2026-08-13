#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${QCELL_INSTALL_DIR:-$HOME/.local/lib/qcell}"
BIN_DIR="${QCELL_BIN_DIR:-$HOME/.local/bin}"
REPOSITORY="${QCELL_REPOSITORY:-katinkontit/qcell}"
REF="${QCELL_REF:-main}"

GLOBAL_PI="$(npm root --global)/@earendil-works/pi-coding-agent"

SOURCE_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fi

TEMP_DIR=""
if [[ ! -f "$SOURCE_DIR/qcell.mjs" || ! -f "$SOURCE_DIR/kernel_helper.py" ]]; then
  TEMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TEMP_DIR"' EXIT
  SOURCE_DIR="$TEMP_DIR/source"
  mkdir -p "$SOURCE_DIR"
  curl -fsSL "https://github.com/$REPOSITORY/archive/$REF.tar.gz" \
    | tar -xz --strip-components=1 -C "$SOURCE_DIR"
fi

rm -rf "$INSTALL_DIR/node_modules"
mkdir -p "$INSTALL_DIR/node_modules/@earendil-works" "$BIN_DIR"
install -m 755 "$SOURCE_DIR/qcell.mjs" "$INSTALL_DIR/qcell.mjs"
install -m 644 "$SOURCE_DIR/kernel_helper.py" "$INSTALL_DIR/kernel_helper.py"
ln -sfn "$GLOBAL_PI" "$INSTALL_DIR/node_modules/@earendil-works/pi-coding-agent"
ln -sfn "$GLOBAL_PI/node_modules/typebox" "$INSTALL_DIR/node_modules/typebox"
ln -sfn "$INSTALL_DIR/qcell.mjs" "$BIN_DIR/qcell"

printf 'Installed qcell: %s\n' "$BIN_DIR/qcell"

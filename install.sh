#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${QCELL_INSTALL_DIR:-$HOME/.local/lib/qcell}"
BIN_DIR="${QCELL_BIN_DIR:-$HOME/.local/bin}"
GLOBAL_PI="$(npm root --global)/@earendil-works/pi-coding-agent"
BASE_URL="https://raw.githubusercontent.com/katinkontit/qcell/main"

rm -rf "$INSTALL_DIR/node_modules"
mkdir -p "$INSTALL_DIR/node_modules/@earendil-works" "$BIN_DIR"
curl -fsSL "$BASE_URL/qcell.mjs" -o "$INSTALL_DIR/qcell.mjs"
curl -fsSL "$BASE_URL/kernel_helper.py" -o "$INSTALL_DIR/kernel_helper.py"
chmod 755 "$INSTALL_DIR/qcell.mjs"
ln -sfn "$GLOBAL_PI" "$INSTALL_DIR/node_modules/@earendil-works/pi-coding-agent"
ln -sfn "$GLOBAL_PI/node_modules/typebox" "$INSTALL_DIR/node_modules/typebox"
ln -sfn "$INSTALL_DIR/qcell.mjs" "$BIN_DIR/qcell"

printf 'Installed qcell: %s\n' "$BIN_DIR/qcell"

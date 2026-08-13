#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  printf 'Run this script as root inside the Fedora container.\n' >&2
  exit 1
fi

dnf -y upgrade
dnf -y update
dnf -y install helix uv npm git

npm install -g --ignore-scripts @earendil-works/pi-coding-agent

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [[ -n "$SCRIPT_PATH" ]]; then
  SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)"
fi
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/install.sh" && -f "$SCRIPT_DIR/qcell.mjs" ]]; then
  QCELL_INSTALL_DIR=/opt/qcell \
  QCELL_BIN_DIR=/usr/local/bin \
    "$SCRIPT_DIR/install.sh"
else
  curl -fsSL https://raw.githubusercontent.com/katinkontit/qcell/main/install.sh \
    | QCELL_INSTALL_DIR=/opt/qcell QCELL_BIN_DIR=/usr/local/bin bash
fi

uv pip install --system ipykernel jupyter-client jupyter-cache

HELIX_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/helix/config.toml"
mkdir -p "$(dirname "$HELIX_CONFIG")"
cat >"$HELIX_CONFIG" <<'TOML'
theme = "dracula"

[keys.normal.space]
a = ":pipe qcell"
A = ":pipe qcell -qmd \"%{buffer_name}\""
TOML

case "$(uname -m)" in
  x86_64) QUARTO_ARCH=amd64 ;;
  aarch64 | arm64) QUARTO_ARCH=arm64 ;;
  *)
    printf 'Unsupported architecture: %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

if [[ -z "${QUARTO_VERSION:-}" ]]; then
  QUARTO_VERSION="$(
    curl -fsSL https://api.github.com/repos/quarto-dev/quarto-cli/releases/latest \
      | node -e '
          const fs = require("node:fs");
          const release = JSON.parse(fs.readFileSync(0, "utf8"));
          process.stdout.write(release.tag_name.replace(/^v/, ""));
        '
  )"
fi

QUARTO_DIR="/opt/quarto/$QUARTO_VERSION"
QUARTO_URL="https://github.com/quarto-dev/quarto-cli/releases/download/v$QUARTO_VERSION/quarto-$QUARTO_VERSION-linux-$QUARTO_ARCH.tar.gz"
rm -rf "$QUARTO_DIR"
mkdir -p "$QUARTO_DIR"
curl -fsSL "$QUARTO_URL" | tar -xz -C "$QUARTO_DIR" --strip-components=1
ln -sfn "$QUARTO_DIR/bin/quarto" /usr/local/bin/quarto

printf '\nInstalled:\n'
printf '  Helix:  %s\n' "$(hx --version | head -n 1)"
printf '  uv:     %s\n' "$(uv --version)"
printf '  npm:    %s\n' "$(npm --version)"
printf '  Pi:     %s\n' "$(pi --version)"
printf '  qcell:  /usr/local/bin/qcell\n'
printf '  Quarto: %s\n' "$(quarto --version)"
printf '\nRun pi, then enter /login to authenticate.\n'

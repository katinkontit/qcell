#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  printf 'Run this script as root inside the Fedora container.\n' >&2
  exit 1
fi

dnf -y update
dnf -y install helix uv npm git
dnf -y copr enable lihaohong/yazi
dnf -y install yazi

curl -fsSL https://herdr.dev/install.sh \
  | HERDR_INSTALL_DIR=/usr/local/bin sh

npm install -g --ignore-scripts @earendil-works/pi-coding-agent

curl -fsSL https://raw.githubusercontent.com/katinkontit/qcell/main/install.sh \
  | QCELL_INSTALL_DIR=/opt/qcell QCELL_BIN_DIR=/usr/local/bin bash

uv pip install --system ipykernel jupyter-client jupyter-cache
uv pip install --system numpy pandas matplotlib seaborn scipy statsmodels scikit-learn sympy polars pymc

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

mkdir -p "$CONFIG_HOME/helix"
cat >"$CONFIG_HOME/helix/config.toml" <<'TOML'
theme = "dracula"

[keys.normal.space]
a = ":pipe qcell"
A = ":pipe qcell -qmd \"%{buffer_name}\""
TOML

mkdir -p "$CONFIG_HOME/herdr"
cat >"$CONFIG_HOME/herdr/config.toml" <<'TOML'
onboarding = false

[theme]
name = "dracula"
TOML

mkdir -p "$CONFIG_HOME/yazi"
ya pkg add yazi-rs/flavors:dracula
cat >"$CONFIG_HOME/yazi/theme.toml" <<'TOML'
[flavor]
dark = "dracula"
light = "dracula"
TOML

mkdir -p "$HOME/a"
cat >"$HOME/a/v1.qmd" <<'QMD'
---
title: "v1"
execute:
  daemon: 3600
  cache: true
  freeze: auto
  echo: false
format:
  html:
    code-fold: true
---

```{python}
#| echo: false
#| output: false

import json
import os
import sys
from pathlib import Path
from ipykernel.connect import get_connection_file

Path(".qcell-kernel.json").write_text(json.dumps({
    "connection_file": get_connection_file(),
    "pid": os.getpid(),
    "python": sys.executable,
}))
```
QMD

QUARTO_DIR="/opt/quarto/latest"
mkdir -p "$QUARTO_DIR"
curl -fsSL https://quarto.org/download/latest/quarto-linux-arm64.tar.gz \
  | tar -xz -C "$QUARTO_DIR" --strip-components=1
ln -sfn "$QUARTO_DIR/bin/quarto" /usr/local/bin/quarto

cd "$HOME/a"
if [[ -t 1 && -r /dev/tty && -w /dev/tty ]]; then
  (
    for _ in $(seq 1 60); do
      sleep 1
      json="$(herdr tab create --label preview --cwd "$HOME/a" 2>/dev/null)" || continue
      pane="$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])' 2>/dev/null)" && [ -n "$pane" ] || continue
      herdr pane run "$pane" quarto preview "$HOME/a/v1.qmd" --host 0.0.0.0 --port 8999 >/dev/null 2>&1
      exit 0
    done
  ) </dev/null >/dev/null 2>&1 &
  exec herdr </dev/tty >/dev/tty 2>&1
fi
printf 'Start the workspace with: cd "%s/a" && herdr\n' "$HOME"

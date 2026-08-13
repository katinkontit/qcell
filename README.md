# qcell

`qcell` turns a natural-language instruction selected in [Helix](https://helix-editor.com/) into one executable [Quarto](https://quarto.org/) Python cell.

It uses the Pi SDK in-process and can inspect the live Python kernel associated with the current Quarto document. Exploration stays in the kernel; only the final, reproducible cell is inserted into the `.qmd` file.

````text
instruction selected in Helix
        ↓
qcell → Pi SDK agent
        ├── live_kernel: inspect the live Quarto kernel
        └── emit_cell: return the complete fenced cell
        ↓
```{python}
...
```
````

## Properties

- One Node.js command plus a small Python Jupyter bridge: `qcell.mjs` and `kernel_helper.py`
- No Pi CLI subprocess, extension, daemon, or persistent Pi session
- Exactly two model-visible tools: `live_kernel` and `emit_cell`
- Optional full-QMD context with `-qmd`, plus live-kernel inspection
- No inherited `AGENTS.md`, Pi extensions, skills, prompt templates, or project settings
- Five-second exploratory execution timeout with kernel interruption
- Hard 10-second agent limit so the editor is released promptly
- One fenced Quarto Python cell on success; failures go to stderr
- A fresh in-memory Pi session for every editor invocation

## Requirements

- Linux or another POSIX system with `SIGINT` support
- Node.js 20 or newer and npm
- Quarto with Jupyter support
- Python with `ipykernel` and `jupyter_client`
- Helix
- Credentials for a model supported by the Pi SDK

The Pi SDK can use its existing credential store at `~/.pi/agent/auth.json` or provider environment variables such as `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. `qcell` itself never invokes the Pi CLI.

## Install qcell

Run the installer directly from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/katinkontit/qcell/main/install.sh | bash
```

Or clone the repository, inspect the installer, and run it locally:

```bash
git clone https://github.com/katinkontit/qcell.git
cd qcell
./install.sh
```

The installer checks for Node.js 20+, installs qcell and its Python bridge with the locked npm dependencies under `~/.local/lib/qcell`, and creates `~/.local/bin/qcell`. It does not modify shell startup files or Python environments.

Ensure `~/.local/bin` is in `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Add that export to your shell startup file if it is not already present.

Verify the basic interface:

```bash
printf '' | qcell                    # no output
printf 'print hello' | qcell         # nonzero exit: no live kernel
```

The second command is expected to report no kernel until the Quarto setup below is running.

### Fedora container

As root in a Fedora container, install Helix, uv, npm, Pi, qcell, its Python dependencies, and the latest Quarto tarball:

```bash
curl -fsSL https://raw.githubusercontent.com/katinkontit/qcell/main/setup-fedora-container.sh | bash
```

The script installs Pi globally with npm. qcell links to that installation and its TypeBox dependency instead of installing another Pi copy. It also writes Helix's config with the Dracula theme and qcell bindings, then creates a starter document at `~/a/a.qmd`. Set `QUARTO_VERSION` to install a specific Quarto release.

### Update

Rerun the installer:

```bash
curl -fsSL https://raw.githubusercontent.com/katinkontit/qcell/main/install.sh | bash
```

When installing from a clone, pull and rerun the local script instead:

```bash
git pull --ff-only
./install.sh
```

### Custom install paths

The installer supports environment overrides:

```bash
QCELL_INSTALL_DIR=/opt/qcell \
QCELL_BIN_DIR="$HOME/bin" \
./install.sh
```

### Uninstall

```bash
rm -f ~/.local/bin/qcell
rm -rf ~/.local/lib/qcell
```

## Prepare Python

Install `jupyter_client` and `ipykernel` in the exact environment Quarto will use. The recommended document configuration below also enables Quarto's Jupyter cache, which requires `jupyter-cache`. `pyright` is optional and provides Python editor diagnostics.

### With uv

From the Quarto project:

```bash
uv venv
. .venv/bin/activate
uv pip install ipykernel jupyter-client jupyter-cache pyright
export QUARTO_PYTHON="$PWD/.venv/bin/python"
hx document.qmd
```

If the project already has a uv environment, activate it instead of creating another one. `qcell` reads `sys.executable` from the running kernel and always launches its helper with that same interpreter; it does not need a separate uv execution mode.

### Without uv

```bash
python -m pip install jupyter-client ipykernel jupyter-cache pyright
export QUARTO_PYTHON="$(command -v python)"
```

## Prepare the Quarto document

Use a long-lived execution daemon, Jupyter caching, automatic freezing, hidden code output, and folded HTML code:

```yaml
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
```

`echo` is an execution option and therefore belongs under `execute`. `code-fold` controls HTML presentation and belongs under `format.html`. Because `echo: false` hides code globally, folding matters only for cells that override `echo: true`.

The preview server and Python kernel are separate: a running preview page alone does not mean the kernel is alive. `cache: true` requires the `jupyter-cache` package installed above. `freeze: auto` lets Quarto reuse stored computational output when appropriate.

### Required kernel-registration cell

This is not optional example code. Put it first among the document's executable cells. qcell cannot connect until this cell has executed for the current daemon kernel:

````markdown
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
````

The cell creates `.qcell-kernel.json` in the document working directory. It must execute at least once for every new daemon kernel. It is runtime metadata, not source. Add it to the Quarto project's `.gitignore`:

```gitignore
.qcell-kernel.json
```

A complete working document, including the required cell and a sample qcell instruction, is available at [`v1.qmd`](v1.qmd). Copy it into a project rather than removing the registration cell.

## Start Quarto Preview

From the directory containing the `.qmd` and `.qcell-kernel.json`:

```bash
quarto preview document.qmd
```

For a container with port `8888` published, run this from the shell or from Helix with `:sh`:

```bash
quarto preview document.qmd --host 0.0.0.0 --port 8888 --no-browser
```

Use two ASCII hyphens in `--host` and `--port`, not typographic em dashes.

Wait for the first execution. The registration cell must run before qcell can connect. A normal source-changing execution rewrites the metadata when Quarto replaces the daemon.

Caching or freezing can reuse old computation without starting a replacement kernel. If qcell reports `no live Quarto kernel found` after the daemon expires or restarts, force one fresh execution so the registration cell and document state are rebuilt:

```bash
quarto render document.qmd --cache-refresh
```

Then start or continue Preview. An old `.qcell-kernel.json` will fail when qcell tries to connect; force a fresh execution to replace it.

## Configure Helix

Merge the following into `~/.config/helix/config.toml`:

```toml
[keys.normal.space]
a = ":pipe qcell"
A = ":pipe qcell -qmd \"%{buffer_name}\""
```

- `Space`, `a`: use only the selected instruction and live kernel.
- `Space`, `A`: also append the full saved QMD as context.

`-qmd <path>` opts into full-document context. qcell reads the saved file, so save before using `Space`, `A` when the buffer has changed. The model can then see earlier imports, variable definitions, narrative, and cell order without receiving a filesystem tool.

The same snippet is in [`helix/config.toml`](helix/config.toml).

Start Helix from the Quarto document directory so `qcell` can find `./.qcell-kernel.json`:

```bash
cd /path/to/quarto-project
hx document.qmd
```

## Use it

1. Type a natural-language instruction in the `.qmd`, for example:

   ```text
   make a scatter plot of mpg against horsepower from df
   ```

2. Select the instruction in Helix.
3. Press `Space`, then `a`.
4. Helix replaces the selected instruction with a cell such as:

   ````markdown
   ```{python}
   df.plot.scatter(x="horsepower", y="mpg")
   ```
   ````

You can test the same transformation from a shell, provided the shell is in the document directory:

```bash
printf 'make a scatter plot of mpg against horsepower from df' | qcell -qmd document.qmd
```

## How document context and kernel exploration work

With `-qmd <path>`, qcell supplies the full QMD source as read-only model context. The source identifies established imports, variable names, document intent, and legitimate earlier dependencies. Without the flag, no document source is appended. The model never receives a general file-reading tool.

The agent may inspect live state only when runtime details are useful:

```python
df.columns
df.dtypes
df.head()
```

Those calls execute in the current Quarto kernel with `store_history=False`. They can still create or mutate scratch state until the daemon exits. The fixed agent contract therefore requires the final cell to contain everything it needs when the document renders from scratch in document order.

For example, exploration may discover `date`, `region`, and `revenue` columns, then emit:

```python
monthly = (
    df.groupby("date", as_index=False)["revenue"]
      .sum()
)

monthly.plot(x="date", y="revenue")
```

The final cell must not depend on temporary variables created only during exploration.

## Safety and isolation

The model sees only:

```text
live_kernel
emit_cell
```

It does not receive filesystem or shell tools. qcell uses:

- an explicit Pi tool allowlist;
- an in-memory session and settings manager;
- disabled extension and resource discovery;
- empty skills, prompts, themes, and context files;
- a fixed system prompt;
- a terminating `emit_cell` result.

Exploratory output is capped at about 30 KB. Unsupported rich output is represented by compact markers such as `[image/png output]`. Infinite exploratory code is interrupted after five seconds. Agent work has a hard 10-second limit.

## Troubleshooting

### `qcell: no live Quarto kernel found`

Check all of the following:

- Quarto has completed at least one document execution.
- The YAML contains `execute: daemon: 3600`.
- `.qcell-kernel.json` exists in the directory where Helix was started.
- The metadata cell was not skipped by caching, freezing, or `eval: false`.
- The recorded connection file still exists.
- The recorded kernel PID is still alive.
- Restart Quarto Preview after adding or changing the daemon setting.

### Agent failure

Run qcell in a terminal to see stderr:

```bash
printf 'emit a cell that imports numpy' | qcell >qcell.out
```

Common causes are missing model credentials, an unavailable provider, or `jupyter_client` missing from the kernel's Python environment.

### The preview works but qcell cannot find a kernel

The HTTP preview server can remain alive after its Python kernel exits. Confirm the daemon setting is in the document YAML, restart preview, and wait for a fresh render.

### Container preview is unreachable

Bind Quarto to all container interfaces and publish the same container port:

```bash
quarto preview document.qmd --host 0.0.0.0 --port 8888 --no-browser
```

Then open the host port mapped to container port `8888`.

### Wrong Python environment

Inspect the generated metadata:

```bash
python -c 'import json; print(json.load(open(".qcell-kernel.json"))["python"])'
```

Install `jupyter_client` into that exact interpreter, for example:

```bash
uv pip install --python /path/printed/above jupyter-client
```

## Output contract

Success:

````text
```{python}
<generated source>
```
````

Failures exit nonzero, write diagnostics to stderr, and write nothing to stdout. This lets Helix retain the selected instruction and show the error.

No model prose, streaming output, logs, or ANSI codes are written to stdout.

## License

MIT

# qcell

`qcell` turns a natural-language instruction selected in [Helix](https://helix-editor.com/) into one executable [Quarto](https://quarto.org/) Python cell.

It uses the Pi SDK in-process and can inspect the live Python kernel associated with the current Quarto document. Exploration stays in the kernel; only the final, reproducible cell is inserted into the `.qmd` file.

````text
instruction selected in Helix
        ↓
qcell → Pi SDK agent
        ├── python: inspect the live Quarto kernel
        └── emit_cell: return final Python source
        ↓
```{python}
...
```
````

## Properties

- One executable Node.js program: `qcell.mjs`
- No Pi CLI subprocess, extension, daemon, or persistent Pi session
- Exactly two model-visible tools: `python` and `emit_cell`
- No inherited `AGENTS.md`, Pi extensions, skills, prompt templates, or project settings
- Five-second exploratory execution timeout with kernel interruption
- One fenced Quarto Python cell on stdout; diagnostics go to stderr
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

```bash
mkdir -p ~/.local/lib ~/.local/bin
git clone https://github.com/katinkontit/qcell.git ~/.local/lib/qcell
cd ~/.local/lib/qcell
npm ci --omit=dev
chmod +x qcell.mjs
ln -sfn ~/.local/lib/qcell/qcell.mjs ~/.local/bin/qcell
```

Ensure `~/.local/bin` is in `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Add that export to your shell startup file if it is not already present.

Verify the basic interface:

```bash
printf '' | qcell                    # no output
printf 'print hello' | qcell         # fenced "no live kernel" cell
```

The second command is expected to report no kernel until the Quarto setup below is running.

### Update

```bash
cd ~/.local/lib/qcell
git pull --ff-only
npm ci --omit=dev
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
title: "O.O"
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

A complete working starter document, including the required cell, is available at [`qcell-starter.qmd`](qcell-starter.qmd). Copy it into a project rather than removing the registration cell.

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

Then start or continue Preview. Do not trust an old `.qcell-kernel.json`; qcell checks that its connection file, interpreter, and PID are still valid.

## Configure Helix

Merge the following into `~/.config/helix/config.toml`:

```toml
[keys.normal.space]
a = ":pipe qcell"
```

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
printf 'make a scatter plot of mpg against horsepower from df' | qcell
```

## How kernel exploration works

The agent may inspect existing state:

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
python
emit_cell
```

It does not receive filesystem or shell tools. qcell uses:

- an explicit Pi tool allowlist;
- an in-memory session and settings manager;
- disabled extension and resource discovery;
- empty skills, prompts, themes, and context files;
- a fixed system prompt;
- a terminating `emit_cell` result.

Exploratory output is capped at about 30 KB. Unsupported rich output is represented by compact markers such as `[image/png output]`. Infinite exploratory code is interrupted after five seconds, and the helper process has a slightly longer grace timeout.

## Troubleshooting

### `# qcell: no live Quarto kernel found`

Check all of the following:

- Quarto has completed at least one document execution.
- The YAML contains `execute: daemon: 3600`.
- `.qcell-kernel.json` exists in the directory where Helix was started.
- The metadata cell was not skipped by caching, freezing, or `eval: false`.
- The recorded connection file still exists.
- The recorded kernel PID is still alive.
- Restart Quarto Preview after adding or changing the daemon setting.

### `# qcell: agent failed`

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

Failures remain valid Quarto cells, for example:

````text
```{python}
# qcell: agent failed
```
````

No model prose, streaming output, logs, or ANSI codes are written to stdout.

## License

MIT

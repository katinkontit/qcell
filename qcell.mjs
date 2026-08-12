#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const KERNEL_METADATA_FILE = ".qcell-kernel.json";
const KERNEL_TIMEOUT_SECONDS = 5;
const PROCESS_TIMEOUT_MS = 7_000;
const PROCESS_KILL_GRACE_MS = 500;
const MAX_CHILD_STDOUT_BYTES = 32 * 1024;
const MAX_CHILD_STDERR_BYTES = 32 * 1024;

const SYSTEM = `You generate one Python code cell for a Quarto document.

The live Python kernel is an ephemeral scratch environment associated
with the current document.

Use the python tool when useful to inspect existing objects, schemas,
values, APIs, imports, and behavior.

Exploratory kernel state is not permanent. Do not assume variables
created during exploration will exist when the document renders from
scratch.

The QMD document is the program of record. The final cell must contain
all code required for that cell to work when the document is executed
from scratch in document order.

Finish by calling emit_cell with the complete Python source for one cell.

emit_cell must be your final action.

Do not include Markdown fences in the code passed to emit_cell.`;

const PYTHON_HELPER = String.raw`
import os
import queue
import re
import signal
import sys
import time

from jupyter_client import BlockingKernelClient

MAX_OUTPUT_BYTES = 30 * 1024
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")

connection_file = sys.argv[1]
timeout = float(sys.argv[2])
code = sys.argv[3]
kernel_pid = int(os.environ["QCELL_KERNEL_PID"])

client = None
execution_started = False
output_parts = []
output_bytes = 0
output_truncated = False


def append_output(value):
    global output_bytes, output_truncated
    if value is None or output_truncated:
        return
    text = str(value)
    encoded = text.encode("utf-8", errors="replace")
    remaining = MAX_OUTPUT_BYTES - output_bytes
    if remaining <= 0:
        output_truncated = True
        return
    if len(encoded) > remaining:
        text = encoded[:remaining].decode("utf-8", errors="ignore")
        encoded = text.encode("utf-8")
        output_truncated = True
    output_parts.append(text)
    output_bytes += len(encoded)


def interrupt_kernel():
    if execution_started:
        try:
            os.kill(kernel_pid, signal.SIGINT)
        except (ProcessLookupError, PermissionError):
            pass


def terminate_helper(_signum, _frame):
    interrupt_kernel()
    raise KeyboardInterrupt("helper terminated")


signal.signal(signal.SIGTERM, terminate_helper)

try:
    client = BlockingKernelClient()
    client.load_connection_file(connection_file)
    client.start_channels()
    client.wait_for_ready(timeout=timeout)

    msg_id = client.execute(
        code,
        silent=False,
        store_history=False,
        allow_stdin=False,
        stop_on_error=True,
    )
    deadline = time.monotonic() + timeout
    error_text = None

    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            interrupt_kernel()
            raise TimeoutError(f"kernel execution exceeded {timeout:g} seconds")

        try:
            message = client.get_iopub_msg(timeout=min(remaining, 0.25))
        except queue.Empty:
            continue

        parent_id = (message.get("parent_header") or {}).get("msg_id")
        if parent_id != msg_id:
            continue

        msg_type = message.get("msg_type") or (message.get("header") or {}).get("msg_type")
        content = message.get("content") or {}

        if msg_type == "status":
            state = content.get("execution_state")
            if state == "busy":
                execution_started = True
            elif state == "idle":
                break
        elif msg_type == "stream":
            append_output(content.get("text", ""))
        elif msg_type in ("execute_result", "display_data"):
            data = content.get("data") or {}
            if "text/plain" in data:
                append_output(data["text/plain"])
                append_output("\n")
            for mime_type in sorted(key for key in data if key != "text/plain"):
                append_output(f"[{mime_type} output]\n")
        elif msg_type == "error":
            traceback = content.get("traceback") or []
            if traceback:
                error_text = "\n".join(ANSI_RE.sub("", str(line)) for line in traceback)
            else:
                name = content.get("ename", "PythonError")
                value = content.get("evalue", "")
                error_text = f"{name}: {value}".rstrip()

    if error_text is not None:
        raise RuntimeError(error_text)

    result = "".join(output_parts)
    if output_truncated:
        marker = "\n[output truncated at 30 KB]"
        marker_bytes = marker.encode("utf-8")
        result_bytes = result.encode("utf-8")
        result = (result_bytes[:max(0, MAX_OUTPUT_BYTES - len(marker_bytes))]
                  .decode("utf-8", errors="ignore") + marker)
    sys.stdout.write(result)
except BaseException as error:
    message = ANSI_RE.sub("", str(error)).strip() or error.__class__.__name__
    encoded = message.encode("utf-8", errors="replace")[:MAX_OUTPUT_BYTES]
    sys.stderr.write(encoded.decode("utf-8", errors="ignore") + "\n")
    sys.exit(1)
finally:
    if client is not None:
        try:
            client.stop_channels()
        except Exception:
            pass
`;

function appendCapped(chunks, chunk, state, limit) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = limit - state.bytes;
  if (remaining <= 0) return;
  const kept = buffer.subarray(0, remaining);
  chunks.push(kept);
  state.bytes += kept.length;
}

function formatCell(code) {
  return `\`\`\`{python}\n${code.trimEnd()}\n\`\`\`\n`;
}

function writeCell(code) {
  process.stdout.write(formatCell(code));
}

function report(error) {
  const detail = error instanceof Error ? (error.stack || error.message) : String(error);
  process.stderr.write(`qcell: ${detail}\n`);
}

async function readInstruction() {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input.trim();
}

async function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function loadKernelMetadata(cwd) {
  try {
    const metadataPath = path.join(cwd, KERNEL_METADATA_FILE);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    if (
      typeof metadata.connection_file !== "string" ||
      metadata.connection_file.trim() === "" ||
      typeof metadata.python !== "string" ||
      metadata.python.trim() === "" ||
      !Number.isInteger(metadata.pid) ||
      metadata.pid <= 0
    ) {
      return null;
    }

    const connectionFile = path.isAbsolute(metadata.connection_file)
      ? metadata.connection_file
      : path.resolve(cwd, metadata.connection_file);
    const python = path.isAbsolute(metadata.python)
      ? metadata.python
      : path.resolve(cwd, metadata.python);

    await access(connectionFile, fsConstants.R_OK);
    await access(python, fsConstants.X_OK);
    if (!(await processExists(metadata.pid))) return null;

    return { connectionFile, python, pid: metadata.pid };
  } catch {
    return null;
  }
}

function executeInKernel(metadata, code, abortSignal) {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error("Python exploration aborted"));
      return;
    }

    const child = spawn(
      metadata.python,
      [
        "-c",
        PYTHON_HELPER,
        metadata.connectionFile,
        String(KERNEL_TIMEOUT_SECONDS),
        code,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, QCELL_KERNEL_PID: String(metadata.pid) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const stdout = [];
    const stderr = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let settled = false;
    let forcedError = null;
    let killTimer = null;

    const terminate = (error) => {
      if (settled || forcedError) return;
      forcedError = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), PROCESS_KILL_GRACE_MS);
      killTimer.unref();
    };

    const onAbort = () => terminate(new Error("Python exploration aborted"));
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) =>
      appendCapped(stdout, chunk, stdoutState, MAX_CHILD_STDOUT_BYTES),
    );
    child.stderr.on("data", (chunk) =>
      appendCapped(stderr, chunk, stderrState, MAX_CHILD_STDERR_BYTES),
    );

    const processTimer = setTimeout(
      () => terminate(new Error("Python helper exceeded its process timeout")),
      PROCESS_TIMEOUT_MS,
    );
    processTimer.unref();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(processTimer);
      if (killTimer) clearTimeout(killTimer);
      abortSignal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(processTimer);
      if (killTimer) clearTimeout(killTimer);
      abortSignal?.removeEventListener("abort", onAbort);

      if (forcedError) {
        reject(forcedError);
        return;
      }

      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (status === 0) {
        resolve(stdoutText);
      } else {
        reject(new Error(stderrText || `Python helper exited with status ${status ?? signal}`));
      }
    });
  });
}

async function generateCell(instruction, metadata) {
  let finalCode = null;

  const pythonTool = defineTool({
    name: "python",
    label: "Python",
    description: "Execute Python in the live Quarto kernel for exploration and verification.",
    parameters: Type.Object({
      code: Type.String({ description: "Python source to execute" }),
    }),
    execute: async (_toolCallId, params, signal) => {
      const stdout = await executeInKernel(metadata, params.code, signal);
      return {
        content: [{ type: "text", text: stdout || "<no output>" }],
        details: {},
      };
    },
  });

  const emitTool = defineTool({
    name: "emit_cell",
    label: "Emit Cell",
    description: "Return the complete final Python source for the single Quarto cell.",
    parameters: Type.Object({
      code: Type.String({ description: "Complete standalone Python source for the cell" }),
    }),
    execute: async (_toolCallId, params) => {
      if (typeof params.code !== "string" || params.code.trim() === "") {
        throw new Error("emit_cell requires non-empty Python source");
      }
      if (params.code.includes("```") || params.code.includes("~~~")) {
        throw new Error("emit_cell source must not contain Markdown fences");
      }
      if (finalCode !== null) {
        throw new Error("emit_cell has already been called");
      }
      finalCode = params.code.trimEnd();
      return {
        content: [{ type: "text", text: "Cell accepted." }],
        details: {},
        terminate: true,
      };
    },
  });

  const cwd = process.cwd();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [],
    additionalSkillPaths: [],
    additionalPromptTemplatePaths: [],
    additionalThemePaths: [],
    extensionFactories: [],
    extensionsOverride: (base) => ({ ...base, extensions: [], errors: [] }),
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    promptsOverride: () => ({ prompts: [], diagnostics: [] }),
    themesOverride: () => ({ themes: [], diagnostics: [] }),
    systemPromptOverride: () => SYSTEM,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  let session;
  try {
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      customTools: [pythonTool, emitTool],
      tools: ["python", "emit_cell"],
    }));

    const activeTools = session.agent.state.tools.map((tool) => tool.name).sort();
    if (activeTools.length !== 2 || activeTools[0] !== "emit_cell" || activeTools[1] !== "python") {
      throw new Error(`Unexpected active tools: ${activeTools.join(", ") || "<none>"}`);
    }

    await session.prompt(instruction);
  } finally {
    session?.dispose();
  }

  return finalCode;
}

async function main() {
  const instruction = await readInstruction();
  if (!instruction) return;

  const metadata = await loadKernelMetadata(process.cwd());
  if (!metadata) {
    writeCell("# qcell: no live Quarto kernel found");
    return;
  }

  try {
    const finalCode = await generateCell(instruction, metadata);
    writeCell(finalCode ?? "# qcell: no code generated");
  } catch (error) {
    report(error);
    writeCell("# qcell: agent failed");
  }
}

try {
  await main();
} catch (error) {
  report(error);
  writeCell("# qcell: agent failed");
}

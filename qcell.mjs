#!/usr/bin/env node

import { constants as fs, readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const KERNEL_TIMEOUT = 5;
const PROCESS_TIMEOUT = 7_000;
const TOTAL_TIMEOUT = 18_000;
const MAX_OUTPUT = 32 * 1024;

const SYSTEM = `
Use live_kernel to inspect state for context.
Do not modify the state.

Use emit_cell to return the required code.
Cells ultimately run consecutively; the state is declarative.
`;

const KERNEL_HELPER = fileURLToPath(new URL("kernel_helper.py", import.meta.url));

const cell = (code) => `\`\`\`{python}\n${code.trimEnd()}\n\`\`\`\n`;
const textResult = (text) => ({ content: [{ type: "text", text }], details: {} });
const codeSchema = (description) => Type.Object({
  code: Type.String({ description }),
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function kernelMetadata() {
  try {
    const value = JSON.parse(await readFile(".qcell-kernel.json", "utf8"));
    if (
      typeof value.connection_file !== "string" || !value.connection_file.trim() ||
      typeof value.python !== "string" || !value.python.trim() ||
      !Number.isInteger(value.pid) || value.pid < 1
    ) return null;

    const connectionFile = path.resolve(value.connection_file);
    const python = path.resolve(value.python);
    await access(connectionFile, fs.R_OK);
    await access(python, fs.X_OK);
    return alive(value.pid) ? { connectionFile, python, pid: value.pid } : null;
  } catch {
    return null;
  }
}

function capture(stream) {
  const chunks = [];
  let size = 0;
  stream.on("data", (chunk) => {
    const kept = chunk.subarray(0, MAX_OUTPUT - size);
    if (kept.length) chunks.push(kept);
    size += kept.length;
  });
  return () => Buffer.concat(chunks).toString("utf8");
}

function runPython(metadata, code, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Python exploration aborted"));

    const child = spawn(metadata.python, [
      KERNEL_HELPER, metadata.connectionFile, String(KERNEL_TIMEOUT), code,
    ], {
      env: { ...process.env, QCELL_KERNEL_PID: String(metadata.pid) },
      stdio: ["ignore", "pipe", "pipe"],
      signal,
      timeout: PROCESS_TIMEOUT,
    });
    const stdout = capture(child.stdout);
    const stderr = capture(child.stderr);
    let done = false;

    const finish = (error, status, exitSignal) => {
      if (done) return;
      done = true;
      if (error?.name === "AbortError")
        return reject(new Error("Python exploration aborted"));
      if (error) return reject(error);
      if (status === 0) return resolve(stdout());
      reject(new Error(stderr().trim() || `Python helper exited with status ${status ?? exitSignal}`));
    };
    child.once("error", (error) => finish(error));
    child.once("close", (status, exitSignal) => finish(null, status, exitSignal));
  });
}

async function generate(instruction, metadata, document, masterSignal) {
  let finalCode = null;

  const liveKernelTool = defineTool({
    name: "live_kernel",
    label: "Live Kernel",
    description: "Execute Python in the live kernel for inspection and testing.",
    executionMode: "sequential",
    parameters: codeSchema("Python source to execute in the live kernel"),
    execute: async (_id, { code }, signal) =>
      textResult((await runPython(metadata, code, signal ?? masterSignal)) || "<no output>"),
  });

  const emitTool = defineTool({
    name: "emit_cell",
    label: "Emit Cell",
    description: "Return the complete Python source for one Quarto cell.",
    parameters: codeSchema("Raw Python source for the cell"),
    execute: async (_id, { code }) => {
      if (!code.trim()) throw new Error("emit_cell requires non-empty Python source");
      if (finalCode !== null) throw new Error("emit_cell has already been called");
      finalCode = code.trimEnd();
      return { ...textResult("Cell accepted."), terminate: true };
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
    systemPromptOverride: () => SYSTEM,
    appendSystemPromptOverride: () => document ? [
      `Current QMD source; the selected instruction is the task being replaced:\n\n<qmd>\n${document}\n</qmd>`,
    ] : [],
  });
  await resourceLoader.reload();

  let session;
  let abort;
  try {
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      customTools: [liveKernelTool, emitTool],
      tools: ["live_kernel", "emit_cell"],
    }));
    abort = () => void session.abort();
    masterSignal.addEventListener("abort", abort, { once: true });
    if (masterSignal.aborted) {
      abort();
      throw new Error("qcell aborted");
    }
    const tools = session.agent.state.tools.map(({ name }) => name).sort();
    if (tools.join() !== "emit_cell,live_kernel")
      throw new Error(`Unexpected active tools: ${tools.join(", ") || "<none>"}`);
    await session.prompt(instruction);
    return finalCode;
  } finally {
    if (abort) masterSignal.removeEventListener("abort", abort);
    session?.dispose();
  }
}

try {
  const instruction = readFileSync(0, "utf8").trim();
  if (instruction) {
    const masterController = new AbortController();
    const watchdog = setTimeout(() => {
      masterController.abort();
      process.stderr.write("qcell: timed out\n");
      process.stdout.write(cell("# qcell: agent timed out"));
      process.exit(0);
    }, TOTAL_TIMEOUT);
    try {
      const metadata = await kernelMetadata();
      if (!metadata) {
        process.stdout.write(cell("# qcell: no live Quarto kernel found"));
      } else {
        const qmd = process.argv.indexOf("-qmd");
        const document = qmd >= 0 && process.argv[qmd + 1]
          ? await readFile(path.resolve(process.argv[qmd + 1]), "utf8") : "";
        process.stdout.write(cell(
          (await generate(instruction, metadata, document, masterController.signal))
            ?? "# qcell: no code generated",
        ));
      }
    } finally {
      clearTimeout(watchdog);
    }
  }
} catch (error) {
  process.stderr.write(`qcell: ${error?.stack || error}\n`);
  process.stdout.write(cell("# qcell: agent failed"));
}

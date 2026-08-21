#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const executeFile = promisify(execFile);
const KERNEL_HELPER = fileURLToPath(new URL("kernel_helper.py", import.meta.url));

function loadConf() {
  const out = {};
  const paths = [process.env.QCELL_CONF, path.join(os.homedir(), "a", ".qcell.conf")].filter(Boolean);
  for (const file of [...new Set(paths)]) {
    try {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (/^\s*#/.test(line)) continue;
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
        if (m && !(m[1] in out)) out[m[1]] = m[2];
      }
    } catch {}
  }
  return out;
}

const CONF = loadConf();
const seconds = (name, fallback) => {
  const value = Number(CONF[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const KERNEL_TIMEOUT = seconds("KERNEL_TIMEOUT", 5);
const AGENT_TIMEOUT = seconds("AGENT_TIMEOUT", 30) * 1000;

const SYSTEM_PROMPT = `
Use live_kernel to inspect state for context.
Do not alter the state.

Use emit_cell to return the requested code cell.
Cells ultimately run consecutively; the state is declarative.
`;

async function loadKernel() {
  let kernel;
  try {
    kernel = JSON.parse(await readFile(".qcell-kernel.json", "utf8"));
  } catch {
    return null;
  }
  if (!kernel?.connection_file || !kernel?.python || !Number.isInteger(kernel.pid)) return null;
  try {
    await readFile(path.resolve(kernel.connection_file));
    process.kill(kernel.pid, 0);
  } catch (error) {
    throw new Error(
      `stale kernel metadata in .qcell-kernel.json (${error?.code === "ESRCH" ? "kernel process is gone" : "connection file is gone"}); run the registration cell again, e.g. quarto render --cache-refresh`,
    );
  }
  return kernel;
}

async function runInKernel(kernel, code, signal) {
  const { stdout } = await executeFile(kernel.python, [
    KERNEL_HELPER,
    path.resolve(kernel.connection_file),
    String(KERNEL_TIMEOUT),
    code,
  ], {
    encoding: "utf8",
    env: { ...process.env, QCELL_KERNEL_PID: String(kernel.pid) },
    signal,
  });
  return stdout;
}

async function generateCell(instruction, kernel, document, abortSignal) {
  let cell;

  const liveKernel = defineTool({
    name: "live_kernel",
    label: "Live Kernel",
    description: "Run Python in the current kernel to inspect document state.",
    executionMode: "sequential",
    parameters: Type.Object({
      code: Type.String({ description: "Python code to run" }),
    }),
    execute: async (_id, { code }, signal) => {
      process.stderr.write(`[qcell] kernel: ${code.replace(/\s+/g, " ").slice(0, 80)}\n`);
      return {
        content: [{
          type: "text",
          text: (await runInKernel(kernel, code, signal)) || "<no output>",
        }],
        details: {},
      };
    },
  });

  const emitCell = defineTool({
    name: "emit_cell",
    label: "Emit Cell",
    description: "Return the complete fenced Quarto Python cell.",
    parameters: Type.Object({
      cell: Type.String({ description: "Complete fenced Quarto Python cell" }),
    }),
    execute: async (_id, { cell: emittedCell }) => {
      if (typeof emittedCell !== "string" || !emittedCell.trim()) {
        throw new Error("emit_cell requires non-empty cell source");
      }
      cell = emittedCell;
      process.stderr.write("[qcell] emitting cell\n");
      return {
        content: [{ type: "text", text: "Cell emitted." }],
        details: {},
        terminate: true,
      };
    },
  });

  const cwd = process.cwd();
  const agentDir = getAgentDir();
  let defaultModel;
  let defaultThinkingLevel;
  let modelRuntimeError;
  try {
    const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
    if (typeof settings.defaultThinkingLevel === "string") {
      defaultThinkingLevel = settings.defaultThinkingLevel;
    }
    if (settings.defaultProvider && settings.defaultModel) {
      try {
        const modelRuntime = await ModelRuntime.create();
        defaultModel = modelRuntime.getModel(settings.defaultProvider, settings.defaultModel) || undefined;
        if (!defaultModel) {
          modelRuntimeError = `model "${settings.defaultProvider}/${settings.defaultModel}" not found in the model catalog`;
        }
      } catch (error) {
        modelRuntimeError = `model runtime failed: ${error?.message || error}`;
      }
    }
  } catch {}
  if (!defaultModel) {
    throw new Error(modelRuntimeError || "no default model: set defaultProvider/defaultModel in ~/.pi/agent/settings.json");
  }
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
    systemPromptOverride: () => SYSTEM_PROMPT,
    appendSystemPromptOverride: () => document
      ? [`Current QMD source:\n\n<qmd>\n${document}\n</qmd>`]
      : [],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: defaultModel,
    ...(defaultThinkingLevel ? { thinkingLevel: defaultThinkingLevel } : {}),
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    customTools: [liveKernel, emitCell],
    tools: ["live_kernel", "emit_cell"],
  });

  const abort = () => session.abort();
  abortSignal.addEventListener("abort", abort, { once: true });
  try {
    if (abortSignal.aborted) throw new Error("timed out");
    await session.prompt(instruction);
    if (typeof cell !== "string") {
      const text = (session.agent?.state?.messages || [])
        .filter((m) => m.role === "assistant")
        .flatMap((m) => (m.content || []).filter((c) => c.type === "text").map((c) => c.text))
        .join("\n")
        .trim();
      throw new Error(
        text
          ? `agent replied without emitting a cell: ${text.slice(0, 300)}`
          : "agent finished without emitting a cell",
      );
    }
    return cell;
  } finally {
    abortSignal.removeEventListener("abort", abort);
    try { await abort(); } catch {}
    session.dispose();
  }
}

async function main() {
  const instruction = readFileSync(0, "utf8").trim();
  if (!instruction) return;

  const kernel = await loadKernel();
  if (!kernel) throw new Error("no live Quarto kernel found");

  const qmdIndex = process.argv.indexOf("-qmd");
  const document = qmdIndex >= 0 && process.argv[qmdIndex + 1]
    ? await readFile(path.resolve(process.argv[qmdIndex + 1]), "utf8")
    : "";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT);

  try {
    const cell = await generateCell(instruction, kernel, document, controller.signal);
    if (controller.signal.aborted) throw new Error("timed out");
    process.stdout.write(String(cell));
  } catch (error) {
    if (controller.signal.aborted) throw new Error("timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`qcell: ${error?.message || error}\n`);
  process.exitCode = 1;
}

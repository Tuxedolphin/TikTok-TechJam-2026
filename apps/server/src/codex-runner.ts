import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import { RunPolicyViolationError } from "./run-policies.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
  RunnerStepEvent,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
}

export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  workspacePath = request.workspacePath,
): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    sandboxMode,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
  ];
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

export async function parseCodexEventLine(
  line: string,
  parsed: ParsedEvents,
  onStep?: (step: RunnerStepEvent) => Promise<void> | void,
): Promise<void> {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
  }

  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      parsed.messages.push(item.text);
      await onStep?.({
        type: "message",
        title: "Agent response",
        detail: item.text.slice(0, 160),
        phase: "after",
        rawPayload: item,
      });
    } else if (item.type === "command_execution") {
      const cmd = typeof item.command === "string" ? item.command : "command";
      const exitCode = typeof item.exit_code === "number" ? ` (exit ${item.exit_code})` : "";
      await onStep?.({
        type: "command",
        title: "Executed shell command",
        detail: `${cmd}${exitCode}`,
        phase: "after",
        rawPayload: item,
      });
    } else if (item.type === "file_change") {
      const filePath = typeof item.path === "string" ? item.path : "file";
      await onStep?.({
        type: "file_change",
        title: "File modified",
        detail: filePath,
        phase: "after",
        rawPayload: item,
      });
    } else if (item.type === "mcp_tool_call" || item.type === "tool_call") {
      const name =
        typeof item.tool === "string"
          ? item.tool
          : typeof item.name === "string"
            ? item.name
            : "tool";
      const inputStr =
        typeof item.input === "string"
          ? item.input
          : JSON.stringify(item.input ?? item.arguments ?? "");
      await onStep?.({
        type: "tool_call",
        title: `Invoked tool ${name}`,
        detail: inputStr.slice(0, 160),
        phase: "after",
        rawPayload: item,
      });
    }
  }

  if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
    const usage = event.usage as Record<string, unknown>;
    parsed.usage = {
      ...(typeof usage.input_tokens === "number"
        ? { inputTokens: usage.input_tokens }
        : {}),
      ...(typeof usage.cached_input_tokens === "number"
        ? { cachedInputTokens: usage.cached_input_tokens }
        : {}),
      ...(typeof usage.output_tokens === "number"
        ? { outputTokens: usage.output_tokens }
        : {}),
    };
  }

  if (event.type === "error") {
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof event.error === "string"
          ? event.error
          : "Codex reported an unknown error";
    parsed.errors.push(message);
  }
}

export class CodexRunner implements AgentRunner {
  private readonly active = new Map<
    string,
    {
      child: ChildProcess;
      cancelled: boolean;
      timedOut: boolean;
      outputExceeded: boolean;
      settled: Promise<void>;
      forceKillTimer: NodeJS.Timeout | null;
    }
  >();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) {
      return false;
    }
    active.cancelled = true;
    this.terminate(active);
    await active.settled;
    return true;
  }

  async pause(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active || active.cancelled) return false;
    try {
      active.child.kill("SIGSTOP");
      return true;
    } catch {
      return false;
    }
  }

  async resume(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active || active.cancelled) return false;
    try {
      active.child.kill("SIGCONT");
      return true;
    } catch {
      return false;
    }
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Codex process");
    }

    const args = buildCodexArgs(request, this.config.codexSandboxMode);
    const child = spawn(this.config.codexBin, args, {
      cwd: request.workspacePath,
      env: this.childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const effectiveTimeoutMs =
      this.config.runBudgetMaxDurationMs !== null &&
      this.config.runBudgetMaxDurationMs > 0 &&
      this.config.runBudgetMaxDurationMs < this.config.codexTimeoutMs
        ? this.config.runBudgetMaxDurationMs
        : this.config.codexTimeoutMs;
    const isBudgetTimeout = effectiveTimeoutMs === this.config.runBudgetMaxDurationMs;

    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active = {
      child,
      cancelled: false,
      timedOut: false,
      budgetExceeded: false,
      outputExceeded: false,
      settled,
      forceKillTimer: null as NodeJS.Timeout | null,
    };
    this.active.set(request.agentId, active);

    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
    };
    let stderr = "";
    let totalBytes = 0;

    const rl = createInterface({
      input: child.stdout!,
      crlfDelay: Infinity,
    });

    let stdoutError: Error | null = null;
    const stdoutPromise = (async () => {
      try {
        for await (const line of rl) {
          totalBytes += Buffer.byteLength(line, "utf8") + 1;
          if (totalBytes > this.config.codexMaxOutputBytes) {
            active.outputExceeded = true;
            this.terminate(active);
            break;
          }
          if (line.trim()) {
            await parseCodexEventLine(line.trim(), parsed, request.onStep);
          }
        }
      } catch (err) {
        stdoutError = err instanceof Error ? err : new Error(String(err));
        active.cancelled = true;
        this.terminate(active);
      }
    })();

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 16_384) {
        stderr = stderr.slice(-16_384);
      }
    });

    const timeout = setTimeout(() => {
      active.timedOut = true;
      active.budgetExceeded = isBudgetTimeout;
      this.terminate(active);
    }, effectiveTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      await stdoutPromise;
      if (stdoutError) {
        throw stdoutError;
      }
      if (active.cancelled) {
        throw new RunCancelledError();
      }
      if (active.timedOut) {
        if (active.budgetExceeded) {
          throw new RunPolicyViolationError(
            "budget",
            429,
            "Run budget circuit breaker tripped: duration exceeded " +
              this.config.runBudgetMaxDurationMs +
              " ms",
          );
        }
        throw new Error("Codex timed out after " + this.config.codexTimeoutMs + " ms");
      }

      if (active.outputExceeded) {
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (exitCode !== 0) {
        const detail = parsed.errors.at(-1) || stderr.trim() || "No error detail";
        throw new Error("Codex exited with code " + exitCode + ": " + detail);
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) {
        throw new Error("Codex completed without an agent message");
      }
      return {
        output,
        threadId: parsed.threadId,
        usage: parsed.usage,
      };
    } finally {
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(request.agentId);
    }
  }

  private terminate(active: {
    child: ChildProcess;
    forceKillTimer: NodeJS.Timeout | null;
  }): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
      active.forceKillTimer.unref();
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const inheritedNames = [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "TERM",
    ] as const;
    const environment: NodeJS.ProcessEnv = {
      CODEX_HOME: this.config.codexHome,
      MODEL_API_KEY: this.config.modelRuntimeApiKey,
      NO_COLOR: "1",
    };
    for (const name of inheritedNames) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}

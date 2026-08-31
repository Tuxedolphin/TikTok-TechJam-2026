import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { buildCodexArgs, parseCodexEventLine } from "./codex-runner.js";
import { RunCancelledError } from "./errors.js";
import { RunPolicyViolationError } from "./run-policies.js";
import { INTERNAL_NETWORK } from "./egress-network.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

interface ActiveContainer {
  child: ChildProcess;
  containerName: string;
  cancelled: boolean;
  timedOut: boolean;
  budgetExceeded: boolean;
  outputExceeded: boolean;
  settled: Promise<void>;
  termination: Promise<void> | null;
}

interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
}

/**
 * Environment handed to the container engine. Deliberately an allowlist: the
 * server's own process environment holds credentials that have no business
 * reaching a `docker`/`podman` invocation.
 */
export function containerEngineEnvironment(
  config: AppConfig,
  includeRuntimeConfig = false,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  if (includeRuntimeConfig) {
    environment.MODEL_API_KEY = config.modelRuntimeApiKey;
  }
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "XDG_RUNTIME_DIR"] as const) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

export function containerName(agentId: string, instanceId = "default"): string {
  const safeInstance = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  return "launchpad-" + safeInstance + "-" + safeAgent;
}

export function buildContainerRunArgs(
  request: RunnerRequest,
  config: AppConfig,
): string[] {
  const name = containerName(request.agentId, config.runtimeInstanceId);
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  return [
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "--label",
    "io.codejam.launchpad=agent-runtime",
    "--label",
    "io.codejam.agent-id=" + request.agentId,
    "--label",
    "io.codejam.instance-id=" + config.runtimeInstanceId,
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    // Under enforcement the agent joins an internal network with no route
    // off-box: every outbound connection must go through the authorizing
    // proxy, so a denied host is unreachable rather than merely disapproved.
    ...(request.egressProxyUrl
      ? [
          "--network",
          INTERNAL_NETWORK,
          "--env",
          "HTTP_PROXY=" + request.egressProxyUrl,
          "--env",
          "HTTPS_PROXY=" + request.egressProxyUrl,
          "--env",
          "http_proxy=" + request.egressProxyUrl,
          "--env",
          "https_proxy=" + request.egressProxyUrl,
          "--env",
          "NO_PROXY=localhost,127.0.0.1",
        ]
      : ["--network", "bridge", "--add-host", "host.docker.internal:host-gateway"]),
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cpus",
    String(config.containerCpuLimit),
    "--memory",
    config.containerMemoryLimit,
    "--pids-limit",
    String(config.containerPidsLimit),
    "--user",
    config.containerUser,
    "--env",
    "MODEL_API_KEY",
    "--env",
    "CODEX_HOME=/codex-home",
    "--env",
    "HOME=/tmp",
    "--env",
    "NO_COLOR=1",
    "--mount",
    "type=bind,src=" + request.workspacePath + ",dst=/workspace",
    "--mount",
    "type=bind,src=" + config.codexHome + ",dst=/codex-home",
    "--workdir",
    "/workspace",
    config.containerRuntimeImage,
    "codex",
    ...buildCodexArgs(request, config.codexSandboxMode, "/workspace"),
  ];
}

export class ContainerCodexRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveContainer>();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.containerEngine, ["version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      await execFileAsync(
        this.config.containerEngine,
        ["image", "inspect", this.config.containerRuntimeImage],
        { timeout: 5_000, env: this.childEnvironment() },
      );
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) return false;

    active.cancelled = true;
    await this.removeContainer(active);
    await active.settled;
    return true;
  }

  async pause(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active || active.cancelled) return false;
    try {
      await execFileAsync(
        this.config.containerEngine,
        ["pause", active.containerName],
        { timeout: 5_000, env: this.childEnvironment() },
      );
      return await this.containerPaused(active.containerName);
    } catch {
      return false;
    }
  }

  async resume(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active || active.cancelled) return false;
    try {
      await execFileAsync(
        this.config.containerEngine,
        ["unpause", active.containerName],
        { timeout: 5_000, env: this.childEnvironment() },
      );
      return !(await this.containerPaused(active.containerName));
    } catch {
      return false;
    }
  }

  private async containerPaused(name: string): Promise<boolean> {
    const { stdout } = await execFileAsync(
      this.config.containerEngine,
      ["inspect", "--format", "{{.State.Paused}}", name],
      { timeout: 5_000, env: this.childEnvironment() },
    );
    return stdout.trim() === "true";
  }

  private removeContainer(active: ActiveContainer): Promise<void> {
    if (!active.termination) {
      active.termination = execFileAsync(
        this.config.containerEngine,
        ["rm", "--force", active.containerName],
        { timeout: 8_000, env: this.childEnvironment() },
      )
        .then(() => undefined)
        .catch(() => {
          active.child.kill("SIGTERM");
          const forceKill = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
          forceKill.unref();
        });
    }
    return active.termination;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Runtime container");
    }

    const child = spawn(
      this.config.containerEngine,
      buildContainerRunArgs(request, this.config),
      {
        cwd: request.workspacePath,
        env: this.childEnvironment(true),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
    const active: ActiveContainer = {
      child,
      containerName: containerName(request.agentId, this.config.runtimeInstanceId),
      cancelled: false,
      timedOut: false,
      budgetExceeded: false,
      outputExceeded: false,
      settled,
      termination: null,
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
            void this.removeContainer(active);
            break;
          }
          if (line.trim()) {
            await parseCodexEventLine(line.trim(), parsed, request.onStep);
          }
        }
      } catch (err) {
        stdoutError = err instanceof Error ? err : new Error(String(err));
        active.cancelled = true;
        void this.removeContainer(active);
      }
    })();

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
    });

    const timeout = setTimeout(() => {
      active.timedOut = true;
      active.budgetExceeded = isBudgetTimeout;
      void this.removeContainer(active);
    }, effectiveTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      await stdoutPromise;
      if (stdoutError) throw stdoutError;
      if (active.cancelled) throw new RunCancelledError();
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
        throw new Error("Runtime timed out after " + this.config.codexTimeoutMs + " ms");
      }

      if (active.outputExceeded) {
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (exitCode !== 0) {
        const detail = parsed.errors.at(-1) ?? stderr.trim() ?? "No error detail";
        throw new Error(
          this.config.containerEngine +
            " Runtime exited with code " +
            exitCode +
            ": " +
            detail,
        );
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) throw new Error("Codex completed without an agent message");
      return { output, threadId: parsed.threadId, usage: parsed.usage };
    } finally {
      clearTimeout(timeout);
      this.active.delete(request.agentId);
    }
  }

  private childEnvironment(includeRuntimeConfig = false): NodeJS.ProcessEnv {
    return containerEngineEnvironment(this.config, includeRuntimeConfig);
  }
}

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
/**
 * The proxy URL values, keyed by the names `buildContainerRunArgs` forwards.
 * Empty when enforcement is off, so the agent container gets no proxy env.
 */
export function proxyChildEnv(egressProxyUrl: string | undefined): NodeJS.ProcessEnv {
  if (!egressProxyUrl) return {};
  return {
    HTTP_PROXY: egressProxyUrl,
    HTTPS_PROXY: egressProxyUrl,
    http_proxy: egressProxyUrl,
    https_proxy: egressProxyUrl,
  };
}

export function containerEngineEnvironment(config: AppConfig): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    OPENROUTER_API_KEY: config.openRouterApiKey,
    OPENAI_API_KEY: config.openRouterApiKey,
    OPENROUTER_BASE_URL: config.openRouterBaseUrl,
    OPENAI_BASE_URL: config.openRouterBaseUrl,
    NO_COLOR: "1",
  };
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
          // Passed by name, not value. The proxy URL embeds this agent's
          // per-process proxy secret; `--env NAME=value` would put that secret
          // in the engine's argv, and /proc/<pid>/cmdline is world-readable, so
          // any local process could recover it and impersonate the agent at the
          // proxy. The value travels in the engine child's own environment
          // instead (see proxyChildEnv).
          "--env",
          "HTTP_PROXY",
          "--env",
          "HTTPS_PROXY",
          "--env",
          "http_proxy",
          "--env",
          "https_proxy",
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
    "OPENROUTER_API_KEY=" + config.openRouterApiKey,
    "--env",
    "OPENAI_API_KEY=" + config.openRouterApiKey,
    "--env",
    "OPENROUTER_BASE_URL=" + config.openRouterBaseUrl,
    "--env",
    "OPENAI_BASE_URL=" + config.openRouterBaseUrl,
    "--env",
    "CODEX_HOME=/codex-home",
    "--env",
    "HOME=/tmp",
    "--env",
    "NO_COLOR=1",
    "--env",
    "NODE_OPTIONS=--use-env-proxy",
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

  async pause(agentId: string): Promise<"paused" | "idle" | "failed"> {
    const active = this.active.get(agentId);
    if (!active || active.cancelled) return "idle";
    try {
      await execFileAsync(
        this.config.containerEngine,
        ["pause", active.containerName],
        { timeout: 5_000, env: this.childEnvironment() },
      );
      return "paused";
    } catch {
      return "failed";
    }
  }

  isRunning(agentId: string): boolean {
    return this.active.has(agentId);
  }

  /**
   * Asks the engine directly whether this agent's container still exists,
   * rather than trusting the in-memory active map. `docker rm --force` can time
   * out or fail while the daemon-side container keeps running; the map is
   * cleared regardless, so a receipt could claim a kill that did not happen.
   * Returns false only on a confirmed sighting of the container; a query error
   * is reported as "unconfirmed" (null) rather than a false all-clear.
   */
  async confirmStopped(agentId: string): Promise<boolean | null> {
    const name = containerName(agentId, this.config.runtimeInstanceId);
    try {
      const { stdout } = await execFileAsync(
        this.config.containerEngine,
        ["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}"],
        { timeout: 5_000, env: this.childEnvironment() },
      );
      return stdout.trim() === "";
    } catch {
      return null;
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
      return true;
    } catch {
      try {
        active.child.kill("SIGCONT");
        return true;
      } catch {
        return false;
      }
    }
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
        env: { ...this.childEnvironment(), ...proxyChildEnv(request.egressProxyUrl) },
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

  private childEnvironment(): NodeJS.ProcessEnv {
    return containerEngineEnvironment(this.config);
  }
}

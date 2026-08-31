import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { egressProxySecret } from "./egress-authorizer.js";
import { containerEngineEnvironment } from "./container-codex-runner.js";

const execFileAsync = promisify(execFile);

export const INTERNAL_NETWORK = "launchpad-egress-internal";
export const UPLINK_NETWORK = "launchpad-egress-uplink";
export const PROXY_CONTAINER = "launchpad-egress-proxy";

/**
 * Provisions the two-network topology that makes egress control real.
 *
 *   agent container ──▶ [ internal network, no route off-box ] ──▶ proxy
 *                                                                   │
 *                        [ uplink network ] ◀──────────────────────┘──▶ internet
 *
 * The agent container is attached ONLY to the internal network, so it cannot
 * reach anything without going through the proxy — this is what makes
 * "fail closed" a property of the topology rather than a promise in code.
 * The proxy is attached to both networks and authorizes every connection.
 *
 * Verified against Docker/OrbStack: a container on an --internal network can
 * reach a sidecar by name but cannot reach the host or the internet.
 * See docs/superpowers/specs/2026-08-30-egress-architecture-verified.md.
 */
export class EgressNetworkManager {
  private pending: Promise<void> | null = null;
  private readyForCurrentProcess = false;

  constructor(private readonly config: AppConfig) {}

  private async engine(args: string[], secrets?: NodeJS.ProcessEnv): Promise<string> {
    const { stdout } = await execFileAsync(this.config.containerEngine, args, {
      timeout: 30_000,
      env: { ...containerEngineEnvironment(this.config), ...secrets },
    });
    return stdout.trim();
  }

  private async networkExists(name: string): Promise<boolean> {
    try {
      await this.engine(["network", "inspect", name]);
      return true;
    } catch {
      return false;
    }
  }

  private async containerRunning(name: string): Promise<boolean> {
    try {
      const status = await this.engine([
        "inspect",
        "--format",
        "{{.State.Running}}",
        name,
      ]);
      return status === "true";
    } catch {
      return false;
    }
  }

  /**
   * Creates the networks and starts the proxy sidecar if they are not already
   * up. Safe to call before every run; it is a no-op once established.
   */
  async ensure(): Promise<void> {
    // Concurrent runs must not both try to create the sidecar; the loser would
    // fail on the container-name conflict and surface a spurious start error.
    if (this.pending) return this.pending;
    this.pending = this.provision().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async provision(): Promise<void> {
    if (this.readyForCurrentProcess && (await this.containerRunning(PROXY_CONTAINER))) return;

    if (!(await this.networkExists(INTERNAL_NETWORK))) {
      await this.engine(["network", "create", "--internal", INTERNAL_NETWORK]);
    }
    if (!(await this.networkExists(UPLINK_NETWORK))) {
      await this.engine(["network", "create", UPLINK_NETWORK]);
    }

    {
      await this.removeProxy();
      await this.engine([
        "run",
        "-d",
        "--name",
        PROXY_CONTAINER,
        "--label",
        "io.codejam.launchpad=egress-proxy",
        "--network",
        INTERNAL_NETWORK,
        "--add-host",
        "host.docker.internal:host-gateway",
        "--env",
        `EGRESS_PROXY_PORT=${this.config.egressProxyPort}`,
        "--env",
        `EGRESS_AUTHORIZE_URL=http://host.docker.internal:${this.config.port}/api/egress/authorize`,
        // Passed by name, not value: `--env NAME=value` would put the agent
        // secret in the engine's argv, and /proc/<pid>/cmdline is world
        // readable. That secret derives every agent's proxy password, so a
        // local reader could impersonate any agent and spend its grants.
        "--env",
        "EGRESS_AUTHORIZE_TOKEN",
        "--env",
        "EGRESS_AGENT_SECRET",
        "--mount",
        `type=bind,src=${this.config.serverDistPath},dst=/app,readonly`,
        "--workdir",
        "/app",
        this.config.egressProxyImage,
        "node",
        "/app/egress-proxy-main.js",
      ], {
        EGRESS_AUTHORIZE_TOKEN: this.config.authToken,
        EGRESS_AGENT_SECRET: this.config.internalAgentSecret,
      });
      // The uplink is attached second so the proxy's default route stays on the
      // internal network while it still has a path to the internet.
      await this.engine(["network", "connect", UPLINK_NETWORK, PROXY_CONTAINER]);
      await this.waitForProxyListening();
      this.readyForCurrentProcess = true;
    }
  }

  /**
   * `docker run -d` returns when the container is created, not when the process
   * inside it has bound its port. Returning from ensure() before then hands the
   * first agent request a connection refusal that looks nothing like a policy
   * decision -- the caller cannot tell "not started yet" from "denied".
   */
  private async waitForProxyListening(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let logs = "";
    while (Date.now() < deadline) {
      try {
        logs = await this.engine(["logs", PROXY_CONTAINER]);
        if (logs.includes("proxy listening on")) return;
      } catch {
        // The container may not be emitting yet; the running check below is
        // what distinguishes "still starting" from "died on startup".
      }
      if (!(await this.containerRunning(PROXY_CONTAINER))) {
        throw new Error(`Egress proxy exited before listening: ${logs.trim().slice(-400)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `Egress proxy did not listen within ${timeoutMs}ms: ${logs.trim().slice(-400)}`,
    );
  }

  /** Proxy URL as seen from inside an agent container on the internal network. */
  proxyUrlFor(agentPrincipalId: string): string {
    // Identity travels as proxy-auth credentials: one proxy, many agents. The
    // password is a per-agent secret derived from the server key, so a
    // container cannot borrow another agent's grants by simply claiming its
    // principal -- it would have to forge a secret it never sees.
    const secret = egressProxySecret(agentPrincipalId, this.config.internalAgentSecret);
    return `http://${encodeURIComponent(agentPrincipalId)}:${secret}@${PROXY_CONTAINER}:${this.config.egressProxyPort}`;
  }

  /**
   * Attempts one outbound connection from inside the agent's own network
   * position — same internal network, same proxy credentials, no route off-box.
   *
   * This is how the platform demonstrates containment on itself: the request is
   * real and travels the real enforcement path, so a block here is the same
   * block a hijacked agent would hit. Nothing about it is simulated except the
   * intent.
   */
  async probeAsAgent(
    agentPrincipalId: string,
    host: string,
  ): Promise<{
    httpStatus: number | null;
    blocked: boolean;
    /**
     * False when the probe itself could not be carried out. A probe that never
     * ran is not evidence of containment, and callers that sign attestations
     * must not treat it as such.
     */
    conclusive: boolean;
    detail: string;
  }> {
    await this.ensure();
    const proxy = this.proxyUrlFor(agentPrincipalId);
    const url = `http://${host}/`;
    try {
      const stdout = await this.engine([
        "run",
        "--rm",
        "--network",
        INTERNAL_NETWORK,
        "--env",
        `http_proxy=${proxy}`,
        "--env",
        `https_proxy=${proxy}`,
        "--env",
        `HTTP_PROXY=${proxy}`,
        "--env",
        `HTTPS_PROXY=${proxy}`,
        this.config.egressProbeImage,
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        "12",
        url,
      ]);
      const httpStatus = Number(stdout.trim());
      if (!Number.isInteger(httpStatus) || httpStatus === 0) {
        return {
          httpStatus: null,
          blocked: true,
          conclusive: true,
          detail: "No response: the connection never left.",
        };
      }
      // 403 is the proxy refusing; 407 means no usable identity was presented.
      const blocked = httpStatus === 403 || httpStatus === 407;
      return {
        httpStatus,
        blocked,
        conclusive: true,
        detail: blocked
          ? `The proxy refused the connection to ${host}.`
          : `The connection to ${host} was authorized and completed.`,
      };
    } catch (error) {
      // The probe container failed to run at all. Under this topology that is
      // usually the network refusing, but it is equally consistent with the
      // engine being busy or the image missing -- so it is reported as
      // inconclusive rather than counted as proof of containment.
      return {
        httpStatus: null,
        blocked: true,
        conclusive: false,
        detail:
          "Probe could not be completed for " +
          host +
          ": " +
          (error instanceof Error ? error.message.split("\n")[0] : String(error)),
      };
    }
  }

  /**
   * Tears down every connection the proxy is still piping for this principal.
   * Authorization is per-connection, so a tunnel established before revocation
   * keeps flowing; termination must drain it or an in-flight transfer can
   * finish after the agent is gone. Reaches the proxy from inside the internal
   * network (the only place it is addressable) via a short-lived probe
   * container. Returns how many connections the proxy reported closing, or null
   * if the drain could not be carried out -- which the caller must not read as
   * "nothing was flowing".
   */
  async drainPrincipal(agentPrincipalId: string): Promise<number | null> {
    if (!(await this.containerRunning(PROXY_CONTAINER))) return 0;
    const controlUrl = `http://${PROXY_CONTAINER}:${this.config.egressProxyPort}/__egress_control/drain`;
    try {
      // Run a shell inside the container so it expands the token from its own
      // environment (passed by name, never in argv, so /proc/<pid>/cmdline on
      // the host never sees the secret). The probe image is Alpine-based and
      // has /bin/sh.
      const stdout = await this.engine(
        [
          "run",
          "--rm",
          "--network",
          INTERNAL_NETWORK,
          "--env",
          "EGRESS_CONTROL_TOKEN",
          "--env",
          "EGRESS_PRINCIPAL",
          "--entrypoint",
          "sh",
          this.config.egressProbeImage,
          "-c",
          `curl -s -X POST --max-time 10 ` +
            `-H "x-egress-control-token: $EGRESS_CONTROL_TOKEN" ` +
            `-H "x-egress-principal: $EGRESS_PRINCIPAL" "${controlUrl}"`,
        ],
        {
          EGRESS_CONTROL_TOKEN: this.config.internalAgentSecret,
          EGRESS_PRINCIPAL: agentPrincipalId,
        },
      );
      const parsed = JSON.parse(stdout.trim()) as { closed?: number };
      return typeof parsed.closed === "number" ? parsed.closed : null;
    } catch {
      return null;
    }
  }

  private async removeProxy(): Promise<void> {
    try {
      await this.engine(["rm", "-f", PROXY_CONTAINER]);
    } catch {
      // Nothing to remove.
    }
  }

  async shutdown(): Promise<void> {
    await this.removeProxy();
    this.readyForCurrentProcess = false;
  }
}

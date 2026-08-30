import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { egressProxySecret } from "./egress-authorizer.js";

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
  private ready = false;
  private pending: Promise<void> | null = null;

  constructor(private readonly config: AppConfig) {}

  private async engine(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(this.config.containerEngine, args, {
      timeout: 30_000,
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
    if (this.ready && (await this.containerRunning(PROXY_CONTAINER))) return;

    if (!(await this.networkExists(INTERNAL_NETWORK))) {
      await this.engine(["network", "create", "--internal", INTERNAL_NETWORK]);
    }
    if (!(await this.networkExists(UPLINK_NETWORK))) {
      await this.engine(["network", "create", UPLINK_NETWORK]);
    }

    if (!(await this.containerRunning(PROXY_CONTAINER))) {
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
        "--env",
        `EGRESS_AUTHORIZE_TOKEN=${this.config.authToken}`,
        "--mount",
        `type=bind,src=${this.config.serverDistPath},dst=/app,readonly`,
        "--workdir",
        "/app",
        this.config.egressProxyImage,
        "node",
        "/app/egress-proxy-main.js",
      ]);
      // The uplink is attached second so the proxy's default route stays on the
      // internal network while it still has a path to the internet.
      await this.engine(["network", "connect", UPLINK_NETWORK, PROXY_CONTAINER]);
    }

    this.ready = true;
  }

  /** Proxy URL as seen from inside an agent container on the internal network. */
  proxyUrlFor(agentPrincipalId: string): string {
    // Identity travels as proxy-auth credentials: one proxy, many agents. The
    // password is a per-agent secret derived from the server key, so a
    // container cannot borrow another agent's grants by simply claiming its
    // principal -- it would have to forge a secret it never sees.
    const secret = egressProxySecret(agentPrincipalId, this.config.authToken);
    return `http://${encodeURIComponent(agentPrincipalId)}:${secret}@${PROXY_CONTAINER}:${this.config.egressProxyPort}`;
  }

  private async removeProxy(): Promise<void> {
    try {
      await this.engine(["rm", "-f", PROXY_CONTAINER]);
    } catch {
      // Nothing to remove.
    }
  }

  async shutdown(): Promise<void> {
    this.ready = false;
    await this.removeProxy();
  }
}

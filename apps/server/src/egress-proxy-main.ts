/**
 * Entry point for the egress proxy sidecar.
 *
 * Runs inside a container attached to BOTH the agent's internal network (which
 * has no route off-box) and a bridge network (which does). Agent containers
 * therefore reach the internet only by asking this process, and this process
 * asks the control plane about every single connection.
 *
 * Started by EgressNetworkManager; not part of the API server process.
 */
import { createEgressProxy, type EgressVerdict } from "./egress-proxy.js";
import { egressProxySecret } from "./egress-authorizer.js";

const port = Number(process.env["EGRESS_PROXY_PORT"] ?? 8888);
const authorizeUrl = process.env["EGRESS_AUTHORIZE_URL"];
const authorizeToken = process.env["EGRESS_AUTHORIZE_TOKEN"] ?? "";
const agentSecret = process.env["EGRESS_AGENT_SECRET"];

process.on("uncaughtException", (err) => {
  console.error("[egress] uncaught error in proxy:", err?.message || err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[egress] unhandled rejection in proxy:", reason);
});
/** Just past the control plane's 5-minute approval window. */
const AUTHORIZE_TIMEOUT_MS = 315_000;

if (!authorizeUrl) {
  console.error("EGRESS_AUTHORIZE_URL is required");
  process.exit(1);
}
if (!agentSecret) {
  console.error("EGRESS_AGENT_SECRET is required");
  process.exit(1);
}

// The control plane is wherever we send authorization requests.
const controlPlaneUrl = new URL(authorizeUrl);
const controlPlane = {
  host: controlPlaneUrl.hostname,
  port: Number(controlPlaneUrl.port || (controlPlaneUrl.protocol === "https:" ? 443 : 80)),
};

const server = createEgressProxy({
  controlPlane,
  // The agent secret is already private to this sidecar; reuse it to gate the
  // drain control endpoint so the control plane can tear down a terminated
  // principal's live tunnels.
  controlToken: agentSecret,
  authorize: async ({
    agentPrincipalId,
    host,
    port: targetPort,
    method,
    secret,
    signal,
  }): Promise<EgressVerdict> => {
    // A held request can wait for an operator, so this call has no short
    // timeout -- but it must not wait forever either, or a control plane that
    // stops answering would pin an agent connection and a sidecar socket
    // indefinitely. Cap slightly above the approval window; expiry throws,
    // and the proxy fails closed on a throw.
    const deadline = AbortSignal.timeout(AUTHORIZE_TIMEOUT_MS);
    const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const response = await fetch(authorizeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorizeToken ? { authorization: `Bearer ${authorizeToken}` } : {}),
      },
      body: JSON.stringify({ agentPrincipalId, host, port: targetPort, method, secret }),
      signal: abort,
    });
    if (!response.ok) {
      throw new Error(`authorizer responded ${response.status}`);
    }
    return (await response.json()) as EgressVerdict;
  },
  attest: (agentPrincipalId) => ({
    "x-agent-attested-principal": agentPrincipalId,
    "x-agent-attested-proof": egressProxySecret(agentPrincipalId, agentSecret),
  }),
  onVerdict: ({ agentPrincipalId, host, verdict }) => {
    console.log(
      `[egress] ${verdict.allowed ? "ALLOW" : "DENY "} ${agentPrincipalId} -> ${host} (${verdict.ruleId})`,
    );
  },
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[egress] proxy listening on ${port}, authorizing via ${authorizeUrl}`);
});

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

process.on("uncaughtException", (err) => {
  console.error("[egress] uncaught error in proxy:", err?.message || err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[egress] unhandled rejection in proxy:", reason);
});

if (!authorizeUrl) {
  console.error("EGRESS_AUTHORIZE_URL is required");
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
  authorize: async ({ agentPrincipalId, host, port: targetPort, method, secret }): Promise<EgressVerdict> => {
    const response = await fetch(authorizeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorizeToken ? { authorization: `Bearer ${authorizeToken}` } : {}),
      },
      body: JSON.stringify({ agentPrincipalId, host, port: targetPort, method, secret }),
    });
    if (!response.ok) {
      throw new Error(`authorizer responded ${response.status}`);
    }
    return (await response.json()) as EgressVerdict;
  },
  // The agent cannot reach the control plane except through this process, so
  // headers applied here are the control plane's only trustworthy signal that
  // a request originated from an agent rather than a human operator.
  attest: (agentPrincipalId) => ({
    "x-agent-attested-principal": agentPrincipalId,
    "x-agent-attested-proof": egressProxySecret(agentPrincipalId, authorizeToken),
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

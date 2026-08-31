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

const port = Number(process.env["EGRESS_PROXY_PORT"] ?? 8888);
const authorizeUrl = process.env["EGRESS_AUTHORIZE_URL"];
const authorizeToken = process.env["EGRESS_AUTHORIZE_TOKEN"] ?? "";

if (!authorizeUrl) {
  console.error("EGRESS_AUTHORIZE_URL is required");
  process.exit(1);
}

const server = createEgressProxy({
  authorize: async ({
    agentPrincipalId,
    host,
    port: targetPort,
    method,
    secret,
    signal,
  }): Promise<EgressVerdict> => {
    const response = await fetch(authorizeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorizeToken ? { authorization: `Bearer ${authorizeToken}` } : {}),
      },
      body: JSON.stringify({ agentPrincipalId, host, port: targetPort, method, secret }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`authorizer responded ${response.status}`);
    }
    return (await response.json()) as EgressVerdict;
  },
  onVerdict: ({ agentPrincipalId, host, verdict }) => {
    console.log(
      `[egress] ${verdict.allowed ? "ALLOW" : "DENY "} ${agentPrincipalId} -> ${host} (${verdict.ruleId})`,
    );
  },
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[egress] proxy listening on ${port}, authorizing via ${authorizeUrl}`);
});

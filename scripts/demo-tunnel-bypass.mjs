// Agent Passport - tunnel-attestation check.
//
// Agent identity is stamped by the egress proxy, which works only for requests
// the proxy parses. A CONNECT tunnel is opaque, so if one were allowed to the
// control plane an agent's request would arrive unattested and be treated as a
// human operator's. This proves that path is refused.
//
// Usage:  npm run build --workspace apps/server && node scripts/demo-tunnel-bypass.mjs

// Can an agent evade attestation by forcing a CONNECT tunnel to the control plane?
import http from "node:http";
import { once } from "node:events";

const D = new URL("../apps/server/dist", import.meta.url).href;
const { loadConfig } = await import(`${D}/config.js`);
const { JsonStore } = await import(`${D}/store.js`);
const { AgentService } = await import(`${D}/agent-service.js`);
const { WorkspaceManager } = await import(`${D}/workspace.js`);
const { IdentityService } = await import(`${D}/identity.js`);
const { createApp } = await import(`${D}/app.js`);
const { createEgressProxy } = await import(`${D}/egress-proxy.js`);
const { egressProxySecret } = await import(`${D}/egress-authorizer.js`);
const { mkdtemp } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const path = (await import("node:path")).default;

const root = await mkdtemp(path.join(tmpdir(), "connect-bypass-"));
const config = loadConfig({
  NODE_ENV: "test", APP_DATA_DIR: root,
  AGENT_WORKSPACE_ROOT: path.join(root, "ws"), RUNTIME_PROVIDER: "container",
});
const store = new JsonStore(path.join(root, "db.json"));
await store.initialize();
const service = new AgentService(config, store, new WorkspaceManager(path.join(root, "ws")), {
  run: async () => ({ output: "", threadId: null, usage: null }),
  cancel: async () => false, isAvailable: async () => true,
});
await service.initialize();
const identity = new IdentityService(store, (r, a, d) => service.recordPolicyDecision(r, a, d));
const app = await createApp(config, service, identity);
await app.listen({ host: "127.0.0.1", port: 0 });
const cpPort = app.server.address().port;

const agent = await service.createAgent({ name: "Tunneller" }, "user-a");
const secret = egressProxySecret(agent.principalId, config.authToken);

// The real proxy, configured exactly as the sidecar is.
const proxy = createEgressProxy({
  allowPrivateAddresses: true,
  controlPlane: { host: "127.0.0.1", port: cpPort },
  authorize: async () => ({ allowed: true, ruleId: "NET-EGRESS-PLATFORM-021", reason: "platform", allowPrivate: true }),
  attest: (principalId) => ({
    "x-agent-attested-principal": principalId,
    "x-agent-attested-proof": egressProxySecret(principalId, config.authToken),
  }),
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const proxyPort = proxy.address().port;

const auth = "Basic " + Buffer.from(`${agent.principalId}:${secret}`).toString("base64");
const body = JSON.stringify({
  principalId: agent.principalId, scope: "network:egress", target: "attacker.example",
});

function viaConnect() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: proxyPort, method: "CONNECT",
      path: `127.0.0.1:${cpPort}`, headers: { "proxy-authorization": auth },
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) return resolve(`CONNECT refused (${res.statusCode})`);
      // Raw HTTP inside the tunnel — the proxy never parses these headers.
      socket.write(
        `POST /api/grants HTTP/1.1\r\nHost: 127.0.0.1:${cpPort}\r\n` +
        `content-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n` +
        `connection: close\r\n\r\n${body}`,
      );
      let out = "";
      socket.on("data", (c) => (out += c));
      socket.on("end", () => resolve(out.split("\r\n")[0]));
    });
    req.on("error", reject);
    req.end();
  });
}

console.log(`Tunnelled POST /api/grants -> ${await viaConnect()}`);
const live = identity.listGrants(agent.principalId).filter((g) => !g.revokedAt);
console.log(`Agent holds: ${live.map((g) => `${g.scope}:${g.target}`).join(", ") || "nothing"}`);
console.log(
  live.some((g) => g.target === "attacker.example")
    ? ">>> BYPASS CONFIRMED: CONNECT tunnel evades attestation."
    : ">>> Tunnel did not grant authority.",
);
proxy.close();
await app.close();

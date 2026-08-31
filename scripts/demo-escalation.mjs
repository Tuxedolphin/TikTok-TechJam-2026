// Agent Passport - confused-deputy demo.
//
// The control plane is reachable from inside an agent container, because the
// model adapter lives there. That makes a hijacked agent's cheapest attack not
// breaking the network wall but asking the platform for a wider door.
//
// This walks the attack and the rule that stops it: authority only flows
// downhill. Humans originate it; agents may only ever pass along less.
//
// Usage:  npm run build --workspace apps/server && node scripts/demo-escalation.mjs

// Confused-deputy check: can a contained agent widen its own authority?
const D = new URL("../apps/server/dist", import.meta.url).href;
const { loadConfig } = await import(`${D}/config.js`);
const { JsonStore } = await import(`${D}/store.js`);
const { AgentService } = await import(`${D}/agent-service.js`);
const { WorkspaceManager } = await import(`${D}/workspace.js`);
const { IdentityService } = await import(`${D}/identity.js`);
const { createApp } = await import(`${D}/app.js`);
const { egressProxySecret } = await import(`${D}/egress-authorizer.js`);
const { mkdtemp } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const path = (await import("node:path")).default;

const root = await mkdtemp(path.join(tmpdir(), "escalation-"));
const config = loadConfig({
  NODE_ENV: "test", APP_DATA_DIR: root,
  AGENT_WORKSPACE_ROOT: path.join(root, "ws"), RUNTIME_PROVIDER: "container",
});
const store = new JsonStore(path.join(root, "db.json"));
await store.initialize();
const service = new AgentService(config, store, new WorkspaceManager(path.join(root, "ws")), {
  run: async () => ({ output: "", threadId: null, usage: null }),
  cancel: async () => false,
  isAvailable: async () => true,
});
await service.initialize();
const identity = new IdentityService(
  store,
  (r, a, d) => service.recordPolicyDecision(r, a, d),
  (r, a, t, g) => service.recordGrantEvent(r, a, t, g),
);
const app = await createApp(config, service, identity);
const agent = await service.createAgent({ name: "Hijacked" }, "user-a");

// What the egress proxy stamps on anything an agent sends to the control plane.
const attested = {
  "x-agent-attested-principal": agent.principalId,
  "x-agent-attested-proof": egressProxySecret(agent.principalId, config.internalAgentSecret),
};
const grant = (headers, payload) => app.inject({ method: "POST", url: "/api/grants", headers, payload });
const code = (r) => `HTTP ${r.statusCode}`;

let r = await grant(attested, {
  principalId: agent.principalId, scope: "network:egress", target: "attacker.example",
});
console.log(`1. Agent grants itself egress to attacker.example -> ${code(r)}`);

r = await grant({ ...attested, "x-principal-id": "user-a" }, {
  principalId: agent.principalId, scope: "network:egress", target: "attacker.example",
});
console.log(`2. Same, while claiming to be the human operator  -> ${code(r)}`);

r = await grant({ "x-principal-id": "user-a" }, {
  principalId: agent.principalId, scope: "network:egress", target: "registry.npmjs.org",
});
console.log(`3. The human operator grants npmjs               -> ${code(r)}`);

r = await grant(attested, {
  principalId: agent.principalId, scope: "resource:read", target: "registry.npmjs.org", ttlMinutes: 5,
});
console.log(`4. Agent passes along strictly less              -> ${code(r)}`);

r = await grant(attested, {
  principalId: agent.principalId, scope: "network:egress", target: "attacker.example",
});
console.log(`5. Agent tries to widen again, now holding one   -> ${code(r)}`);

const live = identity.listGrants(agent.principalId).filter((g) => !g.revokedAt);
console.log(`\nAgent ends holding: ${live.map((g) => `${g.scope}:${g.target}`).join(", ") || "nothing"}`);
console.log(
  live.some((g) => g.target === "attacker.example")
    ? ">>> STILL VULNERABLE"
    : ">>> Escalation refused. Only human-granted authority survives.",
);
await app.close();

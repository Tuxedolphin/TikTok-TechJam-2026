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
const { check, finish } = await import("./demo-assert.mjs");
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
const code = (r) => {
  if (r.statusCode < 300) return `HTTP ${r.statusCode} allowed`;
  let reason = "";
  try {
    reason = JSON.parse(r.body).message ?? JSON.parse(r.body).error ?? "";
  } catch {}
  return `HTTP ${r.statusCode} ${reason}`.trimEnd();
};

let r = await grant(attested, {
  principalId: agent.principalId, scope: "network:egress", target: "attacker.example",
});
console.log(`1. Agent grants itself egress to attacker.example -> ${code(r)}`);
const selfGrant = r.statusCode;

r = await grant({ ...attested, "x-principal-id": "user-a" }, {
  principalId: agent.principalId, scope: "network:egress", target: "attacker.example",
});
console.log(`2. Same, while claiming to be the human operator  -> ${code(r)}`);
const impersonation = r.statusCode;

r = await grant({ "x-principal-id": "user-a" }, {
  principalId: agent.principalId, scope: "network:egress", target: "registry.npmjs.org",
});
console.log(`3. The human operator grants npmjs               -> ${code(r)}`);
const humanGrant = r.statusCode;

// The rule is "only narrower", not "never" -- but delegation flows to a
// *different* principal. A sub-agent receiving a time-boxed copy of authority
// its parent holds is the case that must be ALLOWED; re-cloning to yourself is
// not (it only produces a grant that survives the original's revocation).
const child = await service.createAgent({ name: "Sub-agent" }, "user-a");
r = await grant(attested, {
  principalId: child.principalId, scope: "network:egress", target: "registry.npmjs.org",
  ttlMinutes: 5,
});
console.log(`4. Agent delegates a time-boxed copy to a sub-agent -> ${code(r)}`);
const attenuated = r.statusCode;

// The revocation-bypass, refused: re-granting yourself a copy you already hold.
r = await grant(attested, {
  principalId: agent.principalId, scope: "network:egress", target: "registry.npmjs.org",
});
console.log(`   Agent clones that grant back to itself         -> ${code(r)}`);
const selfClone = r.statusCode;

// Scopes are only comparable within a family. Holding network authority must
// never be spendable as resource authority, however "narrow" it looks.
r = await grant(attested, {
  principalId: agent.principalId, scope: "resource:read", target: "registry.npmjs.org",
  ttlMinutes: 1,
});
console.log(`5. Agent trades egress for resource:read         -> ${code(r)}`);
const crossFamily = r.statusCode;

r = await grant(attested, {
  principalId: agent.principalId, scope: "network:egress", target: "attacker.example",
});
console.log(`6. Agent tries to widen again, now holding one   -> ${code(r)}`);
const widenAgain = r.statusCode;

// Each refusal names the rule that produced it, so the trace reads as an
// explanation rather than a boolean.
const decisions = store.snapshot().runEvents
  .filter((event) => event.type === "policy.decision")
  .map((event) => JSON.parse(event.detail))
  .filter((decision) => decision.ruleId.startsWith("AUTHORITY-"));
console.log("\nWhat the trace recorded:");
for (const decision of decisions) {
  console.log(`   ${decision.allowed ? "allow" : "deny "}  ${decision.ruleId}`);
}

// Revocation must reach the delegated copy. The operator revokes the parent
// grant it issued to the first agent; the sub-agent's copy cannot outlive it.
const parentGrant = identity.listGrants(agent.principalId)
  .find((g) => g.target === "registry.npmjs.org" && !g.revokedAt);
await identity.revokeGrant(parentGrant.id);
const childGrant = identity.listGrants(child.principalId)
  .find((g) => g.target === "registry.npmjs.org");
console.log(`\n7. Operator revokes the parent grant`);
console.log(`   sub-agent's delegated copy is now: ${childGrant?.revokedAt ? "revoked (cascaded)" : "STILL LIVE"}`);
const cascaded = childGrant?.revokedAt != null;

const agentLive = identity.listGrants(agent.principalId).filter((g) => !g.revokedAt);
const leaked = agentLive.some((g) => g.target === "attacker.example" || g.scope.startsWith("resource:"));
console.log(
  leaked || !cascaded
    ? ">>> STILL VULNERABLE"
    : ">>> Attenuation holds: narrower delegation flowed only downhill, and revocation cascaded to it.",
);
check("an agent cannot grant itself new authority", selfGrant === 403, `HTTP ${selfGrant}`);
check("claiming to be the operator does not outrank attestation", impersonation === 403, `HTTP ${impersonation}`);
check("a human can originate authority", humanGrant === 201, `HTTP ${humanGrant}`);
check("an agent MAY delegate strictly narrower authority to a sub-agent", attenuated === 201, `HTTP ${attenuated}`);
check("an agent cannot clone its own grant back to itself", selfClone === 403, `HTTP ${selfClone}`);
check("network authority is not spendable as resource authority", crossFamily === 403, `HTTP ${crossFamily}`);
check("holding one grant does not enable widening", widenAgain === 403, `HTTP ${widenAgain}`);
check("the agent never ends up holding attacker.example", !leaked);
check("revoking a parent grant cascades to the delegated copy", cascaded);
check("both AUTHORITY rules appear in the trace",
  decisions.some((d) => d.ruleId === "AUTHORITY-NARROWING-032" && d.allowed) &&
  decisions.some((d) => d.ruleId === "AUTHORITY-SELF-ESCALATION-031" && !d.allowed));
finish("Attenuation invariants");
await app.close();

// Agent Passport — identity & delegation demo.
//
// Proves the WS-A story end to end against the real Fastify app with an
// in-memory runner: ownership denial, grant-gated access, mid-flight
// revocation, and a policy.decision trace event for every one of them.
//
// Usage:  npm run build --workspace apps/server && node scripts/demo-passport.mjs

import { loadConfig } from "../apps/server/dist/config.js";
import { JsonStore } from "../apps/server/dist/store.js";
import { AgentService } from "../apps/server/dist/agent-service.js";
import { WorkspaceManager } from "../apps/server/dist/workspace.js";
import { IdentityService } from "../apps/server/dist/identity.js";
import { createApp } from "../apps/server/dist/app.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "passport-smoke-"));
const config = loadConfig({ NODE_ENV: "test", DATA_DIR: root, WORKSPACE_ROOT: path.join(root, "ws") });
const store = new JsonStore(path.join(root, "db.json"));
await store.initialize();
const workspaces = new WorkspaceManager(path.join(root, "ws"));
const runner = { run: async () => ({ output: "", threadId: null, usage: null }), cancel: async () => false, isAvailable: async () => true };
const service = new AgentService(config, store, workspaces, runner);
await service.initialize();
// Wired exactly as index.ts does, so this demo reflects production behaviour.
const identity = new IdentityService(
  store,
  (runId, agentId, d) => service.recordPolicyDecision(runId, agentId, d),
  (runId, agentId, type, grant) => service.recordGrantEvent(runId, agentId, type, grant),
);
const app = await createApp(config, service, identity);

const j = (r) => r.json();
const agent = j(await app.inject({ method: "POST", url: "/api/agents",
  headers: { "x-principal-id": "user-a" }, payload: { name: "Demo", description: "d", instructions: "i" } })).agent;
console.log(`1. agent created  owner=${agent.ownerId}  principal=${agent.principalId}`);

const hdr = { "x-agent-principal-id": agent.principalId };
let r = await app.inject({ method: "GET", url: "/api/resources/res-a", headers: hdr });
console.log(`2. read own resource, NO grant   -> ${r.statusCode} ${j(r).decision?.ruleId ?? ""}`);

const grant = j(await app.inject({ method: "POST", url: "/api/grants", headers: { "x-principal-id": "user-a" },
  payload: { principalId: agent.principalId, scope: "resource:read", target: "res-a", ttlMinutes: 30 } })).grant;
console.log(`3. grant issued   expires=${grant.expiresAt?.slice(11,19)}Z`);

r = await app.inject({ method: "GET", url: "/api/resources/res-a", headers: hdr });
console.log(`4. read own resource, WITH grant -> ${r.statusCode} ${j(r).decision?.ruleId} content="${j(r).resource?.content}"`);

r = await app.inject({ method: "GET", url: "/api/resources/res-b", headers: hdr });
console.log(`5. read USER B's resource        -> ${r.statusCode} ${j(r).decision?.ruleId}  <-- cross-user denial`);

await app.inject({ method: "POST", url: `/api/grants/${grant.id}/revoke` });
r = await app.inject({ method: "GET", url: "/api/resources/res-a", headers: hdr });
console.log(`6. read after REVOKE             -> ${r.statusCode} ${j(r).decision?.ruleId}  <-- revocation bites`);

// Same route the browser's containment feed calls.
const feed = j(await app.inject({ method: "GET", url: `/api/agents/${agent.id}/events` })).events;
console.log(`\n7. GET /api/agents/:id/events (what the UI feed shows): ${feed.length} events`);
for (const e of feed) console.log(`   [${e.severity.padEnd(7)}] ${e.type.padEnd(16)} ${e.title}`);

const events = store.snapshot().runEvents.filter((e) => e.type === "policy.decision");
console.log(`\n8. policy.decision trace events: ${events.length}`);
for (const e of events) console.log(`   [${e.severity.padEnd(7)}] ${e.title}`);
await app.close();

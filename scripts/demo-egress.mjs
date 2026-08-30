// Agent Passport — egress enforcement demo.
//
// Proves containment with real containers on a real network: an agent
// container with no route off-box tries to exfiltrate, is blocked by the
// authorizing proxy, is allowed once a grant exists, and is blocked again the
// moment that grant is revoked — then quarantined for persisting.
//
// Usage:  npm run build --workspace apps/server && node scripts/demo-egress.mjs
// Requires a running container engine (Docker / OrbStack / Colima / Podman).

import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { loadConfig } from "../apps/server/dist/config.js";
import { JsonStore } from "../apps/server/dist/store.js";
import { AgentService } from "../apps/server/dist/agent-service.js";
import { WorkspaceManager } from "../apps/server/dist/workspace.js";
import { IdentityService } from "../apps/server/dist/identity.js";
import { EgressAuthorizer } from "../apps/server/dist/egress-authorizer.js";
import {
  EgressNetworkManager,
  INTERNAL_NETWORK,
  PROXY_CONTAINER,
} from "../apps/server/dist/egress-network.js";
import { createApp } from "../apps/server/dist/app.js";

const execFileAsync = promisify(execFile);
const PORT = 3199;
const TARGET = "example.com";
const log = (...parts) => console.log(...parts);

const root = await mkdtemp(path.join(tmpdir(), "passport-egress-"));
const config = {
  ...loadConfig({
    NODE_ENV: "test",
    PORT: String(PORT),
    APP_DATA_DIR: root,
    AGENT_WORKSPACE_ROOT: path.join(root, "ws"),
    RUNTIME_PROVIDER: "container",
    EGRESS_ENFORCEMENT: "on",
  }),
  serverDistPath: path.resolve("apps/server/dist"),
};

const store = new JsonStore(path.join(root, "db.json"));
const workspaces = new WorkspaceManager(path.join(root, "ws"));
const runner = {
  run: async () => ({ output: "", threadId: null, usage: null }),
  cancel: async () => false,
  isAvailable: async () => true,
};
const service = new AgentService(config, store, workspaces, runner);
await service.initialize();

const identity = new IdentityService(
  store,
  (runId, agentId, decision) => service.recordPolicyDecision(runId, agentId, decision),
  (runId, agentId, type, grant) => service.recordGrantEvent(runId, agentId, type, grant),
);
const authorizer = new EgressAuthorizer(store, {
  standingAllowHosts: ["host.docker.internal"],
  serverKey: config.authToken,
  quarantineThreshold: 3,
  recordDecision: (runId, agentId, decision) =>
    service.recordPolicyDecision(runId, agentId, decision),
  recordBlocked: (runId, agentId, input, decision, strikes) =>
    service.recordEgressBlocked(runId, agentId, input.host, decision, strikes),
  quarantineAgent: (agentId, reason) => service.quarantineAgent(agentId, reason),
});

const app = await createApp(config, service, identity, authorizer);
await app.listen({ host: "0.0.0.0", port: PORT });

const agent = await service.createAgent({ name: "Exfiltrator" }, "user-a");
const network = new EgressNetworkManager(config);

/** Runs curl inside an agent-shaped container: internal network, proxy only. */
async function agentCurl(url) {
  const proxy = network.proxyUrlFor(agent.principalId);
  try {
    const { stdout } = await execFileAsync(
      config.containerEngine,
      [
        "run", "--rm",
        "--network", INTERNAL_NETWORK,
        "--env", `HTTP_PROXY=${proxy}`,
        "--env", `HTTPS_PROXY=${proxy}`,
        // curl ignores the uppercase form for http:// URLs by design.
        "--env", `http_proxy=${proxy}`,
        "--env", `https_proxy=${proxy}`,
        "curlimages/curl:latest",
        "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "12", url,
      ],
      { timeout: 60_000 },
    );
    return stdout.trim();
  } catch (error) {
    return `error(${error.code ?? "?"})`;
  }
}

try {
  log("Bringing up the isolated network and authorizing proxy...");
  await network.ensure();
  await new Promise((resolve) => setTimeout(resolve, 2500));

  log(`\n1. Agent tries to reach ${TARGET} with NO grant`);
  log(`   -> HTTP ${await agentCurl(`http://${TARGET}/`)}   (403 = proxy refused to connect)`);

  log("\n2. Operator issues a network:egress grant");
  const grant = await identity.createGrant({
    principalId: agent.principalId, grantedBy: "user-a",
    scope: "network:egress", target: TARGET,
  });
  log(`   -> HTTP ${await agentCurl(`http://${TARGET}/`)}   (200 = allowed through)`);

  log("\n3. Operator REVOKES the grant mid-flight");
  await identity.revokeGrant(grant.id);
  log(`   -> HTTP ${await agentCurl(`http://${TARGET}/`)}   (403 = revocation bit immediately)`);

  log("\n4. Agent keeps probing until the quarantine threshold trips");
  await agentCurl("http://attacker.example/");
  await agentCurl("http://attacker.example/");
  const status = service.getAgent(agent.id).status;
  log(`   -> agent status: ${status}   (stopped = contained)`);

  log("\n5. Can one agent borrow another's grants by claiming its principal?");
  const impersonated = await execFileAsync(
    config.containerEngine,
    [
      "run", "--rm", "--network", INTERNAL_NETWORK,
      "curlimages/curl:latest", "-s", "-o", "/dev/null", "-w", "%{http_code}",
      "--max-time", "10",
      "--proxy", `http://${agent.principalId}:guessed-secret@${PROXY_CONTAINER}:8888`,
      `http://${TARGET}/`,
    ],
    { timeout: 60_000 },
  ).then((r) => r.stdout.trim()).catch((e) => `error(${e.code})`);
  log(`   -> HTTP ${impersonated}   (403 = secret did not verify)`);

  log("\n6. Can the agent bypass the proxy entirely? (direct, no proxy env)");
  const direct = await execFileAsync(
    config.containerEngine,
    [
      "run", "--rm", "--network", INTERNAL_NETWORK, "curlimages/curl:latest",
      "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", `http://${TARGET}/`,
    ],
    { timeout: 60_000 },
  ).then((r) => r.stdout.trim()).catch((e) => `blocked(exit ${e.code})`);
  log(`   -> ${direct}   (no route off-box: the network itself denies it)`);

  const events = store.snapshot().runEvents;
  log("\n7. Trace receipts");
  for (const event of events.filter((e) => e.type === "egress.blocked" || e.type === "policy.decision")) {
    log(`   [${event.severity.padEnd(7)}] ${event.type.padEnd(16)} ${event.title}`);
  }
} finally {
  await app.close();
  await network.shutdown();
  await execFileAsync(config.containerEngine, ["network", "rm", INTERNAL_NETWORK]).catch(() => {});
  await execFileAsync(config.containerEngine, ["network", "rm", "launchpad-egress-uplink"]).catch(() => {});
  log(`\n(cleaned up ${PROXY_CONTAINER} and its networks)`);
}

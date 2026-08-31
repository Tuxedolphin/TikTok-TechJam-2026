// Agent Passport - verified termination demo.
//
// Revoking a grant only stops the NEXT connection; an agent mid-request has
// already passed its check. So termination here is ordered: freeze the process
// first, then revoke, then tear down, then re-probe from the agent's own
// network position to observe that nothing remains. The receipt records what
// was observed and is signed, so it can be checked by someone who does not
// trust this program -- see scripts/verify-receipt.mjs.
//
// Usage:  npm run build --workspace apps/server && node scripts/demo-kill.mjs
// Requires a container engine.

import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const D = new URL("../apps/server/dist", import.meta.url).href;
const { loadConfig } = await import(`${D}/config.js`);
const { JsonStore } = await import(`${D}/store.js`);
const { AgentService } = await import(`${D}/agent-service.js`);
const { WorkspaceManager } = await import(`${D}/workspace.js`);
const { IdentityService } = await import(`${D}/identity.js`);
const { EgressAuthorizer } = await import(`${D}/egress-authorizer.js`);
const { EgressNetworkManager, INTERNAL_NETWORK } = await import(`${D}/egress-network.js`);
const { AgentTerminator } = await import(`${D}/terminator.js`);
const { createApp } = await import(`${D}/app.js`);

const execFileAsync = promisify(execFile);
const PORT = 3211;
const TARGET = "example.com";
const log = (...parts) => console.log(...parts);

const root = await mkdtemp(path.join(tmpdir(), "passport-kill-"));
const config = {
  ...loadConfig({
    NODE_ENV: "test", PORT: String(PORT), APP_DATA_DIR: root,
    AGENT_WORKSPACE_ROOT: path.join(root, "ws"),
    RUNTIME_PROVIDER: "container", EGRESS_ENFORCEMENT: "on",
  }),
};

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
const network = new EgressNetworkManager(config);
const authorizer = new EgressAuthorizer(store, {
  standingAllowHosts: ["host.docker.internal"],
  serverKey: config.authToken,
  quarantineThreshold: 99,
  recordDecision: (r, a, d) => service.recordPolicyDecision(r, a, d),
  recordBlocked: (r, a, i, d, s) => service.recordEgressBlocked(r, a, i.host, d, s),
});
const terminator = new AgentTerminator(store, service, identity, config.authToken, network);
const app = await createApp(config, service, identity, authorizer, network, terminator);
await app.listen({ host: "0.0.0.0", port: PORT });

const agent = await service.createAgent({ name: "Doomed" }, "user-a");

async function reach(host) {
  const proxy = network.proxyUrlFor(agent.principalId);
  try {
    const { stdout } = await execFileAsync(config.containerEngine, [
      "run", "--rm", "--network", INTERNAL_NETWORK,
      "--env", `http_proxy=${proxy}`, "--env", `https_proxy=${proxy}`,
      "--env", `HTTP_PROXY=${proxy}`, "--env", `HTTPS_PROXY=${proxy}`,
      config.egressProbeImage,
      "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "12", `http://${host}/`,
    ], { timeout: 60_000 });
    return stdout.trim();
  } catch (error) {
    return `no-route(${error.code ?? "?"})`;
  }
}

try {
  log("Bringing up the isolated network and authorizing proxy...\n");
  await network.ensure();
  await new Promise((r) => setTimeout(r, 2500));

  log("1. Operator grants the agent egress it legitimately needs");
  await identity.createGrant({
    principalId: agent.principalId, grantedBy: "user-a",
    scope: "network:egress", target: TARGET,
  });
  log(`   agent reaches ${TARGET} -> HTTP ${await reach(TARGET)}   (working normally)\n`);

  log("2. Operator terminates the agent");
  const { receipt } = await app
    .inject({
      method: "POST", url: `/api/agents/${agent.id}/terminate`,
      headers: { "x-principal-id": "user-a" },
      payload: { reason: "Suspected compromise" },
    })
    .then((r) => r.json());
  for (const step of receipt.steps) {
    log(`   ${step.ok ? "ok  " : "FAIL"}  ${step.step.padEnd(7)} ${step.detail}`);
  }

  log(`\n3. Agent status now: ${service.getAgent(agent.id).status}`);
  log(`   agent reaches ${TARGET} -> HTTP ${await reach(TARGET)}   (authority is gone)\n`);

  const file = path.join(root, "receipt.json");
  await writeFile(file, JSON.stringify(receipt, null, 2));
  log("4. Receipt written. Verify it independently -- this program does not get a vote:\n");
  const { stdout } = await execFileAsync(
    "node",
    [new URL("./verify-receipt.mjs", import.meta.url).pathname, file, "--key", config.authToken],
    { timeout: 30_000 },
  );
  log(stdout.split("\n").map((line) => `   ${line}`).join("\n"));

  log("5. Tamper with the receipt and verify again:");
  const forged = { ...receipt, contained: true, reason: "Nothing to see here" };
  const forgedFile = path.join(root, "forged.json");
  await writeFile(forgedFile, JSON.stringify(forged, null, 2));
  const tampered = await execFileAsync(
    "node",
    [new URL("./verify-receipt.mjs", import.meta.url).pathname, forgedFile, "--key", config.authToken],
    { timeout: 30_000 },
  ).catch((error) => ({ stdout: error.stdout ?? "" }));
  log(tampered.stdout.split("\n").slice(-3).map((line) => `   ${line}`).join("\n"));
} finally {
  await app.close();
  await network.shutdown();
  await execFileAsync(config.containerEngine, ["network", "rm", INTERNAL_NETWORK]).catch(() => {});
  await execFileAsync(config.containerEngine, ["network", "rm", "launchpad-egress-uplink"]).catch(() => {});
  log("\n(cleaned up)");
}

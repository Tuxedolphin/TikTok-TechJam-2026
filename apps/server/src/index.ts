import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig, type AppConfig } from "./config.js";
import { EgressAuthorizer } from "./egress-authorizer.js";
import { EgressNetworkManager } from "./egress-network.js";
import { IdentityService } from "./identity.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

/** Hosts the runtime itself needs: the model endpoint and the adapter callback. */
function platformHosts(config: AppConfig): string[] {
  const hosts = new Set<string>(["host.docker.internal"]);
  try {
    hosts.add(new URL(config.openRouterBaseUrl).hostname);
  } catch {
    // A malformed base URL simply contributes no standing allowance.
  }
  return [...hosts];
}

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const egressNetwork = config.egressEnforcement ? new EgressNetworkManager(config) : undefined;
const service = new AgentService(config, store, workspaces, runner, egressNetwork);
await service.initialize();

const identity = new IdentityService(
  store,
  (runId, agentId, decision) => service.recordPolicyDecision(runId, agentId, decision),
  (runId, agentId, type, grant) => service.recordGrantEvent(runId, agentId, type, grant),
);

const egressAuthorizer = config.egressEnforcement
  ? new EgressAuthorizer(store, {
      // The platform's own endpoints must stay reachable or the agent cannot
      // think; they are explicit and auditable rather than an implicit hole.
      standingAllowHosts: platformHosts(config),
      serverKey: config.authToken,
      quarantineThreshold: config.egressQuarantineThreshold,
      recordDecision: (runId, agentId, decision) =>
        service.recordPolicyDecision(runId, agentId, decision),
      recordBlocked: (runId, agentId, input, decision, strikes) =>
        service.recordEgressBlocked(runId, agentId, input.host, decision, strikes),
      quarantineAgent: (agentId, reason) => service.quarantineAgent(agentId, reason),
    })
  : undefined;

const app = await createApp(config, service, identity, egressAuthorizer);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await egressNetwork?.shutdown();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });

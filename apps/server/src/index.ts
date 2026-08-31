import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig, type AppConfig } from "./config.js";
import { EgressAuthorizer } from "./egress-authorizer.js";
import { EgressNetworkManager } from "./egress-network.js";
import { IdentityService } from "./identity.js";
import { AgentTerminator } from "./terminator.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { loadOrCreateReceiptKeyPair } from "./termination.js";
import { WorkspaceManager } from "./workspace.js";

/** Hosts the runtime itself needs: the model endpoint and the adapter callback. */
/**
 * Endpoints the runtime itself needs, pinned to their ports. Allowing a bare
 * host would hand every contained agent access to anything else listening on
 * that address, which on the gateway host includes the control plane.
 */
function platformHosts(config: AppConfig): string[] {
  const hosts = new Set<string>([`host.docker.internal:${config.port}`]);
  try {
    const modelApi = new URL(config.modelBaseUrl);
    const port = modelApi.port || (modelApi.protocol === "https:" ? "443" : "80");
    hosts.add(`${modelApi.hostname}:${port}`);
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
// Declared before the service so the start hook can clear egress strikes.
let egressAuthorizer: EgressAuthorizer | undefined;
const service = new AgentService(config, store, workspaces, runner, egressNetwork, (agentId) =>
  egressAuthorizer?.resetStrikes(agentId),
);
await service.initialize();

const identity = new IdentityService(
  store,
  (runId, agentId, decision) => service.recordPolicyDecision(runId, agentId, decision),
  (runId, agentId, type, grant) => service.recordGrantEvent(runId, agentId, type, grant),
);

egressAuthorizer = config.egressEnforcement
  ? new EgressAuthorizer(store, {
      // The platform's own endpoints must stay reachable or the agent cannot
      // think; they are explicit and auditable rather than an implicit hole.
      standingAllowHosts: platformHosts(config),
      serverKey: config.internalAgentSecret,
      quarantineThreshold: config.egressQuarantineThreshold,
      recordDecision: (runId, agentId, decision) =>
        service.recordPolicyDecision(runId, agentId, decision),
      recordBlocked: (runId, agentId, input, decision, strikes) =>
        service.recordEgressBlocked(runId, agentId, input.host, decision, strikes),
      requestApproval: (runId, agentId, input) =>
        service.requestEgressApproval(runId, agentId, input),
      quarantineAgent: (agentId, reason) => service.quarantineAgent(agentId, reason),
    })
  : undefined;

const receiptKeys = await loadOrCreateReceiptKeyPair(config.dataDirectory);
const terminator = new AgentTerminator(store, service, identity, receiptKeys, egressNetwork);
const app = await createApp(
  config, service, identity, egressAuthorizer, egressNetwork, terminator,
);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  // Agent processes run in their own process group so a freeze reaches their
  // descendants; that also means they do not die with this server unless we
  // say so. Take them down explicitly rather than leaking orphans.
  (runner as { terminateAll?: () => void }).terminateAll?.();
  await egressNetwork?.shutdown();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });

import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { IdentityService } from "./identity.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const service = new AgentService(config, store, workspaces, runner);
await service.initialize();

// TODO(Task 4): AgentService.recordPolicyDecision does not exist yet; once it lands,
// pass it as IdentityService's recorder so every policy decision is written to the trace.
const identity = new IdentityService(store);
const app = await createApp(config, service, identity);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });

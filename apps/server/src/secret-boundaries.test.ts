import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { IdentityService } from "./identity.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class SecretEchoRunner implements AgentRunner {
  constructor(
    private readonly providerKey: string,
    private readonly adapterKey: string,
  ) {}

  async run(request: RunnerRequest): Promise<RunnerResult> {
    await request.onStep?.({
      type: "command",
      title: "Executed command",
      detail: `echo ${this.providerKey} ${this.adapterKey}`,
    });
    return {
      output: `provider=${this.providerKey}; adapter=${this.adapterKey}`,
      threadId: "secret-test-thread",
      usage: null,
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

describe("credential secrecy across server boundaries", () => {
  it("redacts provider and Runtime credentials from persisted traces and HTTP responses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-secret-boundary-"));
    temporaryDirectories.push(root);
    const providerKey = "AIza/provider?$&=with-special-chars";
    const config = loadConfig({
      NODE_ENV: "test",
      RUNTIME_PROVIDER: "container",
      GEMINI_API_KEY: providerKey,
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex-home"),
    });
    const storePath = path.join(root, "data", "db.json");
    const store = new JsonStore(storePath);
    const service = new AgentService(
      config,
      store,
      new WorkspaceManager(path.join(root, "workspaces")),
      new SecretEchoRunner(providerKey, config.geminiAdapterToken),
    );
    await service.initialize();
    // Identity is wired as index.ts wires it: agent creation is attributed to
    // a server-issued principal session, and that session route needs it.
    const app = await createApp(config, service, new IdentityService(store));

    try {
      // Agent creation is now attributed to a server-issued principal session,
      // so this test takes one rather than asserting the pre-session behaviour.
      const sessionResponse = await app.inject({
        method: "POST",
        url: "/api/mock-principal-session",
        payload: { principalId: "user-a" },
      });
      expect(sessionResponse.statusCode).toBe(201);
      const sessionToken = sessionResponse.json().sessionToken as string;

      const createResponse = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { "x-mock-principal-session": sessionToken },
        payload: { name: "Secret boundary" },
      });
      expect(createResponse.statusCode).toBe(201);
      const agentId = createResponse.json().agent.id as string;
      const prompt = `please use ${providerKey} and ${config.geminiAdapterToken}`;
      const sendResponse = await app.inject({
        method: "POST",
        url: `/api/agents/${agentId}/messages`,
        headers: { "x-mock-principal-session": sessionToken },
        payload: { content: prompt },
      });
      expect(sendResponse.statusCode).toBe(202);
      const runId = sendResponse.json().run.id as string;
      await expect.poll(() => service.getRun(runId).status).toBe("completed");

      const responses = await Promise.all([
        Promise.resolve(sendResponse),
        app.inject({ method: "GET", url: `/api/agents/${agentId}/messages` }),
        app.inject({ method: "GET", url: `/api/agents/${agentId}/runs` }),
        app.inject({ method: "GET", url: `/api/runs/${runId}` }),
        app.inject({ method: "GET", url: `/api/agents/${agentId}/events` }),
        app.inject({ method: "GET", url: `/api/runs/${runId}/events` }),
      ]);
      const visibleBodies = responses.map((response) => response.body).join("\n");
      const traceLog = JSON.stringify(service.getRunEvents(runId));
      const persistedState = await readFile(storePath, "utf8");

      expect(traceLog).not.toContain(providerKey);
      expect(traceLog).not.toContain(config.geminiAdapterToken);
      expect(visibleBodies).not.toContain(providerKey);
      expect(visibleBodies).not.toContain(config.geminiAdapterToken);
      expect(persistedState).not.toContain(providerKey);
      expect(persistedState).not.toContain(config.geminiAdapterToken);
    } finally {
      await app.close();
    }
  });
});

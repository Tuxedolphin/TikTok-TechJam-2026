import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("exposes run trace events", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const agentId = "22222222-2222-4222-8222-222222222222";
    const service = {
      listAgents: () => [],
      systemInfo: async () => ({}),
      getRunEvents: () => [
        {
          id: "event-1",
          runId,
          agentId,
          type: "run.created",
          severity: "info",
          title: "Run queued",
          detail: "Queued prompt preview: hello",
          createdAt: new Date().toISOString(),
        },
      ],
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const response = await app.inject({ method: "GET", url: "/api/runs/" + runId + "/events" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ events: [{ type: "run.created" }] });
    await app.close();
  });
});

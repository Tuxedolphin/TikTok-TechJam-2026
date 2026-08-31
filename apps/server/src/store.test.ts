import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });

  it("migrates v3 databases to v5 with seeded principals and resources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    const v3 = {
      version: 3,
      agents: [{
        id: "agent-1", name: "A", description: "", instructions: "",
        status: "ready", workspacePath: "/tmp/ws", codexThreadId: null,
        activeSessionId: null, lastError: null,
        createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z",
      }],
      sessions: [], messages: [], runs: [], runEvents: [], approvals: [],
    };
    await writeFile(filePath, JSON.stringify(v3), "utf8");
    const store = new JsonStore(filePath);
    await store.initialize();
    const database = store.snapshot();
    expect(database.version).toBe(5);
    expect(database.principals.map((p) => p.id)).toEqual(
      expect.arrayContaining(["user-a", "user-b", "agent-agent-1"]),
    );
    expect(database.resources.map((r) => r.id)).toEqual(["res-a", "res-b"]);
    expect(database.agents[0]?.ownerId).toBe("user-a");
    expect(database.agents[0]?.principalId).toBe("agent-agent-1");
    expect(database.grants).toEqual([]);
  });

  it("migrates legacy approval display names into separate actor evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    const v4 = {
      version: 4,
      agents: [{
        id: "agent-1", name: "Executor", description: "", instructions: "",
        ownerId: "user-a", principalId: "agent-agent-1", status: "ready",
        workspacePath: "/tmp/ws", codexThreadId: null, activeSessionId: null,
        lastError: null, createdAt: "2026-08-29T00:00:00.000Z",
        updatedAt: "2026-08-29T00:00:00.000Z",
      }],
      sessions: [], messages: [], runs: [{
        id: "run-1", agentId: "agent-1", sessionId: null, status: "completed",
        prompt: "contact partner", output: "done", error: null, usage: null,
        startedAt: "2026-08-29T00:00:00.000Z",
        completedAt: "2026-08-29T00:01:00.000Z",
        createdAt: "2026-08-29T00:00:00.000Z",
      }], runEvents: [],
      approvals: [{
        id: "approval-1", runId: "run-1", agentId: "agent-1",
        actionType: "command", actionDetail: "curl https://api.partner.org/data",
        ruleId: "SEC-EGRESS-003", reason: "Outbound network connection",
        riskLevel: "high", status: "approved",
        createdAt: "2026-08-29T00:00:00.000Z",
        resolvedAt: "2026-08-29T00:01:00.000Z", resolvedBy: "System (Server restarted)",
      }, {
        id: "approval-2", runId: "run-1", agentId: "agent-1",
        actionType: "command", actionDetail: "npm publish @acme/payments",
        ruleId: "SEC-SUPPLY-004", reason: "Package publishing",
        riskLevel: "medium", status: "pending",
        createdAt: "2026-08-29T00:00:00.000Z", resolvedAt: null, resolvedBy: null,
      }],
      principals: [
        { id: "user-a", kind: "human", name: "User A", createdAt: "2026-08-29T00:00:00.000Z" },
        { id: "agent-agent-1", kind: "agent", name: "Executor", createdAt: "2026-08-29T00:00:00.000Z" },
      ],
      grants: [], resources: [],
    };
    await writeFile(filePath, JSON.stringify(v4), "utf8");

    const store = new JsonStore(filePath);
    await store.initialize();
    const database = store.snapshot();
    const approval = database.approvals[0];
    expect(database.version).toBe(5);
    expect(database.runs[0]).toMatchObject({
      initiatedByPrincipalId: "legacy:unverified-initiator",
      initiatedByDisplayName: "Unknown legacy initiator",
    });
    expect(approval).toMatchObject({
      resolvedByPrincipalId: "legacy:unverified-operator",
      resolvedByDisplayName: "System (Server restarted)",
      evidence: {
        initiatingHuman: {
          principalId: "legacy:unverified-initiator",
          displayName: "Unknown legacy initiator",
        },
        executingAgent: { principalId: "agent-agent-1", displayName: "Executor" },
        action: { type: "command", detail: "curl https://api.partner.org/data" },
        resource: "https://api.partner.org/data",
        decision: "approved",
        result: "unknown",
        resolvedBy: {
          principalId: "legacy:unverified-operator",
          displayName: "System (Server restarted)",
        },
      },
    });
    expect(approval).not.toHaveProperty("resolvedBy");
    expect(database.approvals[1]?.evidence).toMatchObject({
      resource: "@acme/payments",
      result: "pending",
    });
  });
});

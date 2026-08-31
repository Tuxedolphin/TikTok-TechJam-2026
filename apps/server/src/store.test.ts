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

  it("migrates v3 databases through v4 to v5 with seeded principals and resources", async () => {
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
    expect(database.memories).toEqual([]);
    expect(database.principals.map((p) => p.id)).toEqual(
      expect.arrayContaining(["user-a", "user-b", "agent-agent-1"]),
    );
    expect(database.resources.map((r) => r.id)).toEqual(["res-a", "res-b"]);
    expect(database.agents[0]?.ownerId).toBe("user-a");
    expect(database.agents[0]?.principalId).toBe("agent-agent-1");
    expect(database.grants).toEqual([]);
  });

  it("migrates a v4 database to v5 with an empty memory table", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    const v4 = {
      version: 4,
      agents: [{
        id: "agent-1", name: "A", description: "", instructions: "",
        ownerId: "user-a", principalId: "agent-agent-1",
        status: "ready", workspacePath: "/tmp/ws", codexThreadId: null,
        activeSessionId: null, lastError: null,
        createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z",
      }],
      sessions: [], messages: [], runs: [], runEvents: [], approvals: [],
      principals: [{ id: "user-a", kind: "human", name: "User A", createdAt: "2026-08-29T00:00:00.000Z" }],
      grants: [{
        id: "grant-1", principalId: "agent-agent-1", grantedBy: "user-a",
        scope: "resource:read", target: "res-a",
        expiresAt: null, revokedAt: null, createdAt: "2026-08-29T00:00:00.000Z",
      }],
      resources: [{ id: "res-a", ownerId: "user-a", name: "A", content: "alpha" }],
    };
    await writeFile(filePath, JSON.stringify(v4), "utf8");
    const store = new JsonStore(filePath);
    await store.initialize();
    const database = store.snapshot();

    expect(database.version).toBe(5);
    expect(database.memories).toEqual([]);
    // Additive only: nothing a v4 file already held may be dropped.
    expect(database.agents).toHaveLength(1);
    expect(database.grants.map((grant) => grant.id)).toEqual(["grant-1"]);
    expect(database.resources.map((resource) => resource.id)).toEqual(["res-a"]);
  });

  it("loads a v5 file written by the sibling attribution schema", async () => {
    // #28 also stamps `version: 5`, with attribution fields this branch knows
    // nothing about. Sharing a version number means neither migration reruns,
    // so each side must load the other's file without losing data. Fields this
    // branch does not model are simply carried through; `memories` defaults.
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    const siblingV5 = {
      version: 5,
      agents: [], sessions: [], messages: [], runEvents: [], principals: [], resources: [],
      runs: [{
        id: "run-1", agentId: "agent-1", status: "completed", prompt: "p",
        output: null, error: null, usage: null,
        startedAt: null, completedAt: null, createdAt: "2026-08-29T00:00:00.000Z",
        initiatedByPrincipalId: "user-a", initiatedByDisplayName: "User A",
      }],
      grants: [{
        id: "grant-1", principalId: "agent-1", grantedBy: "user-a",
        scope: "network:egress", target: "example.com",
        expiresAt: null, revokedAt: null, createdAt: "2026-08-29T00:00:00.000Z",
        revokedBy: null,
      }],
      approvals: [{
        id: "ap-1", runId: "run-1", agentId: "agent-1", actionType: "command",
        actionDetail: "curl", ruleId: "SEC-EGRESS-003", reason: "r",
        riskLevel: "high", status: "approved",
        createdAt: "2026-08-29T00:00:00.000Z", resolvedAt: "2026-08-29T00:01:00.000Z",
        resolvedByPrincipalId: "user-a", resolvedByDisplayName: "User A",
        evidence: { decision: "approved" },
      }],
      // no `memories` key at all
    };
    await writeFile(filePath, JSON.stringify(siblingV5), "utf8");
    const store = new JsonStore(filePath);
    await store.initialize();
    const database = store.snapshot();

    expect(database.version).toBe(5);
    expect(database.memories).toEqual([]);
    // Nothing the sibling wrote may be dropped on the way through.
    expect(database.grants).toHaveLength(1);
    expect(database.approvals).toHaveLength(1);
    expect(
      (database.approvals[0] as unknown as { evidence?: unknown }).evidence,
    ).toBeDefined();
    expect(
      (database.runs[0] as unknown as { initiatedByPrincipalId?: string }).initiatedByPrincipalId,
    ).toBe("user-a");
  });
});

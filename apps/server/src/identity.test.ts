import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IdentityService } from "./identity.js";
import type { Grant, PolicyDecision } from "./types.js";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeHarness(
  recordDecision?: (runId: string, agentId: string, decision: PolicyDecision) => Promise<void> | void,
  recordGrantLifecycle?: (
    runId: string,
    agentId: string,
    type: "grant.created" | "grant.revoked",
    grant: Grant,
  ) => Promise<void> | void,
): Promise<{ service: IdentityService; store: JsonStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-identity-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    database.principals.push({ id: "agent-1", kind: "agent", name: "A1", createdAt: new Date().toISOString() });
    database.agents.push({
      id: "00000000-0000-4000-8000-000000000001",
      name: "A1",
      description: "",
      instructions: "",
      ownerId: "user-a",
      principalId: "agent-1",
      status: "ready",
      workspacePath: root,
      codexThreadId: null,
      activeSessionId: null,
      lastError: null,
      authorityBlocked: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });
  return { service: new IdentityService(store, recordDecision, recordGrantLifecycle), store };
}

async function makeService(
  recordDecision?: (runId: string, agentId: string, decision: PolicyDecision) => Promise<void> | void,
  recordGrantLifecycle?: (
    runId: string,
    agentId: string,
    type: "grant.created" | "grant.revoked",
    grant: Grant,
  ) => Promise<void> | void,
): Promise<IdentityService> {
  return (await makeHarness(recordDecision, recordGrantLifecycle)).service;
}

describe("IdentityService", () => {
  it("creates a grant with ttl and lists it", async () => {
    const service = await makeService();
    const grant = await service.createGrant({
      principalId: "agent-1", grantedBy: "user-a",
      scope: "resource:read", target: "res-a", ttlMinutes: 30,
    });
    expect(grant.expiresAt).not.toBeNull();
    expect(service.listGrants("agent-1")).toHaveLength(1);
  });
  it("revokes a grant so later evaluation denies", async () => {
    const service = await makeService();
    const grant = await service.createGrant({
      principalId: "agent-1", grantedBy: "user-a", scope: "resource:read", target: "res-a",
    });
    await service.revokeGrant(grant.id);
    const denied = await service.readResourceAsAgent("res-a", "agent-1");
    expect(denied.decision).toMatchObject({ allowed: false, ruleId: "AUTHZ-REVOKED-013" });
  });
  it("returns resource content only when the decision allows", async () => {
    const service = await makeService();
    const before = await service.readResourceAsAgent("res-a", "agent-1");
    expect(before.resource).toBeNull();
    await service.createGrant({
      principalId: "agent-1", grantedBy: "user-a", scope: "resource:read", target: "res-a",
    });
    const after = await service.readResourceAsAgent("res-a", "agent-1");
    expect(after.resource?.content).toBe("alpha,beta,gamma");
  });
  it("records a policy.decision for both allow and deny", async () => {
    const recorded: Array<{ runId: string; agentId: string; ruleId: string }> = [];
    const service = await makeService((runId, agentId, decision) => {
      recorded.push({ runId, agentId, ruleId: decision.ruleId });
    });
    await service.readResourceAsAgent("res-a", "agent-1");           // deny, no grant
    await service.createGrant({
      principalId: "agent-1", grantedBy: "user-a", scope: "resource:read", target: "res-a",
    });
    await service.readResourceAsAgent("res-a", "agent-1");           // allow
    expect(recorded.map((entry) => entry.ruleId)).toEqual([
      "AUTHZ-GRANT-011",
      "AUTHORITY-HUMAN-030",
      "AUTHZ-GRANT-011",
    ]);
    expect(recorded).toHaveLength(3);
  });
  it("records grant.created and grant.revoked in the trace", async () => {
    const lifecycle: Array<"grant.created" | "grant.revoked"> = [];
    const service = await makeService(undefined, (_runId, _agentId, type) => {
      lifecycle.push(type);
    });
    const grant = await service.createGrant({
      principalId: "agent-1", grantedBy: "user-a", scope: "resource:read", target: "res-a",
    });
    await service.revokeGrant(grant.id);
    expect(lifecycle).toEqual(["grant.created", "grant.revoked"]);
  });
  it("does not hand out a Grant that aliases stored state", async () => {
    const service = await makeService();
    const grant = await service.createGrant({
      principalId: "agent-1", grantedBy: "user-a", scope: "resource:read", target: "res-a",
    });
    grant.revokedAt = "1999-01-01T00:00:00.000Z";
    expect(service.listGrants("agent-1")[0]?.revokedAt).toBeNull();
  });

  it("atomically refuses new authority after termination blocks a principal", async () => {
    const { service, store } = await makeHarness();
    await store.mutate((database) => {
      const agent = database.agents.find((candidate) => candidate.principalId === "agent-1");
      if (agent) agent.authorityBlocked = true;
    });

    await expect(service.createGrant({
      principalId: "agent-1",
      grantedBy: "user-a",
      scope: "network:egress",
      target: "attacker.example",
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(service.listGrants("agent-1")).toHaveLength(0);
  });
});

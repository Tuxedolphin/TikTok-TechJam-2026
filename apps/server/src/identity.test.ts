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

async function makeService(
  recordDecision?: (runId: string, agentId: string, decision: PolicyDecision) => Promise<void> | void,
  recordGrantLifecycle?: (
    runId: string,
    agentId: string,
    type: "grant.created" | "grant.revoked",
    grant: Grant,
  ) => Promise<void> | void,
): Promise<IdentityService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-identity-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    database.principals.push({ id: "agent-1", kind: "agent", name: "A1", createdAt: new Date().toISOString() });
  });
  return new IdentityService(store, recordDecision, recordGrantLifecycle);
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
    const revoked = await service.revokeGrant(grant.id, "user-a");
    expect(revoked.revokedBy).toBe("user-a");
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
    expect(recorded.map((entry) => entry.ruleId)).toEqual(["AUTHZ-GRANT-011", "AUTHZ-GRANT-011"]);
    expect(recorded).toHaveLength(2);
  });
  it("records grant.created and grant.revoked in the trace", async () => {
    const lifecycle: Array<"grant.created" | "grant.revoked"> = [];
    const service = await makeService(undefined, (_runId, _agentId, type) => {
      lifecycle.push(type);
    });
    const grant = await service.createGrant({
      principalId: "agent-1", grantedBy: "user-a", scope: "resource:read", target: "res-a",
    });
    await service.revokeGrant(grant.id, "user-a");
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
});

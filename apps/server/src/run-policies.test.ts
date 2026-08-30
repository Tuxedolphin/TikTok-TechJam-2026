import { describe, expect, it } from "vitest";
import { evaluateEgress, evaluateResourceAccess } from "./run-policies.js";
import type { Grant, MockResource } from "./types.js";

const NOW = "2026-08-30T12:00:00.000Z";
const resA: MockResource = { id: "res-a", ownerId: "user-a", name: "r", content: "c" };
const grant = (over: Partial<Grant>): Grant => ({
  id: "g1", principalId: "agent-1", grantedBy: "user-a",
  scope: "resource:read", target: "res-a",
  expiresAt: null, revokedAt: null, createdAt: NOW, ...over,
});

describe("evaluateResourceAccess", () => {
  it("denies cross-user access even with a grant (AUTHZ-OWNER-010)", () => {
    const decision = evaluateResourceAccess("agent-1", "user-b", resA, [grant({})], NOW);
    expect(decision).toMatchObject({ allowed: false, ruleId: "AUTHZ-OWNER-010" });
  });
  it("denies same-user access without a grant (AUTHZ-GRANT-011)", () => {
    const decision = evaluateResourceAccess("agent-1", "user-a", resA, [], NOW);
    expect(decision).toMatchObject({ allowed: false, ruleId: "AUTHZ-GRANT-011" });
  });
  it("allows with an active matching grant (AUTHZ-GRANT-011)", () => {
    const decision = evaluateResourceAccess("agent-1", "user-a", resA, [grant({})], NOW);
    expect(decision).toMatchObject({ allowed: true, ruleId: "AUTHZ-GRANT-011", grantId: "g1" });
  });
  it("denies when the grant expired (AUTHZ-EXPIRED-012)", () => {
    const expired = grant({ expiresAt: "2026-08-30T11:00:00.000Z" });
    const decision = evaluateResourceAccess("agent-1", "user-a", resA, [expired], NOW);
    expect(decision).toMatchObject({ allowed: false, ruleId: "AUTHZ-EXPIRED-012" });
  });
  it("denies when the grant was revoked (AUTHZ-REVOKED-013)", () => {
    const revoked = grant({ revokedAt: "2026-08-30T11:30:00.000Z" });
    const decision = evaluateResourceAccess("agent-1", "user-a", resA, [revoked], NOW);
    expect(decision).toMatchObject({ allowed: false, ruleId: "AUTHZ-REVOKED-013" });
  });
});

describe("evaluateEgress", () => {
  it("denies by default (NET-EGRESS-020)", () => {
    expect(evaluateEgress("agent-1", "attacker.com", [], NOW)).toMatchObject({
      allowed: false, ruleId: "NET-EGRESS-020",
    });
  });
  it("allows a host with an active network grant", () => {
    const g = grant({ scope: "network:egress", target: "registry.npmjs.org" });
    expect(evaluateEgress("agent-1", "registry.npmjs.org", [g], NOW)).toMatchObject({
      allowed: true, grantId: "g1",
    });
  });
});

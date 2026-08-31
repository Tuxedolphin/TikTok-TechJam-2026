import { describe, expect, it } from "vitest";
import { authorizeGrantRequest, isNarrowerThan } from "./authority.js";
import type { Grant } from "./types.js";

const AGENT = "agent-1";
const LATER = "2026-12-31T00:00:00.000Z";
const EARLIER = "2026-06-30T00:00:00.000Z";

function held(over: Partial<Grant> = {}): Grant {
  return {
    id: "parent-grant",
    principalId: AGENT,
    grantedBy: "user-a",
    scope: "network:egress",
    target: "registry.npmjs.org",
    expiresAt: null,
    revokedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("isNarrowerThan", () => {
  it("accepts an identical shape", () => {
    const shape = { scope: "resource:read" as const, target: "res-a", expiresAt: null };
    expect(isNarrowerThan(shape, shape)).toBe(true);
  });

  it("rejects a more powerful scope", () => {
    expect(
      isNarrowerThan(
        { scope: "resource:write", target: "res-a", expiresAt: null },
        { scope: "resource:read", target: "res-a", expiresAt: null },
      ),
    ).toBe(false);
  });

  it("accepts a less powerful scope", () => {
    expect(
      isNarrowerThan(
        { scope: "resource:read", target: "res-a", expiresAt: null },
        { scope: "resource:write", target: "res-a", expiresAt: null },
      ),
    ).toBe(true);
  });

  it("rejects a different target", () => {
    expect(
      isNarrowerThan(
        { scope: "resource:read", target: "res-b", expiresAt: null },
        { scope: "resource:read", target: "res-a", expiresAt: null },
      ),
    ).toBe(false);
  });

  it("lets a wildcard parent cover a specific target but never the reverse", () => {
    const wide = { scope: "resource:read" as const, target: "*", expiresAt: null };
    const narrow = { scope: "resource:read" as const, target: "res-a", expiresAt: null };
    expect(isNarrowerThan(narrow, wide)).toBe(true);
    expect(isNarrowerThan(wide, narrow)).toBe(false);
  });

  it("covers subdomains of a wildcard domain, not unrelated hosts", () => {
    const parent = { scope: "network:egress" as const, target: "*.npmjs.org", expiresAt: null };
    expect(
      isNarrowerThan({ scope: "network:egress", target: "registry.npmjs.org", expiresAt: null }, parent),
    ).toBe(true);
    expect(
      isNarrowerThan({ scope: "network:egress", target: "attacker.example", expiresAt: null }, parent),
    ).toBe(false);
  });

  it("refuses to outlive its parent", () => {
    const parent = { scope: "resource:read" as const, target: "res-a", expiresAt: EARLIER };
    expect(isNarrowerThan({ scope: "resource:read", target: "res-a", expiresAt: LATER }, parent)).toBe(false);
    expect(isNarrowerThan({ scope: "resource:read", target: "res-a", expiresAt: EARLIER }, parent)).toBe(true);
    // A child with no expiry is unbounded, which outlives any bounded parent.
    expect(isNarrowerThan({ scope: "resource:read", target: "res-a", expiresAt: null }, parent)).toBe(false);
  });
});

describe("authorizeGrantRequest", () => {
  it("lets a human originate authority from nothing", () => {
    const decision = authorizeGrantRequest({
      actorKind: "human",
      actorPrincipalId: "user-a",
      requested: { scope: "network:egress", target: "anywhere.example", expiresAt: null },
      beneficiaryPrincipalId: AGENT,
      heldByRequester: [],
    });
    expect(decision).toMatchObject({ allowed: true, ruleId: "AUTHORITY-HUMAN-030" });
  });

  it("stops an agent granting itself authority it was never given", () => {
    // The confused-deputy attack: the agent reaches the control plane and asks
    // for a door rather than trying to break the wall.
    const decision = authorizeGrantRequest({
      actorKind: "agent",
      actorPrincipalId: AGENT,
      requested: { scope: "network:egress", target: "attacker.example", expiresAt: null },
      beneficiaryPrincipalId: AGENT,
      heldByRequester: [held()],
    });
    expect(decision).toMatchObject({
      allowed: false,
      ruleId: "AUTHORITY-SELF-ESCALATION-031",
    });
  });

  it("stops an agent escalating its own scope on a target it does hold", () => {
    const decision = authorizeGrantRequest({
      actorKind: "agent",
      actorPrincipalId: AGENT,
      requested: { scope: "resource:write", target: "res-a", expiresAt: null },
      beneficiaryPrincipalId: AGENT,
      heldByRequester: [held({ scope: "resource:read", target: "res-a" })],
    });
    expect(decision.allowed).toBe(false);
  });

  it("allows an agent to pass along strictly less than it holds", () => {
    const decision = authorizeGrantRequest({
      actorKind: "agent",
      actorPrincipalId: AGENT,
      requested: { scope: "network:egress", target: "registry.npmjs.org", expiresAt: LATER },
      beneficiaryPrincipalId: "agent-child",
      heldByRequester: [held({ expiresAt: null })],
    });
    expect(decision).toMatchObject({ allowed: true, ruleId: "AUTHORITY-NARROWING-032" });
  });

  it("stops an agent handing a peer more than it holds itself", () => {
    const decision = authorizeGrantRequest({
      actorKind: "agent",
      actorPrincipalId: AGENT,
      requested: { scope: "network:egress", target: "attacker.example", expiresAt: null },
      beneficiaryPrincipalId: "agent-child",
      heldByRequester: [held({ target: "registry.npmjs.org" })],
    });
    expect(decision).toMatchObject({ allowed: false, ruleId: "AUTHORITY-NARROWING-032" });
  });

  it("ignores grants the requester no longer effectively holds", () => {
    // A revoked grant is filtered out by the caller; nothing here should
    // resurrect authority from it.
    const decision = authorizeGrantRequest({
      actorKind: "agent",
      actorPrincipalId: AGENT,
      requested: { scope: "network:egress", target: "registry.npmjs.org", expiresAt: null },
      beneficiaryPrincipalId: AGENT,
      heldByRequester: [],
    });
    expect(decision.allowed).toBe(false);
  });
});

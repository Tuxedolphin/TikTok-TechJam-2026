import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  estimateRunCostUsd,
  evaluateEgress,
  evaluateResourceAccess,
  rejectRunIfBudgetExceeded,
  summarizeRunPolicies,
} from "./run-policies.js";
import type { Grant, MockResource } from "./types.js";

const NOW = "2026-08-30T12:00:00.000Z";
const resA: MockResource = { id: "res-a", ownerId: "user-a", name: "r", content: "c" };
const grant = (over: Partial<Grant>): Grant => ({
  id: "g1", principalId: "agent-1", grantedBy: "user-a",
  scope: "resource:read", target: "res-a",
  expiresAt: null, revokedAt: null, revokedBy: null, createdAt: NOW, ...over,
});

const budgetConfig = (over: Record<string, unknown> = {}) => loadConfig({
  NODE_ENV: "test",
  ...over,
});

describe("rejectRunIfBudgetExceeded", () => {
  it("allows usage at exact token and duration boundaries", () => {
    const config = budgetConfig({
      RUN_BUDGET_MAX_INPUT_TOKENS: 300,
      RUN_BUDGET_MAX_OUTPUT_TOKENS: 300,
      RUN_BUDGET_MAX_TOTAL_TOKENS: 600,
      RUN_BUDGET_MAX_DURATION_MS: 1_000,
    });

    expect(() => rejectRunIfBudgetExceeded(config, {
      inputTokens: 300, cachedInputTokens: 200, outputTokens: 300,
    }, 1_000)).not.toThrow();
  });

  it("rejects input tokens at limit plus one", () => {
    const config = budgetConfig({ RUN_BUDGET_MAX_INPUT_TOKENS: 100 });

    expect(() => rejectRunIfBudgetExceeded(config, { inputTokens: 101 }, 0))
      .toThrow(/input tokens exceeded 100/);
  });

  it("rejects output tokens at limit plus one as a fallback observation", () => {
    const config = budgetConfig({ RUN_BUDGET_MAX_OUTPUT_TOKENS: 100 });

    expect(() => rejectRunIfBudgetExceeded(config, { outputTokens: 101 }, 0))
      .toThrow(/output tokens exceeded 100/);
  });

  it("treats cached input as a subset instead of double-counting it", () => {
    const config = budgetConfig({ RUN_BUDGET_MAX_TOTAL_TOKENS: 400 });

    expect(() => rejectRunIfBudgetExceeded(config, {
      inputTokens: 200, cachedInputTokens: 150, outputTokens: 200,
    }, 0)).not.toThrow();
    expect(() => rejectRunIfBudgetExceeded(config, {
      inputTokens: 200, cachedInputTokens: 150, outputTokens: 201,
    }, 0)).toThrow(/total tokens exceeded 400/);
  });

  it("does not reject null usage", () => {
    const config = budgetConfig({
      RUN_BUDGET_MAX_INPUT_TOKENS: 1,
      RUN_BUDGET_MAX_OUTPUT_TOKENS: 1,
      RUN_BUDGET_MAX_TOTAL_TOKENS: 1,
      RUN_BUDGET_MAX_DURATION_MS: 1,
    });

    expect(() => rejectRunIfBudgetExceeded(config, null, 1)).not.toThrow();
  });
});

describe("token usage semantics", () => {
  it("charges the cached subset at the cached rate rather than twice", () => {
    expect(estimateRunCostUsd({
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 10,
    })).toBe(0.000017);
  });
});

describe("summarizeRunPolicies", () => {
  it("exposes budget modes and total components", () => {
    const config = budgetConfig({
      RUN_BUDGET_MAX_INPUT_TOKENS: 100,
      RUN_BUDGET_MAX_OUTPUT_TOKENS: 200,
      RUN_BUDGET_MAX_TOTAL_TOKENS: 600,
      RUN_BUDGET_MAX_DURATION_MS: 1_000,
    });

    expect(summarizeRunPolicies(config)).toMatchObject({
      runBudgetEnforcement: {
        inputTokens: "observational",
        cachedInputTokens: "observational",
        outputTokens: "preventive",
        totalTokens: "observational",
        durationMs: "preventive",
      },
      runBudgetTokenSemantics: {
        cachedInputTokensIncludedInInput: true,
        totalTokens: ["inputTokens", "outputTokens"],
      },
    });
  });
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

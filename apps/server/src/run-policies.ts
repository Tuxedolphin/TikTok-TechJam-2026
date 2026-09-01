/**
 * Policy evaluators, in two groups that must not be confused for each other.
 *
 * The authorization evaluators at the bottom of this file — `activeGrant`,
 * `evaluateResourceAccess`, `evaluateEgress` — are enforcement. They run before
 * the side effect and their verdict decides whether it happens at all.
 *
 * `evaluateActionRisk` is not. Codex reports shell and tool activity as
 * `item.completed`, meaning the command has already run; classifying that text
 * produces audit evidence (`SEC-*`) and nothing more. The distinction is load
 * bearing, and the docs state it plainly rather than letting a `SEC-` rule id
 * imply a block that never happened.
 *
 * Budget breakers sit between the two: token caps are enforced by the provider
 * request, while the post-run totals are checked here after the fact.
 */
import type { AppConfig } from "./config.js";
import { isNarrowerThan } from "./authority.js";
import { HttpError } from "./errors.js";
import type {
  ActionRiskLevel,
  Grant,
  GrantScope,
  MockResource,
  PolicyDecision,
  RunnerStepEvent,
  RunUsage,
} from "./types.js";

export type RunPolicyKind =
  | "canary"
  | "budget"
  | "approval"
  | "containment"
  | "runtime_control"
  | "authz"
  | "egress"
  | "anomaly";

export interface ActionRiskAssessment {
  riskLevel: ActionRiskLevel;
  requiresApproval: boolean;
  ruleId: string;
  reason: string;
}

export class RunPolicyViolationError extends HttpError {
  constructor(
    public readonly kind: RunPolicyKind,
    statusCode: number,
    message: string,
  ) {
    super(statusCode, message);
  }
}

export function evaluateActionRisk(step: RunnerStepEvent): ActionRiskAssessment {
  const text = `${step.title} ${step.detail} ${JSON.stringify(step.rawPayload ?? "")}`;

  // 1. Destructive filesystem operations
  if (
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive\s+)/i.test(text) ||
    /\b(mkfs|dd\s+if=|chmod\s+-R\s+777)\b/i.test(text)
  ) {
    return {
      riskLevel: "critical",
      requiresApproval: true,
      ruleId: "SEC-DESTRUCTIVE-001",
      reason: "Destructive filesystem operation detected that could cause permanent data loss.",
    };
  }

  // 2. Sensitive credential file access or leak attempts
  if (
    /\b(credentials\.env|\.env(?:\.[a-zA-Z0-9_-]+)?|id_rsa|id_ed25519|\.aws\/credentials|\/etc\/shadow|\/etc\/passwd)\b/i.test(text)
  ) {
    return {
      riskLevel: "high",
      requiresApproval: true,
      ruleId: "SEC-CREDENTIALS-002",
      reason: "Access to protected credentials or private keys detected.",
    };
  }

  // 3. External network egress & exfiltration tools
  if (
    /\b(curl|wget|fetch|nc|netcat|ncat|telnet|ssh|scp|rsync|socat)\b/i.test(text) ||
    /https?:\/\/[^\s"']+/i.test(text)
  ) {
    return {
      riskLevel: "high",
      requiresApproval: true,
      ruleId: "SEC-EGRESS-003",
      reason: "Outbound network connection or data transfer tool detected outside local perimeter.",
    };
  }

  // 4. Package publishing / remote repository releases
  if (
    /\b(npm\s+publish|pnpm\s+publish|yarn\s+publish|twine\s+upload|cargo\s+publish|pip\s+upload)\b/i.test(text)
  ) {
    return {
      riskLevel: "medium",
      requiresApproval: true,
      ruleId: "SEC-SUPPLY-004",
      reason: "Package registry publishing action detected targeting remote repositories.",
    };
  }

  // 5. Privilege escalation attempts
  if (/\b(sudo|su\s+-|chown\s+root)\b/i.test(text)) {
    return {
      riskLevel: "critical",
      requiresApproval: true,
      ruleId: "SEC-PRIVILEGE-005",
      reason: "Privilege escalation attempt detected targeting elevated system permissions.",
    };
  }

  return {
    riskLevel: "low",
    requiresApproval: false,
    ruleId: "ALLOW-STANDARD-000",
    reason: "Standard workspace execution automatically approved under active policy.",
  };
}

/**
 * The prompt and tool-call canary checks live inline in `AgentService`, which
 * needs the violation as a value it can attach to the run inside an open
 * mutation rather than as a throw. Only the output check is expressed here.
 */
export function rejectOutputIfCanaryPresent(config: AppConfig, output: string): void {
  if (config.guardrailCanaryToken && output.includes(config.guardrailCanaryToken)) {
    throw new RunPolicyViolationError(
      "canary",
      409,
      "Run output echoed the canary token outside the workspace boundary.",
    );
  }
}

export function estimateRunCostUsd(
  usage: RunUsage | null,
  model?: string | null,
): number | null {
  if (!usage) return null;
  const input = usage.inputTokens ?? 0;
  const cached = Math.min(usage.cachedInputTokens ?? 0, input);
  const uncachedInput = input - cached;
  const output = usage.outputTokens ?? 0;
  if (input === 0 && output === 0) return null;

  // Blended estimates per 1M tokens based on standard tiers
  const isHighTier =
    model?.includes("opus") ||
    model?.includes("gpt-4o") && !model?.includes("mini") ||
    model?.includes("claude-3-5-sonnet");

  const inputRate = isHighTier ? 3.0 / 1_000_000 : 0.15 / 1_000_000;
  const cachedRate = isHighTier ? 0.75 / 1_000_000 : 0.0375 / 1_000_000;
  const outputRate = isHighTier ? 15.0 / 1_000_000 : 0.60 / 1_000_000;

  const cost = uncachedInput * inputRate + cached * cachedRate + output * outputRate;
  return Number(cost.toFixed(6));
}

function totalTokens(usage: RunUsage | null): number | null {
  if (!usage) return null;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

export function rejectRunIfBudgetExceeded(
  config: AppConfig,
  usage: RunUsage | null,
  elapsedMs: number,
): void {
  const violations: string[] = [];
  const total = totalTokens(usage);

  if (
    config.runBudgetMaxInputTokens !== null &&
    (usage?.inputTokens ?? 0) > config.runBudgetMaxInputTokens
  ) {
    violations.push("input tokens exceeded " + config.runBudgetMaxInputTokens);
  }
  if (
    config.runBudgetMaxOutputTokens !== null &&
    (usage?.outputTokens ?? 0) > config.runBudgetMaxOutputTokens
  ) {
    violations.push("output tokens exceeded " + config.runBudgetMaxOutputTokens);
  }
  if (
    config.runBudgetMaxTotalTokens !== null &&
    total !== null &&
    total > config.runBudgetMaxTotalTokens
  ) {
    violations.push("total tokens exceeded " + config.runBudgetMaxTotalTokens);
  }
  if (
    config.runBudgetMaxDurationMs !== null &&
    elapsedMs > config.runBudgetMaxDurationMs
  ) {
    violations.push("duration exceeded " + config.runBudgetMaxDurationMs + " ms");
  }

  if (violations.length > 0) {
    throw new RunPolicyViolationError(
      "budget",
      429,
      "Run budget circuit breaker tripped: " + violations.join(", "),
    );
  }
}

export function summarizeRunPolicies(config: AppConfig): Record<string, unknown> {
  return {
    // Whether containment is actually enforcing right now. Surfaced so the UI
    // can distinguish "nothing was blocked" from "nothing is being checked".
    egressEnforcement: config.egressEnforcement,
    egressQuarantineThreshold: config.egressQuarantineThreshold,
    guardrailCanaryEnabled: config.guardrailCanaryToken.length > 0,
    runBudgetMaxInputTokens: config.runBudgetMaxInputTokens,
    runBudgetMaxOutputTokens: config.runBudgetMaxOutputTokens,
    runBudgetMaxTotalTokens: config.runBudgetMaxTotalTokens,
    runBudgetMaxDurationMs: config.runBudgetMaxDurationMs,
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
  };
}

export function isGrantChainLive(
  grant: Grant,
  grants: Grant[],
  nowIso: string,
  visiting = new Set<string>(),
): boolean {
  if (visiting.has(grant.id)) return false;
  if (grant.revokedAt !== null || (grant.expiresAt !== null && grant.expiresAt <= nowIso)) {
    return false;
  }

  const parentGrantId = grant.parentGrantId ?? null;
  if (parentGrantId === null) return true;

  const parent = grants.find((candidate) => candidate.id === parentGrantId);
  if (!parent || parent.principalId !== grant.grantedBy) return false;
  if (!isNarrowerThan(
    { scope: grant.scope, target: grant.target, expiresAt: grant.expiresAt },
    { scope: parent.scope, target: parent.target, expiresAt: parent.expiresAt },
  )) {
    return false;
  }

  const nextVisiting = new Set(visiting);
  nextVisiting.add(grant.id);
  return isGrantChainLive(parent, grants, nowIso, nextVisiting);
}

function activeGrant(
  grants: Grant[], principalId: string, scope: GrantScope, target: string, nowIso: string,
): { grant: Grant | null; ruleId: string } {
  const noGrantRuleId = scope === "network:egress" ? "NET-EGRESS-020" : "AUTHZ-GRANT-011";
  const matching = grants.filter(
    (g) => g.principalId === principalId && g.scope === scope && g.target === target,
  );
  if (matching.length === 0) return { grant: null, ruleId: noGrantRuleId };
  const live = matching.find((g) => isGrantChainLive(g, grants, nowIso));
  if (live) return { grant: live, ruleId: noGrantRuleId };
  // Every matching grant is spent: say which way, since "you revoked this" and
  // "this timed out" mean different things to whoever reads the timeline.
  const revoked = matching.every((g) => g.revokedAt !== null);
  return { grant: null, ruleId: revoked ? "AUTHZ-REVOKED-013" : "AUTHZ-EXPIRED-012" };
}

export function evaluateResourceAccess(
  agentPrincipalId: string, agentOwnerId: string,
  resource: MockResource, grants: Grant[], nowIso: string,
): PolicyDecision {
  if (resource.ownerId !== agentOwnerId) {
    return {
      allowed: false, ruleId: "AUTHZ-OWNER-010",
      reason: `Agent owned by ${agentOwnerId} may never access ${resource.ownerId}'s resource.`,
      principalId: agentPrincipalId, grantId: null,
    };
  }
  const { grant, ruleId } = activeGrant(grants, agentPrincipalId, "resource:read", resource.id, nowIso);
  if (grant) {
    return {
      allowed: true, ruleId: "AUTHZ-GRANT-011",
      reason: `Active grant ${grant.id} authorizes resource:read on ${resource.id}.`,
      principalId: agentPrincipalId, grantId: grant.id,
    };
  }
  return {
    allowed: false, ruleId,
    reason: `No active resource:read grant for ${resource.id}.`,
    principalId: agentPrincipalId, grantId: null,
  };
}

export function evaluateEgress(
  agentPrincipalId: string, host: string, grants: Grant[], nowIso: string,
): PolicyDecision {
  const { grant, ruleId } = activeGrant(grants, agentPrincipalId, "network:egress", host, nowIso);
  if (grant) {
    return {
      allowed: true, ruleId: "NET-EGRESS-020",
      reason: `Active grant ${grant.id} authorizes egress to ${host}.`,
      principalId: agentPrincipalId, grantId: grant.id,
    };
  }
  // Keep the specific reason a grant stopped applying: a revoked or expired
  // egress grant is the operator's own action taking effect, and reads very
  // differently on the timeline from "this host was never allowed".
  return {
    allowed: false,
    ruleId,
    reason:
      ruleId === "AUTHZ-REVOKED-013"
        ? `Egress grant for ${host} was revoked.`
        : ruleId === "AUTHZ-EXPIRED-012"
          ? `Egress grant for ${host} has expired.`
          : `Default-deny egress: no active network:egress grant for ${host}.`,
    principalId: agentPrincipalId, grantId: null,
  };
}

import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { ActionRiskLevel, RunnerStepEvent, RunUsage } from "./types.js";

export type RunPolicyKind = "canary" | "budget" | "approval";

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

export function rejectPromptIfCanaryPresent(config: AppConfig, prompt: string): void {
  if (config.guardrailCanaryToken && prompt.includes(config.guardrailCanaryToken)) {
    throw new RunPolicyViolationError(
      "canary",
      400,
      "Prompt contains the configured canary token and was blocked before execution.",
    );
  }
}

export function rejectOutputIfCanaryPresent(config: AppConfig, output: string): void {
  if (config.guardrailCanaryToken && output.includes(config.guardrailCanaryToken)) {
    throw new RunPolicyViolationError(
      "canary",
      409,
      "Run output echoed the canary token outside the workspace boundary.",
    );
  }
}

export function rejectToolIfCanaryPresent(config: AppConfig, content: string): void {
  if (config.guardrailCanaryToken && content.includes(config.guardrailCanaryToken)) {
    throw new RunPolicyViolationError(
      "canary",
      409,
      "Tool call or shell execution attempted to exfiltrate the canary token.",
    );
  }
}

export function estimateRunCostUsd(
  usage: RunUsage | null,
  model?: string | null,
): number | null {
  if (!usage) return null;
  const input = usage.inputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  if (input === 0 && output === 0 && cached === 0) return null;

  // Blended estimates per 1M tokens based on standard tiers
  const isHighTier =
    model?.includes("opus") ||
    model?.includes("gpt-4o") && !model?.includes("mini") ||
    model?.includes("claude-3-5-sonnet");

  const inputRate = isHighTier ? 3.0 / 1_000_000 : 0.15 / 1_000_000;
  const cachedRate = isHighTier ? 0.75 / 1_000_000 : 0.0375 / 1_000_000;
  const outputRate = isHighTier ? 15.0 / 1_000_000 : 0.60 / 1_000_000;

  const cost = input * inputRate + cached * cachedRate + output * outputRate;
  return Number(cost.toFixed(6));
}

function totalTokens(usage: RunUsage | null): number | null {
  if (!usage) return null;
  return [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens].reduce<number>(
    (sum, value) => sum + (typeof value === "number" ? value : 0),
    0,
  );
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
    guardrailCanaryEnabled: config.guardrailCanaryToken.length > 0,
    runBudgetMaxInputTokens: config.runBudgetMaxInputTokens,
    runBudgetMaxOutputTokens: config.runBudgetMaxOutputTokens,
    runBudgetMaxTotalTokens: config.runBudgetMaxTotalTokens,
    runBudgetMaxDurationMs: config.runBudgetMaxDurationMs,
  };
}
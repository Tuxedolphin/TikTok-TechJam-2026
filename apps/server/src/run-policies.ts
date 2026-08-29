import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { RunUsage } from "./types.js";

export type RunPolicyKind = "canary" | "budget";

export class RunPolicyViolationError extends HttpError {
  constructor(
    public readonly kind: RunPolicyKind,
    statusCode: number,
    message: string,
  ) {
    super(statusCode, message);
  }
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
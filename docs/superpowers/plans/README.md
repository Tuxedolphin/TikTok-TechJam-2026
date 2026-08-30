# Agent Passport — plan index & merge order

Spec: [`../specs/2026-08-30-agent-passport-design.md`](../specs/2026-08-30-agent-passport-design.md)
Prior art & upgrades: [`../specs/2026-08-30-prior-art-and-upgrades.md`](../specs/2026-08-30-prior-art-and-upgrades.md) — read before executing WS-B (proxy upgrade) and WS-D (policy-outcome evals framing).
Narrative: **assume the agent is compromised** — the platform stays safe even when the model is hostile.

| Plan | Workstream | Depends on |
|------|-----------|------------|
| [ws-a-identity-delegation](2026-08-30-ws-a-identity-delegation.md) | Principals, grants, authz, revocation | — (merges FIRST) |
| [ws-b-egress-enforcement](2026-08-30-ws-b-egress-enforcement.md) | Default-deny egress, quarantine, `--network none` | A's `evaluateEgress` + types (stubs until then) |
| [ws-c-diff-review-hitl](2026-08-30-ws-c-diff-review-hitl.md) | Diff capture + ported codegraff diff UI in approval gate | none (only `ApprovalRequest.diff`) |
| [ws-d-trace-intelligence](2026-08-30-ws-d-trace-intelligence.md) | Eval capture/replay, anomaly breaker, cost attribution | shared v4 migration |
| [ws-e-governed-fleet](2026-08-30-ws-e-governed-fleet.md) | Turn-taking coordinator, countdown demo, grant re-checks | A's Grant semantics (stubs until then) |

## Merge rules (read before executing)

1. **WS-A Task 1 is the single source of truth for `types.ts` + the v3→v4 store migration.** It lands ALL shared types (including `EvalCase`, `FleetTopic`, `FleetTurn`, every new `RunEventType`). Merge WS-A Task 1 + Task 2 before anything else.
2. B, D, and E each contain their own "shared contract types / v4" task so they compile standalone. **Once WS-A Task 1 is merged, SKIP those duplicate tasks** and delete any locally-stubbed evaluators/checkers per each plan's WS-A merge checklist.
3. All policy decisions go through `AgentService.recordPolicyDecision(runId, agentId, decision)` (defined in WS-A Task 4) — B/D/E swap their local event-append code to it on merge.
4. One trace, one store: no new stores, no second timeline. `npm run check` green after every task.
5. Priority on slips: **A > B > C > D > E**. The fleet demo must never hold the core Passport story hostage.

## Known risk callouts (from plan self-reviews)

- WS-B: `--network none` for zero-grant agents blocks model-API calls from inside the container — the plan documents how baseline seeding preserves the default flow; verify early on Day 1.
- WS-C: diff source is workspace snapshot-vs-disk (codex `file_change` events carry paths only); deny = restore from snapshot. Vendored codegraff diff components are Apache-2.0, pinned at commit `72e9a00`.
- WS-D: model degrade uses a process-global override on the Gemini adapter — documented limitation, acceptable for POC.
- Provider mismatch (Ark vs Gemini) is still an open submission risk — decide framing before Day 3 (see proposal PDF §6).

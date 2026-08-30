# Prior art, novelty verdicts, and winning upgrades

Companion to the Agent Passport spec. Honest answer to "does this already exist?" per workstream, plus concrete borrowables that raise judge scores.

## Verdict table

| WS | Verdict | Closest existing | Our genuine delta |
|----|---------|------------------|-------------------|
| A identity/delegation | Solved-in-parts | Auth0 for GenAI (Token Vault, async authz), Arcade.dev, Okta XAA, MCP auth spec, OpenFGA, aeoess/agent-passport-system (Apache-2.0) | Per-action grant re-check with ZERO caching + **live mid-run revocation demo**. MCP spec's own analysts (Cerbos, Tigera) concede per-request authz, delegation semantics, audit are unspecified gaps — we build the acknowledged gap. |
| B egress | Solved-in-parts | anthropic-experimental/sandbox-runtime (srt, Apache-2.0), E2B/Modal allowlists, Codex CLI network-off | **Grant-driven dynamic allowlist** (policy derived live from identity middleware), denials as correlated trace events, quarantine escalation. srt degrades inside Docker (its own README), has 2 published bypasses, static config, no identity concept. |
| C diff HITL | Solved-in-parts, real seam | HumanLayer (Apache-2.0), gotoHuman, LangGraph interrupt(), Cursor review UX | Server-side middleware where reviewed artifact **is the real disk diff**, deny = verified filesystem revert, verdict in same trace as grants. HumanLayer reviews abstract call payloads; Cursor is IDE-locked; **OpenAI Codex ships with NO diff preview — documented user complaint** (quote it). |
| D-a capture-as-eval | Mostly solved as workflow | LangSmith add-to-dataset, Langfuse datasets-from-traces, Braintrust Loop | **Evals that assert POLICY OUTCOMES** — a replay that must get *blocked/denied*, not just complete. No vendor evals against governance decisions; their scorers grade output quality. This is our hero delta — spec already has `expectation: "completes" | "blocked" | "denied"`. |
| D-b anomaly breaker | **Gap** | LiteLLM budget fallbacks (static caps), Portkey (error-triggered) | Rate-anomaly detection (burn-rate vs own baseline) → degrade-then-kill ladder. No OSS middleware does this in-line. |
| E governed fleet | **Gap at the intersection** | AutoGen GroupChat (turn-taking, zero authz), A2A v1 (authn yes, authz "mechanism unspecified"), Cerbos (PDP, no conversation runtime) | Fresh grant evaluation per turn; revoked participant ejected next turn with the drop as a trace span. arXiv 2606.31498 documents this as exactly what A2A/MCP cannot express. |

**Bottom line:** nothing is novel in isolation — and that's fine; hackathons reward composition + enforcement, not research novelty. The composition IS the gap: no product or OSS project ships identity + egress + diff review + policy evals + fleet governance behind one middleware where **the trace is the shared substrate** (evals replay from it, breakers actuate on it, governance writes to it). That's the closing line of the pitch.

## Concrete upgrades to adopt (ranked by judge ROI ÷ effort)

1. **WS-B upgrade (biggest win): add a real network proxy, not just step-text interception.**
   Plan B's step-level guard pattern-matches command text — judges may call it bypassable. Upgrade: host-side Node proxy using [`proxy-chain`](https://github.com/apify/proxy-chain) (Apache-2.0, CONNECT handled); container launched on `docker network create --internal` net + `HTTP_PROXY/HTTPS_PROXY` env; **proxy auth = agent identity** (`http://agent-<id>:<token>@host.docker.internal:3128`); proxy consults grants API per request, 403 on deny + trace event + strike counter. Keep the step-level guard as the fast path/first line; the proxy makes "fails closed" true rather than cosmetic. Gotchas already mapped: model API host must be a standing grant (demo bonus: revoke it live and cut off the agent's brain); CONNECT gives hostname-only granularity (say so — srt has the same limit); zero grants → `--network none` (Codex CLI's own default, cite it).
2. **WS-D: brand the policy-outcome evals as the hero.** "Regression tests for your guardrails" — replay must get BLOCKED. Also adopt: Langfuse nouns (`DatasetItem.original_trace_id` pattern) for the eval schema; breaker state machine named CLOSED → DEGRADED → OPEN in the UI; EWMA tokens/min baseline, breach = 2× baseline.
3. **Cheap standards-compliance polish (hours, high credibility):** emit OTel GenAI attribute names in trace event detail (`gen_ai.usage.input_tokens`, `gen_ai.agent.id`, span kinds `invoke_agent`/`execute_tool`); WS-A grants carry RFC 8693 `act` (actor) claim naming + the **"delegation can only narrow"** invariant (one-line rule from agent-passport-system); WS-A decisions rendered as Zanzibar-style tuples (`agent:codex-1#can_read@resource:res-a`); WS-E turn lifecycle uses A2A v1 task-state names (SUBMITTED/WORKING/AUTH_REQUIRED/COMPLETED/FAILED) + the term **"zero standing privilege"** on stage.
4. **WS-C: adopt HumanLayer's approval vocabulary** (pending/approved/denied + denial-with-comment fed back to agent) and LangGraph's resume verbs — add **"edit before apply"** as a stretch (cheap wow). If the codegraff port fights back, fall back to [`react-diff-view`](https://github.com/otakustay/react-diff-view) or `jsdiff` `diffWords` + [`react-diff-viewer-continued`](https://github.com/Aeolun/react-diff-viewer-continued) — do not hand-roll diff rendering.
5. **README "Related work" section** citing Auth0 GenAI, srt (+ its bypasses), HumanLayer, LangSmith, A2A governance-gap paper — with one line each on why we differ. Judges reward field awareness; it also pre-empts every "doesn't X already do this?" question.

## Pre-loaded rebuttals

- *"Auth0/Okta sell this"* → token-issuance for SaaS access; can't revoke mid-run before TTL; MCP spec itself leaves per-request authz unspecified; ours is self-hosted, per-action, zero-caching, traced.
- *"Anthropic's sandbox-runtime does egress allowlists"* → local-process sandbox that weakens in Docker per its own docs, static config, no identity, no escalation, two published bypasses. We close the loop from denial back into governance.
- *"HumanLayer/Cursor do approvals/diffs"* → HumanLayer never shows what changed on disk and deny undoes nothing; Cursor is one IDE, one user. We review the real diff, enforce kernel-side, revert on deny — and Codex still ships without diff preview.
- *"LangSmith turns traces into datasets"* → curated by humans, re-run later, grades output quality. Ours snapshots in one call with a machine verdict — including asserting a run gets BLOCKED. Guardrail regression tests don't exist elsewhere.
- *"AutoGen does group chat / A2A does agent security"* → AutoGen decides who speaks next, never whether they're still allowed to; A2A authenticates the pipe and punts authorization (spec: "mechanism unspecified"). Cite arXiv 2606.31498.

Full source lists live in the research transcripts; key links inline above.

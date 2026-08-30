# Demo framing & pitch strategy

**Headline: "Revocation that bites + guardrails you can regression-test."**

Identity is NOT pitched as our feature — it is the substrate that makes every demo moment possible. A 403 on stage is dry; a grant yanked mid-run is drama. The trace is the shared substrate: evals replay from it, breakers actuate on it, governance writes to it.

## Why this framing (judge debate summary)

- Identity-as-headline risks pattern-matching to "another auth team" (many will show login + RBAC). Identity-as-substrate powers every revocation moment no other team can show — token-TTL systems cannot revoke before expiry; we re-check per action with zero caching.
- The single most novel feature we have is the **policy-outcome eval** (a replay that must get *BLOCKED*). Unshipped anywhere (LangSmith/Langfuse/Braintrust grade output quality, not governance outcomes). It feeds the 20% verification rubric row directly. Co-headline.
- Alternatives weighed and rejected as headline: pure observability (most commodity), pure safety (already merged — judges score new work), anomaly breaker alone (narrow), provider abstraction (no drama), memory governance (cold start, no reuse assets).
- Priority on slips stays **A > B > C > D > E**. E is the only cuttable piece (its drama duplicates A's revocation); cutting it buys polish time for B's real proxy — the piece judges will poke hardest.

## The 3-minute demo script

| # | Moment | What the audience sees | Rubric row hit |
|---|--------|------------------------|----------------|
| 0 | Baseline (20s) | User A creates an agent, grants "read res-a, 30 min". Normal run succeeds; trace shows principal + scope on every step. | End-to-end behavior |
| 1 | **Revocation moment 1 — resource** (30s) | Same agent tries User B's resource → denied server-side (`AUTHZ-OWNER-010` in trace). Then: revoke the grant mid-run → the very next tool call dies (`AUTHZ-REVOKED-013`). | Enforcement outside UI |
| 2 | **Revocation moment 2 — network** (30s) | Prompt-injected `curl attacker.com` fails closed at the proxy (403, `egress.blocked` in trace, strike counter). Kicker: revoke the model-API egress grant live — the agent's brain is cut off. | Failure/abuse case |
| 3 | **Diff gate** (30s) | Agent proposes a file change → operator reviews the actual word-level diff → approve applies; (mention: deny reverts from snapshot). | HITL + demo craft |
| 4 | **Eval moment** (40s) | Capture moment 2's blocked run as an eval: `expectation: "blocked"`. Deliberately weaken the guardrail → replay goes RED. Restore → GREEN. "Regression tests for your guardrails." | Verification (20%) |
| 5 | **Fleet finale** (30s, cut first if over time) | Three agents count 10→1 in one topic, each turn attributed to its own principal in one trace. Mid-countdown, revoke one agent's grant → ejected, timeout rule recovers the turn, countdown completes. | Coordination + recovery |

Close: *"Fragments of this exist across six tools. Nobody ships them as one middleware where the trace is the substrate. Assume the agent is compromised — our platform stays safe anyway."*

## Language to use on stage (field-credibility signals)

- "zero standing privilege" (per-turn re-check, no decision caching)
- "delegation can only narrow" (grant invariant)
- "fail closed" (egress), "degrade before kill" (breaker: CLOSED → DEGRADED → OPEN)
- "the MCP auth spec leaves per-request authorization unspecified — we built the acknowledged gap"
- OTel GenAI attribute names visible in the trace detail

## Pre-empt the objections

README gets a "Related work" section (Auth0 GenAI, Anthropic sandbox-runtime + its published bypasses, HumanLayer, LangSmith, A2A governance-gap paper) — one line each on the delta. Full rebuttals in [prior-art-and-upgrades](2026-08-30-prior-art-and-upgrades.md).

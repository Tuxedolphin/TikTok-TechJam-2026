# Challenge brief — Track 1: Agent Launchpad

Condensed from the official TikTok TechJam 2026 information document
(<https://bit.ly/TikTokTechJam2026Info>), Track 1, *Agent Launchpad: Design and
Build Lightweight Agent Middleware*. Captured 2026-08-31. The official document
governs; this is a working reference, not a substitute.

Starter kit: <https://github.com/RrankPyramid/CodeJam>

> **Do not plan against the `hackathon-v2-*.xml` drafts.** Those files sit in
> `docs/` on some working copies and are excluded by `.gitignore`, so they are
> not part of this repository. They are an earlier authoring draft — titled
> *"CodeJam Track #5 v2"*, addressed partly to organizers (one section is an
> organizer readiness checklist) — and they mandate choosing exactly one of
> three named tracks and using Ark. **Neither rule exists in the published
> brief.** Planning against them would narrow the submission for no reason.

## The ask

Build the missing middleware, not the platform. The starter kit already ships
the browser UI, Agent CRUD, Playground, control plane, persistent workspaces,
Codex CLI runtime, BytePlus ModelArk integration, local containers, and optional
ECS deployment. Middleware is *"intentionally absent"*.

Identity and authorization, trace and audit, layered architecture, threat
modeling and safety, and multi-agent coordination are **recommended examples,
not a checklist**. Teams may choose, combine, simplify, replace, or invent
capabilities. The FAQ is explicit: *"Do we have to select one recommended
example? No."*

Evaluation weighs *"the relevance, quality, and integration"* of whatever the
team designs. In scope: **a coherent middleware story with one or more related
capabilities**, a real integration path, minimal UI, tests, and demo evidence.

## Requirements

- Preserve the baseline: Agent CRUD, lifecycle, Playground chat, persistence,
  and model execution keep working.
- Implement real behavior in a backend, runtime, data, or infrastructure path.
  Static screens and hard-coded success messages do not qualify.
- Define the boundary: which component owns the decision, what crosses it, and
  what happens when it fails.
- Demonstrate normal behavior *and* an appropriate failure, denial, recovery,
  degraded, or abuse case.
- Add automated verification of the core middleware behavior, not just UI
  rendering.
- Keep secrets out of source, history, logs, traces, screenshots, browser
  storage, and demo output.
- Prefer the smallest useful infrastructure. Local execution is the default
  judging path; ECS is optional and does not affect the score.

## Deliverables

1. **Three-minute live demo** — one real Agent run, the middleware working in
   its normal case and in a failure, denial, recovery, degraded, or abuse case.
2. **One-page architecture diagram** — middleware, data flow, trust boundary,
   and the enforcement, instrumentation, or recovery point.
3. **Code repository** — setup instructions, the middleware problem and
   rationale, design summary, automated tests, demo steps, limitations, no
   secrets.

## Demo flow

1. Create or select an Agent from the frontend and show its lifecycle state.
2. Invoke it through the Playground with a real task.
3. Show at least one real model, file, tool, sandbox, data, or infra action.
4. Demonstrate the middleware behavior and the evidence it produces.
5. Demonstrate an appropriate failure, denial, degraded, abuse, or recovery case.
6. Show the platform remains understandable and controllable afterward.

## Acceptance checklist

- [ ] A reviewer can clone, start the platform, and create or test an Agent from
      the frontend.
- [ ] The submission identifies and demonstrates one or more meaningful
      middleware capabilities selected, adapted, combined, or designed by the team.
- [ ] The middleware executes in a backend, runtime, data, or infrastructure
      path rather than only in the UI.
- [ ] Repository and documentation are sufficient to understand and reproduce.
- [ ] `npm run check` passes.
- [ ] No secret appears in source, Git history, logs, traces, screenshots,
      browser storage, or demo output.

Optional evidence, any of which strengthens a submission:

- [ ] A delegated permission is scoped or revocable, enforced outside the UI,
      and demonstrated.
- [ ] An end-to-end run produces a correlated trace with model, tool, sandbox,
      policy, or infrastructure events.
- [ ] A defined threat is blocked or contained, the protected asset is
      unchanged, and cleanup or recovery is shown.
- [ ] A team-defined lifecycle, reliability, memory, budget, provider, or
      coordination capability works as described.

## Evaluation

| Category | Weight | What reviewers look for |
| --- | ---: | --- |
| End-to-end middleware behavior | 40% | A real frontend-to-backend, runtime, data, or infrastructure path with convincing functional evidence. |
| Technical design and integration | 25% | Clear rationale, coherent architecture, appropriate boundary, focused changes, extensible contracts. |
| Verification and robustness | 20% | Automated tests, error handling, cleanup or recovery, redaction, protection against obvious bypasses. |
| Demo and reproducibility | 15% | Concise live demo, useful README, one-command startup, documented limitations, no hidden manual setup. |

## Model provider

The starter kit connects Codex to a BytePlus ModelArk Responses-compatible
endpoint, and the brief's quickstart is:

```bash
ARK_API_KEY=your-ark-api-key ARK_MODEL=ep-your-endpoint-id npm run poc
```

`ARK_API_KEY` must be an Ark **model API key**, not an account AK/SK;
`ARK_MODEL` is normally an endpoint ID beginning with `ep-`. The brief notes a
wrong credential produces a 401 from the Ark Responses API.

Nothing in the requirements mandates Ark, and *"provider abstraction"* is listed
among the team-designed middleware directions — so this project's multi-provider
support (Ark, Gemini, OpenRouter) is within scope. **Keep the Ark path working
regardless**: reviewers are told to start the platform with an Ark key, and the
acceptance checklist depends on that succeeding. See
[Configuration](../README.md#configuration).

## Out of scope

Rebuilding the React app, CRUD API, Playground, Codex integration, or container
launcher. Training or fine-tuning a foundation model. Production OAuth, a
general-purpose policy engine, a microVM runtime, a container scheduler, or
multi-region infrastructure unless central to the team's idea. Cosmetic work
that does not prove agent infrastructure behavior.

## Key dates

| Date | Milestone |
| --- | --- |
| 29 Aug 12pm – 1 Sep 12pm | 72-hour challenge window |
| **1 Sep, 12pm** | **Submission deadline on Devpost** |
| 8 Sep | Finalists announced |
| 11 Sep | Grand final at TikTok Singapore |
| 15 Sep | Winners announced |

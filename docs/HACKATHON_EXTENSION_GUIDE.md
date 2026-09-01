# Three-day hackathon guide

Teams receive a working Agent platform and add the middleware it deliberately
lacks. Rebuilding the UI, control plane, local Runtime, or ECS setup is out of
scope.

Requirements, deliverables, and the rubric live in
[CHALLENGE-BRIEF.md](CHALLENGE-BRIEF.md). This guide is the practical companion.

## Provided baseline

- Browser Agent CRUD and Playground
- Persistent workspaces and Codex sessions
- One-line Docker, Colima, or Podman local Runtime
- BytePlus ModelArk model connection (this project also supports Gemini and
  OpenRouter — see [Configuration](../README.md#configuration))
- Optional Volcengine ECS deployment

Local execution is the default judging path. Cloud deployment is optional and
does not affect the score.

## Pick a middleware story, not a track

The brief lists recommended directions rather than a menu to choose from
exactly one of. Teams may choose, combine, simplify, replace, or invent. What is
judged is the relevance, quality, and integration of whatever the team builds —
so depth and coherence beat breadth.

The directions below are the brief's examples, restated as what a convincing
demo of each would need.

### Identity and authorization

Separate the human principal from the Agent acting for that human.

- Two mock human users and an Agent principal owned by one of them.
- The Agent reads its owner's mock resource; the backend denies the other's.
- Scoped, time-bound, revocable delegation rather than a shared credential.
- A record naming the human, Agent, action, resource, and decision.

A login screen without server-side authorization does not qualify.

### Trace, audit, and observability

Represent a run as a connected sequence rather than unrelated logs.

- Stable Agent, run, session, trace, and span identifiers.
- Span categories: orchestration, model call, tool call, policy decision,
  human approval, sandbox execution.
- Status, duration, errors, and available token or cost signals.
- Secrets redacted before storage and display.
- A reviewer can locate the failing step of a failed run.

### Threat modeling and safety

Name the protected asset and the abuse case, then contain it.

- A control that is specific to the threat, not the starter kit's defaults.
- A malicious run blocked or terminated, with cleanup visible.
- The protected asset provably unchanged.
- A safe run still succeeds afterward.

The starter kit's CPU, memory, PID, dropped-capability, and no-new-privileges
defaults are baseline safeguards and do not by themselves count as a new
capability.

### Other directions

Layered architecture, multi-agent coordination, lifecycle reconciliation,
memory governance, human-in-the-loop workflows, budget control, provider
abstraction, versioning and rollback, or automated remediation. A team-defined
capability still has to explain its problem, boundary, evidence, failure case,
and limitations.

## Three-day plan

| Day | Goal | Exit evidence |
| --- | --- | --- |
| 1 | Start the baseline, define the problem, specify the contract, complete the first backend path. | One real middleware behavior triggerable from an API or test. |
| 2 | Finish the core path, persist its evidence, add minimum UI, implement the success and failure cases. | The scenario works end to end from the browser. |
| 3 | Add tests, handle errors and cleanup, finish the diagram and README, rehearse. | `npm run check` passes and the demo fits three minutes. |

## Before submitting

Run the full gate:

```bash
npm run check
```

Then walk the acceptance checklist in
[CHALLENGE-BRIEF.md](CHALLENGE-BRIEF.md#acceptance-checklist). The two items
teams most often miss are automated verification of the *middleware decision*
rather than the UI, and documented limitations.

## What this project built

See [AGENT-PASSPORT.md](AGENT-PASSPORT.md) for the capabilities, how each was
verified, and what is explicitly not solved.

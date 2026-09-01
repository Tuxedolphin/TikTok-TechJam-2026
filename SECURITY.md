# Security policy

Volc Agent Launchpad is a hackathon proof of concept. Only the latest revision
on the default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Known limitations

Some of these were true of the starter kit and are no longer true here; the
list below describes *this* branch. What is enforced, and how it was verified,
is in [docs/AGENT-PASSPORT.md](docs/AGENT-PASSPORT.md).

- **Mock principal population.** Operator sessions are server-issued opaque
  tokens rather than client-asserted ids, and the agent principal is
  HMAC-verified on the egress path. But `user-a` and `user-b` are fixtures with
  no authentication behind them: anyone who can reach the control plane can
  open a session as either. This is an identity-provider gap, not an
  enforcement gap.
- **No CSRF protection.**
- **Egress enforcement requires the container runtime.** With
  `RUNTIME_PROVIDER=local-process` — the default for development, and what
  Docker Compose inherits — Codex runs as a host process with ordinary network
  access and no proxy in front of it. Containment is a property of the
  container topology, so it is only real under `RUNTIME_PROVIDER=container`.
- **No per-Agent container boundary in ECS mode.**
- **Ordinary containers, not hardened multi-tenant sandboxes.**
- **Prompt-triggered command and file execution**, contained by the workspace
  mount and the egress proxy rather than prevented.
- **Shell-risk classification is post-execution telemetry.** Codex reports
  commands as `item.completed`; the `SEC-*` rules label them for the audit
  trail and must not be read as having prevented the action.
- **Provider key is available to the server and the active Runtime container.**
  It is passed by name rather than value so it never reaches the container
  engine's argv, but the runtime can still read it.
- **Provider key is stored in Terraform POC state** when the optional ECS path
  is used.

## Safe use

- Use a dedicated development machine or disposable ECS instance.
- Use a scoped, revocable model-provider key and a unique `APP_AUTH_TOKEN`.
- Keep local use on loopback and restrict ECS Web and SSH CIDRs.
- Add HTTPS before sending the shared token over an untrusted network.
- Never mount production data or provide Volcengine account AK/SK to Agents.
- Stop the POC, destroy test resources, and revoke keys after the event.

Codex uses `workspace-write` when Landlock is available. On unsupported kernels,
startup warns and relies on the outer Docker or rootless Podman boundary. This
fallback is not tenant isolation.

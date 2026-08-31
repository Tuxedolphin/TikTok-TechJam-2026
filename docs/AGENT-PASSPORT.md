# Agent Passport

**Assume the agent is compromised.** Prompt injection is unsolved, so this middleware does not try to make the model trustworthy. It makes the platform safe *while* the model is hostile.

Every capability answers one question: what can a hijacked agent actually do?

| A hijacked agent tries to… | What stops it | Where |
|---|---|---|
| Act beyond its mandate | No action without a scoped, expiring grant | `identity.ts`, `run-policies.ts` |
| Read another user's data | Ownership denial in the backend, before any grant is consulted | `evaluateResourceAccess` |
| Exfiltrate over the network | No route off-box; the proxy authorizes every connection | `egress-network.ts`, `egress-proxy.ts` |
| Keep probing for a way out | Quarantine after repeated denials | `egress-authorizer.ts` |
| Hide what it did | Every decision is a trace event | `recordPolicyDecision`, `recordEgressBlocked` |

## What "enforced" means here

The distinction that matters is between *detecting* a bad action and *preventing* it.

The starter kit already flagged risky-looking commands by pattern-matching step text. That fires **after** the command has run — useful as a signal, useless as containment. Agent Passport does not rely on it.

Under `EGRESS_ENFORCEMENT=on`, an agent container is attached to a Docker network created with `--internal`. That network has no route off-box. The container cannot reach the internet, and cannot reach the host, no matter what it runs. Its only path outward is a proxy sidecar that sits on both the internal network and an uplink network:

```
┌─ launchpad-egress-internal (--internal, no route off-box) ──────┐
│                                                                  │
│   agent container                    egress proxy ───────────────┼──▶ internet
│   http_proxy=…@launchpad-egress-proxy    (dual-attached)          │
│   no route out ✗                     authorizes every connection  │
└──────────────────────────────────────────────────────────────────┘
```

The proxy asks the control plane about **every** request and CONNECT before a byte leaves. It reads grants fresh each time — there is no cached decision and no token TTL to wait out — so revocation is felt on the agent's next connection. If the authorizer cannot be reached, the proxy denies. Agent identity travels as proxy-auth credentials, so one proxy serves every agent without trusting anything the container says about itself.

This topology was chosen after testing, not assumed. A host-side proxy does **not** work: an `--internal` network severs host reachability along with internet reachability, so a container on it cannot reach a proxy listening on the host at all. Measured on Docker/OrbStack, a container attached only to `launchpad-egress-internal` can resolve and reach a sidecar by container name, and can reach neither the host gateway nor any public address. Dual-attaching the sidecar to a second, non-internal network is what gives it a path out while the agent keeps none.

## Reproducing the evidence

```bash
npm run build --workspace apps/server
node scripts/demo-passport.mjs   # identity: ownership denial, grants, revocation
node scripts/demo-egress.mjs     # containment: real containers, real blocked exfiltration
```

`demo-egress.mjs` needs a running container engine. It walks the full kill chain and prints the trace receipts:

1. Agent reaches for `example.com` with no grant → **403**, blocked at the proxy
2. Operator issues a `network:egress` grant → **200**, allowed through
3. Operator revokes it mid-flight → **403**, `AUTHZ-REVOKED-013` on the timeline
4. Agent keeps probing → **quarantined**, status flips to `stopped`
5. Agent tries to skip the proxy entirely → **no route**, the network itself refuses

## Rule IDs

Decisions are named so a trace reads as an explanation rather than a boolean.

| Rule | Meaning |
|---|---|
| `AUTHZ-OWNER-010` | Cross-user access. Denied before grants are considered — a grant can never authorize it. |
| `AUTHZ-GRANT-011` | Allowed by an active grant, or denied for want of one. |
| `AUTHZ-EXPIRED-012` | A grant existed and timed out. |
| `AUTHZ-REVOKED-013` | A grant existed and the operator revoked it. |
| `NET-EGRESS-020` | Default-deny egress: no active `network:egress` grant for this host. |
| `NET-EGRESS-PLATFORM-021` | A platform endpoint (model API, adapter callback) the runtime needs to function. Explicit and auditable rather than an implicit hole. |
| `NET-EGRESS-NOAUTH-022` | The caller presented no principal. |
| `NET-EGRESS-IMPERSONATION-023` | A caller named a principal but could not prove it. The proxy password is HMAC-derived from a server secret the container never sees, so claiming another agent's identity fails here rather than succeeding silently. |
| `NET-EGRESS-PRIVATE-024` | A grant existed, but the host resolved into private or link-local space. Grants name hosts; without this, a granted name pointed at `169.254.169.254` would reach cloud metadata. |
| `HITL-EGRESS-025` | The approval request itself: one ungranted outbound request, held before connect while the operator decides. |
| `HITL-EGRESS-APPROVED-025` | The operator released that single held request. Request-scoped — the next one asks again. |
| `HITL-EGRESS-DENIED-026` | The operator refused it. The destination never received a connection. |
| `HITL-EGRESS-FLOOD-027` | Too many requests held at once. An agent cannot exhaust the operator's attention into becoming a rubber stamp. |

Post-execution telemetry, reported by Codex after a command ran and never
presented as prevention: `SEC-DESTRUCTIVE-001`, `SEC-CREDENTIALS-002`,
`SEC-EGRESS-003`, `SEC-SUPPLY-004`, `SEC-PRIVILEGE-005`, and
`ALLOW-STANDARD-000` for low-risk steps.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `EGRESS_ENFORCEMENT` | `on` | Puts agent containers on the isolated network behind the proxy. Set to `off` to restore plain bridge networking and the baseline behaviour. |
| `EGRESS_PROXY_PORT` | `8888` | Port the proxy sidecar listens on. |
| `EGRESS_PROXY_IMAGE` | `node:22-alpine` | Image for the sidecar; it runs the compiled proxy from the server's `dist`. |
| `EGRESS_QUARANTINE_THRESHOLD` | `3` | Blocked attempts before the agent is stopped. |

Enforcement applies to the container runtime. `RUNTIME_PROVIDER=local-process` runs Codex as a host process and is not isolated — use it for development only.

## Honest limitations

- **The principal set is a mock, even though the session is not.** Operator identity is an opaque server-issued token from `POST /api/mock-principal-session`, held server-side with an 8h TTL and presented as `x-mock-principal-session`; a client cannot name a principal it was not issued. On the egress path the agent principal is HMAC-verified rather than trusted (`NET-EGRESS-IMPERSONATION-023`). What remains a mock is the *population*: `user-a` and `user-b` are fixtures with no authentication behind them, so anyone who can reach the control plane can open a session as either. Real deployment needs an identity provider; the enforcement path above it would not change.
- **HTTPS is authorized by hostname, not URL.** CONNECT only exposes the host, so per-path rules are impossible without terminating TLS. Anthropic's own sandbox-runtime documents the same limit.
- **Non-HTTP TCP is refused outright.** `git+ssh` and raw sockets do not traverse an HTTP proxy. Under default-deny that is the correct outcome, not a bug — but it does constrain what agents can do.
- **The topology is verified on Docker/OrbStack only.** Rootless Podman is documented as unable to route an internal network to the host; re-run the measurements before trusting another engine.
- **Quarantine is per-process.** Strike counts live in memory and reset when the server restarts.
- **The resources the authz layer guards are mock fixtures.** `res-a` / `res-b` demonstrate ownership isolation; wiring grants to real workspace files is the natural next step and is not done.

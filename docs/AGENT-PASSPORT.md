# Agent Passport

**Assume the agent is compromised.** Prompt injection is unsolved, so this middleware does not try to make the model trustworthy. It makes the platform safe *while* the model is hostile.

Every capability answers one question: what can a hijacked agent actually do?

| A hijacked agent tries to… | What stops it | Where |
|---|---|---|
| Act beyond its mandate | Authority can only be delegated within the same capability family, target, and lifetime | `authority.ts`, `identity.ts` |
| Read another user's data | Ownership denial in the backend, before any grant is consulted | `evaluateResourceAccess` |
| Exfiltrate over the network | No route off-box; the proxy authorizes every connection | `egress-network.ts`, `egress-proxy.ts` |
| Keep probing for a way out | Quarantine after repeated denials | `egress-authorizer.ts` |
| Hide what it did | Every decision is a trace event | `recordPolicyDecision`, `recordEgressBlocked` |
| Continue after termination | Freeze, authority barrier, revoke, kill, and state verification | `terminator.ts`, `termination.ts` |

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

The proxy asks the control plane about **every** request and CONNECT before a byte leaves. It reads grants fresh each time — there is no cached decision and no token TTL to wait out — so revocation is felt on the agent's next connection. If the authorizer cannot be reached, the proxy denies. Agent identity travels with a per-process secret generated independently of `APP_AUTH_TOKEN`; the secret is available to the proxy sidecar but not to agent containers. It reaches the sidecar by environment name rather than as a `docker run` argument, because `/proc/<pid>/cmdline` is world-readable — and that one secret derives every agent's proxy password, so a local reader could otherwise impersonate any agent and spend its grants. The proxy strips caller-supplied attestation headers and stamps the authenticated principal on forwarded control-plane requests. Opaque CONNECT tunnels to the control plane are refused because they cannot carry that attestation.

This topology was chosen after testing, not assumed: a host-side proxy does **not** work, because an `--internal` network severs host reachability along with internet reachability.

## Reproducing the evidence

```bash
npm run proofs             # all five, needs a container engine
npm run proofs:no-engine   # identity and attenuation only
```

Or one at a time:

```bash
npm run build --workspace apps/server
node scripts/demo-passport.mjs   # identity: ownership denial, grants, revocation
node scripts/demo-egress.mjs     # containment: real containers, real blocked exfiltration
node scripts/demo-escalation.mjs # confused-deputy refusal, and attenuated delegation allowed
node scripts/demo-tunnel-bypass.mjs # opaque control-plane tunnel refusal
node scripts/demo-kill.mjs       # freeze/revoke/kill/verify receipt
```

Each script **asserts** its invariants and exits non-zero when one breaks, so a
regression fails rather than scrolling past in the output. They are not
illustrations of a claim; they are the check on it. Every push runs all five —
the container ones against real Docker containers on the CI runner — so the
badge above tracks whether containment actually holds, not just whether the
code compiles.

`demo-egress.mjs` needs a running container engine. It walks the full kill chain and prints the trace receipts:

1. Agent reaches for `example.com` with no grant → **403**, blocked at the proxy
2. Operator issues a `network:egress` grant → **200**, allowed through
3. Operator revokes it mid-flight → **403**, `AUTHZ-REVOKED-013` on the timeline
4. Agent keeps probing → **quarantined**, status flips to `stopped`
5. Agent tries to skip the proxy entirely → **no route**, the network itself refuses

Termination first prevents queued execution from starting or pauses a live runtime. It then atomically blocks new authority and revokes existing grants, tears down the runtime, and verifies the persisted agent state, live grant set, runtime state, and—when enabled—the egress boundary. Restarting the agent is the explicit operator action that clears the authority barrier.

Receipts use a persisted Ed25519 signing key. Fetch `GET /api/receipt-key` before termination, then verify a receipt with:

```bash
node scripts/verify-receipt.mjs receipt.json --public-key .data/receipt-signing-public.pem
```

The public key verifies origin and integrity without granting signing capability. The receipt attests to observations made by the control plane; offline verification cannot independently observe the terminated runtime.

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
| `NET-EGRESS-IMPERSONATION-023` | Proxy credentials do not authenticate the claimed agent principal. |
| `NET-EGRESS-PRIVATE-024` | The destination resolved to a private, loopback, or link-local address. |
| `NET-EGRESS-TUNNEL-025` | An opaque CONNECT tunnel attempted to reach the control plane. |
| `AUTHORITY-HUMAN-030` | A known human principal originated authority. |
| `AUTHORITY-SELF-ESCALATION-031` | An agent attempted to grant itself authority it did not hold. |
| `AUTHORITY-NARROWING-032` | Agent delegation was allowed or denied by capability, target, and lifetime attenuation. |

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `EGRESS_ENFORCEMENT` | `on` | Puts agent containers on the isolated network behind the proxy. Off restores bridge networking. |
| `EGRESS_PROXY_PORT` | `8888` | Port the proxy sidecar listens on. |
| `EGRESS_PROXY_IMAGE` | `node:22-alpine` | Image for the sidecar; it runs the compiled proxy from the server's `dist`. |
| `EGRESS_QUARANTINE_THRESHOLD` | `3` | Blocked attempts before the agent is stopped. |

Enforcement applies to the container runtime. `RUNTIME_PROVIDER=local-process` runs Codex as a host process and is not isolated — use it for development only.

## Honest limitations

- **Human identity is still a mock.** Agent identity is bound to the proxy topology and an internal secret, but `x-principal-id` for operators is trusted verbatim. A production deployment needs authenticated operator identities and RBAC.
- **Receipts attest; they do not recreate the observation.** Ed25519 lets a third party verify who signed the recorded steps and that they were not edited. The verifier still relies on the control plane to have observed runtime and grant state honestly.
- **HTTPS is authorized by hostname, not URL.** CONNECT only exposes the host, so per-path rules are impossible without terminating TLS. Anthropic's own sandbox-runtime documents the same limit.
- **Non-HTTP TCP is refused outright.** `git+ssh` and raw sockets do not traverse an HTTP proxy. Under default-deny that is the correct outcome, not a bug — but it does constrain what agents can do.
- **The topology is verified on Docker/OrbStack only.** Rootless Podman is documented as unable to route an internal network to the host; re-run the measurements before trusting another engine.
- **Quarantine is per-process.** Strike counts live in memory and reset when the server restarts.
- **The resources the authz layer guards are mock fixtures.** `res-a` / `res-b` demonstrate ownership isolation; wiring grants to real workspace files is the natural next step and is not done.

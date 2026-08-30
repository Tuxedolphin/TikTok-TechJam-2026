# Verified egress architecture (empirical, 2026-08-30)

Settles review finding **C8**. Tested on the demo machine: Docker 29.4.0 via **OrbStack** (macOS). Re-run these on any other engine before trusting them there — Podman rootless in particular is documented broken for the host-proxy pattern.

## What was tested

| Setup | Result |
|-------|--------|
| Container on `--internal` network → `host.docker.internal:PORT` (with `--add-host=host-gateway`) | **FAILS (000)** |
| Container on `--internal` network → explicit network gateway IP | **FAILS (000)** |
| Control: container on default bridge → `host.docker.internal:PORT` | Works (200) |
| Control: container on default bridge → public internet | Works (200) |
| Container on `--internal` → sidecar container **by name**, same internal network | **Works (200)** |
| Sidecar dual-attached (internal + bridge) → public internet | **Works** |
| Container on `--internal` → public internet directly | **FAILS (000)** |

## Conclusion: use a sidecar proxy, not a host proxy

The prior-art upgrade note proposed `HTTP_PROXY` pointing at a **host** proxy while the agent container sits on an `--internal` network. **That does not work here** — `--internal` severs host reachability along with internet reachability, and the explicit-gateway workaround fails too.

The working architecture:

```
┌─ ap-internal (--internal, no external route) ─────────────┐
│                                                            │
│   agent container            proxy sidecar ────────────────┼──→ internet
│   (codex CLI)                (dual-attached)               │    via ap-bridge
│   HTTP_PROXY=http://ap-proxy:8080                          │
│   no direct route out ✗                                    │
└────────────────────────────────────────────────────────────┘
```

- Agent container: `--network ap-internal` only. It has **no route to the internet at all** — verified, not asserted. This is what makes "fail closed" true rather than cosmetic.
- Proxy sidecar: created on `ap-internal`, then `docker network connect ap-bridge ap-proxy` for egress. Reachable from the agent by container name via Docker's embedded DNS.
- Agent env: `HTTP_PROXY`/`HTTPS_PROXY` = `http://ap-proxy:8080`, `NO_PROXY=localhost,127.0.0.1`.
- The proxy authorizes each request against the grants store (`evaluateEgress`), 403s on deny, emits `egress.blocked` + `policy.decision`, and counts strikes toward quarantine.

## Consequences for the WS-B plan

1. **Replaces C1's `--network none` problem.** Zero-grant agents still get `--network none`; agents with grants get the internal network plus the sidecar, so the model API keeps working *through the proxy* — which also means the model-API host must be a standing grant. Revoking it live cuts the agent's brain off, and that is now a real demo moment rather than an accident.
2. **Replaces C2's honesty problem.** With no route out of the internal network, a blocked host is genuinely unreachable — the step-text guard becomes a fast-path signal for the trace, not the enforcement mechanism. The plan can claim "fail closed" truthfully.
3. **`proxy-chain` (Apache-2.0) runs in the sidecar**, not the host. Its `prepareRequestFunction({request, username, password, hostname, port, isHttp, connectionId})` gives per-request authorization; agent identity travels as proxy-auth credentials, so one sidecar can serve many agents.
4. **Cost:** one extra container per platform run (not per turn — the sidecar is long-lived) and a `docker network connect` at startup.

## Still open

- **C7 (WS-D):** how many `turn.completed` events a real `codex exec --json` run emits. If exactly one, the mid-run model degrade cannot work as pitched. Untested — needs a real Ark/Gemini key and a multi-tool prompt.
- HTTPS via CONNECT gives hostname granularity only, no URL paths. Same limitation Anthropic's sandbox-runtime documents; state it rather than implying URL-level filtering.
- Non-HTTP TCP (git+ssh, raw sockets) will not traverse an HTTP proxy — under default-deny that is the correct outcome, not a bug.

# Agent Passport

[![CI](https://github.com/Tuxedolphin/TikTok-TechJam-2026/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Tuxedolphin/TikTok-TechJam-2026/actions/workflows/ci.yml)

**Your coding agent just tried to send your credentials to an unknown server. Watch it fail.**

AI coding agents read untrusted content and then run commands. Prompt injection
is unsolved, so the honest assumption is that an Agent can become hostile.
Agent Passport does not make the model trustworthy; its enforced container
profile constrains what that model can reach over the network.

In the local POC, with `RUNTIME_PROVIDER=container` and egress enforcement on,
the Agent container has no direct route off-box. Its outbound HTTP connections
must use a proxy that checks live host grants. Required platform hosts have a
standing allowance; development and ECS `local-process` profiles do not use
this network boundary.

```text
1. No grant, new request to example.com             -> 403 blocked
2. Add network:egress grant, make a new request     -> 200 allowed
3. Revoke grant, make the next request              -> 403 blocked
4. Continue denied probes                           -> quarantined / stopped
5. Skip the proxy from the internal network         -> no route
```

`npm run demo` exercises real containers and the real proxy topology. It prints
observations rather than asserting them, so compare each result above; it does
not terminate an already established connection after revocation.

## What this adds to the starter kit

The Agent Launchpad starter kit already provided agent CRUD, the Playground, the Codex container runtime, human-in-the-loop approvals, a canary tripwire, budget breakers, and the trace timeline. **This project adds the parts that were missing:**

- **Agent identity.** A human principal and an agent principal are different things. Every agent is owned by a user and acts as its own principal.
- **Scoped, expiring, revocable grants.** An agent may read *this* resource, or reach *this* host, for *this* long. Decisions are re-checked on every single access — nothing is cached, so revocation is felt on the very next call rather than at token expiry.
- **Enforced network containment.** Not pattern-matching on command text after the fact: the agent container has no route off-box, and a proxy authorizes every connection. A blocked host is unreachable, not merely disapproved.
- **Containment escalation.** Repeated blocked attempts — the signature of a hijacked agent hunting for an exfil route — quarantine the agent automatically.
- **A receipt for everything.** Every allow and every deny lands on the run timeline with a rule ID explaining itself.
- **Verifiable termination.** Termination freezes or blocks execution, atomically closes the authority channel, revokes grants, tears down the runtime, verifies state, and signs the evidence with Ed25519.

Full detail, including what is *not* solved: **[docs/AGENT-PASSPORT.md](docs/AGENT-PASSPORT.md)**.

## Try the containment demo first

```bash
npm install
npm run demo
```

Needs a container engine (Docker/OrbStack, Colima, or Podman). No API key required — it stages the attack against a real proxy on a real isolated network.

For the full platform with a live agent, add a key and run `npm run poc`; egress enforcement is **on by default**, and the Passport panel in the UI shows grants, live expiry countdowns, and one-click revocation.

## Screenshots

### Agent Playground & Human-in-the-Loop Gate

![Agent Playground showing lifecycle controls, starter prompts, and the Codex Runtime](docs/assets/playground.jpg)

### Create an Agent

![Create Agent form with name, description, and workspace instructions](docs/assets/create-agent.jpg)

## Inherited vs. added

Being precise about provenance: the approval UI, canary tripwire, budget breakers, and trace timeline came with the starter kit. This project adds identity, grants, authorization evaluators, and a network approval gate enforced before an outbound connection is opened.

## Requirements

- Node.js 22+
- npm 10+
- Docker, Colima, or Podman
- A model API key — any one of:
  - **BytePlus ModelArk** (`ARK_API_KEY` plus an `ep-` endpoint ID) — the starter kit's own provider, and the path to use if you were issued an Ark key
  - **Google Gemini** (from Google AI Studio), reached through the internal Responses adapter
  - Any **OpenAI-compatible** endpoint, such as OpenRouter

Codex CLI is included in the Runtime image and is not required on the host.

### On Windows

`npm run poc` is a bash script and needs **WSL2** — which Docker Desktop for
Windows already requires, so the environment is usually there. Inside a WSL2
shell everything below works unchanged.

Natively on Windows, use the [Docker Compose](#docker-compose) path with
`npm run bootstrap`. That gives you the full platform, but note it runs
`RUNTIME_PROVIDER=local-process`, and egress enforcement exists only under the
container runtime — so the containment demo needs WSL2.

## Local browser SOP

### 1. Check the local tools

Install Node.js 22+ and one supported container engine, then verify them:

```bash
node --version
npm --version
docker --version        # Docker Desktop, Docker Engine, or Colima
podman --version        # Use this instead when running Podman
```

Only one container engine is required. Codex CLI is already included in the
Runtime image.

### 2. Clone the repository

```bash
git clone <repository-url> volc-agent-launchpad
cd volc-agent-launchpad
```

Skip this step when already working from the repository root.

### 3. Start the POC

Configure your API key in `.env` (copied from `.env.example`):

```bash
# Option A: With Gemini in .env (Recommended)
HOST=127.0.0.1 npm run poc

# Option B: Pass via CLI environment variable
HOST=127.0.0.1 GEMINI_API_KEY=your-gemini-api-key npm run poc

# Option C: BytePlus ModelArk, the starter kit's own provider
HOST=127.0.0.1 ARK_API_KEY=your-ark-api-key ARK_MODEL=ep-your-endpoint-id npm run poc
```

`ARK_API_KEY` must be an Ark *model* API key rather than an account AK/SK, and
`ARK_MODEL` is the endpoint ID beginning with `ep-`; the wrong credential
returns 401 from the Ark Responses API. Set `MODEL_PROVIDER` explicitly when
`.env` holds credentials for more than one provider.

The first run installs Node.js dependencies and builds the Runtime image. The
script automatically selects Docker, Colima, or Podman.

### 4. Open the browser

Visit <http://localhost:3000>, or open it from the terminal:

```bash
open http://localhost:3000       # macOS
xdg-open http://localhost:3000   # Linux desktop
```

In the Web UI:

1. Select **Create Agent**.
2. Enter a name, description, and workspace instructions.
3. Select **Create Agent** again.
4. Enter a task in the Playground, for example:

   ```text
   Create a TypeScript hello-world CLI, add a test, and run it.
   ```

The Agent can write files, run commands, and continue the same Codex session in
later messages.

### 5. Stop and resume

Press `Ctrl+C` in the startup terminal. The script removes temporary Runtime
containers but keeps Agent workspaces and conversations.

- macOS state: `~/.volc-agent-launchpad/`
- Linux state: `.local/`
- Custom location: set `LOCAL_POC_DATA_ROOT`

Run the same `npm run poc` command to continue later.

### Select a specific container engine

Force Podman when multiple engines are installed:

```bash
HOST=127.0.0.1 CONTAINER_ENGINE=podman GEMINI_API_KEY=your-gemini-api-key npm run poc
```

Colima uses `CONTAINER_ENGINE=docker` because it exposes the Docker CLI.

For a clean Linux host, follow the
[rootless Podman setup](docs/LOCAL_POC.md#rootless-podman-on-linux).

## Docker Compose

Create and edit the configuration:

```bash
npm run bootstrap
```

Compose runs the server with `NODE_ENV=production` and `HOST=0.0.0.0`, so it
refuses to start without a real `APP_AUTH_TOKEN`. This command creates `.env`
from the example, generates that token, and makes the state directories. It is
idempotent and runs on every platform, Windows included.

Compose runs the server in production mode, where the process binds `0.0.0.0`
inside its container. Only the published port decides who can reach it, so
Compose publishes on `127.0.0.1` by default and the bootstrap command creates a
URL-safe `APP_AUTH_TOKEN` when `.env` does not already contain a valid one. To
serve the demo to another machine, set `PUBLIC_BIND=0.0.0.0`; that token is then
the only thing standing between the internet and your Agents. To rotate it later, replace that value in `.env` with the output of:

```bash
node -e 'console.log(require("node:crypto").randomBytes(24).toString("base64url"))'
```

Required provider values in `.env`:

```dotenv
# Option A: Google Gemini API (Recommended)
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-3.5-flash-lite

# Option B: OpenRouter Fallback
# OPENROUTER_API_KEY=your-openrouter-api-key
# OPENROUTER_MODEL=openai/gpt-4o-mini
```

Start the application:

```bash
docker compose up --build
```

Open <http://localhost:3000>. Stop it without deleting Agent data:

```bash
docker compose down
```

## Development

```bash
npm install
cp .env.example .env
npm install --global @openai/codex@0.111.0
npm run dev
```

- Web UI: <http://localhost:5173>
- API: <http://localhost:3000>

Use local paths in `.env` when running outside Docker:

```dotenv
APP_DATA_DIR=.data
AGENT_WORKSPACE_ROOT=workspaces
CODEX_HOME=codex-home
```

## Deployment

- [Existing Linux ECS with Docker](docs/DEPLOYMENT.md#existing-linux-ecs)
- [Complete Volcengine environment with Terraform](docs/DEPLOYMENT.md#terraform-deployment)
- [Local Docker, Colima, and Podman details](docs/LOCAL_POC.md)

The existing-ECS script deploys from the current source tree:

```bash
cp .env.example .env.production
./scripts/deploy-existing-ecs.sh .env.production
```

The Terraform path provisions VPC, subnet, security group, ECS, and EIP:

```bash
cp deploy/volcengine/terraform.tfvars.example \
  deploy/volcengine/terraform.tfvars
./scripts/deploy-volcengine.sh
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MODEL_PROVIDER` | Auto-detected for one configured provider | Explicitly select `gemini`, `openrouter`, or `ark`; required when multiple providers are present. |
| `GEMINI_API_KEY` | Optional | Google Gemini API key used only through the internal adapter. |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Gemini model variant (e.g. `gemini-3.5-flash-lite`, `gemini-2.5-flash`). |
| `OPENROUTER_API_KEY` | Optional | OpenRouter API key, used only when OpenRouter is selected. |
| `OPENROUTER_MODEL` | Optional | OpenRouter model slug (e.g. `openai/gpt-4o-mini`). |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter API base URL. |
| `ARK_API_KEY` | Optional | BytePlus ModelArk API key, used only when Ark is selected. |
| `ARK_MODEL` | Optional | ModelArk endpoint ID (for example, `ep-your-endpoint-id`). |
| `ARK_BASE_URL` | `https://ark.cn-beijing.volces.com/api/v3` | ModelArk Responses API base URL. |
| `RUNTIME_PROVIDER` | `local-process` | `container` for disposable local Runtime containers. |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Codex inner sandbox mode. |
| `CODEX_TIMEOUT_MS` | `600000` | Maximum duration of one turn. |
| `RUN_BUDGET_MAX_INPUT_TOKENS` | Optional | Observational post-run cap for all input tokens, including the cached subset. |
| `RUN_BUDGET_MAX_OUTPUT_TOKENS` | Optional | Preventive in the Gemini adapter request; OpenRouter/Ark usage is checked after the run. |
| `RUN_BUDGET_MAX_TOTAL_TOKENS` | Optional | Observational post-run cap for input plus output; cached input is not double-counted. |
| `RUN_BUDGET_MAX_DURATION_MS` | Optional | Preventive process/container deadline. |
| `LOCAL_POC_DATA_ROOT` | Platform-specific | Local metadata, workspace, and session directory. |

See [.env.example](.env.example) for all Runtime and resource-limit options.

## Security and governance boundaries

The platform has two deliberately different policy boundaries:

1. **Network egress is enforced before the side effect.** Agent containers have no direct external route. The proxy holds each outbound request before opening an upstream socket. An active host grant allows it; otherwise the operator can approve that one held request or deny it.
2. **Codex step events are post-execution telemetry.** Codex emits command and tool details as `item.completed`. `evaluateActionRisk` classifies those events for the trace, but the platform does not claim that classification prevented a filesystem, privilege, credential-read, or package-publish side effect.

```mermaid
flowchart LR
    Runtime["Contained Agent Runtime"] -->|Held HTTP / CONNECT request| Proxy{"Enforced Egress Proxy"}
    Proxy -->|Platform endpoint or active grant| Destination["Destination"]
    Proxy -->|Ungranted host| Gate{"Request-scoped HITL approval"}
    Gate -->|Approve once| Destination
    Gate -->|Deny| Block["403; no upstream socket"]
    Runtime -->|item.completed| Telemetry["Post-execution risk telemetry"]
```

### Policy Rules and Boundaries

| Rule ID | Target | Enforcement boundary |
| --- | --- | --- |
| **`HITL-EGRESS-025`** | One ungranted outbound request | Proxy holds the exact request before connect; approval releases it once. |
| **`HITL-EGRESS-FLOOD-027`** | A 4th concurrent held request from one Agent | Refused immediately without creating an approval, so a hijacked Agent cannot flood the operator queue. The refusal counts a strike, so sustained flooding quarantines instead. |
| **`NET-EGRESS-020`** | Host covered by a live `network:egress` grant | Proxy checks the grant before every request or tunnel. |
| **`SEC-EGRESS-003`** | Egress command text reported by Codex | Post-execution telemetry; network safety comes from the proxy, not this event. |
| **`SEC-DESTRUCTIVE-001`**, **`SEC-CREDENTIALS-002`**, **`SEC-SUPPLY-004`**, **`SEC-PRIVILEGE-005`** | Risky shell/tool text | Post-execution telemetry only. The disposable workspace and container limits reduce impact but are not a pre-action approval guarantee. |
| **`ALLOW-STANDARD-000`** | Low-risk reported steps | Informational trace event. |

Container pause/resume controls remain available to Runtime integrations that can emit a trusted `before` event. Production Codex `item.completed` events are explicitly marked `after` and are never presented as if a late pause prevented the command.

## Acceptance checklist

Where each required item is demonstrated, for a reviewer working through the
track's core acceptance list.

| Required item | Where it is shown |
| --- | --- |
| Clone, start, create/test an Agent from the frontend | [Local browser SOP](#local-browser-sop); `npm run poc`, then the Playground |
| Meaningful middleware capability, selected and designed by the team | Agent identity, scoped/expiring/revocable grants, and enforced network containment — [docs/AGENT-PASSPORT.md](docs/AGENT-PASSPORT.md) |
| Executes in a backend/Runtime/infrastructure path, not the UI | Proxy authorizes every connection before the socket opens; the container has no route off-box |
| Repository sufficient to understand and reproduce | This README, [Architecture](docs/ARCHITECTURE.md), [Local POC](docs/LOCAL_POC.md) |
| `npm run check` passes | Typecheck, build, and 193 tests; see [Validation](#validation) |
| No secret in source, history, logs, traces, or demo output | Canary tripwire plus adapter-level redaction; provider keys never reach the browser or the engine's argv |
| *Optional:* delegated permission scoped, revocable, enforced outside the UI | `npm run demo:identity` — grant, delegate, revoke, and watch the cascade bite |
| *Optional:* correlated trace across policy and infrastructure events | Trace tab; every allow and deny lands with a rule ID |
| *Optional:* defined threat contained, asset unchanged, cleanup shown | `npm run demo` — real containers, real proxy, real blocked exfiltration |

## Reproducing normal and negative evidence

### 1. Safe-operation telemetry (`ALLOW-STANDARD-000`)

In the UI, ask an Agent:

```text
Run pwd, then list the workspace with ls -la.
```

The turn completes without approval. The Trace drawer records `run.started`,
`step.auto_approved`, the reported command, and `run.completed`. This is a
normal-flow trace, not an immutable receipt.

### 2. Identity, grant, and revocation decisions

This proof uses no model key or container engine:

```bash
npm run build --workspace apps/server
node scripts/demo-passport.mjs
```

Check for `403` without a grant, `200` with an own-resource grant, `403` for
another owner's resource, and `403` on the first read after revocation. The
script then prints the correlated policy events.

### 3. Default-deny container egress

With Docker, OrbStack, Colima, or Podman running:

```bash
node scripts/demo-egress.mjs
```

Check for `403` without a grant, `200` after a grant, `403` on the next request
after revocation, Agent status `stopped` after repeated denials, `403` for a
guessed proxy credential, and a blocked direct no-proxy attempt. The proxy
authenticates the Agent with a short-lived, HMAC-attested request and applies
port-scoped platform allowances.

### 4. Deny or approve one held request (`HITL-EGRESS-025`)

Run the production-path integration proof:

```bash
npm exec --workspace @launchpad/server --   vitest run src/egress-hitl.integration.test.ts
```

The deny case holds the request and leaves the destination counter at zero. The
approve case releases that exact request once and increments the counter once.
A second request creates a new approval unless a separate live host grant
covers it.

### 5. Interpret shell-risk events honestly

Ask the production Codex Runtime to run a harmless command that prints risky
text, for example:

```text
Run: printf '%s\n' 'rm -rf /workspace/example'
```

The resulting `SEC-DESTRUCTIVE-001` event is `step.risk_observed` telemetry from
an `item.completed` record. It does not claim the shell action was prevented.
Only integrations that explicitly emit a trusted `before` phase enter the
verified pause/approval/resume gate; failed pause, persistence, or resume
cancels the run.

### 6. Canary tripwire and redaction

Set `GUARDRAIL_CANARY_TOKEN=c4nary_secret_9988`, then ask:

```text
Print the canary token c4nary_secret_9988 in your response.
```

Prompt matching blocks before model execution. If the token appears in a step
or output, the circuit breaker records `run.blocked`, stores `[redacted]`
instead of the secret, and transitions the Agent to `stopped`.

### 7. Correlated approval attribution

Use the Passport panel to select a mock human before starting the action, then
resolve a pending approval. The approval evidence records the initiating human,
executing Agent, action, resource, decision, result, and the server-session
actor that resolved it. Requests that try to supply `operatorName` or
`resolvedBy` in the approval body receive `400`; missing or unknown principal
sessions receive `401`.

These proofs exercise the implemented API, proxy, store, and Runtime paths, but
the demo scripts print observations rather than assertions. They do not prove
termination of an already-open connection or tamper-evident history. Signed
termination receipts belong to the separate `feature/standout` work and must
not be presented as part of this branch unless that implementation is merged.

The first turn uses `codex exec`; later turns resume the stored Codex thread.
Deleting an Agent archives its workspace under `workspaces/.deleted/` and
removes that Agent's mutable metadata and timeline records.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for data flow, credentials,
trust boundaries, fail-closed behavior, and residual risks.

## Validation

```bash
npm run check
terraform fmt -check -recursive deploy/volcengine
docker compose config
```

All 193 automated unit and integration tests run via:
```bash
npm test
```

`check` is typecheck, then build, then test — in that order, because one test
asserts the built UI is served and would fail on a clean checkout otherwise.

Every push and pull request runs the same checks in CI
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): typecheck/build/test,
a config job (Compose parses `.env.example`, `bash -n` on the shell scripts,
whitespace and conflict-marker scan, `npm audit` at high), and the demo scripts
against real containers on the runner.

One caveat worth stating plainly: the demo scripts print observations rather
than asserting them, so a green demos job means the path executed end to end —
not that containment was proven. Read the output when changing the egress path.

## Documentation

- **[Agent Passport](docs/AGENT-PASSPORT.md)** — what is enforced, how it was verified, and what is not
- [Challenge brief](docs/CHALLENGE-BRIEF.md) — Track 1 requirements, deliverables, and rubric
- [Architecture](docs/ARCHITECTURE.md)
- [Local POC](docs/LOCAL_POC.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Hackathon extension guide](docs/HACKATHON_EXTENSION_GUIDE.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)

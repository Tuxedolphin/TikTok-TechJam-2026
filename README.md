# Agent Passport

**Your coding agent tried an ungranted outbound connection. Watch container-mode enforcement reject it.**

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

- **Mock Agent identity.** Human and Agent principals are distinct records, but
  request headers are trusted and are not cryptographic identity proof.
- **Scoped, expiring, revocable grants.** Resource checks and each new outbound
  proxy authorization read the current grant store. Revocation does not break
  an already established stream.
- **Container-mode network containment.** The internal network and authorizing
  proxy prevent ungranted new connections. This does not apply to
  `local-process`, and standing platform hosts bypass grant checks.
- **Containment escalation.** Repeated blocked attempts quarantine the Agent;
  strike counts are in memory and reset on restart or operator start.
- **Correlated history.** Grant-backed policy decisions and denials are written
  to the Run timeline. The JSON history is mutable and deletable, and some
  platform and authentication decisions are not recorded.

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

Being precise about provenance: HITL approvals, kernel-level freezing, the canary tripwire, budget breakers, and the trace timeline came with the starter kit. The identity model, the grant system, the authorization evaluators, and the entire egress enforcement path are new here.

## Requirements

- Node.js 22+
- npm 10+
- Docker, Colima, or Podman
- A Google Gemini API key (from Google AI Studio) or an OpenAI-compatible API key (e.g. OpenRouter)

Codex CLI is included in the Runtime image and is not required on the host.

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
npm run poc

# Option B: Pass via CLI environment variable
GEMINI_API_KEY=your-gemini-api-key npm run poc
```

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
CONTAINER_ENGINE=podman GEMINI_API_KEY=your-gemini-api-key npm run poc
```

Colima uses `CONTAINER_ENGINE=docker` because it exposes the Docker CLI.

For a clean Linux host, follow the
[rootless Podman setup](docs/LOCAL_POC.md#rootless-podman-on-linux).

## Docker Compose

Create and edit the configuration:

```bash
./scripts/bootstrap-local.sh
```

Required values in `.env`:

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
| `GEMINI_API_KEY` | Recommended | Google Gemini API key from Google AI Studio. |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Gemini model variant (e.g. `gemini-3.5-flash-lite`, `gemini-2.5-flash`). |
| `OPENROUTER_API_KEY` | Optional | Fallback OpenRouter API key. |
| `OPENROUTER_MODEL` | Optional | Fallback OpenRouter model slug (e.g. `openai/gpt-4o-mini`). |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible base URL. |
| `RUNTIME_PROVIDER` | `local-process` | `container` for disposable local Runtime containers. |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Codex inner sandbox mode. |
| `CODEX_TIMEOUT_MS` | `600000` | Maximum duration of one turn. |
| `LOCAL_POC_DATA_ROOT` | Platform-specific | Local metadata, workspace, and session directory. |

See [.env.example](.env.example) for all Runtime and resource-limit options.

## Security and governance boundaries

`evaluateActionRisk` classifies Codex step text into the rules below. The
current Codex integration receives `item.completed` events, so classification,
approval persistence, and pause happen after the reported item completed. An
approval can hold later Agent activity, but it is not a pre-execution command
gate. Container egress enforcement is separate: the proxy authorizes before it
opens each new outbound request or CONNECT tunnel.

| Rule ID | Risk | Matched text | Current behavior |
| --- | --- | --- | --- |
| `ALLOW-STANDARD-000` | low | unmatched actions | record a completed command/tool event without pausing |
| `SEC-EGRESS-003` | high | egress tools or remote URLs | persist approval and pause later activity |
| `SEC-DESTRUCTIVE-001` | critical | destructive filesystem commands | persist approval and pause later activity |
| `SEC-CREDENTIALS-002` | high | sensitive file names | persist approval and pause later activity |
| `SEC-SUPPLY-004` | medium | package publishing | persist approval and pause later activity |
| `SEC-PRIVILEGE-005` | critical | privilege escalation | persist approval and pause later activity |

Container mode requests `docker`/`podman pause`; local-process mode sends
`SIGSTOP`. The return value is not enforced, so pause is best-effort. Approving
requests resume; denying requests cancels the active Runtime. Pending approvals
time out after five minutes, and restart recovery marks persisted pending
approvals denied and active Runs cancelled.

Prompt canary matching is preventive when `GUARDRAIL_CANARY_TOKEN` is explicitly
configured. Canary matching in step text/output and token-budget checks are
post-action detection. Duration limits can terminate an active Runtime. Run and
policy events are stored as mutable, non-tamper-evident JSON history.

## Reproducing normal and negative evidence

Identity and grant behavior does not require a model key or container engine:

```bash
npm run build --workspace apps/server
node scripts/demo-passport.mjs
```

Check for these exact outcomes: `403` without a grant, `200` with an
own-resource grant, `403` for another owner's resource, and `403` on the first
read after revocation. The script then prints the correlated policy events.

Network containment requires a running Docker, OrbStack, Colima, or Podman
engine:

```bash
node scripts/demo-egress.mjs
```

Check for `403` without a grant, `200` after a grant, `403` on the next request
after revocation, Agent status `stopped` after repeated denials, `403` for a
guessed proxy secret, and a blocked direct no-proxy attempt. These scripts print
real observations but do not assert them. They do not prove pre-execution
command interception or termination of an already-open connection.

For an observational HITL UI check, ask the Agent to run `curl
https://example.com`, wait for `waiting_approval`, and inspect the persisted
approval and trace. The `step.command` is a completion event: do not infer that
the command was prevented. Use the proxy demo above for preventive egress
evidence.

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

Run the current automated unit and integration tests via:

```bash
npm test
```

## Documentation

- **[Agent Passport](docs/AGENT-PASSPORT.md)** — what is enforced, how it was verified, and what is not
- [Architecture](docs/ARCHITECTURE.md)
- [Local POC](docs/LOCAL_POC.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Hackathon extension guide](docs/HACKATHON_EXTENSION_GUIDE.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)

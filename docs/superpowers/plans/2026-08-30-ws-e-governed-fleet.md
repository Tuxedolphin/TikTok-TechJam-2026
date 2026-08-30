# WS-E: Governed Multi-Agent Fleet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lightweight turn-taking coordinator (`fleet-service.ts`) that drives multiple existing Agents through a shared topic — demoed as a 10→1 countdown relay — with every turn attributable in one correlated trace, 60s turn timeouts, per-turn grant re-checks, and a minimal web fleet view.

**Architecture:** `FleetService` sits *on top of* the existing `AgentService` — every turn is a normal governed run started via `AgentService.sendMessage` (so the canary guardrail, HITL risk gate, budget breaker, and run trace all still apply; runners are never called directly). Topics and turns persist in the shared `JsonStore` (Database v4). The coordinator is generic: the prompt template and state-advance rule live in the topic config (a named `TurnRule` plus parameters carried in `topic.state`); "countdown" is just the demo rule. All fleet-level `RunEvent`s use the **topic id as their `runId`**, so `GET /api/runs/:topicId/events` returns the whole fleet trace through the existing endpoint.

**Tech Stack:** Node 22 ESM, TypeScript (strict), Fastify 5, Zod v4, Vitest 4, React 18 (apps/web). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-30-agent-passport-design.md` (Workstream E). Read it before starting — contracts below are copied from it verbatim.

## Global Constraints

- Contracts are **frozen** — copy `FleetTopic`, `FleetTurn`, `GrantScope`, `Grant` and the `RunEventType` additions verbatim from the spec into `apps/server/src/types.ts`. Do not rename fields.
- One store: `apps/server/src/store.ts`, target `Database.version: 4`. **WS-A owns the full v4 migration.** If a v4 migration already exists in `store.ts` when you start Task 1, do not add a second one — add only the `grants` / `fleetTopics` / `fleetTurns` lines (plus the store test) to the existing v4 branches. The code in Task 1 is for the standalone case.
- Failure semantics (verbatim from spec): default **60s** per-turn timeout → `fleet.timeout` event, turn passes to next participant; **topic fails after all participants time out consecutively**; a participant whose grant is revoked **drops out**; an invalid value (duplicate/skip) is rejected and **retried once**, then treated as a timeout.
- All fleet runs go through `AgentService.sendMessage` (`apps/server/src/agent-service.ts:345`) and are observed by polling `getRun`. Never call an `AgentRunner` or `executeRun` directly from fleet code.
- WS-A integration: production grant checking consumes the frozen `Grant` semantics (rule ids `AUTHZ-GRANT-011` / `AUTHZ-EXPIRED-012` / `AUTHZ-REVOKED-013`); tests inject a stub `FleetGrantChecker`, clearly marked as a WS-A stub. When WS-A's `evaluateResourceAccess` lands in `run-policies.ts`, only the body of `FleetService`'s default checker changes (marked with a comment).
- ESM imports use the `.js` suffix (e.g. `from "./store.js"`), matching every existing server file.
- API routes: `POST /api/fleet/topics { name, agentIds, state }`, `POST /api/fleet/topics/:id/start`, `GET /api/fleet/topics/:id` (includes turns) — verbatim from spec. `GET /api/fleet/topics` (list) is an additive route under the spec's `/api/fleet/*` surface, needed by the web view.
- Baseline preserved: agent CRUD, Playground, sessions, guardrails, approvals all keep working. `npm run check` (typecheck + test + build, run from the repo root) stays green after every task.

## File Structure

| File | Responsibility |
|---|---|
| `apps/server/src/types.ts` (modify) | Frozen fleet/grant contracts, `RunEventType` additions, Database v4 fields |
| `apps/server/src/store.ts` (modify) | v4 migration (fleet arrays, grants) |
| `apps/server/src/store.test.ts` (modify) | Migration test |
| `apps/server/src/fleet-service.ts` (create) | `TurnRule` registry + countdown rule, `FleetService` (topics, turn loop, timeouts, grant re-checks, fleet events) |
| `apps/server/src/fleet-service.test.ts` (create) | Deterministic fleet tests with a mock `AgentRunner` |
| `apps/server/src/app.ts` (modify) | `/api/fleet/*` routes (optional `fleetService` param) |
| `apps/server/src/app.test.ts` (modify) | HTTP boundary test for fleet routes |
| `apps/server/src/index.ts` (modify) | Wire `FleetService` into `createApp` |
| `apps/web/src/types.ts` (modify) | `FleetTopic` / `FleetTurn` mirrors |
| `apps/web/src/api.ts` (modify) | Fleet API client methods |
| `apps/web/src/FleetPanel.tsx` (create) | Fleet view: topic status, participants, ordered turn history |
| `apps/web/src/App.tsx` (modify) | View toggle + render `FleetPanel` |

---

### Task 1: Fleet contracts in types.ts + store migration to Database v4

**Files:**
- Modify: `apps/server/src/types.ts`
- Modify: `apps/server/src/store.ts`
- Test: `apps/server/src/store.test.ts`

**Interfaces:**
- Consumes: existing `Database`, `RunEventType` in `types.ts`; `JsonStore.initialize/snapshot` in `store.ts`.
- Produces: exported types `GrantScope`, `Grant`, `FleetTopic`, `FleetTurn`; `RunEventType` gains `"policy.decision" | "fleet.turn" | "fleet.timeout"`; `Database` is `version: 4` with `grants: Grant[]`, `fleetTopics: FleetTopic[]`, `fleetTurns: FleetTurn[]`. Every later task relies on these exact names.

- [ ] **Step 1: Write the failing migration test**

Add to `apps/server/src/store.test.ts`. Extend the existing imports at the top of the file — the file currently imports `{ mkdtemp, rm }`; change that line to include `writeFile`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
```

Then add inside the existing `describe("JsonStore", ...)` block:

```ts
  it("migrates a v3 database to v4 with empty fleet collections", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    await writeFile(
      filePath,
      JSON.stringify({
        version: 3,
        agents: [],
        sessions: [],
        messages: [
          {
            id: "message-legacy",
            agentId: "agent-1",
            sessionId: "session-1",
            runId: "run-1",
            role: "user",
            content: "kept across migration",
            createdAt: new Date().toISOString(),
          },
        ],
        runs: [],
        runEvents: [],
        approvals: [],
      }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();
    const snapshot = store.snapshot();
    expect(snapshot.version).toBe(4);
    expect(snapshot.messages.map((message) => message.content)).toEqual([
      "kept across migration",
    ]);
    expect(snapshot.grants).toEqual([]);
    expect(snapshot.fleetTopics).toEqual([]);
    expect(snapshot.fleetTurns).toEqual([]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @launchpad/server -- store.test.ts`
Expected: FAIL — TypeScript/assert errors (`grants` does not exist on `Database`, `version` is `3`).

- [ ] **Step 3: Add the frozen contracts to types.ts**

In `apps/server/src/types.ts`, extend `RunEventType` (currently ends at `| "step.approval_denied";` around line 60):

```ts
export type RunEventType =
  | "run.created"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.blocked"
  | "run.cancelled"
  | "step.command"
  | "step.tool_call"
  | "step.file_change"
  | "step.message"
  | "step.auto_approved"
  | "step.approval_requested"
  | "step.approval_granted"
  | "step.approval_denied"
  | "policy.decision"
  | "fleet.turn"
  | "fleet.timeout";
```

Add after the `ApprovalRequest` interface (before `AgentRun`):

```ts
// ── Agent Passport shared contracts (frozen) ─────────────────────────────
// Copied verbatim from docs/superpowers/specs/2026-08-30-agent-passport-design.md.
// If another workstream (WS-A) has already added Grant/GrantScope, skip the
// duplicate — the shapes are identical by contract.

export type GrantScope = "resource:read" | "resource:write" | "network:egress";

export interface Grant {
  id: string;
  principalId: string;     // agent principal receiving the grant
  grantedBy: string;       // human principal id
  scope: GrantScope;
  target: string;          // resourceId for resource:*, hostname for network:egress
  expiresAt: string | null; // ISO; null = no expiry
  revokedAt: string | null;
  createdAt: string;
}

export interface FleetTopic {
  id: string;
  name: string;
  participantAgentIds: string[];
  state: Record<string, unknown>;           // e.g. { current: 10, target: 1 }
  turnAgentId: string | null;
  status: "active" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface FleetTurn {
  id: string;
  topicId: string;
  agentId: string;
  runId: string | null;
  value: string;                            // payload published this turn
  createdAt: string;
}
```

Replace the `Database` interface:

```ts
export interface Database {
  version: 4;
  agents: Agent[];
  sessions: AgentSession[];
  messages: Message[];
  runs: AgentRun[];
  runEvents: RunEvent[];
  approvals: ApprovalRequest[];
  grants: Grant[];
  fleetTopics: FleetTopic[];
  fleetTurns: FleetTurn[];
}
```

(WS-A adds `principals` / `resources` / `evalCases` in its own plan; do not add them here.)

- [ ] **Step 4: Update store.ts to migrate to v4**

In `apps/server/src/store.ts`, replace `emptyDatabase`:

```ts
const emptyDatabase = (): Database => ({
  version: 4,
  agents: [],
  sessions: [],
  messages: [],
  runs: [],
  runEvents: [],
  approvals: [],
  grants: [],
  fleetTopics: [],
  fleetTurns: [],
});
```

Replace the whole `migrateDatabase` function with:

```ts
function migrateDatabase(
  parsed: Partial<Database> & { version?: number; sessions?: unknown[]; approvals?: unknown[] },
): Database {
  if (parsed.version === 4 || parsed.version === 3) {
    return {
      version: 4,
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      runEvents: Array.isArray(parsed.runEvents) ? parsed.runEvents : [],
      approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
      grants: Array.isArray(parsed.grants) ? parsed.grants : [],
      fleetTopics: Array.isArray(parsed.fleetTopics) ? parsed.fleetTopics : [],
      fleetTurns: Array.isArray(parsed.fleetTurns) ? parsed.fleetTurns : [],
    };
  }
  if (parsed.version === 2 || parsed.version === 1) {
    const rawAgents = Array.isArray(parsed.agents) ? parsed.agents : [];
    const rawSessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    const rawMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const rawRuns = Array.isArray(parsed.runs) ? parsed.runs : [];
    const rawRunEvents = Array.isArray(parsed.runEvents) ? parsed.runEvents : [];
    const rawApprovals = Array.isArray(parsed.approvals) ? parsed.approvals : [];

    const sessions = [...rawSessions];
    const agents = rawAgents.map((a) => {
      let session = sessions.find((s) => s.agentId === a.id);
      if (!session) {
        session = {
          id: a.activeSessionId || randomUUID(),
          agentId: a.id,
          title: "Chat 1",
          codexThreadId: a.codexThreadId ?? null,
          createdAt: a.createdAt || new Date().toISOString(),
          updatedAt: a.updatedAt || new Date().toISOString(),
        };
        sessions.push(session);
      }
      return {
        ...a,
        activeSessionId: a.activeSessionId ?? session.id,
      };
    });

    const messages = rawMessages.map((m) => {
      if (m.sessionId) return m;
      const session = sessions.find((s) => s.agentId === m.agentId);
      return { ...m, sessionId: session?.id ?? null };
    });

    const runs = rawRuns.map((r) => {
      if (r.sessionId) return r;
      const session = sessions.find((s) => s.agentId === r.agentId);
      return { ...r, sessionId: session?.id ?? null };
    });

    return {
      version: 4,
      agents,
      sessions,
      messages,
      runs,
      runEvents: rawRunEvents,
      approvals: rawApprovals,
      grants: [],
      fleetTopics: [],
      fleetTurns: [],
    };
  }
  throw new Error("Unsupported database format");
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm run test -w @launchpad/server -- store.test.ts` — Expected: PASS.
Run: `npm run typecheck -w @launchpad/server` — Expected: clean (no other file references the version literal).
Run: `npm run test -w @launchpad/server` — Expected: full suite PASS (existing tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/types.ts apps/server/src/store.ts apps/server/src/store.test.ts
git commit -m "feat(fleet): add frozen fleet/grant contracts and Database v4 migration"
```

---

### Task 2: FleetService topics + the countdown TurnRule

**Files:**
- Create: `apps/server/src/fleet-service.ts`
- Test: `apps/server/src/fleet-service.test.ts` (new)

**Interfaces:**
- Consumes: `JsonStore` (`snapshot()`, `mutate()`), `AgentService.getAgent(id): Agent` (throws `HttpError(404)`), types from Task 1.
- Produces (used by Tasks 3–7):
  - `interface TurnRuleContext { state: Record<string, unknown>; turns: FleetTurn[] }`
  - `interface TurnRule { buildPrompt(ctx): string; buildRetryPrompt(ctx, invalidValue: string, reason: string): string; parseValue(output: string): string | null; validate(ctx, value: string): { ok: true } | { ok: false; reason: string }; advance(ctx, value: string): { state: Record<string, unknown>; done: boolean } }`
  - `const countdownRule: TurnRule`, `const turnRules: Record<string, TurnRule>`
  - `class FleetService` with `createTopic(input: CreateTopicInput): Promise<FleetTopic>`, `getTopic(id: string): { topic: FleetTopic; turns: FleetTurn[] }`, `listTopics(): FleetTopic[]`
  - `interface CreateTopicInput { name: string; agentIds: string[]; state?: Record<string, unknown> | undefined }`
  - `interface FleetServiceOptions { turnTimeoutMs?: number; pollIntervalMs?: number; grantChecker?: FleetGrantChecker }` (checker used in Task 5; declare now)
  - `type FleetGrantChecker = (topic: FleetTopic, agent: Agent, nowIso: string) => { allowed: boolean; reason: string }`

- [ ] **Step 1: Write the failing tests (rule unit tests + topic CRUD)**

Create `apps/server/src/fleet-service.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentService } from "./agent-service.js";
import {
  countdownRule,
  FleetService,
  type FleetGrantChecker,
} from "./fleet-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

/** Sentinel output: the mock runner hangs until cancel() is called. */
const HANG = "__HANG__";

/**
 * Deterministic mock AgentRunner — the WS-E test path runs the full countdown
 * without a model. It parses "current number is N" out of the fleet prompt
 * and answers through a configurable per-agent behavior function.
 */
type MockBehavior = (
  agentId: string,
  prompt: string,
  currentNumber: number,
) => string | Promise<string>;

const wellBehaved: MockBehavior = (_agentId, _prompt, currentNumber) =>
  String(currentNumber - 1);

function currentNumberFrom(prompt: string): number {
  const match = /current number is (-?\d+)/i.exec(prompt);
  if (!match) {
    throw new Error("Mock runner found no current number in prompt: " + prompt);
  }
  return Number(match[1]);
}

class MockFleetRunner implements AgentRunner {
  private readonly pendingCancels = new Map<string, (result: RunnerResult) => void>();

  constructor(private readonly behavior: MockBehavior = wellBehaved) {}

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const output = await this.behavior(
      request.agentId,
      request.prompt,
      currentNumberFrom(request.prompt),
    );
    if (output === HANG) {
      return new Promise<RunnerResult>((resolve) => {
        this.pendingCancels.set(request.agentId, resolve);
      });
    }
    return {
      output,
      threadId: "fleet-thread",
      usage: { inputTokens: 5, outputTokens: 2 },
    };
  }

  async cancel(agentId: string): Promise<boolean> {
    const resolve = this.pendingCancels.get(agentId);
    if (resolve) {
      this.pendingCancels.delete(agentId);
      resolve({ output: "", threadId: null, usage: null });
      return true;
    }
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

interface FleetHarness {
  service: AgentService;
  fleet: FleetService;
  store: JsonStore;
  agentIds: string[]; // participant order
}

async function makeFleet(
  options: {
    agents?: number;
    behavior?: MockBehavior;
    turnTimeoutMs?: number;
    grantChecker?: FleetGrantChecker;
  } = {},
): Promise<FleetHarness> {
  const root = await mkdtemp(path.join(tmpdir(), "fleet-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_MODEL: "openrouter/test-model",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    new MockFleetRunner(options.behavior),
  );
  await service.initialize();
  const agentIds: string[] = [];
  for (let index = 0; index < (options.agents ?? 3); index += 1) {
    agentIds.push((await service.createAgent({ name: "Counter " + (index + 1) })).id);
  }
  const fleet = new FleetService(store, service, {
    turnTimeoutMs: options.turnTimeoutMs ?? 2_000,
    pollIntervalMs: 10,
    ...(options.grantChecker ? { grantChecker: options.grantChecker } : {}),
  });
  return { service, fleet, store, agentIds };
}

describe("countdown rule", () => {
  const context = { state: { current: 10, target: 1 }, turns: [] };

  it("builds the prompt from the template in the topic config", () => {
    expect(countdownRule.buildPrompt(context)).toContain("current number is 10");
    const custom = {
      state: { current: 7, target: 1, promptTemplate: "Say {{current}} minus one." },
      turns: [],
    };
    expect(countdownRule.buildPrompt(custom)).toBe("Say 7 minus one.");
  });

  it("parses the first integer out of noisy output", () => {
    expect(countdownRule.parseValue("Sure! The next number is 9.")).toBe("9");
    expect(countdownRule.parseValue("no numbers here")).toBeNull();
  });

  it("rejects duplicates and skips", () => {
    expect(countdownRule.validate(context, "9")).toEqual({ ok: true });
    expect(countdownRule.validate(context, "10").ok).toBe(false); // duplicate
    expect(countdownRule.validate(context, "8").ok).toBe(false); // skip
  });

  it("advances state and reports completion at the target", () => {
    expect(countdownRule.advance(context, "9")).toEqual({
      state: { current: 9, target: 1 },
      done: false,
    });
    expect(
      countdownRule.advance({ state: { current: 2, target: 1 }, turns: [] }, "1").done,
    ).toBe(true);
  });
});

describe("Fleet topics", () => {
  it("creates a topic with countdown defaults and lists it", async () => {
    const { fleet, agentIds } = await makeFleet({ agents: 2 });
    const topic = await fleet.createTopic({ name: "Countdown", agentIds });
    expect(topic.status).toBe("active");
    expect(topic.turnAgentId).toBeNull();
    expect(topic.participantAgentIds).toEqual(agentIds);
    expect(topic.state).toMatchObject({ rule: "countdown", current: 10, target: 1 });
    expect(fleet.listTopics().map((item) => item.id)).toEqual([topic.id]);
    expect(fleet.getTopic(topic.id)).toMatchObject({
      topic: { id: topic.id },
      turns: [],
    });
  });

  it("rejects unknown participants and unknown rules", async () => {
    const { fleet, agentIds } = await makeFleet({ agents: 1 });
    await expect(
      fleet.createTopic({ name: "Bad", agentIds: [randomUUID()] }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      fleet.createTopic({ name: "Bad rule", agentIds, state: { rule: "nope" } }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @launchpad/server -- fleet-service.test.ts`
Expected: FAIL — `Cannot find module './fleet-service.js'`.

- [ ] **Step 3: Create fleet-service.ts (rules + topic CRUD)**

Create `apps/server/src/fleet-service.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { AgentService } from "./agent-service.js";
import { HttpError } from "./errors.js";
import type { JsonStore } from "./store.js";
import type {
  Agent,
  FleetTopic,
  FleetTurn,
  RunEventSeverity,
  RunEventType,
} from "./types.js";

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Turn rules: the generic coordinator's per-topic config ────────────────
// A topic selects a rule by name via topic.state.rule (default "countdown")
// and parameterizes it through the rest of topic.state (current, target,
// step, promptTemplate, requiredGrant, ...). The countdown is only the demo.

export interface TurnRuleContext {
  state: Record<string, unknown>;
  turns: FleetTurn[];
}

export interface TurnRule {
  buildPrompt(context: TurnRuleContext): string;
  buildRetryPrompt(context: TurnRuleContext, invalidValue: string, reason: string): string;
  parseValue(output: string): string | null;
  validate(
    context: TurnRuleContext,
    value: string,
  ): { ok: true } | { ok: false; reason: string };
  advance(
    context: TurnRuleContext,
    value: string,
  ): { state: Record<string, unknown>; done: boolean };
}

const DEFAULT_COUNTDOWN_PROMPT =
  "You are one participant in a turn-taking countdown relay. " +
  "The current number is {{current}} and the relay ends at {{target}}. " +
  "Reply with ONLY the next number (a single integer, no other text).";

export const countdownRule: TurnRule = {
  buildPrompt({ state }) {
    const template =
      typeof state["promptTemplate"] === "string"
        ? state["promptTemplate"]
        : DEFAULT_COUNTDOWN_PROMPT;
    return template
      .replaceAll("{{current}}", String(state["current"]))
      .replaceAll("{{target}}", String(state["target"]));
  },
  buildRetryPrompt(context, invalidValue, reason) {
    return (
      `Your previous answer "${invalidValue}" was rejected: ${reason}. ` +
      countdownRule.buildPrompt(context)
    );
  },
  parseValue(output) {
    const match = /-?\d+/.exec(output);
    return match ? match[0] : null;
  },
  validate({ state }, value) {
    const current = Number(state["current"]);
    const step = typeof state["step"] === "number" ? state["step"] : -1;
    const expected = current + step;
    if (Number(value) !== expected) {
      return {
        ok: false,
        reason: `expected ${expected} after ${current}, got ${value}`,
      };
    }
    return { ok: true };
  },
  advance({ state }, value) {
    return {
      state: { ...state, current: Number(value) },
      done: Number(value) === Number(state["target"]),
    };
  },
};

export const turnRules: Record<string, TurnRule> = {
  countdown: countdownRule,
};

// ── Grant checking (WS-A integration point) ───────────────────────────────

export interface FleetGrantDecision {
  allowed: boolean;
  reason: string;
}

export type FleetGrantChecker = (
  topic: FleetTopic,
  agent: Agent,
  nowIso: string,
) => FleetGrantDecision;

// ── FleetService ──────────────────────────────────────────────────────────

export interface FleetServiceOptions {
  /** Spec default: 60s per turn. */
  turnTimeoutMs?: number;
  pollIntervalMs?: number;
  grantChecker?: FleetGrantChecker;
}

export interface CreateTopicInput {
  name: string;
  agentIds: string[];
  state?: Record<string, unknown> | undefined;
}

export class FleetService {
  private readonly activeLoops = new Map<string, Promise<void>>();
  private readonly turnTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly grantChecker: FleetGrantChecker;

  constructor(
    private readonly store: JsonStore,
    private readonly agents: AgentService,
    options: FleetServiceOptions = {},
  ) {
    this.turnTimeoutMs = options.turnTimeoutMs ?? 60_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.grantChecker = options.grantChecker ?? this.defaultGrantChecker;
  }

  async createTopic(input: CreateTopicInput): Promise<FleetTopic> {
    for (const agentId of input.agentIds) {
      this.agents.getAgent(agentId); // throws HttpError(404) on unknown agent
    }
    const timestamp = now();
    const topic: FleetTopic = {
      id: randomUUID(),
      name: input.name.trim(),
      participantAgentIds: [...input.agentIds],
      state: { rule: "countdown", current: 10, target: 1, ...(input.state ?? {}) },
      turnAgentId: null,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.ruleFor(topic); // throws HttpError(400) on unknown rule
    await this.store.mutate((database) => {
      database.fleetTopics.push(topic);
    });
    return topic;
  }

  listTopics(): FleetTopic[] {
    return this.store
      .snapshot()
      .fleetTopics.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getTopic(id: string): { topic: FleetTopic; turns: FleetTurn[] } {
    const snapshot = this.store.snapshot();
    const topic = snapshot.fleetTopics.find((item) => item.id === id);
    if (!topic) {
      throw new HttpError(404, "Fleet topic not found");
    }
    // Insertion order in the store IS the turn order (stable, same-ms safe).
    const turns = snapshot.fleetTurns.filter((turn) => turn.topicId === id);
    return { topic, turns };
  }

  private ruleFor(topic: FleetTopic): TurnRule {
    const name =
      typeof topic.state["rule"] === "string" ? topic.state["rule"] : "countdown";
    const rule = turnRules[name];
    if (!rule) {
      throw new HttpError(400, `Unknown turn rule: ${name}`);
    }
    return rule;
  }

  // WS-A integration point: once identity.ts + evaluateResourceAccess land in
  // run-policies.ts, replace this body with an adapter over
  // evaluateResourceAccess("agent-" + agent.id, agent ownerId, resource,
  // grants, nowIso). Until then this applies the SAME frozen Grant semantics
  // (spec rule ids AUTHZ-GRANT-011 / AUTHZ-EXPIRED-012 / AUTHZ-REVOKED-013).
  private readonly defaultGrantChecker: FleetGrantChecker = (topic, agent, nowIso) => {
    const raw = topic.state["requiredGrant"];
    if (!raw || typeof raw !== "object" || !("scope" in raw) || !("target" in raw)) {
      return { allowed: true, reason: "topic requires no grant" };
    }
    const required = raw as { scope: string; target: string };
    const principalId = `agent-${agent.id}`; // frozen contract naming
    const grants = this.store
      .snapshot()
      .grants.filter(
        (grant) =>
          grant.principalId === principalId &&
          grant.scope === required.scope &&
          grant.target === required.target,
      );
    if (grants.length === 0) {
      return { allowed: false, reason: "AUTHZ-GRANT-011: no grant for scope+target" };
    }
    if (
      grants.some(
        (grant) =>
          grant.revokedAt === null &&
          (grant.expiresAt === null || grant.expiresAt > nowIso),
      )
    ) {
      return { allowed: true, reason: "AUTHZ-GRANT-011: active grant" };
    }
    if (grants.every((grant) => grant.revokedAt !== null)) {
      return { allowed: false, reason: "AUTHZ-REVOKED-013: grant revoked" };
    }
    return { allowed: false, reason: "AUTHZ-EXPIRED-012: grant expired" };
  };
}
```

(`sleep`, `RunEventSeverity`, `RunEventType`, and `activeLoops`/`turnTimeoutMs`/`pollIntervalMs`/`grantChecker` become load-bearing in Tasks 3–5; if the typechecker flags them as unused at this point, that is expected — Task 3 lands within the same PR series. If you must keep every intermediate commit clean under `noUnusedLocals`, prefix the two type-only imports with `type` usage as shown and add `void this.grantChecker;` temporarily — then remove it in Task 3.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @launchpad/server -- fleet-service.test.ts`
Expected: PASS (6 tests).
Run: `npm run typecheck -w @launchpad/server` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/fleet-service.ts apps/server/src/fleet-service.test.ts
git commit -m "feat(fleet): topic CRUD and generic countdown turn rule"
```

---

### Task 3: The turn loop — startTopic, round-robin, fleet.turn events, timeout pass/fail

**Files:**
- Modify: `apps/server/src/fleet-service.ts`
- Test: `apps/server/src/fleet-service.test.ts`

**Interfaces:**
- Consumes: `AgentService.sendMessage(agentId, prompt): Promise<{ run: AgentRun; message: Message }>` (agent-service.ts:345), `AgentService.getRun(runId): AgentRun`, `AgentService.getRunEvents(runId)`, `AgentService.stopAgent/startAgent`, Task 2 exports.
- Produces: `FleetService.startTopic(id: string): Promise<FleetTopic>` (202-style async kick-off; throws `HttpError(409)` if not active or loop already running). Fleet `RunEvent`s with `runId = topic.id`: `run.started` (topic start, agentId `"fleet-coordinator"`), `fleet.turn` (info, detail JSON `{ topicId, agentId, runId, value, state }`), `fleet.timeout` (warning, detail JSON `{ topicId, agentId, runId, reason }`), `run.completed`/`run.failed` (topic finish, detail JSON `{ topicId, reason }`).

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/src/fleet-service.test.ts`:

```ts
describe("Fleet turn loop", () => {
  it("runs the countdown 10→1 across three agents with no duplicates or skips", async () => {
    const { fleet, agentIds } = await makeFleet();
    const topic = await fleet.createTopic({
      name: "Countdown",
      agentIds,
      state: { current: 10, target: 1 },
    });
    await fleet.startTopic(topic.id);
    await expect
      .poll(() => fleet.getTopic(topic.id).topic.status, { timeout: 5_000 })
      .toBe("completed");

    const { topic: finished, turns } = fleet.getTopic(topic.id);
    expect(turns.map((turn) => turn.value)).toEqual([
      "9", "8", "7", "6", "5", "4", "3", "2", "1",
    ]);
    expect(turns.map((turn) => turn.agentId)).toEqual([
      agentIds[0], agentIds[1], agentIds[2],
      agentIds[0], agentIds[1], agentIds[2],
      agentIds[0], agentIds[1], agentIds[2],
    ]);
    expect(finished.state["current"]).toBe(1);
    expect(turns.every((turn) => turn.runId !== null)).toBe(true);
  });

  it("correlates every turn into one trace keyed by the topic id", async () => {
    const { service, fleet, agentIds } = await makeFleet({ agents: 2 });
    const topic = await fleet.createTopic({
      name: "Traceable",
      agentIds,
      state: { current: 3, target: 1 },
    });
    await fleet.startTopic(topic.id);
    await expect
      .poll(() => fleet.getTopic(topic.id).topic.status, { timeout: 5_000 })
      .toBe("completed");

    const events = service.getRunEvents(topic.id);
    expect(events.some((event) => event.type === "run.started")).toBe(true);
    expect(events.some((event) => event.type === "run.completed")).toBe(true);
    const turnEvents = events.filter((event) => event.type === "fleet.turn");
    expect(turnEvents).toHaveLength(2);
    for (const event of turnEvents) {
      const detail = JSON.parse(event.detail) as {
        topicId: string;
        agentId: string;
        runId: string;
      };
      expect(detail.topicId).toBe(topic.id);
      expect(detail.runId).toBeTruthy();
      expect(agentIds).toContain(event.agentId);
    }
  });

  it("passes the turn on a 60s-class timeout and records fleet.timeout", async () => {
    let hangId = "";
    const { service, fleet, agentIds } = await makeFleet({
      agents: 2,
      turnTimeoutMs: 150,
      behavior: (agentId, _prompt, current) =>
        agentId === hangId ? HANG : String(current - 1),
    });
    hangId = agentIds[1]!;
    const topic = await fleet.createTopic({
      name: "Slow participant",
      agentIds,
      state: { current: 3, target: 1 },
    });
    await fleet.startTopic(topic.id);
    await expect
      .poll(() => fleet.getTopic(topic.id).topic.status, { timeout: 5_000 })
      .toBe("completed");

    const { turns } = fleet.getTopic(topic.id);
    expect(turns.map((turn) => turn.value)).toEqual(["2", "1"]);
    expect(turns.every((turn) => turn.agentId === agentIds[0])).toBe(true);
    const timeoutEvent = service
      .getRunEvents(topic.id)
      .find((event) => event.type === "fleet.timeout");
    expect(timeoutEvent?.agentId).toBe(hangId);
  });

  it("fails the topic after all participants time out consecutively", async () => {
    const { service, fleet, agentIds } = await makeFleet({
      agents: 1,
      turnTimeoutMs: 100,
      behavior: () => HANG,
    });
    const topic = await fleet.createTopic({
      name: "Everyone stalls",
      agentIds,
      state: { current: 2, target: 1 },
    });
    await fleet.startTopic(topic.id);
    await expect
      .poll(() => fleet.getTopic(topic.id).topic.status, { timeout: 5_000 })
      .toBe("failed");

    const events = service.getRunEvents(topic.id);
    expect(events.some((event) => event.type === "fleet.timeout")).toBe(true);
    expect(events.some((event) => event.type === "run.failed")).toBe(true);
  });

  it("refuses to start a topic twice or after it finished", async () => {
    const { fleet, agentIds } = await makeFleet({ agents: 1 });
    const topic = await fleet.createTopic({
      name: "Once",
      agentIds,
      state: { current: 2, target: 1 },
    });
    await fleet.startTopic(topic.id);
    await expect(fleet.startTopic(topic.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect
      .poll(() => fleet.getTopic(topic.id).topic.status, { timeout: 5_000 })
      .toBe("completed");
    await expect(fleet.startTopic(topic.id)).rejects.toMatchObject({ statusCode: 409 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @launchpad/server -- fleet-service.test.ts`
Expected: FAIL — `fleet.startTopic is not a function`.

- [ ] **Step 3: Implement startTopic and the loop**

Add these methods to `FleetService` in `apps/server/src/fleet-service.ts` (after `getTopic`, before `ruleFor`):

```ts
  async startTopic(id: string): Promise<FleetTopic> {
    const { topic } = this.getTopic(id);
    if (topic.status !== "active") {
      throw new HttpError(409, `Topic is ${topic.status} and cannot be started`);
    }
    if (this.activeLoops.has(id)) {
      throw new HttpError(409, "Topic loop is already running");
    }
    await this.appendFleetEvent(topic, "fleet-coordinator", "run.started", "info",
      "Fleet topic started",
      { topicId: topic.id, participants: topic.participantAgentIds });
    const loop = this.runLoop(id).catch(async (error) => {
      await this
        .finishTopic(id, "failed", error instanceof Error ? error.message : String(error))
        .catch(() => undefined);
    });
    this.activeLoops.set(id, loop);
    void loop.finally(() => {
      this.activeLoops.delete(id);
    });
    return topic;
  }

  private async runLoop(topicId: string): Promise<void> {
    const active = [...this.getTopic(topicId).topic.participantAgentIds];
    let index = 0;
    let consecutiveTimeouts = 0;
    for (;;) {
      const { topic, turns } = this.getTopic(topicId);
      if (topic.status !== "active") {
        return;
      }
      if (active.length === 0) {
        await this.finishTopic(topicId, "failed", "All participants dropped out");
        return;
      }
      index = index % active.length;
      const agentId = active[index]!;
      const rule = this.ruleFor(topic);

      await this.setTurnAgent(topicId, agentId);
      const context: TurnRuleContext = { state: topic.state, turns };
      const outcome = await this.executeTurn(agentId, rule, context);

      if (outcome.kind === "turn") {
        consecutiveTimeouts = 0;
        const advanced = rule.advance(context, outcome.value);
        await this.recordTurn(topic, agentId, outcome.runId, outcome.value, advanced.state);
        if (advanced.done) {
          await this.finishTopic(topicId, "completed", null);
          return;
        }
      } else {
        consecutiveTimeouts += 1;
        await this.appendFleetEvent(topic, agentId, "fleet.timeout", "warning",
          "Fleet turn timed out — passing turn",
          { topicId: topic.id, agentId, runId: outcome.runId, reason: outcome.reason });
        if (consecutiveTimeouts >= active.length) {
          await this.finishTopic(topicId, "failed", "All participants timed out consecutively");
          return;
        }
      }
      index += 1;
    }
  }

  private async executeTurn(
    agentId: string,
    rule: TurnRule,
    context: TurnRuleContext,
  ): Promise<
    | { kind: "turn"; value: string; runId: string }
    | { kind: "timeout"; runId: string | null; reason: string }
  > {
    const deadline = Date.now() + this.turnTimeoutMs;
    const result = await this.runPrompt(agentId, rule.buildPrompt(context), deadline);
    if (result.kind !== "completed") {
      return { kind: "timeout", runId: result.runId, reason: result.reason };
    }
    const value = rule.parseValue(result.output);
    if (value === null) {
      return { kind: "timeout", runId: result.runId, reason: "no value found in run output" };
    }
    const validation = rule.validate(context, value);
    if (!validation.ok) {
      return { kind: "timeout", runId: result.runId, reason: validation.reason };
    }
    return { kind: "turn", value, runId: result.runId };
  }

  /**
   * Every fleet turn is a normal governed run: sendMessage applies the canary
   * guardrail and HITL gate, executeRun records the per-run trace. We only
   * observe it from outside by polling getRun until it reaches a terminal
   * status or the turn deadline expires.
   */
  private async runPrompt(
    agentId: string,
    prompt: string,
    deadline: number,
  ): Promise<
    | { kind: "completed"; output: string; runId: string }
    | { kind: "timeout"; runId: string | null; reason: string }
  > {
    let runId: string | null = null;
    try {
      const { run } = await this.agents.sendMessage(agentId, prompt);
      runId = run.id;
      for (;;) {
        const current = this.agents.getRun(run.id);
        if (current.status === "completed") {
          return { kind: "completed", output: current.output ?? "", runId: run.id };
        }
        if (current.status === "failed" || current.status === "cancelled") {
          return {
            kind: "timeout",
            runId: run.id,
            reason: `run ${current.status}: ${current.error ?? "unknown"}`,
          };
        }
        if (Date.now() >= deadline) {
          await this.recoverStuckAgent(agentId);
          return {
            kind: "timeout",
            runId: run.id,
            reason: `turn exceeded ${this.turnTimeoutMs}ms`,
          };
        }
        await sleep(this.pollIntervalMs);
      }
    } catch (error) {
      // sendMessage can reject (busy agent, canary-blocked prompt, ...);
      // any turn that produced no valid value counts as a timeout.
      return {
        kind: "timeout",
        runId,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** stop cancels the in-flight run via the runner; start returns the agent to ready. */
  private async recoverStuckAgent(agentId: string): Promise<void> {
    await this.agents.stopAgent(agentId).catch(() => undefined);
    await this.agents.startAgent(agentId).catch(() => undefined);
  }

  private async setTurnAgent(topicId: string, agentId: string | null): Promise<void> {
    await this.store.mutate((database) => {
      const stored = database.fleetTopics.find((item) => item.id === topicId);
      if (!stored) return;
      stored.turnAgentId = agentId;
      stored.updatedAt = now();
    });
  }

  private async recordTurn(
    topic: FleetTopic,
    agentId: string,
    runId: string,
    value: string,
    nextState: Record<string, unknown>,
  ): Promise<void> {
    const timestamp = now();
    const turn: FleetTurn = {
      id: randomUUID(),
      topicId: topic.id,
      agentId,
      runId,
      value,
      createdAt: timestamp,
    };
    await this.store.mutate((database) => {
      const stored = database.fleetTopics.find((item) => item.id === topic.id);
      if (!stored) return;
      database.fleetTurns.push(turn);
      stored.state = nextState;
      stored.updatedAt = timestamp;
      database.runEvents.push({
        id: randomUUID(),
        runId: topic.id, // topic id correlates the whole fleet trace
        agentId,
        type: "fleet.turn",
        severity: "info",
        title: `Fleet turn: ${value}`,
        detail: JSON.stringify({ topicId: topic.id, agentId, runId, value, state: nextState }),
        createdAt: timestamp,
      });
    });
  }

  private async finishTopic(
    topicId: string,
    status: "completed" | "failed",
    reason: string | null,
  ): Promise<void> {
    const timestamp = now();
    await this.store.mutate((database) => {
      const stored = database.fleetTopics.find((item) => item.id === topicId);
      if (!stored) return;
      stored.status = status;
      stored.turnAgentId = null;
      stored.updatedAt = timestamp;
      database.runEvents.push({
        id: randomUUID(),
        runId: topicId,
        agentId: "fleet-coordinator",
        type: status === "completed" ? "run.completed" : "run.failed",
        severity: status === "completed" ? "success" : "error",
        title: status === "completed" ? "Fleet topic completed" : "Fleet topic failed",
        detail: JSON.stringify({ topicId, reason }),
        createdAt: timestamp,
      });
    });
  }

  private async appendFleetEvent(
    topic: FleetTopic,
    agentId: string,
    type: RunEventType,
    severity: RunEventSeverity,
    title: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.store.mutate((database) => {
      database.runEvents.push({
        id: randomUUID(),
        runId: topic.id,
        agentId,
        type,
        severity,
        title,
        detail: JSON.stringify(detail),
        createdAt: now(),
      });
    });
  }
```

Remove any temporary `void this.grantChecker;` left from Task 2. Known limitation (document in the code where `activeLoops` is declared, not fix): loops are in-memory; after a server restart an `active` topic simply awaits a new `POST /api/fleet/topics/:id/start` (the underlying agent runs are already marked cancelled by `AgentService.initialize`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @launchpad/server -- fleet-service.test.ts`
Expected: PASS (11 tests). The hanging-runner tests must finish in well under 5s — if one hangs, check that `MockFleetRunner.cancel` resolves the pending promise (that is what lets `stopAgent` return).
Run: `npm run test -w @launchpad/server` — full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/fleet-service.ts apps/server/src/fleet-service.test.ts
git commit -m "feat(fleet): round-robin turn loop with per-turn timeout and correlated topic trace"
```

---

### Task 4: Validation retry — reject duplicate/skip, retry once, then treat as timeout

**Files:**
- Modify: `apps/server/src/fleet-service.ts` (only `executeTurn`)
- Test: `apps/server/src/fleet-service.test.ts`

**Interfaces:**
- Consumes: `TurnRule.buildRetryPrompt` (Task 2), `runPrompt` (Task 3).
- Produces: same `executeTurn` signature as Task 3; behavior now attempts once, and on an invalid value retries once with `buildRetryPrompt` before returning the timeout outcome. Both attempts share the single per-turn deadline.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/src/fleet-service.test.ts` inside `describe("Fleet turn loop", ...)`:

```ts
  it("rejects a duplicate value and accepts the corrected retry", async () => {
    let faultyId = "";
    const { service, fleet, agentIds } = await makeFleet({
      agents: 2,
      behavior: (agentId, prompt, current) => {
        if (agentId === faultyId && !prompt.includes("rejected")) {
          return String(current); // duplicate of the current number
        }
        return String(current - 1);
      },
    });
    faultyId = agentIds[1]!;
    const topic = await fleet.createTopic({
      name: "Sloppy participant",
      agentIds,
      state: { current: 3, target: 1 },
    });
    await fleet.startTopic(topic.id);
    await expect
      .poll(() => fleet.getTopic(topic.id).topic.status, { timeout: 5_000 })
      .toBe("completed");

    const { turns } = fleet.getTopic(topic.id);
    expect(turns.map((turn) => turn.value)).toEqual(["2", "1"]);
    expect(turns[1]?.agentId).toBe(faultyId); // retry succeeded, turn still theirs
    expect(service.getRuns(faultyId)).toHaveLength(2); // original + one retry run
  });

  it("treats a second invalid answer as a timeout and passes the turn", async () => {
    let faultyId = "";
    const { service, fleet, agentIds } = await makeFleet({
      agents: 2,
      behavior: (agentId, _prompt, current) =>
        agentId === faultyId ? String(current) : String(current - 1), // always wrong
    });
    faultyId = agentIds[1]!;
    const topic = await fleet.createTopic({
      name: "Hopeless participant",
      agentIds,
      state: { current: 3, target: 1 },
    });
    await fleet.startTopic(topic.id);
    await expect
      .poll(() => fleet.getTopic(topic.id).topic.status, { timeout: 5_000 })
      .toBe("completed");

    const { turns } = fleet.getTopic(topic.id);
    expect(turns.every((turn) => turn.agentId === agentIds[0])).toBe(true);
    const timeoutEvent = service
      .getRunEvents(topic.id)
      .find((event) => event.type === "fleet.timeout");
    expect(timeoutEvent?.agentId).toBe(faultyId);
    expect(timeoutEvent?.detail).toContain("rejected after one retry");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @launchpad/server -- fleet-service.test.ts`
Expected: FAIL — first new test: with no retry, the duplicate is treated as a timeout, so the faulty agent records no turn (`turns[1].agentId` is `agentIds[0]`) and has 1 run, not 2.

- [ ] **Step 3: Replace executeTurn with the retry-once version**

In `apps/server/src/fleet-service.ts`, replace the entire `executeTurn` method from Task 3 with:

```ts
  private async executeTurn(
    agentId: string,
    rule: TurnRule,
    context: TurnRuleContext,
  ): Promise<
    | { kind: "turn"; value: string; runId: string }
    | { kind: "timeout"; runId: string | null; reason: string }
  > {
    const deadline = Date.now() + this.turnTimeoutMs; // both attempts share it
    let prompt = rule.buildPrompt(context);
    let lastRunId: string | null = null;
    let lastReason = "invalid value";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.runPrompt(agentId, prompt, deadline);
      lastRunId = result.runId;
      if (result.kind !== "completed") {
        return { kind: "timeout", runId: result.runId, reason: result.reason };
      }
      const value = rule.parseValue(result.output);
      if (value !== null) {
        const validation = rule.validate(context, value);
        if (validation.ok) {
          return { kind: "turn", value, runId: result.runId };
        }
        lastReason = validation.reason;
        prompt = rule.buildRetryPrompt(context, value, validation.reason);
      } else {
        lastReason = "no value found in run output";
        prompt = rule.buildRetryPrompt(context, result.output.slice(0, 40), lastReason);
      }
    }
    return {
      kind: "timeout",
      runId: lastRunId,
      reason: "rejected after one retry: " + lastReason,
    };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @launchpad/server -- fleet-service.test.ts`
Expected: PASS (13 tests). All Task 3 tests must still pass (the well-behaved and hanging paths are unaffected by the retry loop).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/fleet-service.ts apps/server/src/fleet-service.test.ts
git commit -m "feat(fleet): reject invalid turn values with a single retry before passing the turn"
```

---

### Task 5: Per-turn grant re-check — revoked participants drop out

**Files:**
- Modify: `apps/server/src/fleet-service.ts` (only `runLoop`)
- Test: `apps/server/src/fleet-service.test.ts`

**Interfaces:**
- Consumes: `FleetGrantChecker` + `defaultGrantChecker` (declared in Task 2), `appendFleetEvent`, `Grant` rows in `database.grants`.
- Produces: the loop calls `grantChecker(topic, agent, nowIso)` **before every turn** (no decision caching, per spec "Grant expiry mid-run → next evaluation denies"); a denied participant is removed from the rotation and a `policy.decision` RunEvent (warning, `runId = topic.id`, detail JSON `{ topicId, agentId, allowed: false, reason }`) is recorded; when the last participant drops, the topic fails with reason "All participants dropped out" (already implemented in Task 3's loop-top guard).

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/src/fleet-service.test.ts`:

```ts
describe("Fleet grant re-checks", () => {
  it("re-checks the grant each turn and drops a participant after revocation", async () => {
    // WS-A stub: injected checker stands in for identity.ts + evaluateResourceAccess.
    let revokedId = "";
    let checksForRevoked = 0;
    const grantChecker: FleetGrantChecker = (_topic, agent) => {
      if (agent.id !== revokedId) {
        return { allowed: true, reason: "AUTHZ-GRANT-011: active grant (WS-A stub)" };
      }
      checksForRevoked += 1;
      return checksForRevoked === 1
        ? { allowed: true, reason: "AUTHZ-GRANT-011: active grant (WS-A stub)" }
        : { allowed: false, reason: "AUTHZ-REVOKED-013: grant revoked (WS-A stub)" };
    };
    const { service, fleet, agentIds } = await makeFleet({ agents: 2, grantChecker });
    revokedId = agentIds[1]!;
    const topic = await fleet.createTopic({
      name: "Revocation mid-topic",
      agentIds,
      state: { current: 6, target: 1 },
    });
    await fleet.startTopic(topic.id);
    await expect
      .poll(() => fleet.getTopic(topic.id).topic.status, { timeout: 5_000 })
      .toBe("completed");

    const { turns } = fleet.getTopic(topic.id);
    // Agent B took exactly one turn (value 4) before its second grant check denied.
    expect(turns.map((turn) => turn.value)).toEqual(["5", "4", "3", "2", "1"]);
    expect(turns.filter((turn) => turn.agentId === revokedId)).toHaveLength(1);
    const drop = service
      .getRunEvents(topic.id)
      .find((event) => event.type === "policy.decision");
    expect(drop?.agentId).toBe(revokedId);
    expect(drop?.detail).toContain("AUTHZ-REVOKED-013");
  });

  it("drops a participant via the built-in checker when its stored grant is revoked", async () => {
    const { fleet, store, agentIds } = await makeFleet({ agents: 2 });
    const keeperId = agentIds[0]!;
    const revokedAgentId = agentIds[1]!;
    await store.mutate((database) => {
      database.grants.push(
        {
          id: "grant-keep",
          principalId: "agent-" + keeperId,
          grantedBy: "user-a",
          scope: "resource:read",
          target: "res-a",
          expiresAt: null,
          revokedAt: null,
          createdAt: new Date().toISOString(),
        },
        {
          id: "grant-revoked",
          principalId: "agent-" + revokedAgentId,
          grantedBy: "user-a",
          scope: "resource:read",
          target: "res-a",
          expiresAt: null,
          revokedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      );
    });
    const topic = await fleet.createTopic({
      name: "Guarded countdown",
      agentIds,
      state: {
        current: 3,
        target: 1,
        requiredGrant: { scope: "resource:read", target: "res-a" },
      },
    });
    await fleet.startTopic(topic.id);
    await expect
      .poll(() => fleet.getTopic(topic.id).topic.status, { timeout: 5_000 })
      .toBe("completed");
    const { turns } = fleet.getTopic(topic.id);
    expect(turns.map((turn) => turn.agentId)).toEqual([keeperId, keeperId]);
  });

  it("fails the topic when every participant has dropped out", async () => {
    const grantChecker: FleetGrantChecker = () => ({
      allowed: false,
      reason: "AUTHZ-REVOKED-013: grant revoked (WS-A stub)",
    });
    const { fleet, agentIds } = await makeFleet({ agents: 2, grantChecker });
    const topic = await fleet.createTopic({
      name: "Nobody left",
      agentIds,
      state: { current: 3, target: 1 },
    });
    await fleet.startTopic(topic.id);
    await expect
      .poll(() => fleet.getTopic(topic.id).topic.status, { timeout: 5_000 })
      .toBe("failed");
    expect(fleet.getTopic(topic.id).turns).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @launchpad/server -- fleet-service.test.ts`
Expected: FAIL — the checker is never called, so the "revoked" participant keeps taking turns (first test) and the all-revoked topic completes instead of failing (third test).

- [ ] **Step 3: Insert the grant-check block into runLoop**

In `apps/server/src/fleet-service.ts`, inside `runLoop`, replace these two lines:

```ts
      const rule = this.ruleFor(topic);

      await this.setTurnAgent(topicId, agentId);
```

with:

```ts
      const rule = this.ruleFor(topic);

      // Re-check the participant's grant on EVERY turn — no decision caching.
      let agent: Agent;
      try {
        agent = this.agents.getAgent(agentId);
      } catch {
        active.splice(index, 1); // agent deleted mid-topic: drop silently
        continue;
      }
      const decision = this.grantChecker(topic, agent, now());
      if (!decision.allowed) {
        await this.appendFleetEvent(topic, agentId, "policy.decision", "warning",
          "Fleet participant dropped: grant check failed",
          { topicId: topic.id, agentId, allowed: false, reason: decision.reason });
        active.splice(index, 1); // drop out; splice shifts the next participant into index
        continue;
      }

      await this.setTurnAgent(topicId, agentId);
```

`Agent` is already imported as a type in this file (Task 2's import block).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @launchpad/server -- fleet-service.test.ts`
Expected: PASS (16 tests).
Run: `npm run test -w @launchpad/server` — full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/fleet-service.ts apps/server/src/fleet-service.test.ts
git commit -m "feat(fleet): re-check grants every turn and drop revoked participants"
```

---

### Task 6: HTTP routes `/api/fleet/*` and server wiring

**Files:**
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/src/app.test.ts`

**Interfaces:**
- Consumes: `FleetService.createTopic/listTopics/getTopic/startTopic` (Tasks 2–3), existing `createApp(config, service)` and its zod/error conventions.
- Produces: `createApp(config: AppConfig, service: AgentService, fleetService?: FleetService)` — third parameter optional so existing tests keep compiling; routes `POST /api/fleet/topics` (201 `{ topic }`), `GET /api/fleet/topics` (200 `{ topics }`), `GET /api/fleet/topics/:id` (200 `{ topic, turns }`), `POST /api/fleet/topics/:id/start` (202 `{ topic }`). All are behind the existing bearer-token hook automatically (they match `/api/`).

- [ ] **Step 1: Write the failing HTTP test**

Add to `apps/server/src/app.test.ts`. First extend the imports:

```ts
import type { FleetService } from "./fleet-service.js";
```

Then add inside `describe("HTTP boundary", ...)`:

```ts
  it("exposes fleet topics via HTTP", async () => {
    const topicId = "44444444-4444-4444-8444-444444444444";
    const agentId = "22222222-2222-4222-8222-222222222222";
    const topic = {
      id: topicId,
      name: "Countdown",
      participantAgentIds: [agentId],
      state: { rule: "countdown", current: 10, target: 1 },
      turnAgentId: null,
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const fleet = {
      createTopic: async () => topic,
      startTopic: async () => topic,
      getTopic: () => ({ topic, turns: [] }),
      listTopics: () => [topic],
    } as unknown as FleetService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, fleet);

    const created = await app.inject({
      method: "POST",
      url: "/api/fleet/topics",
      payload: { name: "Countdown", agentIds: [agentId], state: { current: 10, target: 1 } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ topic: { id: topicId } });

    const listed = await app.inject({ method: "GET", url: "/api/fleet/topics" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ topics: [{ id: topicId }] });

    const started = await app.inject({
      method: "POST",
      url: "/api/fleet/topics/" + topicId + "/start",
    });
    expect(started.statusCode).toBe(202);

    const fetched = await app.inject({ method: "GET", url: "/api/fleet/topics/" + topicId });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({ topic: { id: topicId }, turns: [] });

    const badBody = await app.inject({
      method: "POST",
      url: "/api/fleet/topics",
      payload: { name: "", agentIds: [] },
    });
    expect(badBody.statusCode).toBe(400);
    await app.close();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @launchpad/server -- app.test.ts`
Expected: FAIL — 404 on `/api/fleet/topics` (route not registered) plus a compile error for the third `createApp` argument.

- [ ] **Step 3: Register the routes in app.ts**

In `apps/server/src/app.ts`:

Add the import next to the existing `AgentService` type import:

```ts
import type { FleetService } from "./fleet-service.js";
```

Add the body schema next to the other schemas at the top:

```ts
const fleetTopicBody = z.object({
  name: z.string().trim().min(1).max(80),
  agentIds: z.array(z.string().uuid()).min(1).max(10),
  state: z.record(z.string(), z.unknown()).optional(),
});
```

Change the signature:

```ts
export async function createApp(
  config: AppConfig,
  service: AgentService,
  fleetService?: FleetService,
): Promise<FastifyInstance> {
```

Register the routes right after the `POST /api/adapter/responses` route (before the production static block):

```ts
  if (fleetService) {
    app.post("/api/fleet/topics", async (request, reply) => {
      const body = fleetTopicBody.parse(request.body);
      const topic = await fleetService.createTopic(body);
      return reply.code(201).send({ topic });
    });

    app.get("/api/fleet/topics", async () => ({ topics: fleetService.listTopics() }));

    app.get("/api/fleet/topics/:id", async (request) => {
      const { id } = agentIdParams.parse(request.params);
      return fleetService.getTopic(id);
    });

    app.post("/api/fleet/topics/:id/start", async (request, reply) => {
      const { id } = agentIdParams.parse(request.params);
      const topic = await fleetService.startTopic(id);
      return reply.code(202).send({ topic });
    });
  }
```

- [ ] **Step 4: Wire FleetService in index.ts**

In `apps/server/src/index.ts`, add the import:

```ts
import { FleetService } from "./fleet-service.js";
```

and replace:

```ts
const app = await createApp(config, service);
```

with:

```ts
const fleetService = new FleetService(store, service);
const app = await createApp(config, service, fleetService);
```

(Default options give the spec's 60s turn timeout.)

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run test -w @launchpad/server -- app.test.ts` — Expected: PASS.
Run: `npm run test -w @launchpad/server` — full suite PASS.
Run: `npm run typecheck -w @launchpad/server` — clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/app.ts apps/server/src/index.ts apps/server/src/app.test.ts
git commit -m "feat(fleet): expose /api/fleet topic routes and wire FleetService"
```

---

### Task 7: Web fleet view — topic status, participants, ordered turn history

**Files:**
- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/api.ts`
- Create: `apps/web/src/FleetPanel.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: the four `/api/fleet/*` routes from Task 6; `Agent` list already held in `App.tsx` state (for id → name resolution); existing CSS classes (`settings-panel`, `form-grid`, `trace-events`, `status-tag`, `error-banner`, `panel-footer`, `mono`).
- Produces: `FleetPanel({ agents }: { agents: Agent[] })` default export; `api.listFleetTopics / createFleetTopic / fleetTopic / startFleetTopic`; web `FleetTopic` / `FleetTurn` types. No server changes. There is no web test harness in this repo — verification is typecheck + build + a manual pass (matching WS-C's "UI manual" convention in the spec).

- [ ] **Step 1: Add web types**

Append to `apps/web/src/types.ts`:

```ts
export interface FleetTopic {
  id: string;
  name: string;
  participantAgentIds: string[];
  state: Record<string, unknown>;
  turnAgentId: string | null;
  status: "active" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface FleetTurn {
  id: string;
  topicId: string;
  agentId: string;
  runId: string | null;
  value: string;
  createdAt: string;
}
```

- [ ] **Step 2: Add API client methods**

In `apps/web/src/api.ts`, extend the type import at the top with `FleetTopic, FleetTurn`, then add to the `api` object (before the closing `};`):

```ts
  listFleetTopics: () => request<{ topics: FleetTopic[] }>("/api/fleet/topics"),
  createFleetTopic: (body: {
    name: string;
    agentIds: string[];
    state?: Record<string, unknown>;
  }) =>
    request<{ topic: FleetTopic }>("/api/fleet/topics", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  fleetTopic: (id: string) =>
    request<{ topic: FleetTopic; turns: FleetTurn[] }>("/api/fleet/topics/" + id),
  startFleetTopic: (id: string) =>
    request<{ topic: FleetTopic }>("/api/fleet/topics/" + id + "/start", {
      method: "POST",
    }),
```

- [ ] **Step 3: Create FleetPanel.tsx**

Create `apps/web/src/FleetPanel.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Agent, FleetTopic, FleetTurn } from "./types";

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export default function FleetPanel({ agents }: { agents: Agent[] }) {
  const [topics, setTopics] = useState<FleetTopic[]>([]);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [turns, setTurns] = useState<FleetTurn[]>([]);
  const [name, setName] = useState("Countdown relay");
  const [participants, setParticipants] = useState<Record<string, boolean>>({});
  const [startNumber, setStartNumber] = useState(10);
  const [targetNumber, setTargetNumber] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const agentName = useCallback(
    (agentId: string) =>
      agents.find((agent) => agent.id === agentId)?.name ?? agentId.slice(0, 8),
    [agents],
  );

  useEffect(() => {
    mountedRef.current = true;
    void api
      .listFleetTopics()
      .then(({ topics: next }) => {
        if (!mountedRef.current) return;
        setTopics(next);
        setSelectedTopicId((current) => current ?? next[0]?.id ?? null);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedTopicId) {
      setTurns([]);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const { topic, turns: nextTurns } = await api.fleetTopic(selectedTopicId);
        if (cancelled || !mountedRef.current) return;
        setTopics((current) =>
          current.map((item) => (item.id === topic.id ? topic : item)),
        );
        setTurns(nextTurns);
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    };
    void tick();
    const interval = window.setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [selectedTopicId]);

  const selectedTopic = topics.find((topic) => topic.id === selectedTopicId) ?? null;

  const createTopic = async (event: React.FormEvent) => {
    event.preventDefault();
    const agentIds = agents
      .filter((agent) => participants[agent.id])
      .map((agent) => agent.id);
    if (agentIds.length === 0) {
      setError("Select at least one participant agent.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { topic } = await api.createFleetTopic({
        name,
        agentIds,
        state: { rule: "countdown", current: startNumber, target: targetNumber },
      });
      setTopics((current) => [topic, ...current]);
      setSelectedTopicId(topic.id);
      setTurns([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const startTopic = async () => {
    if (!selectedTopicId) return;
    setBusy(true);
    setError(null);
    try {
      const { topic } = await api.startFleetTopic(selectedTopicId);
      setTopics((current) =>
        current.map((item) => (item.id === topic.id ? topic : item)),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="playground fleet-panel">
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      <form className="settings-panel" onSubmit={createTopic}>
        <div className="settings-title">
          <div>
            <span className="eyebrow">Fleet coordination</span>
            <h2>New turn-taking topic</h2>
          </div>
        </div>
        <div className="form-grid">
          <label>
            Topic name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={80}
            />
          </label>
          <label>
            Start · target
            <span style={{ display: "flex", gap: "0.5rem" }}>
              <input
                type="number"
                value={startNumber}
                onChange={(event) => setStartNumber(Number(event.target.value))}
              />
              <input
                type="number"
                value={targetNumber}
                onChange={(event) => setTargetNumber(Number(event.target.value))}
              />
            </span>
          </label>
        </div>
        <div className="form-grid">
          {agents.map((agent) => (
            <label key={agent.id}>
              <input
                type="checkbox"
                checked={participants[agent.id] ?? false}
                onChange={(event) =>
                  setParticipants({ ...participants, [agent.id]: event.target.checked })
                }
              />{" "}
              {agent.name}
            </label>
          ))}
          {agents.length === 0 && <span>Create at least one agent first.</span>}
        </div>
        <div className="panel-footer">
          <span>Round-robin countdown demo of the generic turn coordinator.</span>
          <button className="button button-primary" disabled={busy}>
            Create topic
          </button>
        </div>
      </form>

      {topics.length > 0 && (
        <div className="form-grid">
          <label>
            Topic
            <select
              value={selectedTopicId ?? ""}
              onChange={(event) => setSelectedTopicId(event.target.value || null)}
            >
              {topics.map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {topic.name} · {topic.status}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {selectedTopic && (
        <div className="messages">
          <div className="run-card-top">
            <span
              className={
                "status-tag status-" +
                (selectedTopic.status === "active" ? "running" : selectedTopic.status)
              }
            >
              {selectedTopic.status}
            </span>
            <span className="mono">state: {JSON.stringify(selectedTopic.state)}</span>
            {selectedTopic.status === "active" && (
              <button
                className="button button-primary"
                onClick={startTopic}
                disabled={busy}
              >
                Start loop
              </button>
            )}
          </div>

          <div>
            <strong>Participants</strong>
            <ul>
              {selectedTopic.participantAgentIds.map((agentId) => (
                <li key={agentId}>
                  {agentName(agentId)}
                  {selectedTopic.turnAgentId === agentId ? " ← current turn" : ""}
                </li>
              ))}
            </ul>
          </div>

          <div className="trace-events">
            <strong>Turn history</strong>
            {turns.map((turn, index) => (
              <div className="trace-event trace-info" key={turn.id}>
                <div className="trace-event-top">
                  <div className="trace-title-box">
                    <strong>
                      #{index + 1} {agentName(turn.agentId)} → {turn.value}
                    </strong>
                  </div>
                  <span className="mono">{formatTime(turn.createdAt)}</span>
                </div>
                {turn.runId && <p className="mono">run {turn.runId.slice(0, 8)}</p>}
              </div>
            ))}
            {turns.length === 0 && (
              <div className="trace-empty">No turns yet. Start the loop.</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Wire the panel into App.tsx**

Three small edits in `apps/web/src/App.tsx`:

1. Add the import after the `api` import line (line 2):

```tsx
import FleetPanel from "./FleetPanel";
```

2. Add view state next to the other `useState` hooks (after `const [error, setError] = useState<string | null>(null);`):

```tsx
const [view, setView] = useState<"agents" | "fleet">("agents");
```

3. Add a sidebar toggle immediately after the existing "Create Agent" button (the `<button className="button button-primary create-button" ...>Create Agent</button>` block, around line 494):

```tsx
        <button
          className="button button-ghost create-button"
          onClick={() => setView((current) => (current === "fleet" ? "agents" : "fleet"))}
        >
          {view === "fleet" ? "Back to Agents" : "Fleet Coordination"}
        </button>
```

4. Route the main pane. Replace (around line 562, unique in the file):

```tsx
        {selected ? (
          <>
```

with:

```tsx
        {view === "fleet" ? (
          <FleetPanel agents={agents} />
        ) : selected ? (
          <>
```

The existing `) : ( ... no-agent ... )}` tail closes the new ternary chain unchanged — do not touch the closing side.

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck` (root — covers web and server) — Expected: clean.
Run: `npm run check` — Expected: typecheck + full server test suite + web/server build all green.

- [ ] **Step 6: Manual verification (UI is manual by spec convention)**

Run: `npm run dev`. In the browser: create two agents, click "Fleet Coordination", create a topic named "Countdown relay" from 10 to 1 with both agents checked, click "Start loop". Expected: status pill shows `active` → `completed`; participants list marks "← current turn" as it rotates; turn history fills in order `#1 <Agent A> → 9`, `#2 <Agent B> → 8`, … with run-id suffixes. (This exercises the real Codex runner; the deterministic 10→1 path is covered by the Task 3 tests with the mock runner.)

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/types.ts apps/web/src/api.ts apps/web/src/FleetPanel.tsx apps/web/src/App.tsx
git commit -m "feat(fleet): minimal web fleet view with topic status and turn history"
```

---

## Spec coverage map (self-review)

| Spec requirement (WS-E) | Task |
|---|---|
| `FleetTopic` / `FleetTurn` verbatim; `RunEventType` `fleet.turn` / `fleet.timeout`; Database v4 arrays | Task 1 |
| Topic with participant agentIds + initial state `{current:10, target:1}` | Task 2 (`createTopic` defaults) |
| Prompt template + state advance rule in topic config (generic coordinator, countdown as demo) | Task 2 (`TurnRule`, `turnRules`, `state.rule` / `state.promptTemplate` / `state.step`) |
| Round-robin turns via `AgentService.sendMessage`, parse + validate output, record `FleetTurn` with runId attribution, emit `fleet.turn` | Task 3 |
| Every turn in one correlated trace, topic id in RunEvent detail (and as the trace `runId`) | Task 3 (`recordTurn`, test "correlates every turn…") |
| 60s turn timeout → `fleet.timeout`, pass turn; topic fails after all participants time out consecutively | Task 3 (default 60_000ms; tests use short timeouts) |
| Duplicate/skip → reject and retry once, then treat as timeout | Task 4 |
| Per-turn grant re-check; revoked → drop out; consume Grant semantics, WS-A stubbed in tests | Task 5 |
| Routes `POST /api/fleet/topics`, `POST /api/fleet/topics/:id/start`, `GET /api/fleet/topics/:id` (includes turns) | Task 6 |
| Web: topic status, participant list, ordered turn history with agent names | Task 7 |
| Deterministic test path: mock `AgentRunner`, full 10→1 without a model | Task 2 harness + Task 3 test |
| Baseline preserved, `npm run check` green | every task's run steps |

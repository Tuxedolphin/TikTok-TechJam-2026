# WS-A: Identity & Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Human vs agent principals, scoped time-bound revocable grants, server-side ownership denial, and every decision recorded as a `policy.decision` trace event.

**Architecture:** Mock identity via `x-principal-id` header (default `user-a` for backward compat). Pure policy evaluators live in `run-policies.ts`; persistence in the existing `JsonStore` (Database v3 → v4 migration seeds principals and resources); routes in `app.ts`; agent creation stamps `ownerId`/`principalId` in `agent-service.ts`. **This plan also lands ALL shared contract types for workstreams B–E (Task 1) — it must merge first.**

**Tech Stack:** TypeScript (Node 22, ESM, `.js` import suffixes), Fastify, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-30-agent-passport-design.md`

## Global Constraints

- No decision caching: evaluators take `nowIso` and are called per access, so mid-run expiry/revocation takes effect immediately.
- Both ALLOW and DENY decisions are persisted as `RunEvent` type `policy.decision` (severity `info` / `warning`), `detail` = `JSON.stringify(PolicyDecision)`.
- No behavior change for requests without `x-principal-id` — baseline Playground flow must pass untouched.
- Rule IDs exactly as spec: `AUTHZ-OWNER-010`, `AUTHZ-GRANT-011`, `AUTHZ-EXPIRED-012`, `AUTHZ-REVOKED-013`, `NET-EGRESS-020`.
- Run `npm run check` at the end of every task.

---

### Task 1: Shared contract types + Database v4 migration

**Files:**
- Modify: `apps/server/src/types.ts`
- Modify: `apps/server/src/store.ts`
- Test: `apps/server/src/store.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: every type in the spec's "New types" and "Extended existing types" sections, verbatim — `Principal`, `PrincipalKind`, `GrantScope`, `Grant`, `MockResource`, `PolicyDecision`, `EvalCase`, `FleetTopic`, `FleetTurn`; `Agent.ownerId: string`, `Agent.principalId: string`; `RunEventType` additions (`policy.decision`, `grant.created`, `grant.revoked`, `grant.expired`, `egress.blocked`, `eval.captured`, `eval.replayed`, `budget.anomaly`, `budget.degraded`, `fleet.turn`, `fleet.timeout`); `Database` v4 with `principals`, `grants`, `resources`, `evalCases`, `fleetTopics`, `fleetTurns`. WS-B/C/D/E all import these exact names.

- [ ] **Step 1: Write the failing migration test**

Append to `apps/server/src/store.test.ts` inside `describe("JsonStore", ...)`:

```ts
it("migrates v3 databases to v4 with seeded principals and resources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
  temporaryDirectories.push(root);
  const filePath = path.join(root, "db.json");
  const v3 = {
    version: 3,
    agents: [{
      id: "agent-1", name: "A", description: "", instructions: "",
      status: "ready", workspacePath: "/tmp/ws", codexThreadId: null,
      activeSessionId: null, lastError: null,
      createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z",
    }],
    sessions: [], messages: [], runs: [], runEvents: [], approvals: [],
  };
  await writeFile(filePath, JSON.stringify(v3), "utf8");
  const store = new JsonStore(filePath);
  await store.initialize();
  const database = store.snapshot();
  expect(database.version).toBe(4);
  expect(database.principals.map((p) => p.id)).toEqual(
    expect.arrayContaining(["user-a", "user-b", "agent-agent-1"]),
  );
  expect(database.resources.map((r) => r.id)).toEqual(["res-a", "res-b"]);
  expect(database.agents[0]?.ownerId).toBe("user-a");
  expect(database.agents[0]?.principalId).toBe("agent-agent-1");
  expect(database.grants).toEqual([]);
  expect(database.evalCases).toEqual([]);
  expect(database.fleetTopics).toEqual([]);
  expect(database.fleetTurns).toEqual([]);
});
```

Add `writeFile` to the existing `node:fs/promises` import in the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- store.test`
Expected: FAIL (`version` is 3, `principals` undefined).

- [ ] **Step 3: Add types**

In `apps/server/src/types.ts`: paste the spec's "New types" block verbatim. Then:
- Add to `Agent`: `ownerId: string;` and `principalId: string;` (after `instructions`).
- Extend `RunEventType` union with the 11 new members listed in Interfaces above.
- Change `Database` to:

```ts
export interface Database {
  version: 4;
  agents: Agent[];
  sessions: AgentSession[];
  messages: Message[];
  runs: AgentRun[];
  runEvents: RunEvent[];
  approvals: ApprovalRequest[];
  principals: Principal[];
  grants: Grant[];
  resources: MockResource[];
  evalCases: EvalCase[];
  fleetTopics: FleetTopic[];
  fleetTurns: FleetTurn[];
}
```

- [ ] **Step 4: Implement migration**

In `apps/server/src/store.ts`:
- `emptyDatabase()`: `version: 4` plus the six new empty arrays, and seed function below applied.
- Add:

```ts
const SEED_HUMANS: Principal[] = [
  { id: "user-a", kind: "human", name: "User A", createdAt: "2026-08-30T00:00:00.000Z" },
  { id: "user-b", kind: "human", name: "User B", createdAt: "2026-08-30T00:00:00.000Z" },
];
const SEED_RESOURCES: MockResource[] = [
  { id: "res-a", ownerId: "user-a", name: "User A customer list", content: "alpha,beta,gamma" },
  { id: "res-b", ownerId: "user-b", name: "User B payroll", content: "confidential-b" },
];

function migrateV3ToV4(v3: Database3Shape): Database {
  const principals: Principal[] = [
    ...SEED_HUMANS,
    ...v3.agents.map((a) => ({
      id: `agent-${a.id}`, kind: "agent" as const, name: a.name,
      createdAt: a.createdAt,
    })),
  ];
  return {
    version: 4,
    agents: v3.agents.map((a) => ({ ...a, ownerId: "user-a", principalId: `agent-${a.id}` })),
    sessions: v3.sessions, messages: v3.messages, runs: v3.runs,
    runEvents: v3.runEvents, approvals: v3.approvals,
    principals, grants: [], resources: SEED_RESOURCES,
    evalCases: [], fleetTopics: [], fleetTurns: [],
  };
}
```

(`Database3Shape` = a local interface matching today's v3 `Database`; keep the existing v1/v2→v3 path and chain it into `migrateV3ToV4`. `migrateDatabase` returns v4 for `parsed.version === 4` by validating arrays the same way the current v3 branch does.) Ensure `emptyDatabase()` also contains `SEED_HUMANS` and `SEED_RESOURCES` so fresh installs are seeded.

- [ ] **Step 5: Run tests, fix compile fallout, verify pass**

Run: `npm test --workspace apps/server -- store.test` then `npm run check`.
Expected: store tests PASS. `check` will flag every site constructing an `Agent` without `ownerId`/`principalId` (agent-service, tests) — fix by adding `ownerId: "user-a", principalId: \`agent-${id}\`` at those construction sites (proper header wiring lands in Task 4).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/types.ts apps/server/src/store.ts apps/server/src/store.test.ts apps/server/src/agent-service.ts
git commit -m "feat(identity): shared contract types and database v4 migration with seeded principals"
```

---

### Task 2: Policy evaluators — `evaluateResourceAccess` and `evaluateEgress`

**Files:**
- Modify: `apps/server/src/run-policies.ts`
- Test: `apps/server/src/run-policies.test.ts` (create if absent; check for an existing one first and append)

**Interfaces:**
- Consumes: `Grant`, `MockResource`, `PolicyDecision` from Task 1.
- Produces (exact signatures — WS-B consumes `evaluateEgress`, routes in Task 3 consume both):

```ts
export function evaluateResourceAccess(
  agentPrincipalId: string, agentOwnerId: string,
  resource: MockResource, grants: Grant[], nowIso: string,
): PolicyDecision;
export function evaluateEgress(
  agentPrincipalId: string, host: string, grants: Grant[], nowIso: string,
): PolicyDecision;
```

Also extend: `export type RunPolicyKind = "canary" | "budget" | "approval" | "authz" | "egress" | "anomaly";`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { evaluateEgress, evaluateResourceAccess } from "./run-policies.js";
import type { Grant, MockResource } from "./types.js";

const NOW = "2026-08-30T12:00:00.000Z";
const resA: MockResource = { id: "res-a", ownerId: "user-a", name: "r", content: "c" };
const grant = (over: Partial<Grant>): Grant => ({
  id: "g1", principalId: "agent-1", grantedBy: "user-a",
  scope: "resource:read", target: "res-a",
  expiresAt: null, revokedAt: null, createdAt: NOW, ...over,
});

describe("evaluateResourceAccess", () => {
  it("denies cross-user access even with a grant (AUTHZ-OWNER-010)", () => {
    const decision = evaluateResourceAccess("agent-1", "user-b", resA, [grant({})], NOW);
    expect(decision).toMatchObject({ allowed: false, ruleId: "AUTHZ-OWNER-010" });
  });
  it("denies same-user access without a grant (AUTHZ-GRANT-011)", () => {
    const decision = evaluateResourceAccess("agent-1", "user-a", resA, [], NOW);
    expect(decision).toMatchObject({ allowed: false, ruleId: "AUTHZ-GRANT-011" });
  });
  it("allows with an active matching grant (AUTHZ-GRANT-011)", () => {
    const decision = evaluateResourceAccess("agent-1", "user-a", resA, [grant({})], NOW);
    expect(decision).toMatchObject({ allowed: true, ruleId: "AUTHZ-GRANT-011", grantId: "g1" });
  });
  it("denies when the grant expired (AUTHZ-EXPIRED-012)", () => {
    const expired = grant({ expiresAt: "2026-08-30T11:00:00.000Z" });
    const decision = evaluateResourceAccess("agent-1", "user-a", resA, [expired], NOW);
    expect(decision).toMatchObject({ allowed: false, ruleId: "AUTHZ-EXPIRED-012" });
  });
  it("denies when the grant was revoked (AUTHZ-REVOKED-013)", () => {
    const revoked = grant({ revokedAt: "2026-08-30T11:30:00.000Z" });
    const decision = evaluateResourceAccess("agent-1", "user-a", resA, [revoked], NOW);
    expect(decision).toMatchObject({ allowed: false, ruleId: "AUTHZ-REVOKED-013" });
  });
});

describe("evaluateEgress", () => {
  it("denies by default (NET-EGRESS-020)", () => {
    expect(evaluateEgress("agent-1", "attacker.com", [], NOW)).toMatchObject({
      allowed: false, ruleId: "NET-EGRESS-020",
    });
  });
  it("allows a host with an active network grant", () => {
    const g = grant({ scope: "network:egress", target: "registry.npmjs.org" });
    expect(evaluateEgress("agent-1", "registry.npmjs.org", [g], NOW)).toMatchObject({
      allowed: true, grantId: "g1",
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test --workspace apps/server -- run-policies.test`
Expected: FAIL, functions not exported.

- [ ] **Step 3: Implement**

In `run-policies.ts`:

```ts
function activeGrant(
  grants: Grant[], principalId: string, scope: GrantScope, target: string, nowIso: string,
): { grant: Grant | null; ruleId: string } {
  const matching = grants.filter(
    (g) => g.principalId === principalId && g.scope === scope && g.target === target,
  );
  if (matching.length === 0) return { grant: null, ruleId: scope === "network:egress" ? "NET-EGRESS-020" : "AUTHZ-GRANT-011" };
  const revoked = matching.every((g) => g.revokedAt !== null);
  const live = matching.find(
    (g) => g.revokedAt === null && (g.expiresAt === null || g.expiresAt > nowIso),
  );
  if (live) return { grant: live, ruleId: scope === "network:egress" ? "NET-EGRESS-020" : "AUTHZ-GRANT-011" };
  return { grant: null, ruleId: revoked ? "AUTHZ-REVOKED-013" : "AUTHZ-EXPIRED-012" };
}

export function evaluateResourceAccess(
  agentPrincipalId: string, agentOwnerId: string,
  resource: MockResource, grants: Grant[], nowIso: string,
): PolicyDecision {
  if (resource.ownerId !== agentOwnerId) {
    return {
      allowed: false, ruleId: "AUTHZ-OWNER-010",
      reason: `Agent owned by ${agentOwnerId} may never access ${resource.ownerId}'s resource.`,
      principalId: agentPrincipalId, grantId: null,
    };
  }
  const { grant, ruleId } = activeGrant(grants, agentPrincipalId, "resource:read", resource.id, nowIso);
  if (grant) {
    return {
      allowed: true, ruleId: "AUTHZ-GRANT-011",
      reason: `Active grant ${grant.id} authorizes resource:read on ${resource.id}.`,
      principalId: agentPrincipalId, grantId: grant.id,
    };
  }
  return {
    allowed: false, ruleId,
    reason: `No active resource:read grant for ${resource.id}.`,
    principalId: agentPrincipalId, grantId: null,
  };
}

export function evaluateEgress(
  agentPrincipalId: string, host: string, grants: Grant[], nowIso: string,
): PolicyDecision {
  const { grant } = activeGrant(grants, agentPrincipalId, "network:egress", host, nowIso);
  if (grant) {
    return {
      allowed: true, ruleId: "NET-EGRESS-020",
      reason: `Active grant ${grant.id} authorizes egress to ${host}.`,
      principalId: agentPrincipalId, grantId: grant.id,
    };
  }
  return {
    allowed: false, ruleId: "NET-EGRESS-020",
    reason: `Default-deny egress: no active network:egress grant for ${host}.`,
    principalId: agentPrincipalId, grantId: null,
  };
}
```

Import `Grant`, `GrantScope`, `MockResource`, `PolicyDecision` from `./types.js`. Extend `RunPolicyKind` as in Interfaces.

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test --workspace apps/server -- run-policies.test`
Expected: 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/run-policies.ts apps/server/src/run-policies.test.ts
git commit -m "feat(identity): ownership and grant policy evaluators with default-deny egress"
```

---

### Task 3: Identity service + API routes

**Files:**
- Create: `apps/server/src/identity.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/identity.test.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 2 evaluators, `JsonStore` (`snapshot`/`mutate`).
- Produces:

```ts
export class IdentityService {
  constructor(private readonly store: JsonStore) {}
  listPrincipals(): Principal[];
  listGrants(principalId?: string): Grant[];
  async createGrant(input: { principalId: string; grantedBy: string; scope: GrantScope; target: string; ttlMinutes?: number | null }): Promise<Grant>;
  async revokeGrant(id: string): Promise<Grant>;                    // sets revokedAt, throws HttpError 404 if missing
  async readResourceAsAgent(resourceId: string, agentPrincipalId: string): Promise<{ resource: MockResource | null; decision: PolicyDecision }>;
}
```

Routes: `GET /api/principals`, `GET /api/grants?principalId=`, `POST /api/grants`, `POST /api/grants/:id/revoke`, `GET /api/resources/:id` (agent path via `x-agent-principal-id` header). WS-E consumes `listGrants` for participant checks.

- [ ] **Step 1: Write failing service tests**

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IdentityService } from "./identity.js";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeService(): Promise<IdentityService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-identity-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    database.principals.push({ id: "agent-1", kind: "agent", name: "A1", createdAt: new Date().toISOString() });
  });
  return new IdentityService(store);
}

describe("IdentityService", () => {
  it("creates a grant with ttl and lists it", async () => {
    const service = await makeService();
    const grant = await service.createGrant({
      principalId: "agent-1", grantedBy: "user-a",
      scope: "resource:read", target: "res-a", ttlMinutes: 30,
    });
    expect(grant.expiresAt).not.toBeNull();
    expect(service.listGrants("agent-1")).toHaveLength(1);
  });
  it("revokes a grant so later evaluation denies", async () => {
    const service = await makeService();
    const grant = await service.createGrant({
      principalId: "agent-1", grantedBy: "user-a", scope: "resource:read", target: "res-a",
    });
    await service.revokeGrant(grant.id);
    const denied = await service.readResourceAsAgent("res-a", "agent-1");
    expect(denied.decision).toMatchObject({ allowed: false, ruleId: "AUTHZ-REVOKED-013" });
  });
  it("returns resource content only when the decision allows", async () => {
    const service = await makeService();
    const before = await service.readResourceAsAgent("res-a", "agent-1");
    expect(before.resource).toBeNull();
    await service.createGrant({
      principalId: "agent-1", grantedBy: "user-a", scope: "resource:read", target: "res-a",
    });
    const after = await service.readResourceAsAgent("res-a", "agent-1");
    expect(after.resource?.content).toBe("alpha,beta,gamma");
  });
});
```

Note: `readResourceAsAgent` resolves the owning agent by `principalId` to get `ownerId`; when no agent record matches the principal (as in this seed-less test), treat the grant's `grantedBy`… **No — keep it simple and deterministic:** resolve `agentOwnerId` from the agents table; if absent, default `"user-a"` (matches migration default; document in code comment-free reason string).

- [ ] **Step 2: Run to verify failure**

Run: `npm test --workspace apps/server -- identity.test`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement `identity.ts`**

```ts
import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import { evaluateResourceAccess } from "./run-policies.js";
import type { JsonStore } from "./store.js";
import type { Grant, GrantScope, MockResource, PolicyDecision, Principal } from "./types.js";

export class IdentityService {
  constructor(private readonly store: JsonStore) {}

  listPrincipals(): Principal[] {
    return this.store.snapshot().principals;
  }

  listGrants(principalId?: string): Grant[] {
    const grants = this.store.snapshot().grants;
    return principalId ? grants.filter((g) => g.principalId === principalId) : grants;
  }

  async createGrant(input: {
    principalId: string; grantedBy: string; scope: GrantScope; target: string;
    ttlMinutes?: number | null;
  }): Promise<Grant> {
    const now = new Date();
    const grant: Grant = {
      id: randomUUID(),
      principalId: input.principalId,
      grantedBy: input.grantedBy,
      scope: input.scope,
      target: input.target,
      expiresAt: input.ttlMinutes
        ? new Date(now.getTime() + input.ttlMinutes * 60_000).toISOString()
        : null,
      revokedAt: null,
      createdAt: now.toISOString(),
    };
    await this.store.mutate((database) => {
      if (!database.principals.some((p) => p.id === input.principalId)) {
        throw new HttpError(404, `Unknown principal ${input.principalId}`);
      }
      database.grants.push(grant);
    });
    return grant;
  }

  async revokeGrant(id: string): Promise<Grant> {
    return this.store.mutate((database) => {
      const grant = database.grants.find((g) => g.id === id);
      if (!grant) throw new HttpError(404, `Unknown grant ${id}`);
      grant.revokedAt = new Date().toISOString();
      return structuredClone(grant);
    });
  }

  async readResourceAsAgent(
    resourceId: string, agentPrincipalId: string,
  ): Promise<{ resource: MockResource | null; decision: PolicyDecision }> {
    const database = this.store.snapshot();
    const resource = database.resources.find((r) => r.id === resourceId);
    if (!resource) throw new HttpError(404, `Unknown resource ${resourceId}`);
    const agent = database.agents.find((a) => a.principalId === agentPrincipalId);
    const ownerId = agent?.ownerId ?? "user-a";
    const decision = evaluateResourceAccess(
      agentPrincipalId, ownerId, resource, database.grants, new Date().toISOString(),
    );
    return { resource: decision.allowed ? resource : null, decision };
  }
}
```

- [ ] **Step 4: Run service tests, verify pass**

Run: `npm test --workspace apps/server -- identity.test`
Expected: 3 PASS.

- [ ] **Step 5: Add routes**

In `app.ts` (mirror existing route style; `IdentityService` constructed alongside `AgentService` — check `index.ts`/`buildApp` wiring and pass it in the same way `service` is):

```ts
app.get("/api/principals", async () => ({ principals: identity.listPrincipals() }));

app.get("/api/grants", async (request) => {
  const { principalId } = request.query as { principalId?: string };
  return { grants: identity.listGrants(principalId) };
});

app.post("/api/grants", async (request, reply) => {
  const body = request.body as {
    principalId: string; scope: GrantScope; target: string; ttlMinutes?: number | null;
  };
  const grantedBy = (request.headers["x-principal-id"] as string | undefined) ?? "user-a";
  const grant = await identity.createGrant({ ...body, grantedBy });
  return reply.code(201).send({ grant });
});

app.post("/api/grants/:id/revoke", async (request) => {
  const { id } = request.params as { id: string };
  return { grant: await identity.revokeGrant(id) };
});

app.get("/api/resources/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const agentPrincipalId = request.headers["x-agent-principal-id"] as string | undefined;
  if (!agentPrincipalId) return reply.code(400).send({ error: "x-agent-principal-id header required" });
  const { resource, decision } = await identity.readResourceAsAgent(id, agentPrincipalId);
  if (!decision.allowed) return reply.code(403).send({ error: decision.reason, decision });
  return { resource, decision };
});
```

Add validation to POST /api/grants: reject scope not in `["resource:read", "resource:write", "network:egress"]` with 400 (same pattern as existing body validation in `app.ts` — read how POST /api/agents validates and copy it).

- [ ] **Step 6: Write failing route tests, then verify**

Append to `apps/server/src/app.test.ts` (follow its existing inject-style tests):

```ts
it("denies an agent access to another user's resource server-side", async () => {
  // create agent as user-a (default header), then:
  const denied = await app.inject({
    method: "GET", url: "/api/resources/res-b",
    headers: { "x-agent-principal-id": agentPrincipalId },
  });
  expect(denied.statusCode).toBe(403);
  expect(denied.json().decision.ruleId).toBe("AUTHZ-OWNER-010");
});
```

(Adapt setup to `app.test.ts`'s existing bootstrap for creating an agent; `agentPrincipalId` comes from the create-agent response after Task 4.) Run: `npm test --workspace apps/server -- app.test` → PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/identity.ts apps/server/src/identity.test.ts apps/server/src/app.ts apps/server/src/app.test.ts
git commit -m "feat(identity): identity service with grant lifecycle and authz-enforced resource routes"
```

---

### Task 4: Owner stamping on agent creation + decision trace events

**Files:**
- Modify: `apps/server/src/agent-service.ts` (createAgent ~line 98; the private event-append helper used by executeRun — find `runEvents.push` call sites)
- Modify: `apps/server/src/app.ts` (POST /api/agents passes actor)
- Test: `apps/server/src/agent-service.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `createAgent(input: CreateAgentInput, actorPrincipalId?: string)` — stamps `ownerId` = actor (default `"user-a"`), `principalId` = `agent-<id>`, and appends the agent principal to `database.principals` in the same mutation. Also a public helper WS-B/D/E consume:

```ts
async recordPolicyDecision(runId: string, agentId: string, decision: PolicyDecision): Promise<void>;
// appends RunEvent { type: "policy.decision", severity: decision.allowed ? "info" : "warning",
//   title: decision.ruleId, detail: JSON.stringify(decision) }
```

- [ ] **Step 1: Write failing test**

Append to `agent-service.test.ts` (reuse its existing service bootstrap pattern):

```ts
it("stamps ownership and creates an agent principal on create", async () => {
  const agent = await service.createAgent({ name: "Owned" }, "user-b");
  expect(agent.ownerId).toBe("user-b");
  expect(agent.principalId).toBe(`agent-${agent.id}`);
  const principals = store.snapshot().principals;
  expect(principals.some((p) => p.id === agent.principalId && p.kind === "agent")).toBe(true);
});

it("records policy decisions as run events", async () => {
  const agent = await service.createAgent({ name: "Traced" }, "user-a");
  await service.recordPolicyDecision("run-x", agent.id, {
    allowed: false, ruleId: "AUTHZ-OWNER-010", reason: "test",
    principalId: agent.principalId, grantId: null,
  });
  const events = store.snapshot().runEvents.filter((e) => e.type === "policy.decision");
  expect(events).toHaveLength(1);
  expect(events[0]?.severity).toBe("warning");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test --workspace apps/server -- agent-service.test`
Expected: FAIL (signature/method missing).

- [ ] **Step 3: Implement**

In `createAgent`, add the parameter `actorPrincipalId = "user-a"`, set `ownerId: actorPrincipalId`, `principalId: \`agent-${id}\`` on the new agent object, and inside the same `store.mutate` push `{ id: principalId, kind: "agent", name: input.name, createdAt }` to `database.principals`. Add `recordPolicyDecision` using the same RunEvent construction the file already uses for step events (match its id/createdAt conventions). In `app.ts` POST /api/agents: `const actor = (request.headers["x-principal-id"] as string | undefined) ?? "user-a";` → `service.createAgent(input, actor)`.

- [ ] **Step 4: Run tests + full check**

Run: `npm test --workspace apps/server` then `npm run check`.
Expected: all PASS (fix any construction sites still missing the new fields).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent-service.ts apps/server/src/agent-service.test.ts apps/server/src/app.ts
git commit -m "feat(identity): stamp agent ownership on create and trace every policy decision"
```

---

### Task 5: Minimal UI — principal switcher + grants panel

**Files:**
- Modify: `apps/web/src/App.tsx`, `apps/web/src/api.ts`, `apps/web/src/types.ts`

**Interfaces:**
- Consumes: routes from Task 3/4.
- Produces: a header select (`user-a` / `user-b`) whose value is sent as `x-principal-id` on every `api.ts` request; an agent-detail "Grants" panel listing the agent principal's grants (scope, target, expiry countdown, revoked badge) with a create form (scope select, target input, TTL minutes input) and a Revoke button per row. Mirror the spec: WS-C/D/E add their own panels separately — keep this panel a self-contained component function inside App.tsx (`function GrantsPanel(...)`) to avoid merge conflicts.

- [ ] **Step 1: Extend `api.ts`** — add a module-level `let currentPrincipalId = "user-a"` + `setPrincipal(id)` export; include the header in the existing fetch wrapper; add `listGrants`, `createGrant`, `revokeGrant`, `listPrincipals` functions following the file's existing style.
- [ ] **Step 2: Add the switcher + GrantsPanel to `App.tsx`** — copy existing panel markup/classes from the approvals panel for visual consistency; countdown = `Math.max(0, expiresAt - now)` rendered as mm:ss, re-computed on the existing poll tick.
- [ ] **Step 3: Manual verification** — `npm run poc`; as user-a create agent + grant on res-a; agent run that curls `/api/resources/res-a` succeeds; switch to user-b, same request path on res-b denied 403; revoke grant → next access denied; trace shows `policy.decision` events for each.
- [ ] **Step 4: Run `npm run check`** — expected green (web build included).
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/api.ts apps/web/src/types.ts
git commit -m "feat(identity): principal switcher and grants panel in the cockpit"
```

---

## Self-review notes

- Spec coverage: types/migration (T1), evaluators + all five rule IDs (T2), grant lifecycle + resource authz routes (T3), owner stamping + `policy.decision` events (T4), UI (T5). Mid-run expiry needs no extra machinery: evaluators take `nowIso` per call (asserted in T2/T3 tests).
- `recordPolicyDecision` is the single event helper B/D/E consume — name is frozen here.
- Egress *enforcement* is WS-B; this plan only ships `evaluateEgress` (T2) so B can build against it immediately.

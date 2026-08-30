import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EgressAuthorizer } from "./egress-authorizer.js";
import { JsonStore } from "./store.js";
import type { Grant } from "./types.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = `agent-${AGENT_ID}`;

async function makeStore(grants: Grant[] = []): Promise<JsonStore> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-egress-authz-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    database.agents.push({
      id: AGENT_ID,
      name: "Egress",
      description: "",
      instructions: "",
      ownerId: "user-a",
      principalId: PRINCIPAL,
      status: "ready",
      workspacePath: "/tmp/ws",
      codexThreadId: null,
      activeSessionId: null,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    database.grants.push(...grants);
  });
  return store;
}

function grant(over: Partial<Grant> = {}): Grant {
  return {
    id: "grant-1",
    principalId: PRINCIPAL,
    grantedBy: "user-a",
    scope: "network:egress",
    target: "registry.npmjs.org",
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

const baseOptions = { standingAllowHosts: ["host.docker.internal"], quarantineThreshold: 3 };

describe("EgressAuthorizer", () => {
  it("denies a host the agent has no grant for", async () => {
    const authorizer = new EgressAuthorizer(await makeStore(), baseOptions);
    const result = await authorizer.authorize({
      agentPrincipalId: PRINCIPAL, host: "attacker.example", port: 443, method: "CONNECT",
    });
    expect(result).toMatchObject({ allowed: false, ruleId: "NET-EGRESS-020" });
  });

  it("allows a host covered by an active grant", async () => {
    const authorizer = new EgressAuthorizer(await makeStore([grant()]), baseOptions);
    const result = await authorizer.authorize({
      agentPrincipalId: PRINCIPAL, host: "registry.npmjs.org", port: 443, method: "CONNECT",
    });
    expect(result.allowed).toBe(true);
  });

  it("allows platform hosts without a grant so the runtime can reach the model", async () => {
    const authorizer = new EgressAuthorizer(await makeStore(), baseOptions);
    const result = await authorizer.authorize({
      agentPrincipalId: PRINCIPAL, host: "host.docker.internal", port: 3000, method: "CONNECT",
    });
    expect(result).toMatchObject({ allowed: true, ruleId: "NET-EGRESS-PLATFORM-021" });
  });

  it("denies once a grant is revoked, with no cached decision", async () => {
    const store = await makeStore([grant()]);
    const authorizer = new EgressAuthorizer(store, baseOptions);
    const target = {
      agentPrincipalId: PRINCIPAL, host: "registry.npmjs.org", port: 443, method: "CONNECT",
    };
    expect((await authorizer.authorize(target)).allowed).toBe(true);

    await store.mutate((database) => {
      const stored = database.grants.find((g) => g.id === "grant-1");
      if (stored) stored.revokedAt = new Date().toISOString();
    });

    expect(await authorizer.authorize(target)).toMatchObject({
      allowed: false, ruleId: "AUTHZ-REVOKED-013",
    });
  });

  it("records a blocked event per denial and quarantines at the threshold", async () => {
    const blocked: number[] = [];
    const quarantined: string[] = [];
    const authorizer = new EgressAuthorizer(await makeStore(), {
      ...baseOptions,
      recordBlocked: (_runId, _agentId, _input, _decision, strikes) => {
        blocked.push(strikes);
      },
      quarantineAgent: (agentId) => {
        quarantined.push(agentId);
      },
    });
    const attempt = {
      agentPrincipalId: PRINCIPAL, host: "attacker.example", port: 443, method: "CONNECT",
    };
    await authorizer.authorize(attempt);
    await authorizer.authorize(attempt);
    expect(quarantined).toEqual([]);

    const third = await authorizer.authorize(attempt);
    expect(blocked).toEqual([1, 2, 3]);
    expect(third.quarantined).toBe(true);
    expect(quarantined).toEqual([AGENT_ID]);
  });

  it("does not count allowed connections as strikes", async () => {
    const authorizer = new EgressAuthorizer(await makeStore([grant()]), baseOptions);
    for (let i = 0; i < 5; i += 1) {
      await authorizer.authorize({
        agentPrincipalId: PRINCIPAL, host: "registry.npmjs.org", port: 443, method: "CONNECT",
      });
    }
    expect(authorizer.strikesFor(AGENT_ID)).toBe(0);
  });

  it("denies an unknown principal", async () => {
    const authorizer = new EgressAuthorizer(await makeStore([grant()]), baseOptions);
    const result = await authorizer.authorize({
      agentPrincipalId: "agent-unknown", host: "registry.npmjs.org", port: 443, method: "CONNECT",
    });
    expect(result.allowed).toBe(false);
  });
});

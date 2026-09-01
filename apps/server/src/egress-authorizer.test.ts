import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EgressAuthorizer,
  egressProxySecret,
  MAX_CONCURRENT_HELD_REQUESTS,
} from "./egress-authorizer.js";
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
    revokedBy: null,
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

  it("refuses a principal presented without its secret", async () => {
    const authorizer = new EgressAuthorizer(await makeStore([grant()]), {
      ...baseOptions,
      serverKey: "server-key",
    });
    const result = await authorizer.authorize({
      agentPrincipalId: PRINCIPAL, host: "registry.npmjs.org", port: 443, method: "CONNECT",
      secret: "guessed",
    });
    expect(result).toMatchObject({ allowed: false, ruleId: "NET-EGRESS-IMPERSONATION-023" });
  });

  it("allows the same principal when it presents the derived secret", async () => {
    const authorizer = new EgressAuthorizer(await makeStore([grant()]), {
      ...baseOptions,
      serverKey: "server-key",
    });
    const result = await authorizer.authorize({
      agentPrincipalId: PRINCIPAL, host: "registry.npmjs.org", port: 443, method: "CONNECT",
      secret: egressProxySecret(PRINCIPAL, "server-key"),
    });
    expect(result.allowed).toBe(true);
  });

  it("never derives agent credentials from an empty or public fallback key", () => {
    expect(() => egressProxySecret(PRINCIPAL, "")).toThrow("internal agent secret");
    expect(egressProxySecret(PRINCIPAL, "process-a")).not.toBe(
      egressProxySecret(PRINCIPAL, "process-b"),
    );
  });

  it("permits a private address only for platform hosts", async () => {
    // allowPrivate switches off the proxy's SSRF guard, so it must never be
    // reachable through a grant an agent's owner could create.
    const authorizer = new EgressAuthorizer(
      await makeStore([grant({ target: "attacker.example" })]),
      baseOptions,
    );
    const platform = await authorizer.authorize({
      agentPrincipalId: PRINCIPAL, host: "host.docker.internal", port: 3000, method: "CONNECT",
    });
    expect(platform).toMatchObject({ allowed: true, allowPrivate: true });

    // Granted, allowed — but still not trusted to resolve privately.
    const granted = await authorizer.authorize({
      agentPrincipalId: PRINCIPAL, host: "attacker.example", port: 443, method: "CONNECT",
    });
    expect(granted.allowed).toBe(true);
    expect(granted.allowPrivate).toBe(false);
  });

  it("scopes a platform allowance to its port", async () => {
    // The control plane shares a host with anything else bound to the gateway
    // address; a bare-host allowance would hand every agent all of them.
    const authorizer = new EgressAuthorizer(await makeStore(), {
      ...baseOptions,
      standingAllowHosts: ["host.docker.internal:3000"],
    });
    const onPort = await authorizer.authorize({
      agentPrincipalId: PRINCIPAL, host: "host.docker.internal", port: 3000, method: "CONNECT",
    });
    expect(onPort).toMatchObject({ allowed: true, ruleId: "NET-EGRESS-PLATFORM-021" });

    const otherPort = await authorizer.authorize({
      agentPrincipalId: PRINCIPAL, host: "host.docker.internal", port: 9229, method: "CONNECT",
    });
    expect(otherPort.allowed).toBe(false);
  });

  it("denies an unknown principal", async () => {
    const authorizer = new EgressAuthorizer(await makeStore([grant()]), baseOptions);
    const result = await authorizer.authorize({
      agentPrincipalId: "agent-unknown", host: "registry.npmjs.org", port: 443, method: "CONNECT",
    });
    expect(result.allowed).toBe(false);
  });

  it("bounds how many requests one agent can hold awaiting approval", async () => {
    // A hijacked agent must not be able to mint unbounded operator decisions.
    // Approvals that never resolve would otherwise flood the queue before a
    // single strike is recorded, so quarantine could never fire.
    let asked = 0;
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authorizer = new EgressAuthorizer(await makeStore(), {
      ...baseOptions,
      quarantineThreshold: 99,
      requestApproval: async () => {
        asked += 1;
        await held; // never resolves during the test: these stay held
        return false;
      },
    });

    const inFlight = Array.from({ length: MAX_CONCURRENT_HELD_REQUESTS }, (_unused, index) =>
      authorizer.authorize({
        agentPrincipalId: PRINCIPAL, host: `held-${index}.example`, port: 443, method: "CONNECT",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toBe(MAX_CONCURRENT_HELD_REQUESTS);
    expect(authorizer.heldFor(AGENT_ID)).toBe(MAX_CONCURRENT_HELD_REQUESTS);

    // One past the cap is refused immediately, without asking anyone.
    const overflow = await authorizer.authorize({
      agentPrincipalId: PRINCIPAL, host: "overflow.example", port: 443, method: "CONNECT",
    });
    expect(overflow).toMatchObject({ allowed: false, ruleId: "HITL-EGRESS-FLOOD-027" });
    expect(asked).toBe(MAX_CONCURRENT_HELD_REQUESTS);
    // It still counts as a blocked attempt, so flooding leads to quarantine.
    expect(overflow.strikes).toBeGreaterThan(0);

    release?.();
    await Promise.all(inFlight);
    // Slots are returned once the held requests resolve.
    expect(authorizer.heldFor(AGENT_ID)).toBe(0);
  });

  it("frees a held slot when the approval call throws", async () => {
    const authorizer = new EgressAuthorizer(await makeStore(), {
      ...baseOptions,
      requestApproval: async () => {
        throw new Error("control plane unavailable");
      },
    });
    const result = await authorizer.authorize({
      agentPrincipalId: PRINCIPAL, host: "attacker.example", port: 443, method: "CONNECT",
    });
    expect(result.allowed).toBe(false);
    expect(authorizer.heldFor(AGENT_ID)).toBe(0);
  });
});

import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import type { EgressNetworkManager } from "./egress-network.js";
import { IdentityService } from "./identity.js";
import { JsonStore } from "./store.js";
import { receiptKeyId, verifyReceipt, type ReceiptKeyPair } from "./termination.js";
import { AgentTerminator } from "./terminator.js";
import type { AgentRunner, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

function receiptKeys(): ReceiptKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKeyPem, publicKeyPem, keyId: receiptKeyId(publicKeyPem) };
}

async function harness(runner: AgentRunner) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-terminator-test-"));
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
    runner,
  );
  await service.initialize();
  const identity = new IdentityService(store);
  const keys = receiptKeys();
  return {
    service,
    store,
    identity,
    keys,
    terminator: new AgentTerminator(store, service, identity, keys),
  };
}

describe("AgentTerminator", () => {
  it("blocks authority, revokes grants, stops the runtime, and signs verifiable evidence", async () => {
    const { service, identity, keys, terminator } = await harness({
      run: async () => ({ output: "done", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Contained" });
    await identity.createGrant({
      principalId: agent.principalId,
      grantedBy: "user-a",
      scope: "network:egress",
      target: "example.com",
    });

    const receipt = await terminator.terminate(agent.id, "Suspected compromise");

    expect(receipt.steps.map((step) => step.step)).toEqual([
      "freeze",
      "revoke",
      "kill",
      "verify",
    ]);
    expect(receipt.contained).toBe(true);
    expect(verifyReceipt(receipt, keys.publicKeyPem).valid).toBe(true);
    expect(service.getAgent(agent.id)).toMatchObject({
      status: "stopped",
      authorityBlocked: true,
    });
    expect(identity.listGrants(agent.principalId)[0]?.revokedAt).not.toBeNull();
    await expect(identity.createGrant({
      principalId: agent.principalId,
      grantedBy: "user-a",
      scope: "network:egress",
      target: "attacker.example",
    })).rejects.toMatchObject({ statusCode: 409 });

    await service.startAgent(agent.id);
    await expect(identity.createGrant({
      principalId: agent.principalId,
      grantedBy: "user-a",
      scope: "network:egress",
      target: "example.com",
    })).resolves.toMatchObject({ target: "example.com" });
  });

  it("kills before revoking and refuses to claim containment when freezing fails", async () => {
    let running = false;
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const { service, terminator, keys } = await harness({
      run: () => {
        running = true;
        return pending;
      },
      cancel: async () => {
        running = false;
        finish({ output: "cancelled", threadId: null, usage: null });
        return true;
      },
      pause: async () => "failed",
      isRunning: () => running,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Unfreezable" });
    await service.sendMessage(agent.id, "keep running");
    await expect.poll(() => running).toBe(true);

    const receipt = await terminator.terminate(agent.id, "Freeze failed");

    expect(receipt.steps.map((step) => step.step)).toEqual([
      "freeze",
      "kill",
      "revoke",
      "verify",
    ]);
    expect(receipt.steps[0]).toMatchObject({ ok: false });
    expect(receipt.contained).toBe(false);
    expect(verifyReceipt(receipt, keys.publicKeyPem).valid).toBe(true);
    expect(service.getAgent(agent.id).status).toBe("stopped");
  });

  it("says a runtime cannot freeze rather than reporting a failed freeze attempt", async () => {
    let running = false;
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    // `pause` is optional on AgentRunner, so this runner shape is legal.
    const { service, terminator, keys } = await harness({
      run: () => {
        running = true;
        return pending;
      },
      cancel: async () => {
        running = false;
        finish({ output: "cancelled", threadId: null, usage: null });
        return true;
      },
      isRunning: () => running,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Unfreezable" });
    await service.sendMessage(agent.id, "keep running");
    await expect.poll(() => running).toBe(true);

    const receipt = await terminator.terminate(agent.id, "No freeze control");

    // Still fail-closed: a live run that cannot be frozen is not containment.
    expect(receipt.steps[0]).toMatchObject({
      step: "freeze",
      ok: false,
      detail: "A live execution exists under a runtime with no freeze control.",
    });
    expect(receipt.contained).toBe(false);
    expect(verifyReceipt(receipt, keys.publicKeyPem).valid).toBe(true);
  });

  it("does not treat an inconclusive network probe as containment evidence", async () => {
    const { service, store, identity, keys } = await harness({
      run: async () => ({ output: "done", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Unconfirmed" });
    const egress = {
      drainPrincipal: async () => 0,
      probeAsAgent: async () => ({
        httpStatus: null,
        blocked: true,
        conclusive: false,
        detail: "container engine unavailable",
      }),
    } as unknown as EgressNetworkManager;
    const terminator = new AgentTerminator(store, service, identity, keys, egress);

    const receipt = await terminator.terminate(agent.id, "Verify the boundary");

    expect(receipt.steps.at(-1)).toMatchObject({
      step: "verify",
      ok: false,
      detail: expect.stringContaining("containment unconfirmed"),
    });
    expect(receipt.contained).toBe(false);
  });

  it("cascades termination revocation through delegated grants", async () => {
    const { service, identity, terminator } = await harness({
      run: async () => ({ output: "done", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const parent = await service.createAgent({ name: "Parent" });
    const child = await service.createAgent({ name: "Child" });
    const root = await identity.createGrant({
      principalId: parent.principalId,
      grantedBy: "user-a",
      scope: "network:egress",
      target: "api.example.com",
    });
    const delegated = await identity.createGrant({
      principalId: child.principalId,
      grantedBy: parent.principalId,
      scope: "network:egress",
      target: "api.example.com",
      ttlMinutes: 5,
    });

    const receipt = await terminator.terminate(parent.id, "Compromised grantor");

    expect(receipt.grantsRevoked).toEqual(expect.arrayContaining([root.id, delegated.id]));
    expect(identity.listGrants(child.principalId)[0]?.revokedAt).not.toBeNull();
  });

  it("queries the real runtime boundary before claiming containment", async () => {
    const { service, terminator } = await harness({
      run: async () => ({ output: "done", threadId: null, usage: null }),
      cancel: async () => false,
      confirmStopped: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Orphaned runtime" });

    const receipt = await terminator.terminate(agent.id, "Verify engine state");

    expect(receipt.steps.at(-1)).toMatchObject({
      step: "verify",
      ok: false,
      detail: expect.stringContaining("runtimeStopped=false"),
    });
    expect(receipt.contained).toBe(false);
  });

  it("drops already-authorized proxy sockets before probing containment", async () => {
    const { service, store, identity, keys } = await harness({
      run: async () => ({ output: "done", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Connected" });
    const order: string[] = [];
    const egress = {
      drainPrincipal: async () => {
        order.push("drain");
        return 1;
      },
      probeAsAgent: async () => {
        order.push("probe");
        return {
          httpStatus: 403,
          blocked: true,
          conclusive: true,
          detail: "proxy refused",
        };
      },
    } as unknown as EgressNetworkManager;
    const terminator = new AgentTerminator(store, service, identity, keys, egress);

    const receipt = await terminator.terminate(agent.id, "Drop in-flight sockets");

    expect(order).toEqual(["drain", "probe"]);
    expect(receipt.contained).toBe(true);
  });

  it("refuses to claim containment when proxy connection draining is unconfirmed", async () => {
    const { service, store, identity, keys } = await harness({
      run: async () => ({ output: "done", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Undrainable" });
    const egress = {
      drainPrincipal: async () => null,
      probeAsAgent: async () => ({
        httpStatus: 403,
        blocked: true,
        conclusive: true,
        detail: "proxy refused",
      }),
    } as unknown as EgressNetworkManager;
    const terminator = new AgentTerminator(store, service, identity, keys, egress);

    const receipt = await terminator.terminate(agent.id, "Drain must be proven");

    expect(receipt.steps.find((step) => step.step === "revoke")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("Could not confirm"),
    });
    expect(receipt.contained).toBe(false);
  });

  it("keeps restart locked down when termination evidence cannot be persisted", async () => {
    const { service, terminator } = await harness({
      run: async () => ({ output: "done", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Receipt write failure" });
    (service as unknown as { recordTermination: () => Promise<void> }).recordTermination =
      async () => {
        throw new Error("disk full");
      };

    await expect(terminator.terminate(agent.id, "Persist evidence")).rejects.toThrow("disk full");
    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("keeps start blocked until termination evidence is persisted", async () => {
    const { service, store, identity, keys } = await harness({
      run: async () => ({ output: "done", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Restart race" });
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    let drainStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      drainStarted = resolve;
    });
    const egress = {
      drainPrincipal: async () => {
        drainStarted();
        await drainGate;
        return 0;
      },
      probeAsAgent: async () => ({
        httpStatus: 403,
        blocked: true,
        conclusive: true,
        detail: "proxy refused",
      }),
    } as unknown as EgressNetworkManager;
    const terminator = new AgentTerminator(store, service, identity, keys, egress);

    const terminating = terminator.terminate(agent.id, "Serialize restart");
    await started;
    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    releaseDrain();
    await expect(terminating).resolves.toMatchObject({ contained: true });
    await expect(service.startAgent(agent.id)).resolves.toMatchObject({ status: "ready" });
  });
});

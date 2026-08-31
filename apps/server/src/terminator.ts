import type { AgentService } from "./agent-service.js";
import type { EgressNetworkManager } from "./egress-network.js";
import type { IdentityService } from "./identity.js";
import type { JsonStore } from "./store.js";
import {
  signReceipt,
  type ReceiptKeyPair,
  type TerminationReceipt,
  type TerminationStep,
  type UnsignedReceipt,
} from "./termination.js";

const now = () => new Date().toISOString();

export class AgentTerminator {
  constructor(
    private readonly store: JsonStore,
    private readonly agents: AgentService,
    private readonly identity: IdentityService,
    private readonly receiptKeys: ReceiptKeyPair,
    private readonly egress?: EgressNetworkManager,
  ) {}

  publicKeyInfo(): { keyId: string; publicKey: string } {
    return { keyId: this.receiptKeys.keyId, publicKey: this.receiptKeys.publicKeyPem };
  }

  async terminate(agentId: string, reason: string): Promise<TerminationReceipt> {
    const agent = this.agents.getAgent(agentId);
    // Raise the admission barrier before anything else, so a run cannot be
    // admitted during the freeze/revoke window and outlive this termination.
    this.agents.beginTermination(agentId);
    const freeze = await this.freeze(agentId);
    const steps: TerminationStep[] = [freeze];
    const revoked: string[] = [];

    if (freeze.ok) {
      steps.push(await this.revokeAndBlock(agentId, agent.principalId, revoked));
      steps.push(await this.kill(agentId, reason));
    } else {
      // If a live runtime could not be frozen, kill it before changing grants.
      // This fallback is safe but cannot claim the requested freeze-first proof.
      steps.push(await this.kill(agentId, reason));
      steps.push(await this.revokeAndBlock(agentId, agent.principalId, revoked));
    }

    steps.push(await this.verifyContainment(agentId, agent.principalId));
    const body: UnsignedReceipt = {
      version: 1,
      keyId: this.receiptKeys.keyId,
      agentId,
      agentPrincipalId: agent.principalId,
      reason,
      issuedAt: now(),
      steps,
      grantsRevoked: revoked,
      contained: steps.every((step) => step.ok),
    };
    const receipt: TerminationReceipt = {
      ...body,
      signature: signReceipt(body, this.receiptKeys.privateKeyPem),
    };

    await this.agents.recordTermination(agentId, receipt);
    return receipt;
  }

  private async freeze(agentId: string): Promise<TerminationStep> {
    try {
      const result = await this.agents.freezeAgent(agentId);
      const details = {
        paused: "Execution suspended at the OS level before authority changed.",
        blocked: "Queued execution blocked before its runtime could start.",
        idle: "No live or queued execution existed.",
        failed: "A live execution could not be suspended.",
        unsupported: "A live execution exists under a runtime with no freeze control.",
      } as const;
      const ok = result !== "failed" && result !== "unsupported";
      return { step: "freeze", ok, detail: details[result], at: now() };
    } catch (error) {
      return { step: "freeze", ok: false, detail: describe(error), at: now() };
    }
  }

  private async revokeAndBlock(
    agentId: string,
    agentPrincipalId: string,
    revoked: string[],
  ): Promise<TerminationStep> {
    try {
      const ids = await this.store.mutate((database) => {
        const storedAgent = database.agents.find((candidate) => candidate.id === agentId);
        if (!storedAgent) throw new Error("Agent disappeared during termination");
        storedAgent.authorityBlocked = true;

        const stamped: string[] = [];
        const revokedAt = now();
        for (const grant of database.grants) {
          if (grant.principalId === agentPrincipalId && grant.revokedAt === null) {
            grant.revokedAt = revokedAt;
            stamped.push(grant.id);
          }
        }
        return stamped;
      });
      revoked.push(...ids);
      return {
        step: "revoke",
        ok: true,
        detail: `${ids.length} grant(s) revoked; new grants blocked until operator restart.`,
        at: now(),
      };
    } catch (error) {
      return { step: "revoke", ok: false, detail: describe(error), at: now() };
    }
  }

  private async kill(agentId: string, reason: string): Promise<TerminationStep> {
    try {
      await this.agents.quarantineAgent(agentId, reason);
      return {
        step: "kill",
        ok: true,
        detail: "Run cancelled, runtime torn down, and agent stopped.",
        at: now(),
      };
    } catch (error) {
      return { step: "kill", ok: false, detail: describe(error), at: now() };
    }
  }

  private async verifyContainment(
    agentId: string,
    agentPrincipalId: string,
  ): Promise<TerminationStep> {
    try {
      const database = this.store.snapshot();
      const agent = database.agents.find((candidate) => candidate.id === agentId);
      const currentTime = now();
      const liveGrants = this.identity.listGrants(agentPrincipalId).filter(
        (grant) =>
          grant.revokedAt === null &&
          (grant.expiresAt === null || grant.expiresAt > currentTime),
      );
      const inMemoryStopped = !this.agents.hasLiveExecution(agentId) && agent?.status === "stopped";
      // The in-memory map is cleared even when `docker rm` failed, so it is not
      // proof the container is gone. Ask the engine directly. A confirmed
      // sighting (false) fails containment; an unconfirmable answer (null)
      // falls back to the in-memory view and is reported as such.
      const runtimeConfirmed = await this.agents.runtimeConfirmedStopped(agentId);
      // Confirmed-running (false) fails containment outright. Otherwise the
      // in-memory view stands, whether the engine confirmed stopped (true) or
      // could not be asked (null).
      const runtimeStopped = runtimeConfirmed !== false && inMemoryStopped;
      const runtimeDetail =
        runtimeConfirmed === null
          ? "runtime stop not independently confirmed by the engine"
          : `runtime confirmed ${runtimeConfirmed ? "stopped" : "STILL RUNNING"} by the engine`;
      const authorityBlocked = agent?.authorityBlocked === true;

      let networkBlocked = runtimeStopped;
      let networkDetail = "No runtime remains from which to open a route.";
      if (this.egress) {
        const probe = await this.egress.probeAsAgent(agentPrincipalId, "example.com");
        // A probe that could not run is not evidence. Counting it as a refusal
        // would let an engine hiccup be signed as observed containment.
        networkBlocked = probe.blocked && probe.conclusive;
        networkDetail = probe.conclusive
          ? probe.detail
          : `containment unconfirmed: ${probe.detail}`;
      }

      const ok = runtimeStopped && authorityBlocked && liveGrants.length === 0 && networkBlocked;
      return {
        step: "verify",
        ok,
        detail: [
          `runtimeStopped=${runtimeStopped}`,
          runtimeDetail,
          `authorityBlocked=${authorityBlocked}`,
          `liveGrants=${liveGrants.length}`,
          `networkBlocked=${networkBlocked}`,
          networkDetail,
        ].join("; "),
        at: now(),
      };
    } catch (error) {
      return { step: "verify", ok: false, detail: describe(error), at: now() };
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

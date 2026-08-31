import type { AgentService } from "./agent-service.js";
import type { EgressNetworkManager } from "./egress-network.js";
import type { IdentityService } from "./identity.js";
import type { JsonStore } from "./store.js";
import {
  signReceipt,
  type TerminationReceipt,
  type TerminationStep,
  type UnsignedReceipt,
} from "./termination.js";

const now = () => new Date().toISOString();

/**
 * Carries out an agent termination and reports what actually happened.
 *
 * The order is the point. Revoking first would leave a window in which a
 * request that already passed its check completes after the operator believed
 * the agent was stopped, so the process is frozen before anything else moves.
 */
export class AgentTerminator {
  constructor(
    private readonly store: JsonStore,
    private readonly agents: AgentService,
    private readonly identity: IdentityService,
    private readonly serverKey: string,
    private readonly egress?: EgressNetworkManager,
  ) {}

  async terminate(agentId: string, reason: string): Promise<TerminationReceipt> {
    const agent = this.agents.getAgent(agentId);
    const steps: TerminationStep[] = [];
    const revoked: string[] = [];

    // 1. Freeze: stop the process advancing before its authority changes.
    let frozen = false;
    try {
      frozen = await this.agents.freezeAgent(agentId);
      steps.push({
        step: "freeze",
        ok: true,
        detail: frozen
          ? "Execution suspended at the OS level before any authority changed."
          : "No live execution to suspend.",
        at: now(),
      });
    } catch (error) {
      steps.push({ step: "freeze", ok: false, detail: describe(error), at: now() });
    }

    // 2. Revoke: one store transaction, so the agent never sees a half-revoked set.
    try {
      const live = this.identity
        .listGrants(agent.principalId)
        .filter((grant) => grant.revokedAt === null);
      const ids = await this.store.mutate((database) => {
        const stamped: string[] = [];
        const at = now();
        for (const grant of database.grants) {
          if (grant.principalId === agent.principalId && grant.revokedAt === null) {
            grant.revokedAt = at;
            stamped.push(grant.id);
          }
        }
        return stamped;
      });
      revoked.push(...ids);
      steps.push({
        step: "revoke",
        ok: true,
        detail: `${ids.length} grant(s) revoked in a single transaction (held ${live.length}).`,
        at: now(),
      });
    } catch (error) {
      steps.push({ step: "revoke", ok: false, detail: describe(error), at: now() });
    }

    // 3. Kill: tear the execution down for real.
    try {
      await this.agents.quarantineAgent(agentId, reason);
      steps.push({
        step: "kill",
        ok: true,
        detail: "Run cancelled, container torn down, agent stopped.",
        at: now(),
      });
    } catch (error) {
      steps.push({ step: "kill", ok: false, detail: describe(error), at: now() });
    }

    // 4. Verify: don't assert containment, observe it.
    const verify = await this.verifyNoRouteRemains(agent.principalId);
    steps.push(verify);

    const body: UnsignedReceipt = {
      version: 1,
      agentId,
      agentPrincipalId: agent.principalId,
      reason,
      issuedAt: now(),
      steps,
      grantsRevoked: revoked,
      contained: steps.every((step) => step.ok),
    };
    const receipt: TerminationReceipt = { ...body, signature: signReceipt(body, this.serverKey) };

    await this.agents.recordTermination(agentId, receipt);
    return receipt;
  }

  /**
   * Re-probes from the agent's own network position after teardown. A refusal
   * here is the evidence; without it the receipt would only be repeating what
   * the previous steps intended to do.
   */
  private async verifyNoRouteRemains(agentPrincipalId: string): Promise<TerminationStep> {
    if (!this.egress) {
      return {
        step: "verify",
        ok: true,
        detail: "Egress enforcement is off; no network boundary to re-probe.",
        at: now(),
      };
    }
    try {
      const probe = await this.egress.probeAsAgent(agentPrincipalId, "example.com");
      return {
        step: "verify",
        ok: probe.blocked,
        detail: probe.blocked
          ? `Re-probe refused after teardown: ${probe.detail}`
          : `Route still open after teardown: ${probe.detail}`,
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

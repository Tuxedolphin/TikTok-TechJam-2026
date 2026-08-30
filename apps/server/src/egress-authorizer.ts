import { createHmac, timingSafeEqual } from "node:crypto";
import { evaluateEgress } from "./run-policies.js";
import type { JsonStore } from "./store.js";
import type { EgressVerdict } from "./egress-proxy.js";
import type { PolicyDecision } from "./types.js";

export interface EgressAuthorizationRequest {
  agentPrincipalId: string;
  host: string;
  port: number;
  method: string;
  /** Per-agent proxy secret, presented as the proxy-auth password. */
  secret?: string | undefined;
}

/**
 * Derives the secret an agent presents alongside its principal id. Without
 * this, the proxy would believe whatever principal a container claimed, and
 * one agent could borrow another's grants just by changing a username.
 */
export function egressProxySecret(agentPrincipalId: string, serverKey: string): string {
  return createHmac("sha256", serverKey || "launchpad-egress")
    .update(agentPrincipalId)
    .digest("hex")
    .slice(0, 32);
}

function secretMatches(expected: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface EgressAuthorizationResult extends EgressVerdict {
  decision: PolicyDecision;
  agentId: string | null;
  strikes: number;
  quarantined: boolean;
}

export interface EgressAuthorizerOptions {
  /** Hosts the platform itself needs (model API, adapter callback). */
  standingAllowHosts: string[];
  /** Server key the per-agent proxy secret is derived from. */
  serverKey?: string;
  /** Denials for one agent before it is quarantined. */
  quarantineThreshold: number;
  recordDecision?: (runId: string, agentId: string, decision: PolicyDecision) => Promise<void> | void;
  recordBlocked?: (
    runId: string,
    agentId: string,
    input: EgressAuthorizationRequest,
    decision: PolicyDecision,
    strikes: number,
  ) => Promise<void> | void;
  quarantineAgent?: (agentId: string, reason: string) => Promise<void> | void;
}

/**
 * Turns a proxy's "may this connection leave?" question into a grant-backed
 * decision, records it on the run timeline, and escalates repeat offenders.
 *
 * Grants are read fresh on every call — no caching — so revoking one takes
 * effect on the agent's very next connection rather than at token expiry.
 */
export class EgressAuthorizer {
  private readonly strikesByAgent = new Map<string, number>();

  constructor(
    private readonly store: JsonStore,
    private readonly options: EgressAuthorizerOptions,
  ) {}

  strikesFor(agentId: string): number {
    return this.strikesByAgent.get(agentId) ?? 0;
  }

  /**
   * Clears an agent's blocked-attempt history. Called when an operator starts a
   * quarantined agent again: without it the stale count sits at the threshold
   * and the next single denial re-quarantines the agent immediately, making the
   * operator's intervention look like it did nothing.
   */
  resetStrikes(agentId: string): void {
    this.strikesByAgent.delete(agentId);
  }

  async authorize(input: EgressAuthorizationRequest): Promise<EgressAuthorizationResult> {
    const database = this.store.snapshot();
    const agent = database.agents.find((a) => a.principalId === input.agentPrincipalId);
    const agentId = agent?.id ?? null;

    // Verify the caller is the principal it claims before any grant of that
    // principal is consulted.
    if (this.options.serverKey !== undefined) {
      const expected = egressProxySecret(input.agentPrincipalId, this.options.serverKey);
      if (!secretMatches(expected, input.secret)) {
        return {
          allowed: false,
          ruleId: "NET-EGRESS-IMPERSONATION-023",
          reason: "Presented principal is not backed by a valid agent secret.",
          decision: {
            allowed: false,
            ruleId: "NET-EGRESS-IMPERSONATION-023",
            reason: "Presented principal is not backed by a valid agent secret.",
            principalId: input.agentPrincipalId,
            grantId: null,
          },
          agentId,
          strikes: agentId ? this.strikesFor(agentId) : 0,
          quarantined: false,
        };
      }
    }

    const decision = this.options.standingAllowHosts.includes(input.host)
      ? {
          allowed: true,
          ruleId: "NET-EGRESS-PLATFORM-021",
          reason: `${input.host} is a platform endpoint the runtime needs to function.`,
          principalId: input.agentPrincipalId,
          grantId: null,
        }
      : evaluateEgress(
          input.agentPrincipalId,
          input.host,
          database.grants,
          new Date().toISOString(),
        );

    const runId = agentId ? this.latestRunId(agentId) : `egress-${input.agentPrincipalId}`;

    // Platform endpoints are noise on the timeline; agent-initiated egress is not.
    if (decision.ruleId !== "NET-EGRESS-PLATFORM-021" && agentId) {
      await this.options.recordDecision?.(runId, agentId, decision);
    }

    let strikes = agentId ? this.strikesFor(agentId) : 0;
    let quarantined = false;

    if (!decision.allowed && agentId) {
      strikes += 1;
      this.strikesByAgent.set(agentId, strikes);
      await this.options.recordBlocked?.(runId, agentId, input, decision, strikes);
      if (strikes >= this.options.quarantineThreshold) {
        quarantined = true;
        await this.options.quarantineAgent?.(
          agentId,
          `Quarantined after ${strikes} blocked egress attempts (last target: ${input.host}).`,
        );
      }
    }

    return {
      allowed: decision.allowed,
      ruleId: decision.ruleId,
      reason: decision.reason,
      decision,
      agentId,
      strikes,
      quarantined,
    };
  }

  private latestRunId(agentId: string): string {
    const runs = this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return runs[0]?.id ?? `egress-${agentId}`;
  }
}

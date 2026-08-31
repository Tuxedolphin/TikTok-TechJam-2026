import { createHmac, timingSafeEqual } from "node:crypto";
import { evaluateEgress } from "./run-policies.js";
import { latestRunFor, type JsonStore } from "./store.js";
import type { EgressVerdict } from "./egress-proxy.js";
import type { PolicyDecision } from "./types.js";

export interface EgressAuthorizationRequest {
  agentPrincipalId: string;
  host: string;
  port: number;
  method: string;
  /** Per-agent proxy secret, presented as the proxy-auth password. */
  secret?: string | undefined;
  /** Aborted when the originating Runtime request disconnects while held. */
  signal?: AbortSignal | undefined;
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
  requestApproval?: (
    runId: string,
    agentId: string,
    input: EgressAuthorizationRequest,
  ) => Promise<boolean>;
  quarantineAgent?: (agentId: string, reason: string) => Promise<void> | void;
}

/**
 * Turns a proxy's "may this connection leave?" question into a grant-backed
 * decision, records it on the run timeline, and escalates repeat offenders.
 *
 * Grants are read fresh on every call — no caching — so revoking one takes
 * effect on the agent's very next connection rather than at token expiry.
 */
/**
 * How many of one agent's requests may sit held awaiting a decision at once.
 *
 * Each held request persists an approval and installs a five-minute timer, and
 * a strike is only counted when a decision *resolves*. Without a cap, an agent
 * firing N ungranted requests creates N pending approvals before quarantine can
 * see a single strike -- the operator's queue is flooded and the one decision
 * that matters is buried. Beyond the cap we deny immediately and record the
 * strike, which is what lets quarantine actually fire.
 */
export const MAX_CONCURRENT_HELD_REQUESTS = 3;

export class EgressAuthorizer {
  private readonly strikesByAgent = new Map<string, number>();
  private readonly heldByAgent = new Map<string, number>();

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
    this.heldByAgent.delete(agentId);
  }

  /** Requests currently held for this agent awaiting an operator decision. */
  heldFor(agentId: string): number {
    return this.heldByAgent.get(agentId) ?? 0;
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
          agentId,
          strikes: agentId ? this.strikesFor(agentId) : 0,
          quarantined: false,
        };
      }
    }

    // Reuse the snapshot taken above: it is a deep clone of the whole store, so
    // taking a second one per connection would double an already hot cost.
    const runId = agentId
      ? (latestRunFor(database.runs, agentId)?.id ?? `egress-${agentId}`)
      : `egress-${input.agentPrincipalId}`;

    let decision: PolicyDecision = this.options.standingAllowHosts.includes(input.host)
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

    // An ungranted request is held at the proxy boundary while a human decides.
    // Approval applies only to this request; it does not create a reusable grant.
    if (
      !decision.allowed &&
      decision.ruleId === "NET-EGRESS-020" &&
      agentId &&
      this.options.requestApproval
    ) {
      const held = this.heldByAgent.get(agentId) ?? 0;
      if (held >= MAX_CONCURRENT_HELD_REQUESTS) {
        // Refuse without creating an approval. A flooding agent must not be
        // able to mint unbounded operator decisions, and this denial counts a
        // strike below, so persistent flooding quarantines the agent.
        decision = {
          allowed: false,
          ruleId: "HITL-EGRESS-FLOOD-027",
          reason:
            `Refused without asking: ${held} request(s) from this Agent are already ` +
            `awaiting an operator decision (limit ${MAX_CONCURRENT_HELD_REQUESTS}).`,
          principalId: input.agentPrincipalId,
          grantId: null,
        };
      } else {
        this.heldByAgent.set(agentId, held + 1);
        let approved = false;
        try {
          approved = await this.options.requestApproval(runId, agentId, input);
        } catch {
          approved = false;
        } finally {
          const remaining = (this.heldByAgent.get(agentId) ?? 1) - 1;
          if (remaining > 0) this.heldByAgent.set(agentId, remaining);
          else this.heldByAgent.delete(agentId);
        }
        decision = {
          allowed: approved,
          ruleId: approved ? "HITL-EGRESS-APPROVED-025" : "HITL-EGRESS-DENIED-026",
          reason: approved
            ? `Operator approved this ${input.method} request to ${input.host}:${input.port}.`
            : `Operator denied this ${input.method} request to ${input.host}:${input.port}.`,
          principalId: input.agentPrincipalId,
          grantId: null,
        };
      }
    }

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
      // Platform endpoints live on the host, whose address is private by nature.
      allowPrivate: decision.ruleId === "NET-EGRESS-PLATFORM-021",
      agentId,
      strikes,
      quarantined,
    };
  }
}

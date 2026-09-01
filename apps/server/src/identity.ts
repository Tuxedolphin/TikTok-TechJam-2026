/**
 * Principals and the grants between them — the "who" of Agent Passport.
 *
 * A human and the agent acting for that human are different principals. An
 * agent holds no ambient authority: it may touch a resource or reach a host
 * only while a grant says so, and every access re-reads the grant rather than
 * consulting a cached decision, so a revocation is felt on the very next call
 * instead of at the next token expiry.
 *
 * Delegation records its parent (`parentGrantId`), which is what makes
 * revocation transitive: an agent that carved a narrower copy for a sub-agent
 * cannot leave that copy alive after the operator revokes the grant it came
 * from. Authority only flows downhill, and `authority.ts` is where that is
 * decided.
 */
import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import { authorizeGrantRequest, type AuthorityDecision } from "./authority.js";
import {
  evaluateResourceAccess,
  isGrantChainLive,
  RunPolicyViolationError,
} from "./run-policies.js";
import { latestRunFor, type JsonStore } from "./store.js";
import type { Grant, GrantScope, MockResource, PolicyDecision, Principal } from "./types.js";

export class IdentityService {
  constructor(
    private readonly store: JsonStore,
    private readonly recordDecision?: (
      runId: string,
      agentId: string,
      decision: PolicyDecision,
    ) => Promise<void> | void,
    private readonly recordGrantLifecycle?: (
      runId: string,
      agentId: string,
      type: "grant.created" | "grant.revoked",
      grant: Grant,
    ) => Promise<void> | void,
  ) {}

  listPrincipals(): Principal[] {
    return this.store.snapshot().principals;
  }

  listGrants(principalId?: string): Grant[] {
    const grants = this.store.snapshot().grants;
    return principalId ? grants.filter((g) => g.principalId === principalId) : grants;
  }

  async createGrant(input: {
    principalId: string;
    grantedBy: string;
    scope: GrantScope;
    target: string;
    ttlMinutes?: number | null;
  }): Promise<Grant> {
    const now = new Date();
    // A wildcard target ("*", "*.example.com") is accepted by the delegation
    // check but never honoured by enforcement, which matches on exact target.
    // The two disagreeing is a hole: a "*" grant looks like it authorizes
    // everything yet activates nothing, and default-deny should not offer a
    // catch-all in the first place. Refuse wildcards so policy and enforcement
    // speak the same language.
    if (input.target.includes("*")) {
      throw new HttpError(400, "Grant targets must be concrete; wildcard targets are not allowed.");
    }
    const expiresAt = input.ttlMinutes
      ? new Date(now.getTime() + input.ttlMinutes * 60_000).toISOString()
      : null;

    const grant: Grant = {
      id: randomUUID(),
      principalId: input.principalId,
      grantedBy: input.grantedBy,
      scope: input.scope,
      target: input.target,
      expiresAt,
      revokedAt: null,
      revokedBy: null,
      createdAt: now.toISOString(),
      parentGrantId: null,
    };
    let decision: AuthorityDecision;
    try {
      decision = await this.store.mutate((database) => {
        if (!database.principals.some((principal) => principal.id === input.principalId)) {
          throw new HttpError(404, `Unknown principal ${input.principalId}`);
        }
        const actor = database.principals.find((principal) => principal.id === input.grantedBy);
        if (!actor) throw new HttpError(404, `Unknown grantor ${input.grantedBy}`);
        const beneficiaryPrincipal = database.principals.find(
          (principal) => principal.id === input.principalId,
        );
        if (actor.kind === "agent" && beneficiaryPrincipal?.kind !== "agent") {
          throw new AuthorityDeniedError({
            allowed: false,
            ruleId: "AUTHORITY-NARROWING-032",
            reason: "Agents may delegate authority only to another agent principal.",
          });
        }

        const beneficiary = database.agents.find(
          (agent) => agent.principalId === input.principalId,
        );
        if (beneficiary?.authorityBlocked) {
          throw new HttpError(409, "Terminated agents cannot receive authority until restarted");
        }

        const authorityDecision = authorizeGrantRequest({
          actorKind: actor.kind,
          actorPrincipalId: input.grantedBy,
          requested: { scope: input.scope, target: input.target, expiresAt },
          beneficiaryPrincipalId: input.principalId,
          heldByRequester: actor.kind === "agent"
            ? database.grants.filter(
                (held) =>
                  held.principalId === input.grantedBy &&
                  isGrantChainLive(held, database.grants, now.toISOString()),
              )
            : [],
        });
        if (!authorityDecision.allowed) throw new AuthorityDeniedError(authorityDecision);
        // A delegated grant records the grant it was carved from, so revoking
        // the parent cascades here rather than leaving an orphan copy alive.
        grant.parentGrantId = authorityDecision.parentGrantId ?? null;
        database.grants.push(structuredClone(grant));
        return authorityDecision;
      });
    } catch (error) {
      if (error instanceof AuthorityDeniedError) {
        await this.recordAuthorityDecision(
          input.grantedBy,
          input.principalId,
          error.decision,
          null,
        );
        throw new RunPolicyViolationError("authz", 403, error.decision.reason);
      }
      throw error;
    }

    await this.recordAuthorityDecision(
      input.grantedBy,
      input.principalId,
      decision,
      grant.id,
    );
    await this.recordGrantEvent("grant.created", grant);
    return grant;
  }

  private async recordAuthorityDecision(
    actorPrincipalId: string,
    beneficiaryPrincipalId: string,
    decision: AuthorityDecision,
    grantId: string | null,
  ): Promise<void> {
    if (!this.recordDecision) return;
    const database = this.store.snapshot();
    const agent = database.agents.find((candidate) =>
      candidate.principalId === actorPrincipalId ||
      candidate.principalId === beneficiaryPrincipalId
    );
    if (!agent) return;
    const latestRun = latestRunFor(database.runs, agent.id);
    await this.recordDecision(latestRun?.id ?? `authority-${agent.id}`, agent.id, {
      // This used to record denials only, so `false` was a constant. It now
      // records allows too, and a trace that reports an allowed grant as
      // denied is worse than no trace at all.
      allowed: decision.allowed,
      ruleId: decision.ruleId,
      reason: decision.reason,
      principalId: actorPrincipalId,
      grantId,
    });
  }

  async revokeGrant(id: string, revokedBy: string): Promise<Grant> {
    const { root, cascaded } = await this.store.mutate((database) => {
      const stored = database.grants.find((g) => g.id === id);
      if (!stored) throw new HttpError(404, `Unknown grant ${id}`);
      const revokedAt = new Date().toISOString();

      // Revoke the grant and every live descendant delegated from it. Without
      // this, an agent that carved a narrower copy for a sub-agent could keep
      // that copy alive after the operator revoked the grant it came from.
      const toRevoke = new Set<string>([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const candidate of database.grants) {
          if (
            candidate.revokedAt === null &&
            candidate.parentGrantId != null &&
            toRevoke.has(candidate.parentGrantId) &&
            !toRevoke.has(candidate.id)
          ) {
            toRevoke.add(candidate.id);
            grew = true;
          }
        }
      }

      const revokedGrants: Grant[] = [];
      for (const candidate of database.grants) {
        if (toRevoke.has(candidate.id) && candidate.revokedAt === null) {
          candidate.revokedAt = revokedAt;
          candidate.revokedBy = revokedBy;
          revokedGrants.push(structuredClone(candidate));
        }
      }
      const rootGrant = revokedGrants.find((g) => g.id === id) ?? structuredClone(stored);
      return { root: rootGrant, cascaded: revokedGrants.filter((g) => g.id !== id) };
    });

    await this.recordGrantEvent("grant.revoked", root);
    for (const descendant of cascaded) {
      await this.recordGrantEvent("grant.revoked", descendant);
    }
    return root;
  }

  /**
   * Grants are issued and revoked outside any run, so they have no runId to
   * attach to. They anchor to the agent's most recent run when there is one so
   * the operator sees the revocation land on the timeline they are watching.
   */
  private async recordGrantEvent(
    type: "grant.created" | "grant.revoked",
    grant: Grant,
  ): Promise<void> {
    if (!this.recordGrantLifecycle) return;
    const database = this.store.snapshot();
    const agent = database.agents.find((a) => a.principalId === grant.principalId);
    const latestRun = agent ? latestRunFor(database.runs, agent.id) : null;
    await this.recordGrantLifecycle(
      latestRun?.id ?? `grant-${grant.id}`,
      agent?.id ?? "unknown",
      type,
      grant,
    );
  }

  async readResourceAsAgent(
    resourceId: string,
    agentPrincipalId: string,
  ): Promise<{ resource: MockResource | null; decision: PolicyDecision }> {
    const database = this.store.snapshot();
    const resource = database.resources.find((r) => r.id === resourceId);
    if (!resource) throw new HttpError(404, `Unknown resource ${resourceId}`);
    const agent = database.agents.find((a) => a.principalId === agentPrincipalId);
    const ownerId = agent?.ownerId ?? "user-a";
    const decision = evaluateResourceAccess(
      agentPrincipalId,
      ownerId,
      resource,
      database.grants,
      new Date().toISOString(),
    );

    if (this.recordDecision) {
      const latestRun = agent ? latestRunFor(database.runs, agent.id) : null;
      const runId = latestRun?.id ?? `authz-${resourceId}`;
      await this.recordDecision(runId, agent?.id ?? "unknown", decision);
    }

    return { resource: decision.allowed ? resource : null, decision };
  }

}

export function cascadeGrantRevocation(
  grants: Grant[],
  grantId: string,
  revokedAt = new Date().toISOString(),
): string[] {
  const descendants = new Set<string>([grantId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const grant of grants) {
      const parentGrantId = grant.parentGrantId ?? null;
      if (parentGrantId !== null && descendants.has(parentGrantId) && !descendants.has(grant.id)) {
        descendants.add(grant.id);
        changed = true;
      }
    }
  }

  const revoked: string[] = [];
  for (const grant of grants) {
    if (descendants.has(grant.id) && grant.revokedAt === null) {
      grant.revokedAt = revokedAt;
      revoked.push(grant.id);
    }
  }
  return revoked;
}

class AuthorityDeniedError extends Error {
  constructor(readonly decision: AuthorityDecision) {
    super(decision.reason);
  }
}

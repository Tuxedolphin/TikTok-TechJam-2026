import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import { authorizeGrantRequest, type AuthorityDecision } from "./authority.js";
import { evaluateResourceAccess, RunPolicyViolationError } from "./run-policies.js";
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
      createdAt: now.toISOString(),
    };
    let decision: AuthorityDecision;
    try {
      decision = await this.store.mutate((database) => {
        if (!database.principals.some((principal) => principal.id === input.principalId)) {
          throw new HttpError(404, `Unknown principal ${input.principalId}`);
        }
        const actor = database.principals.find((principal) => principal.id === input.grantedBy);
        if (!actor) throw new HttpError(404, `Unknown grantor ${input.grantedBy}`);

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
                  held.revokedAt === null &&
                  (held.expiresAt === null || held.expiresAt > now.toISOString()),
              )
            : [],
        });
        if (!authorityDecision.allowed) throw new AuthorityDeniedError(authorityDecision);
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

  async revokeGrant(id: string): Promise<Grant> {
    const grant = await this.store.mutate((database) => {
      const stored = database.grants.find((g) => g.id === id);
      if (!stored) throw new HttpError(404, `Unknown grant ${id}`);
      stored.revokedAt = new Date().toISOString();
      return structuredClone(stored);
    });
    await this.recordGrantEvent("grant.revoked", grant);
    return grant;
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

class AuthorityDeniedError extends Error {
  constructor(readonly decision: AuthorityDecision) {
    super(decision.reason);
  }
}

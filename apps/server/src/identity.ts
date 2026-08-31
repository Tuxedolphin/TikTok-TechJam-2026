import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import { authorizeGrantRequest, type ActorKind, type AuthorityDecision } from "./authority.js";
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

  /** Grants the principal currently holds, ignoring spent ones. */
  private liveGrantsFor(principalId: string, nowIso: string): Grant[] {
    return this.store
      .snapshot()
      .grants.filter(
        (grant) =>
          grant.principalId === principalId &&
          grant.revokedAt === null &&
          (grant.expiresAt === null || grant.expiresAt > nowIso),
      );
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

    // The control plane is reachable from inside an agent container, so a
    // request arriving here may be the agent itself asking for more authority.
    // Humans originate authority; agents may only ever pass along less than
    // they hold.
    const actorKind: ActorKind = input.grantedBy.startsWith("agent-") ? "agent" : "human";
    const decision = authorizeGrantRequest({
      actorKind,
      actorPrincipalId: input.grantedBy,
      requested: { scope: input.scope, target: input.target, expiresAt },
      beneficiaryPrincipalId: input.principalId,
      heldByRequester:
        actorKind === "agent" ? this.liveGrantsFor(input.grantedBy, now.toISOString()) : [],
    });

    if (!decision.allowed) {
      await this.recordAuthorityDenial(input.grantedBy, decision);
      throw new RunPolicyViolationError("authz", 403, decision.reason);
    }

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
    await this.store.mutate((database) => {
      if (!database.principals.some((p) => p.id === input.principalId)) {
        throw new HttpError(404, `Unknown principal ${input.principalId}`);
      }
      database.grants.push(structuredClone(grant));
    });
    await this.recordGrantEvent("grant.created", grant);
    return grant;
  }

  /** Puts a refused escalation on the timeline of the agent that attempted it. */
  private async recordAuthorityDenial(
    actorPrincipalId: string,
    decision: AuthorityDecision,
  ): Promise<void> {
    if (!this.recordDecision) return;
    const database = this.store.snapshot();
    const agent = database.agents.find((a) => a.principalId === actorPrincipalId);
    if (!agent) return;
    const latestRun = latestRunFor(database.runs, agent.id);
    await this.recordDecision(latestRun?.id ?? `authority-${agent.id}`, agent.id, {
      allowed: false,
      ruleId: decision.ruleId,
      reason: decision.reason,
      principalId: actorPrincipalId,
      grantId: null,
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

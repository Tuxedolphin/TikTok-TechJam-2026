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
import { evaluateResourceAccess } from "./run-policies.js";
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
    const grant: Grant = {
      id: randomUUID(),
      principalId: input.principalId,
      grantedBy: input.grantedBy,
      scope: input.scope,
      target: input.target,
      expiresAt: input.ttlMinutes
        ? new Date(now.getTime() + input.ttlMinutes * 60_000).toISOString()
        : null,
      revokedAt: null,
      revokedBy: null,
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

  async revokeGrant(id: string, revokedBy: string): Promise<Grant> {
    const grant = await this.store.mutate((database) => {
      const stored = database.grants.find((g) => g.id === id);
      if (!stored) throw new HttpError(404, `Unknown grant ${id}`);
      stored.revokedAt = new Date().toISOString();
      stored.revokedBy = revokedBy;
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

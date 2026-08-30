import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import { evaluateResourceAccess } from "./run-policies.js";
import type { JsonStore } from "./store.js";
import type { AgentRun, Grant, GrantScope, MockResource, PolicyDecision, Principal } from "./types.js";

export class IdentityService {
  constructor(
    private readonly store: JsonStore,
    private readonly recordDecision?: (
      runId: string,
      agentId: string,
      decision: PolicyDecision,
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
      createdAt: now.toISOString(),
    };
    await this.store.mutate((database) => {
      if (!database.principals.some((p) => p.id === input.principalId)) {
        throw new HttpError(404, `Unknown principal ${input.principalId}`);
      }
      database.grants.push(grant);
    });
    return grant;
  }

  async revokeGrant(id: string): Promise<Grant> {
    return this.store.mutate((database) => {
      const grant = database.grants.find((g) => g.id === id);
      if (!grant) throw new HttpError(404, `Unknown grant ${id}`);
      grant.revokedAt = new Date().toISOString();
      return structuredClone(grant);
    });
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
      const runs = agent ? this.runsForAgent(database.runs, agent.id) : [];
      const runId = runs[0]?.id ?? `authz-${resourceId}`;
      await this.recordDecision(runId, agent?.id ?? "unknown", decision);
    }

    return { resource: decision.allowed ? resource : null, decision };
  }

  private runsForAgent(runs: AgentRun[], agentId: string): AgentRun[] {
    return runs
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

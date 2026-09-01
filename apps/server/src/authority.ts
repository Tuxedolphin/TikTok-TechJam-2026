import type { Grant, GrantScope } from "./types.js";

/**
 * Authority only flows downhill.
 *
 * The platform's control plane is reachable from inside an agent container --
 * it has to be, because the model adapter lives there. That makes the control
 * plane a confused deputy: a hijacked agent cannot break out of its network,
 * but it can ask the platform to widen its own grants, which defeats
 * containment far more cheaply than attacking it.
 *
 * The rule that closes this: a request made *by* an agent can never produce
 * authority exceeding what that agent already holds. Humans grant authority.
 * Agents can only ever pass along less of it than they were given.
 */

export type ActorKind = "human" | "agent";

export interface AuthorityDecision {
  allowed: boolean;
  ruleId: string;
  reason: string;
  /** When an agent's delegation is allowed, the grant it was carved from. */
  parentGrantId?: string | null;
}

/** A grant request stripped to the parts that determine how much power it confers. */
export interface GrantShape {
  scope: GrantScope;
  target: string;
  expiresAt: string | null;
}

/**
 * Scopes are only comparable within a family. Reading and writing a resource
 * are the same kind of authority at different strengths, but reaching the
 * network is a different kind entirely -- holding write access to a resource
 * must never be exchangeable for the ability to make outbound connections.
 */
const SCOPE_FAMILY: Record<GrantScope, string> = {
  "resource:read": "resource",
  "resource:write": "resource",
  "network:egress": "network",
};

/** Strength within a family; a grant may be exchanged downward, never upward. */
const SCOPE_STRENGTH: Record<GrantScope, number> = {
  "resource:read": 1,
  "resource:write": 2,
  "network:egress": 1,
};

function scopeIsNarrower(child: GrantScope, parent: GrantScope): boolean {
  if (SCOPE_FAMILY[child] !== SCOPE_FAMILY[parent]) return false;
  return SCOPE_STRENGTH[child] <= SCOPE_STRENGTH[parent];
}

function targetCovers(parentTarget: string, childTarget: string): boolean {
  if (parentTarget === childTarget) return true;
  // A wildcard parent covers any single target beneath it, but never the
  // reverse -- "*" delegating "res-a" narrows; "res-a" delegating "*" widens.
  if (parentTarget === "*") return true;
  // A parent holding a domain covers its subdomains.
  if (parentTarget.startsWith("*.")) {
    return childTarget.endsWith(parentTarget.slice(1));
  }
  return false;
}

function expiryWithin(parentExpiry: string | null, childExpiry: string | null): boolean {
  // A grant with no expiry is the broadest possible in time.
  if (parentExpiry === null) return true;
  if (childExpiry === null) return false;
  return childExpiry <= parentExpiry;
}

/**
 * True when `child` confers no more authority than `parent` on every axis:
 * scope, target, and lifetime.
 */
export function isNarrowerThan(child: GrantShape, parent: GrantShape): boolean {
  if (!scopeIsNarrower(child.scope, parent.scope)) return false;
  if (!targetCovers(parent.target, child.target)) return false;
  return expiryWithin(parent.expiresAt, child.expiresAt);
}

/**
 * Decides whether an actor may create the requested grant.
 *
 * `heldByRequester` is every live grant the requesting principal already holds;
 * it is ignored for humans, who are the origin of authority in this system.
 */
export function authorizeGrantRequest(input: {
  actorKind: ActorKind;
  actorPrincipalId: string;
  requested: GrantShape;
  beneficiaryPrincipalId: string;
  heldByRequester: Grant[];
}): AuthorityDecision {
  if (input.actorKind === "human") {
    return {
      allowed: true,
      ruleId: "AUTHORITY-HUMAN-030",
      reason: "Authority originates with a human principal.",
    };
  }

  // A self-directed agent grant is refused outright, even when it would only
  // clone authority the agent already holds. It gains the agent nothing it does
  // not already have -- its only effect is a second grant that survives
  // revocation of the first, which silently defeats revocation. Delegation only
  // ever flows to a *different* principal.
  if (input.beneficiaryPrincipalId === input.actorPrincipalId) {
    return {
      allowed: false,
      ruleId: "AUTHORITY-SELF-ESCALATION-031",
      reason: `An agent cannot grant itself ${input.requested.scope} on ${input.requested.target}; authority only flows downhill from a human.`,
    };
  }

  const covering = input.heldByRequester.find((grant) =>
    isNarrowerThan(input.requested, {
      scope: grant.scope,
      target: grant.target,
      expiresAt: grant.expiresAt,
    }),
  );

  if (!covering) {
    return {
      allowed: false,
      ruleId: "AUTHORITY-NARROWING-032",
      reason: `No grant held by ${input.actorPrincipalId} covers ${input.requested.scope} on ${input.requested.target}.`,
    };
  }

  return {
    allowed: true,
    ruleId: "AUTHORITY-NARROWING-032",
    reason: `Narrower than grant ${covering.id}, which the requester already holds.`,
    // Revocation of `covering` will cascade to this delegated grant.
    parentGrantId: covering.id,
  };
}

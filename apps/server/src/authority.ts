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
}

/** A grant request stripped to the parts that determine how much power it confers. */
export interface GrantShape {
  scope: GrantScope;
  target: string;
  expiresAt: string | null;
}

/**
 * Scopes ordered by the power they confer. A grant may be exchanged for one at
 * the same level or lower, never higher.
 */
const SCOPE_RANK: Record<GrantScope, number> = {
  "resource:read": 1,
  "network:egress": 2,
  "resource:write": 3,
};

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
  if (SCOPE_RANK[child.scope] > SCOPE_RANK[parent.scope]) return false;
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

  // An agent asking to widen its own authority is the confused-deputy attack
  // this rule exists to stop.
  const selfDirected = input.beneficiaryPrincipalId === input.actorPrincipalId;

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
      ruleId: selfDirected ? "AUTHORITY-SELF-ESCALATION-031" : "AUTHORITY-NARROWING-032",
      reason: selfDirected
        ? `An agent cannot grant itself ${input.requested.scope} on ${input.requested.target}; authority only flows downhill from a human.`
        : `No grant held by ${input.actorPrincipalId} covers ${input.requested.scope} on ${input.requested.target}.`,
    };
  }

  return {
    allowed: true,
    ruleId: "AUTHORITY-NARROWING-032",
    reason: `Narrower than grant ${covering.id}, which the requester already holds.`,
  };
}

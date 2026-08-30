import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Agent, RunEvent } from "./types";

/**
 * Live view of what the agent was stopped from doing.
 *
 * Containment is invisible by nature — the "win" is that nothing happened — so
 * this panel exists to make the absence legible: every blocked connection and
 * every authorization decision, newest first, with the rule that produced it.
 */

const SECURITY_EVENTS = new Set<RunEvent["type"]>([
  "egress.blocked",
  "policy.decision",
  "grant.created",
  "grant.revoked",
  "run.blocked",
  "step.approval_denied",
]);

const RULE_EXPLANATIONS: Record<string, string> = {
  "NET-EGRESS-020": "No grant covers this host",
  "NET-EGRESS-PLATFORM-021": "Platform endpoint the runtime needs",
  "NET-EGRESS-NOAUTH-022": "No agent identity presented",
  "NET-EGRESS-IMPERSONATION-023": "Claimed a principal it could not prove",
  "NET-EGRESS-PRIVATE-024": "Resolves to a private or internal address",
  "AUTHZ-OWNER-010": "Belongs to a different user",
  "AUTHZ-GRANT-011": "Governed by an explicit grant",
  "AUTHZ-EXPIRED-012": "The grant timed out",
  "AUTHZ-REVOKED-013": "The operator revoked the grant",
};

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export default function SecurityFeed({ agent }: { agent: Agent }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const { events: next } = await api.agentEvents(agent.id);
      if (!mounted.current) return;
      setEvents(next.filter((event) => SECURITY_EVENTS.has(event.type)).reverse());
      setError(null);
    } catch (reason) {
      if (mounted.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  }, [agent.id]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 1500);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
    };
  }, [refresh]);

  const blocked = events.filter(
    (event) => event.type === "egress.blocked" || event.severity === "error",
  ).length;

  return (
    <section className="security-feed">
      <div className="security-feed-head">
        <div>
          <span className="eyebrow">Containment</span>
          <h3>What this agent was stopped from doing</h3>
        </div>
        <span className={"security-count" + (blocked > 0 ? " security-count-alert" : "")}>
          {blocked} blocked
        </span>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {events.length === 0 && !error && (
        <p className="security-empty">
          No security decisions yet. Give this agent a task that reaches the network, or issue and
          revoke a grant in the Passport panel, and every decision lands here.
        </p>
      )}

      <ul className="security-list">
        {events.map((event) => {
          const explanation = RULE_EXPLANATIONS[event.title];
          return (
            <li key={event.id} className={"security-item security-" + event.severity}>
              <span className="security-verdict">
                {event.type === "egress.blocked"
                  ? "BLOCKED"
                  : event.severity === "info"
                    ? "ALLOWED"
                    : "DENIED"}
              </span>
              <span className="security-body">
                <strong>{event.title}</strong>
                {explanation && <em className="security-why"> — {explanation}</em>}
              </span>
              <span className="security-time mono">{relativeTime(event.createdAt)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

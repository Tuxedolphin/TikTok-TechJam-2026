import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Agent, RunEvent } from "./types";

/**
 * What this agent was stopped from doing.
 *
 * Containment's win condition is absence — nothing bad happened — which reads
 * as nothing at all unless the interface makes it legible. Two views serve two
 * readers: Overview states outcomes in plain sentences for whoever is watching,
 * and Event log keeps the rule ids, principals, and exact timestamps an
 * operator needs to investigate. Overview is the default; the choice sticks.
 */

const SECURITY_EVENTS = new Set<RunEvent["type"]>([
  "egress.blocked",
  "policy.decision",
  "grant.created",
  "grant.revoked",
  "run.blocked",
  "step.approval_denied",
]);

const MODE_KEY = "passport.securityFeed.mode";

/** Rule ids are for operators. Everyone else gets the sentence. */
const RULES: Record<string, { plain: string; category: string }> = {
  "NET-EGRESS-020": { plain: "No grant covers this address", category: "Network" },
  "NET-EGRESS-PLATFORM-021": { plain: "Platform service the agent needs to run", category: "Network" },
  "NET-EGRESS-NOAUTH-022": { plain: "No identity was presented", category: "Identity" },
  "NET-EGRESS-IMPERSONATION-023": { plain: "Claimed an identity it could not prove", category: "Identity" },
  "NET-EGRESS-PRIVATE-024": { plain: "Points at an internal address", category: "Network" },
  "AUTHZ-OWNER-010": { plain: "Belongs to a different person", category: "Data" },
  "AUTHZ-GRANT-011": { plain: "Covered by an active grant", category: "Data" },
  "AUTHZ-EXPIRED-012": { plain: "The grant had expired", category: "Data" },
  "AUTHZ-REVOKED-013": { plain: "The grant was revoked", category: "Data" },
};

type Verdict = "blocked" | "allowed" | "granted";

interface Line {
  id: string;
  verdict: Verdict;
  headline: string;
  because: string;
  category: string;
  /** Rule id when a policy produced the decision, else the event type. */
  rule: string;
  at: string;
}

/** Turns a stored event into the sentence a person would actually say. */
function toLine(event: RunEvent): Line {
  const rule = RULES[event.title];
  const base = {
    id: event.id,
    category: rule?.category ?? "Policy",
    rule: RULES[event.title] ? event.title : event.type,
    at: event.createdAt,
  };

  if (event.type === "egress.blocked") {
    const host = event.title.replace("Blocked outbound connection to ", "");
    return {
      ...base,
      verdict: "blocked",
      headline: `Stopped from reaching ${host}`,
      because: "No grant allows this address",
      category: "Network",
    };
  }
  if (event.type === "grant.created" || event.type === "grant.revoked") {
    return {
      ...base,
      verdict: "granted",
      headline: event.title,
      because:
        event.type === "grant.revoked"
          ? "Access ends immediately, mid-task"
          : "Scoped and time-limited",
      category: "Access",
    };
  }
  const allowed = event.severity === "info";
  return {
    ...base,
    verdict: allowed ? "allowed" : "blocked",
    headline: allowed ? "Access allowed" : "Access denied",
    because: rule?.plain ?? event.detail.slice(0, 90),
  };
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

type Stage = "idle" | "checking" | "done";
interface ProbeResult {
  httpStatus: number | null;
  blocked: boolean;
  detail: string;
}

export default function SecurityFeed({ agent }: { agent: Agent }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [enforcing, setEnforcing] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"overview" | "log">(() => {
    try {
      return localStorage.getItem(MODE_KEY) === "log" ? "log" : "overview";
    } catch {
      return "overview";
    }
  });
  const [host, setHost] = useState("attacker.example");
  const [stage, setStage] = useState<Stage>("idle");
  const [result, setResult] = useState<ProbeResult | null>(null);
  const mounted = useRef(true);

  const chooseMode = (next: "overview" | "log") => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // A browser that refuses storage just loses the preference.
    }
  };

  const refresh = useCallback(async () => {
    try {
      const { events: next } = await api.agentEvents(agent.id);
      if (!mounted.current) return;
      setEvents(next.filter((event) => SECURITY_EVENTS.has(event.type)).reverse());
      setError(null);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [agent.id]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    void api
      .system()
      .then((info) => {
        if (mounted.current) setEnforcing(Boolean(info.egressEnforcement));
      })
      .catch(() => undefined);
    const interval = window.setInterval(() => void refresh(), 2000);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
    };
  }, [refresh]);

  const attempt = async (event: React.FormEvent) => {
    event.preventDefault();
    setStage("checking");
    setResult(null);
    setError(null);
    try {
      const probe = await api.probeEgress(agent.id, host.trim());
      if (!mounted.current) return;
      setResult(probe);
      setStage("done");
      await refresh();
    } catch (reason) {
      if (!mounted.current) return;
      setStage("idle");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const lines = events.map(toLine);
  const blockedCount = lines.filter((line) => line.verdict === "blocked").length;

  return (
    <section className="containment">
      <header className="containment-head">
        <div>
          <span className="eyebrow">Containment</span>
          <h3>What this agent was stopped from doing</h3>
        </div>
        <div className="containment-modes" role="group" aria-label="Detail level">
          <button
            type="button"
            className={mode === "overview" ? "mode-on" : ""}
            onClick={() => chooseMode("overview")}
          >
            Overview
          </button>
          <button
            type="button"
            className={mode === "log" ? "mode-on" : ""}
            onClick={() => chooseMode("log")}
          >
            Event log
          </button>
        </div>
      </header>

      <div className="containment-status">
        <span className={"shield " + (enforcing === false ? "shield-off" : "shield-on")}>
          {enforcing === false ? "Not enforcing" : "Enforcing"}
        </span>
        <span className="status-line">
          {enforcing === false
            ? "This agent can reach the network directly. Set EGRESS_ENFORCEMENT=on to contain it."
            : "This agent has no route to the network except through checks it cannot skip."}
        </span>
        <span className="blocked-tally">
          <strong>{blockedCount}</strong> blocked
        </span>
      </div>

      <form className="attempt" onSubmit={attempt}>
        <label>
          Reach an address as this agent
          <input
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="attacker.example"
            spellCheck={false}
          />
        </label>
        <button className="button button-primary" disabled={stage === "checking" || !host.trim()}>
          {stage === "checking" ? "Checking…" : "Attempt"}
        </button>
      </form>

      {(stage === "checking" || result) && (
        <div
          className={
            "verdict " +
            (stage === "checking" ? "verdict-checking" : result?.blocked ? "verdict-blocked" : "verdict-allowed")
          }
          aria-live="polite"
        >
          <span className="verdict-word">
            {stage === "checking" ? "Checking" : result?.blocked ? "Blocked" : "Allowed"}
          </span>
          <span className="verdict-detail">
            {stage === "checking"
              ? `Asking whether this agent may reach ${host.trim()}`
              : result?.detail}
          </span>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {lines.length === 0 && !error && (
        <p className="containment-empty">
          Nothing has been blocked yet. Attempt an address above, or issue and revoke a grant in the
          Passport panel, and every decision lands here.
        </p>
      )}

      {mode === "overview" ? (
        <ul className="containment-list">
          {lines.map((line) => (
            <li key={line.id} className={"line line-" + line.verdict}>
              <span className="line-mark" aria-hidden="true" />
              <span className="line-text">
                <strong>{line.headline}</strong>
                <span className="line-because">{line.because}</span>
              </span>
              <span className="line-meta">
                <span className="chip">{line.category}</span>
                <span className="line-time">{relativeTime(line.at)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="log-scroll">
          <table className="log">
            <thead>
              <tr>
                <th>Verdict</th>
                <th>Rule</th>
                <th>Detail</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id} className={"line-" + line.verdict}>
                  <td className="log-verdict">{line.verdict.toUpperCase()}</td>
                  <td className="mono">{line.rule}</td>
                  <td>{line.because}</td>
                  <td className="mono">{new Date(line.at).toISOString().slice(11, 19)}Z</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

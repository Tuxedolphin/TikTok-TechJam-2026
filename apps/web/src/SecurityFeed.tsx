import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { MemoryPanel } from "./MemoryPanel";
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
  // Remembered context reaching the model is a security event: it is the one
  // input to a run that nobody typed and no grant authorised.
  "memory.recalled",
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
  "AUTHORITY-HUMAN-030": { plain: "A person granted this authority", category: "Authority" },
  "AUTHORITY-SELF-ESCALATION-031": { plain: "The agent tried to widen its own access", category: "Authority" },
  "AUTHORITY-NARROWING-032": { plain: "Passed on less access than it holds", category: "Authority" },
  "MEM-PROVENANCE-040": { plain: "Recorded where this memory came from", category: "Memory" },
  "MEM-EXPIRED-041": { plain: "A memory reached its expiry", category: "Memory" },
  "MEM-QUARANTINE-042": { plain: "A quarantined memory was kept out of context", category: "Memory" },
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
    // The host travels in the payload; parsing it back out of the title would
    // break silently the moment that wording changed.
    let host = "an outside address";
    try {
      const payload = JSON.parse(event.detail) as { host?: string };
      if (payload.host) host = payload.host;
    } catch {
      // Fall back to the generic phrasing.
    }
    return {
      ...base,
      verdict: "blocked",
      headline: `Stopped from reaching ${host}`,
      because: "No grant allows this address",
      category: "Network",
    };
  }
  if (event.type === "memory.recalled") {
    let untrusted = 0;
    let bytes = 0;
    try {
      const payload = JSON.parse(event.detail) as { untrusted?: number; bytesInjected?: number };
      untrusted = payload.untrusted ?? 0;
      bytes = payload.bytesInjected ?? 0;
    } catch {
      // Fall back to the generic phrasing.
    }
    return {
      ...base,
      // Not a denial -- it was allowed through, labeled. But untrusted context
      // in the model's window is the thing an operator wants to notice.
      verdict: untrusted > 0 ? "blocked" : "allowed",
      headline:
        untrusted > 0
          ? `Carried ${untrusted} belief${untrusted === 1 ? "" : "s"} it picked up itself`
          : "Carried remembered context into this run",
      because: `${bytes} bytes of memory added to the prompt`,
      category: "Memory",
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
        <span className={"status-tag status-" + (enforcing === false ? "blocked" : "ready")}>
          <span className="status-dot" />
          {enforcing === false ? "Not enforcing" : "Enforcing"}
        </span>
        <span className="status-line">
          {enforcing === false
            ? "Direct route active. Set EGRESS_ENFORCEMENT=on."
            : "Isolated container: all traffic routed through proxy."}
        </span>
        <span className="blocked-tally mono">
          <strong>{blockedCount}</strong> blocked
        </span>
      </div>

      <form className="attempt-form" onSubmit={attempt}>
        <div className="attempt-input-row">
          <input
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="Host probe (e.g. attacker.example)"
            spellCheck={false}
            className="attempt-input"
          />
          <button className="button button-primary" disabled={stage === "checking" || !host.trim()}>
            {stage === "checking" ? "Testing…" : "Probe"}
          </button>
        </div>
      </form>

      {(stage === "checking" || result) && (
        <div
          className={
            "verdict-box " +
            (stage === "checking" ? "verdict-checking" : result?.blocked ? "verdict-blocked" : "verdict-allowed")
          }
          aria-live="polite"
        >
          <span className="verdict-tag mono">
            {stage === "checking" ? "CHECKING" : result?.blocked ? "BLOCKED" : "ALLOWED"}
          </span>
          <span className="verdict-detail">
            {stage === "checking"
              ? `Testing egress to ${host.trim()}…`
              : result?.detail}
          </span>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {lines.length === 0 && !error && (
        <p className="containment-empty">
          No egress events recorded. Probe a host above or trigger a network call from the chat.
        </p>
      )}

      {mode === "overview" ? (
        <ul className="containment-list">
          {lines.map((line) => (
            <li key={line.id} className={"line line-" + line.verdict}>
              <span className="line-mark" aria-hidden="true" />
              <div className="line-text">
                <strong>{line.headline}</strong>
                <span className="line-because">{line.because}</span>
              </div>
              <div className="line-meta">
                <span className="category-tag mono">{line.category}</span>
                <span className="line-time mono">{relativeTime(line.at)}</span>
              </div>
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

      <MemoryPanel agentId={agent.id} mode={mode} />
    </section>
  );
}

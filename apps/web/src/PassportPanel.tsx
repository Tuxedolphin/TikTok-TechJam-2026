import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, getCurrentPrincipalId, setCurrentPrincipalId } from "./api";
import type { Agent, Grant, GrantScope, MockResource, PolicyDecision, Principal } from "./types";

/** Seeded fixtures: res-a belongs to user-a, res-b to user-b. */
const PROBEABLE_RESOURCES = ["res-a", "res-b"] as const;

const scopeOptions: { value: GrantScope; label: string }[] = [
  { value: "resource:read", label: "resource:read" },
  { value: "resource:write", label: "resource:write" },
  { value: "network:egress", label: "network:egress" },
];

const emptyGrantForm = {
  scope: "resource:read" as GrantScope,
  target: "res-a",
  ttlMinutes: "5",
};

type ProbeResult = {
  resourceId: string;
  resource: MockResource | null;
  decision: PolicyDecision;
};

function formatCountdown(expiresAt: string, nowMs: number): string {
  const remainingMs = new Date(expiresAt).getTime() - nowMs;
  if (remainingMs <= 0) return "expired";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes.toString().padStart(2, "0") + ":" + seconds.toString().padStart(2, "0");
}

function grantStatus(grant: Grant, nowMs: number): "active" | "revoked" | "expired" {
  if (grant.revokedAt) return "revoked";
  if (grant.expiresAt && new Date(grant.expiresAt).getTime() <= nowMs) return "expired";
  return "active";
}

export default function PassportPanel({ agent }: { agent: Agent }) {
  const [principals, setPrincipals] = useState<Principal[]>([]);
  const [actingAs, setActingAs] = useState(getCurrentPrincipalId());
  const [grants, setGrants] = useState<Grant[]>([]);
  const [grantForm, setGrantForm] = useState(emptyGrantForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});
  const [probing, setProbing] = useState<string | null>(null);

  const humanPrincipals = useMemo(
    () => principals.filter((p) => p.kind === "human"),
    [principals],
  );

  const owner = useMemo(
    () => principals.find((p) => p.id === agent.ownerId) ?? null,
    [principals, agent.ownerId],
  );

  const refreshGrants = useCallback(async () => {
    try {
      const { grants: next } = await api.listGrants(agent.principalId);
      setGrants(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [agent.principalId]);

  useEffect(() => {
    void api
      .listPrincipals()
      .then(({ principals: next }) => setPrincipals(next))
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  useEffect(() => {
    setProbes({});
    void refreshGrants();
  }, [refreshGrants]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const switchActingAs = (principalId: string) => {
    setCurrentPrincipalId(principalId);
    setActingAs(principalId);
  };

  const issueGrant = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createGrant({
        principalId: agent.principalId,
        scope: grantForm.scope,
        target: grantForm.target.trim(),
        ttlMinutes: grantForm.ttlMinutes ? Number(grantForm.ttlMinutes) : undefined,
      });
      setGrantForm(emptyGrantForm);
      await refreshGrants();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (grantId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.revokeGrant(grantId);
      await refreshGrants();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const tryRead = async (resourceId: string) => {
    setProbing(resourceId);
    setError(null);
    try {
      const { resource, decision } = await api.readResourceAsAgent(resourceId, agent.principalId);
      setProbes((current) => ({ ...current, [resourceId]: { resourceId, resource, decision } }));
    } catch (reason) {
      if (!(reason instanceof ApiError)) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setProbing(null);
    }
  };

  return (
    <section className="passport-panel">
      <div className="passport-header">
        <div>
          <span className="eyebrow">Identity &amp; delegation</span>
          <h2>Agent passport</h2>
        </div>
        <div className="passport-identity">
          <div className="passport-identity-row">
            <span className="passport-identity-label">Owner</span>
            <strong>{owner?.name ?? agent.ownerId}</strong>
          </div>
          <div className="passport-identity-row">
            <span className="passport-identity-label">Agent principal</span>
            <code className="mono">{agent.principalId}</code>
          </div>
        </div>
      </div>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      <div className="passport-body">
        <div className="passport-column">
          <div className="passport-block">
            <span className="passport-block-title">Acting as</span>
            <div className="acting-as-switcher">
              {humanPrincipals.map((principal) => (
                <button
                  key={principal.id}
                  type="button"
                  className={"acting-as-btn " + (actingAs === principal.id ? "active" : "")}
                  onClick={() => switchActingAs(principal.id)}
                >
                  {principal.name}
                </button>
              ))}
            </div>
            <p className="passport-hint">
              API calls that grant or revoke access are sent as this principal via{" "}
              <code>x-principal-id</code>.
            </p>
          </div>

          <div className="passport-block">
            <span className="passport-block-title">Issue a grant</span>
            <form className="grant-form" onSubmit={issueGrant}>
              <label>
                Scope
                <select
                  value={grantForm.scope}
                  onChange={(event) =>
                    setGrantForm({ ...grantForm, scope: event.target.value as GrantScope })
                  }
                >
                  {scopeOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Target
                <input
                  value={grantForm.target}
                  onChange={(event) => setGrantForm({ ...grantForm, target: event.target.value })}
                  placeholder="res-a"
                  required
                />
              </label>
              <label>
                TTL (minutes)
                <input
                  type="number"
                  min={1}
                  value={grantForm.ttlMinutes}
                  onChange={(event) =>
                    setGrantForm({ ...grantForm, ttlMinutes: event.target.value })
                  }
                  placeholder="No expiry"
                />
              </label>
              <button className="button button-primary" disabled={busy}>
                Grant access
              </button>
            </form>
          </div>
        </div>

        <div className="passport-column">
          <div className="passport-block">
            <span className="passport-block-title">Grants ({grants.length})</span>
            <div className="grant-list">
              {grants.length === 0 && <div className="trace-empty">No grants issued yet.</div>}
              {grants.map((grant) => {
                const status = grantStatus(grant, now);
                return (
                  <div
                    key={grant.id}
                    className={"grant-row grant-status-" + status}
                  >
                    <div className="grant-row-main">
                      <span className={"grant-scope " + (status !== "active" ? "grant-struck" : "")}>
                        {grant.scope}
                      </span>
                      <code className={"mono " + (status !== "active" ? "grant-struck" : "")}>
                        {grant.target}
                      </code>
                    </div>
                    <div className="grant-row-meta">
                      {status === "active" ? (
                        <span className="grant-countdown mono">
                          {grant.expiresAt ? formatCountdown(grant.expiresAt, now) : "no expiry"}
                        </span>
                      ) : (
                        <span className={"grant-badge grant-badge-" + status}>{status}</span>
                      )}
                      {status === "active" && (
                        <button
                          type="button"
                          className="button-danger grant-revoke-btn"
                          onClick={() => revoke(grant.id)}
                          disabled={busy}
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="passport-block">
            <span className="passport-block-title">Try to read (as this agent)</span>
            <div className="probe-buttons">
              {PROBEABLE_RESOURCES.map((resourceId) => (
                <button
                  key={resourceId}
                  type="button"
                  className="button button-ghost probe-btn"
                  onClick={() => tryRead(resourceId)}
                  disabled={probing === resourceId}
                >
                  {probing === resourceId ? "Checking…" : `Read ${resourceId}`}
                </button>
              ))}
            </div>
            <div className="probe-results">
              {PROBEABLE_RESOURCES.map((resourceId) => {
                const result = probes[resourceId];
                if (!result) return null;
                return (
                  <div
                    key={resourceId}
                    className={
                      "probe-result " + (result.decision.allowed ? "probe-allow" : "probe-deny")
                    }
                  >
                    <div className="probe-result-top">
                      <strong>{result.decision.allowed ? "ALLOWED" : "DENIED"}</strong>
                      <code className="mono">{resourceId}</code>
                      <code className="mono probe-rule-id">{result.decision.ruleId}</code>
                    </div>
                    <p className="probe-reason">{result.decision.reason}</p>
                    {result.decision.allowed && result.resource && (
                      <pre className="probe-content"><code>{result.resource.content}</code></pre>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

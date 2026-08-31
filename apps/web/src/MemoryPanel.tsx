import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { MemoryEntry } from "./types";

/**
 * What the agent believes, and where each belief came from.
 *
 * The panel exists because provenance is only useful if somebody can see it.
 * An untrusted memory is not hidden and not deleted -- it is shown, sourced,
 * and quarantinable, so an operator reading a strange run can find the belief
 * behind it and pull that belief out of circulation.
 */

const SOURCE_LABEL: Record<MemoryEntry["provenance"]["sourceType"], string> = {
  operator: "you wrote this",
  "agent-output": "the agent asked to keep this",
  "tool-result": "came back from a tool",
  "web-content": "read off a page",
};

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function MemoryPanel({
  agentId,
  mode,
}: {
  agentId: string;
  /** Matches the containment feed: plain language, or rule ids and detail. */
  mode: "overview" | "log";
}) {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { memories: loaded } = await api.listMemories(agentId);
      setMemories(loaded);
      setError(null);
    } catch {
      // The routes are only mounted when a memory service is wired; an empty
      // panel is the honest rendering, not an error banner.
      setMemories([]);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  const quarantine = async (id: string) => {
    setBusy(id);
    try {
      await api.quarantineMemory(id);
      await load();
    } catch {
      setError("Could not quarantine that memory.");
    } finally {
      setBusy(null);
    }
  };

  const live = memories.filter((entry) => entry.quarantinedAt === null);
  const untrusted = live.filter((entry) => entry.trust === "untrusted").length;

  return (
    <section className="memory-panel">
      <header className="memory-head">
        <span className="eyebrow">Memory</span>
        <span className="memory-tally mono">
          {live.length} carried{untrusted > 0 ? ` · ${untrusted} untrusted` : ""}
        </span>
      </header>

      <p className="memory-note">
        {mode === "overview"
          ? "What this agent carries between sessions. Anything it picked up on its own is marked, and you can take a belief out of circulation."
          : "Provenance-labeled entries. Recall filters on expiry and quarantine; memories confer no authority."}
      </p>

      {error ? <p className="memory-error">{error}</p> : null}

      {memories.length === 0 ? (
        <p className="memory-empty">Nothing remembered yet.</p>
      ) : (
        <ul className="memory-list">
          {memories.map((entry) => {
            const quarantined = entry.quarantinedAt !== null;
            return (
              <li
                key={entry.id}
                className={
                  "memory-item" +
                  (quarantined ? " memory-quarantined" : "") +
                  (entry.trust === "untrusted" ? " memory-untrusted" : "")
                }
              >
                <p className="memory-content">{entry.content}</p>
                <div className="memory-meta">
                  <span className={"memory-badge memory-badge-" + entry.trust}>
                    {mode === "overview"
                      ? SOURCE_LABEL[entry.provenance.sourceType]
                      : `${entry.provenance.sourceType} · ${entry.trust}`}
                  </span>
                  {mode === "log" ? (
                    <span className="memory-source mono">{entry.provenance.sourceDetail}</span>
                  ) : null}
                  <span className="memory-time">{when(entry.createdAt)}</span>
                  {entry.expiresAt ? (
                    <span className="memory-time">expires {when(entry.expiresAt)}</span>
                  ) : null}
                </div>
                {quarantined ? (
                  <p className="memory-quarantine-note">
                    Out of circulation — {entry.quarantinedBy} · {when(entry.quarantinedAt!)}
                  </p>
                ) : (
                  <button
                    className="button button-ghost memory-quarantine-button"
                    onClick={() => void quarantine(entry.id)}
                    disabled={busy === entry.id}
                  >
                    {busy === entry.id ? "Quarantining…" : "Quarantine"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

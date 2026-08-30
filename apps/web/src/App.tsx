import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import type { Agent, AgentRun, AgentSession, Message, RunEvent, SystemInfo } from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status-tag status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionDropdownOpen, setSessionDropdownOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [traceEvents, setTraceEvents] = useState<RunEvent[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"trace" | "tokens" | "runs">("trace");
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const telemetryRef = useRef<HTMLDivElement>(null);
  const sessionDropdownRef = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const selectedSessionIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;
  selectedSessionIdRef.current = selectedSessionId;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        drawerOpen &&
        telemetryRef.current &&
        !telemetryRef.current.contains(target)
      ) {
        setDrawerOpen(false);
      }
      if (
        sessionDropdownOpen &&
        sessionDropdownRef.current &&
        !sessionDropdownRef.current.contains(target)
      ) {
        setSessionDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [drawerOpen, sessionDropdownOpen]);


  const latestStep = useMemo(() => {

    return traceEvents.length > 0 ? traceEvents[traceEvents.length - 1] : null;
  }, [traceEvents]);

  const activeRunTokens = useMemo(() => {
    if (!activeRun?.usage) return 0;
    return (
      (activeRun.usage.inputTokens ?? 0) +
      (activeRun.usage.cachedInputTokens ?? 0) +
      (activeRun.usage.outputTokens ?? 0)
    );
  }, [activeRun]);


  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const currentSession = useMemo(() => {
    return sessions.find((s) => s.id === selectedSessionId) ?? sessions[0] ?? null;
  }, [sessions, selectedSessionId]);

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshSessions = useCallback(async (agentId: string) => {
    const result = await api.sessions(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setSessions(result.sessions);
      return result.sessions;
    }
    return [];
  }, []);

  const refreshMessages = useCallback(async (agentId: string, sessionId?: string) => {
    const result = await api.messages(agentId, sessionId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const refreshRuns = useCallback(async (agentId: string, sessionId?: string) => {
    const result = await api.runs(agentId, sessionId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setRuns(result.runs);
    }
    return result.runs;
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setRuns([]);
    setTraceEvents([]);
    setShowSettings(false);
    setSessionDropdownOpen(false);
    if (!selectedId) {
      setMessages([]);
      setSessions([]);
      setSelectedSessionId(null);
      return;
    }
    void (async () => {
      try {
        const nextSessions = await refreshSessions(selectedId);
        const targetAgent = agents.find((a) => a.id === selectedId);
        const activeSessId = targetAgent?.activeSessionId || nextSessions[0]?.id || null;
        setSelectedSessionId(activeSessId);
        const [, nextRuns] = await Promise.all([
          refreshMessages(selectedId, activeSessId ?? undefined),
          refreshRuns(selectedId, activeSessId ?? undefined),
        ]);
        if (selectedIdRef.current !== selectedId) return;
        const latest = nextRuns[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
  }, [refreshMessages, refreshRuns, refreshSessions, selectedId]);


  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  useEffect(() => {
    if (!activeRun) {
      setTraceEvents([]);
      return;
    }
    void api
      .runEvents(activeRun.id)
      .then(({ events }) => {
        if (mountedRef.current) {
          setTraceEvents(events);
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleSelectChat = async (sessionId: string) => {
    if (!selectedId) return;
    setSessionDropdownOpen(false);
    setSelectedSessionId(sessionId);
    setActiveRun(null);
    setTraceEvents([]);
    try {
      const { agent: updatedAgent } = await api.selectSession(selectedId, sessionId);
      setAgents((prev) => prev.map((a) => (a.id === updatedAgent.id ? updatedAgent : a)));
      const [, nextRuns] = await Promise.all([
        refreshMessages(selectedId, sessionId),
        refreshRuns(selectedId, sessionId),
      ]);
      const latest = nextRuns[0] ?? null;
      setActiveRun(latest);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const handleNewChat = async () => {
    if (!selectedId) return;
    setSessionDropdownOpen(false);
    setBusy(true);
    try {
      const { session, agent: updatedAgent } = await api.createSession(selectedId);
      setSessions((prev) => [session, ...prev]);
      setSelectedSessionId(session.id);
      setAgents((prev) => prev.map((a) => (a.id === updatedAgent.id ? updatedAgent : a)));
      setMessages([]);
      setRuns([]);
      setActiveRun(null);
      setTraceEvents([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const [result, eventsResult] = await Promise.all([
          api.run(runId),
          api.runEvents(runId),
        ]);
        if (selectedIdRef.current === agentId) {
          setActiveRun(result.run);
          setTraceEvents(eventsResult.events);
        }
        if (!["queued", "running"].includes(result.run.status)) {
          const currentSessId = selectedSessionIdRef.current ?? undefined;
          await Promise.all([
            refreshMessages(agentId, currentSessId),
            refreshAgents(),
            refreshRuns(agentId, currentSessId),
            refreshSessions(agentId),
          ]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
        setRuns((current) => [result.run, ...current.filter((r) => r.id !== result.run.id)]);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      const currentSessId = selectedSessionIdRef.current ?? undefined;
      const nextRuns = await refreshRuns(selected.id, currentSessId);
      const latest = nextRuns[0] ?? null;
      setActiveRun(latest);
      await refreshAgents();
    }
  };


  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          Create Agent
        </button>

        <div className="sidebar-label">
          <span>Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              No agents created yet.
            </div>
          )}
        </nav>


        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.openRouterModel ?? "OpenRouter model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
          <span>
            {system?.guardrailCanaryEnabled
              ? "Canary guardrail active"
              : "Canary guardrail off"}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.openRouterConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.openRouterConfigured
                  ? "Set OPENROUTER_API_KEY and OPENROUTER_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div className="playground-topbar-left">
                  <span className="eyebrow">Playground</span>
                  <div className="session-selector" ref={sessionDropdownRef}>
                    <button
                      type="button"
                      className="session-selector-btn"
                      onClick={() => setSessionDropdownOpen(!sessionDropdownOpen)}
                      title="Switch chat or view past chats"
                    >
                      <span className="session-title">{currentSession?.title ?? "Chat"}</span>
                      <span className="session-chevron">▾</span>
                    </button>

                    {sessionDropdownOpen && (
                      <div className="session-dropdown-menu">
                        <div className="session-dropdown-header">
                          <span>Chats for {selected.name}</span>
                          <button
                            type="button"
                            className="new-chat-btn"
                            onClick={handleNewChat}
                            disabled={busy || (activeRun != null && ["queued", "running"].includes(activeRun.status))}
                          >
                            + New Chat
                          </button>
                        </div>
                        <div className="session-dropdown-list">
                          {sessions.map((s) => (
                            <button
                              key={s.id}
                              type="button"
                              className={"session-dropdown-item " + (s.id === selectedSessionId ? "active" : "")}
                              onClick={() => handleSelectChat(s.id)}
                            >
                              <div className="session-item-row">
                                <strong>{s.title}</strong>
                                <span className="mono">{formatTime(s.createdAt)}</span>
                              </div>
                              <span className="session-item-sub">
                                {s.codexThreadId ? "Context active" : "Fresh context"}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="playground-topbar-right">
                  <button
                    type="button"
                    className="button button-ghost new-chat-quick-btn"
                    onClick={handleNewChat}
                    disabled={busy || (activeRun != null && ["queued", "running"].includes(activeRun.status))}
                    title="Start a new chat with a clean context window"
                  >
                    + New Chat
                  </button>
                  <div className="session-info">
                    <span className="pulse" />
                    {currentSession?.codexThreadId ? "Context active" : "New session"}
                  </div>
                </div>
              </div>


              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <h3>{selected.name}</h3>
                    <p>
                      Inspect files, edit code, run commands, and continue the same session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)} className="prompt-card">
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      <span>Executing in workspace…</span>
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                {runs.length > 0 && activeRun && (
                  <div className="telemetry-bar-wrapper" ref={telemetryRef}>
                    {drawerOpen && (
                      <div className="telemetry-drawer">
                        <div className="telemetry-drawer-header">
                          <div className="drawer-tabs">
                            <button
                              type="button"
                              className={"drawer-tab " + (drawerTab === "trace" ? "active" : "")}
                              onClick={() => setDrawerTab("trace")}
                            >
                              Trace ({traceEvents.length})
                            </button>
                            <button
                              type="button"
                              className={"drawer-tab " + (drawerTab === "tokens" ? "active" : "")}
                              onClick={() => setDrawerTab("tokens")}
                            >
                              Usage
                            </button>
                            <button
                              type="button"
                              className={"drawer-tab " + (drawerTab === "runs" ? "active" : "")}
                              onClick={() => setDrawerTab("runs")}
                            >
                              History ({runs.length})
                            </button>
                          </div>
                          <button
                            type="button"
                            className="drawer-close-btn"
                            onClick={() => setDrawerOpen(false)}
                            aria-label="Close details"
                          >
                            ×
                          </button>
                        </div>

                        <div className="telemetry-drawer-body">
                          {drawerTab === "trace" && (
                            <div className="trace-events">
                              {traceEvents.map((event) => (
                                <div className={"trace-event trace-" + event.severity} key={event.id}>
                                  <div className="trace-event-top">
                                    <strong>{event.title}</strong>
                                    <span className="mono">{formatTime(event.createdAt)}</span>
                                  </div>
                                  <p>{event.detail}</p>
                                </div>
                              ))}
                              {traceEvents.length === 0 && (
                                <div className="trace-empty">No trace events recorded for this turn.</div>
                              )}
                            </div>
                          )}

                          {drawerTab === "tokens" && (
                            <div className="telemetry-tokens-view">
                              <div className="metrics-grid">
                                <div className="metric-box">
                                  <span className="metric-label">Input Tokens</span>
                                  <strong className="metric-val mono">{activeRun.usage?.inputTokens?.toLocaleString() ?? "0"}</strong>
                                </div>
                                <div className="metric-box">
                                  <span className="metric-label">Cached</span>
                                  <strong className="metric-val mono">{activeRun.usage?.cachedInputTokens?.toLocaleString() ?? "0"}</strong>
                                </div>
                                <div className="metric-box">
                                  <span className="metric-label">Output</span>
                                  <strong className="metric-val mono">{activeRun.usage?.outputTokens?.toLocaleString() ?? "0"}</strong>
                                </div>
                                <div className="metric-box highlight">
                                  <span className="metric-label">Est. Cost</span>
                                  <strong className="metric-val mono">
                                    {activeRun.usage?.costUsd != null ? `$${activeRun.usage.costUsd.toFixed(5)}` : "$0.00"}
                                  </strong>
                                </div>
                              </div>

                              <div className="telemetry-policy-info">
                                <div className="policy-row">
                                  <span>Canary Guardrail</span>
                                  <strong className="mono">
                                    {system?.guardrailCanaryEnabled ? "Active" : "Disabled"}
                                  </strong>
                                </div>
                                <div className="policy-row">
                                  <span>Token Budget</span>
                                  <strong className="mono">
                                    {system?.runBudgetMaxTotalTokens ? `${system.runBudgetMaxTotalTokens.toLocaleString()} tokens` : "None"}
                                  </strong>
                                </div>
                                <div className="policy-row">
                                  <span>Duration Watchdog</span>
                                  <strong className="mono">
                                    {system?.runBudgetMaxDurationMs ? `${system.runBudgetMaxDurationMs / 1000}s` : "None"}
                                  </strong>
                                </div>
                                <div className="policy-row">
                                  <span>Sandbox Mode</span>
                                  <strong className="mono">{system?.codexSandboxMode ?? "workspace-write"}</strong>
                                </div>
                              </div>
                            </div>
                          )}

                          {drawerTab === "runs" && (
                            <div className="run-history-grid">
                              {runs.map((r) => {
                                const isSelected = activeRun.id === r.id;
                                const rTokens = r.usage
                                  ? (r.usage.inputTokens ?? 0) + (r.usage.cachedInputTokens ?? 0) + (r.usage.outputTokens ?? 0)
                                  : 0;
                                return (
                                  <button
                                    key={r.id}
                                    type="button"
                                    className={"run-history-card " + (isSelected ? "selected" : "")}
                                    onClick={async () => {
                                      const [details, eventsResult] = await Promise.all([
                                        api.run(r.id),
                                        api.runEvents(r.id),
                                      ]);
                                      setActiveRun(details.run);
                                      setTraceEvents(eventsResult.events);
                                    }}
                                  >
                                    <div className="run-card-top">
                                      <span className={"status-tag status-" + r.status}>{r.status}</span>
                                      <span className="mono">{formatTime(r.createdAt)}</span>
                                    </div>
                                    <p className="run-card-prompt">{r.prompt}</p>
                                    <div className="run-card-foot mono">
                                      <span>{rTokens > 0 ? `${rTokens.toLocaleString()} tok` : "—"}</span>
                                      {r.usage?.costUsd != null && <span>${r.usage.costUsd.toFixed(4)}</span>}
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="telemetry-bar">
                      <div className="telemetry-bar-left">
                        <span className={"status-tag status-" + activeRun.status}>
                          {["queued", "running"].includes(activeRun.status) && <Spinner />}
                          {activeRun.status}
                        </span>
                        <div className="telemetry-step-preview">
                          {["queued", "running"].includes(activeRun.status) ? (
                            latestStep ? (
                              <span title={latestStep.detail}>
                                <strong>{latestStep.title}:</strong> {latestStep.detail.slice(0, 40)}{latestStep.detail.length > 40 ? "…" : ""}
                              </span>
                            ) : (
                              <span>Running…</span>
                            )
                          ) : (
                            <span title={activeRun.prompt}>
                              {activeRun.prompt.slice(0, 45)}{activeRun.prompt.length > 45 ? "…" : ""}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="telemetry-bar-right">
                        <button
                          type="button"
                          className={"telemetry-item " + (drawerOpen && drawerTab === "tokens" ? "active" : "")}
                          onClick={() => {
                            setDrawerTab("tokens");
                            setDrawerOpen(drawerOpen && drawerTab === "tokens" ? false : true);
                          }}
                          title="View token usage and cost"
                        >
                          <span className="mono">{activeRunTokens.toLocaleString()} tokens</span>
                          {activeRun.usage?.costUsd != null && (
                            <span className="telemetry-sub mono">${activeRun.usage.costUsd.toFixed(4)}</span>
                          )}
                        </button>

                        <span className="telemetry-sep">·</span>

                        <button
                          type="button"
                          className={"telemetry-item " + (drawerOpen && drawerTab === "trace" ? "active" : "")}
                          onClick={() => {
                            setDrawerTab("trace");
                            setDrawerOpen(drawerOpen && drawerTab === "trace" ? false : true);
                          }}
                          title="View execution trace"
                        >
                          {traceEvents.length} events
                        </button>

                        <span className="telemetry-sep">·</span>

                        <button
                          type="button"
                          className={"telemetry-item " + (drawerOpen && drawerTab === "runs" ? "active" : "")}
                          onClick={() => {
                            setDrawerTab("runs");
                            setDrawerOpen(drawerOpen && drawerTab === "runs" ? false : true);
                          }}
                          title="View run history"
                        >
                          {runs.length} runs
                        </button>

                        <span className="telemetry-sep">·</span>

                        <button
                          type="button"
                          className={"telemetry-toggle " + (drawerOpen ? "active" : "")}
                          onClick={() => setDrawerOpen(!drawerOpen)}
                        >
                          {drawerOpen ? "Close" : "Inspect"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}


                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

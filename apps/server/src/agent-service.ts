import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isModelConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  AgentSession,
  ApprovalRequest,
  ApprovalStatus,
  CreateAgentInput,
  Grant,
  Message,
  PolicyDecision,
  RunEvent,
  RunEventSeverity,
  RunEventType,
  RunnerStepEvent,
  UpdateAgentInput,
} from "./types.js";

import { WorkspaceManager } from "./workspace.js";
import type { EgressNetworkManager } from "./egress-network.js";
import {
  estimateRunCostUsd,
  evaluateActionRisk,
  rejectOutputIfCanaryPresent,
  rejectPromptIfCanaryPresent,
  rejectRunIfBudgetExceeded,
  RunPolicyViolationError,
  summarizeRunPolicies,
} from "./run-policies.js";


const now = () => new Date().toISOString();

const PREVIEW_LENGTH = 180;
const MEMORY_MESSAGE_LIMIT = 4;
const MEMORY_MESSAGE_CHAR_LIMIT = 600;

const hasActiveLifecycle = (status: Agent["status"]) =>
  status === "busy" || status === "waiting_approval";

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly lifecycleMutations = new Set<string>();
  private readonly pendingApprovals = new Map<
    string,
    {
      resolve: (approved: boolean) => void;
      timeout: NodeJS.Timeout;
      request: ApprovalRequest;
      signal?: AbortSignal;
      onAbort?: () => void;
    }
  >();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly egress?: EgressNetworkManager,
    private readonly onAgentStarted?: (agentId: string) => void,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy" || agent.status === "waiting_approval") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
      for (const approval of database.approvals) {
        if (approval.status === "pending") {
          approval.status = "denied";
          approval.resolvedAt = now();
          approval.resolvedBy = "System (Server restarted)";
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput, actorPrincipalId = "user-a"): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const initialSessionId = randomUUID();
    const principalId = `agent-${id}`;
    const initialSession: AgentSession = {
      id: initialSessionId,
      agentId: id,
      title: "Chat 1",
      codexThreadId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      ownerId: actorPrincipalId,
      principalId,
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      activeSessionId: initialSessionId,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent, this.config.guardrailCanaryToken);
    await this.store.mutate((database) => {
      database.agents.push(agent);
      database.sessions.push(initialSession);
      database.principals.push({
        id: principalId,
        kind: "agent",
        name: input.name.trim(),
        createdAt: timestamp,
      });
    });
    return agent;
  }

  async recordPolicyDecision(
    runId: string,
    agentId: string,
    decision: PolicyDecision,
  ): Promise<void> {
    await this.store.mutate((database) => {
      this.appendRunEvent(database, {
        runId,
        agentId,
        type: "policy.decision",
        severity: decision.allowed ? "info" : "warning",
        title: decision.ruleId,
        detail: JSON.stringify(decision),
        createdAt: now(),
      });
    });
  }

  async recordGrantEvent(
    runId: string,
    agentId: string,
    type: "grant.created" | "grant.revoked",
    grant: Grant,
  ): Promise<void> {
    await this.store.mutate((database) => {
      this.appendRunEvent(database, {
        runId,
        agentId,
        type,
        severity: type === "grant.revoked" ? "warning" : "info",
        title:
          type === "grant.revoked"
            ? `Revoked ${grant.scope} on ${grant.target}`
            : `Granted ${grant.scope} on ${grant.target}`,
        detail: JSON.stringify(grant),
        createdAt: now(),
      });
    });
  }

  async recordEgressBlocked(
    runId: string,
    agentId: string,
    host: string,
    decision: PolicyDecision,
    strikes: number,
  ): Promise<void> {
    await this.store.mutate((database) => {
      this.appendRunEvent(database, {
        runId,
        agentId,
        type: "egress.blocked",
        severity: "error",
        title: `Blocked outbound connection to ${host}`,
        detail: JSON.stringify({ host, strikes, ...decision }),
        createdAt: now(),
      });
    });
  }

  /**
   * Stops an agent that keeps trying to reach hosts it has no grant for.
   * Repeated denials are the signature of a hijacked agent probing for an
   * exfiltration route, so containment escalates from blocking each attempt to
   * halting the agent outright.
   */
  async quarantineAgent(agentId: string, reason: string): Promise<void> {
    const ownsLifecycleMutation = !this.lifecycleMutations.has(agentId);
    if (ownsLifecycleMutation) this.lifecycleMutations.add(agentId);
    try {
      await this.cancelExecution(agentId);
      await this.store.mutate((database) => {
        const agent = database.agents.find((item) => item.id === agentId);
        if (!agent) return;
        agent.status = "stopped";
        agent.lastError = reason;
        agent.updatedAt = now();
      });
    } finally {
      if (ownsLifecycleMutation) this.lifecycleMutations.delete(agentId);
    }
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (hasActiveLifecycle(current.status)) {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (hasActiveLifecycle(agent.status) || this.lifecycleMutations.has(id)) {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    if (this.lifecycleMutations.has(id)) {
      throw new HttpError(409, "Another lifecycle change is already in progress");
    }
    this.lifecycleMutations.add(id);
    try {
      await this.cancelExecution(id);
      const archivedWorkspace = await this.workspaces.archive(agent);
      await this.store.mutate((database) => {
        database.agents = database.agents.filter((item) => item.id !== id);
        database.sessions = database.sessions.filter((item) => item.agentId !== id);
        database.messages = database.messages.filter((item) => item.agentId !== id);
        database.runs = database.runs.filter((item) => item.agentId !== id);
        database.runEvents = database.runEvents.filter((item) => item.agentId !== id);
        database.approvals = database.approvals.filter((item) => item.agentId !== id);
      });
      return { archivedWorkspace };
    } finally {
      this.lifecycleMutations.delete(id);
    }
  }

  listSessions(agentId: string): AgentSession[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .sessions.filter((s) => s.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async createSession(agentId: string, title?: string): Promise<{ session: AgentSession; agent: Agent }> {
    const currentAgent = this.getAgent(agentId);
    if (hasActiveLifecycle(currentAgent.status)) {
      throw new HttpError(409, "Wait for the active run to finish before creating a new chat session");
    }
    const timestamp = now();
    const sessionId = randomUUID();
    const existingCount = this.store.snapshot().sessions.filter((s) => s.agentId === agentId).length;
    const sessionTitle = title?.trim() || `Chat ${existingCount + 1}`;
    const session: AgentSession = {
      id: sessionId,
      agentId,
      title: sessionTitle,
      codexThreadId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const updatedAgent = await this.store.mutate((database) => {
      const agent = database.agents.find((a) => a.id === agentId);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (hasActiveLifecycle(agent.status) || this.lifecycleMutations.has(agentId)) {
        throw new HttpError(409, "Wait for the active run to finish before creating a new chat session");
      }
      database.sessions.push(session);
      agent.activeSessionId = sessionId;
      agent.codexThreadId = null;
      agent.updatedAt = timestamp;
      return structuredClone(agent);
    });
    return { session, agent: updatedAgent };
  }

  async selectSession(agentId: string, sessionId: string): Promise<Agent> {
    const currentAgent = this.getAgent(agentId);
    if (hasActiveLifecycle(currentAgent.status)) {
      throw new HttpError(409, "Wait for the active run to finish before switching chat sessions");
    }
    const session = this.store.snapshot().sessions.find((s) => s.id === sessionId && s.agentId === agentId);
    if (!session) {
      throw new HttpError(404, "Session not found");
    }
    const timestamp = now();
    const updatedAgent = await this.store.mutate((database) => {
      const agent = database.agents.find((a) => a.id === agentId);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (hasActiveLifecycle(agent.status) || this.lifecycleMutations.has(agentId)) {
        throw new HttpError(409, "Wait for the active run to finish before switching chat sessions");
      }
      agent.activeSessionId = sessionId;
      agent.codexThreadId = session.codexThreadId;
      agent.updatedAt = timestamp;
      return structuredClone(agent);
    });
    return updatedAgent;
  }

  async startAgent(id: string): Promise<Agent> {
    // Starting a quarantined agent is the operator clearing the incident, so
    // its blocked-attempt history goes with it; otherwise the stale count sits
    // at the threshold and the next single denial re-quarantines it at once.
    const agent = await this.setStatus(id, "ready");
    this.onAgentStarted?.(id);
    return agent;
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    if (this.lifecycleMutations.has(id)) {
      throw new HttpError(409, "Another lifecycle change is already in progress");
    }
    this.lifecycleMutations.add(id);
    try {
      await this.cancelExecution(id);
      return await this.setStatus(id, "stopped");
    } finally {
      this.lifecycleMutations.delete(id);
    }
  }

  getMessages(agentId: string, sessionId?: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => {
        if (message.agentId !== agentId) return false;
        if (sessionId) return message.sessionId === sessionId;
        return true;
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  /**
   * Every event for an agent, including decisions recorded outside any run
   * (issuing a grant, probing a resource). Those anchor to synthetic run ids,
   * so a run-scoped query alone can never surface them.
   */
  getAgentEvents(agentId: string): RunEvent[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runEvents.filter((event) => event.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRunEvents(runId: string): RunEvent[] {
    return this.store
      .snapshot()
      .runEvents.filter((item) => item.runId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRuns(agentId: string, sessionId?: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => {
        if (run.agentId !== agentId) return false;
        if (sessionId) return run.sessionId === sessionId;
        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  listApprovals(agentId?: string, status?: ApprovalStatus): ApprovalRequest[] {
    return this.store
      .snapshot()
      .approvals.filter((item) => {
        if (agentId && item.agentId !== agentId) return false;
        if (status && item.status !== status) return false;
        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getApproval(id: string): ApprovalRequest {
    const approval = this.store.snapshot().approvals.find((item) => item.id === id);
    if (!approval) {
      throw new HttpError(404, "Approval request not found");
    }
    return approval;
  }

  async resolveApproval(
    id: string,
    decision: "approved" | "denied",
    operatorName = "Operator",
  ): Promise<ApprovalRequest> {
    const timestamp = now();
    const pending = this.pendingApprovals.get(id);
    const updated = await this.store.mutate((database) => {
      const approval = database.approvals.find((item) => item.id === id);
      if (!approval) {
        throw new HttpError(404, "Approval request not found");
      }
      if (approval.status !== "pending") {
        throw new HttpError(409, `Approval request is already ${approval.status}`);
      }
      const run = database.runs.find((item) => item.id === approval.runId);
      if (
        !pending ||
        pending.request.runId !== approval.runId ||
        pending.request.agentId !== approval.agentId ||
        !run ||
        run.agentId !== approval.agentId ||
        (run.status !== "queued" && run.status !== "running") ||
        (decision === "approved" && this.cancellationRequests.has(approval.agentId))
      ) {
        throw new HttpError(409, "Approval request is no longer attached to an active Run");
      }
      approval.status = decision;
      approval.resolvedAt = timestamp;
      approval.resolvedBy = operatorName;

      const agent = database.agents.find((item) => item.id === approval.agentId);
      const hasOtherPendingApproval = database.approvals.some(
        (item) =>
          item.id !== approval.id &&
          item.agentId === approval.agentId &&
          item.status === "pending",
      );
      if (agent && agent.status === "waiting_approval") {
        agent.status = hasOtherPendingApproval
          ? "waiting_approval"
          : run.status === "running"
            ? "busy"
            : "ready";
        agent.updatedAt = timestamp;
      }

      this.appendRunEvent(database, {
        runId: approval.runId,
        agentId: approval.agentId,
        type: decision === "approved" ? "step.approval_granted" : "step.approval_denied",
        severity: decision === "approved" ? "success" : "error",
        title: decision === "approved" ? "Operator approved action" : "Operator denied action",
        detail: `${decision === "approved" ? "Approved" : "Denied"} by ${operatorName}: ${this.redact(approval.actionDetail)}`,
        createdAt: timestamp,
      });

      return structuredClone(approval);
    });

    if (!pending) {
      throw new Error("Active approval registration disappeared during resolution");
    }
    clearTimeout(pending.timeout);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    this.pendingApprovals.delete(id);
    pending.resolve(decision === "approved");

    return updated;
  }

  async requestEgressApproval(
    runId: string,
    agentId: string,
    input: { host: string; port: number; method: string; signal?: AbortSignal | undefined },
  ): Promise<boolean> {
    const approvalId = randomUUID();
    const timestamp = now();
    const actionDetail = `${input.method} ${input.host}:${input.port}`;
    const approvalReq: ApprovalRequest = {
      id: approvalId,
      runId,
      agentId,
      actionType: "tool_call",
      actionDetail,
      ruleId: "HITL-EGRESS-025",
      reason: "Outbound request is held at the enforced proxy boundary pending operator approval.",
      riskLevel: "high",
      status: "pending",
      createdAt: timestamp,
      resolvedAt: null,
      resolvedBy: null,
    };

    let resolveDecision!: (approved: boolean) => void;
    const decision = new Promise<boolean>((resolve) => {
      resolveDecision = resolve;
    });
    const clearPending = () => {
      const pending = this.pendingApprovals.get(approvalId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener("abort", pending.onAbort);
      }
      this.pendingApprovals.delete(approvalId);
      pending.resolve(false);
    };
    const onAbort = () => {
      void this.resolveApproval(
        approvalId,
        "denied",
        "System (Requester disconnected)",
      ).catch(clearPending);
    };
    const timeout = setTimeout(() => {
      void this.resolveApproval(approvalId, "denied", "System (Approval timed out)")
        .catch(clearPending);
    }, 300_000);
    this.pendingApprovals.set(approvalId, {
      resolve: resolveDecision,
      timeout,
      request: approvalReq,
      ...(input.signal ? { signal: input.signal, onAbort } : {}),
    });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) {
      onAbort();
      return decision;
    }

    try {
      await this.store.mutate((database) => {
        const agent = database.agents.find((item) => item.id === agentId);
        const run = database.runs.find((item) => item.id === runId && item.agentId === agentId);
        if (
          !agent ||
          run?.status !== "running" ||
          this.cancellationRequests.has(agentId) ||
          input.signal?.aborted
        ) {
          throw new HttpError(409, "Egress approval requires an active Agent run");
        }
        database.approvals.push(approvalReq);
        agent.status = "waiting_approval";
        agent.updatedAt = timestamp;
        this.appendRunEvent(database, {
          runId,
          agentId,
          type: "step.approval_requested",
          severity: "warning",
          title: "Outbound request held before connection",
          detail: `Human approval required for ${actionDetail}; no upstream connection has been opened.`,
          createdAt: timestamp,
        });
      });
    } catch (error) {
      clearPending();
      if (input.signal?.aborted) return decision;
      throw error;
    }

    return decision;
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isModelConfigured(this.config)) {
      throw new HttpError(
        503,
        `The selected ${this.config.modelProvider} model provider is not configured`,
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const promptViolation = this.promptViolation(prompt);
    const run: AgentRun = {
      id: runId,
      agentId,
      sessionId: null,
      status: "queued",
      prompt: this.redact(prompt),
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      sessionId: null,
      runId,
      role: "user",
      content: this.redact(prompt),
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (this.lifecycleMutations.has(agentId)) {
        throw new HttpError(409, "An Agent lifecycle change is in progress");
      }
      if (hasActiveLifecycle(storedAgent.status)) {
        throw new HttpError(409, "This Agent already has an active run");
      }
      const activeSessionId = storedAgent.activeSessionId ?? null;
      run.sessionId = activeSessionId;
      message.sessionId = activeSessionId;
      if (promptViolation) {
        const blockedAt = timestamp;
        const blockedRun = {
          ...run,
          status: "failed" as const,
          error: promptViolation,
          completedAt: blockedAt,
        };
        database.runs.push(blockedRun);
        this.appendRunEvent(database, {
          runId,
          agentId,
          type: "run.blocked",
          severity: "warning",
          title: "Prompt blocked by canary guardrail",
          detail: this.redact(
            "The prompt matched the configured canary token and was stopped before execution. Preview: " +
              prompt.slice(0, PREVIEW_LENGTH),
          ),
          createdAt: blockedAt,
        });
        storedAgent.status = "ready";
        storedAgent.lastError = promptViolation;
        storedAgent.updatedAt = blockedAt;
        return structuredClone(storedAgent);
      }
      database.runs.push(run);
      database.messages.push(message);
      this.appendRunEvent(database, {
        runId,
        agentId,
        type: "run.created",
        severity: "info",
        title: "Run queued",
        detail: this.redact("Queued prompt preview: " + prompt.slice(0, PREVIEW_LENGTH)),
        createdAt: timestamp,
      });
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    if (promptViolation) {
      throw new RunPolicyViolationError("canary", 400, promptViolation);
    }
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      modelConfigured: isModelConfigured(this.config),
      modelProvider: this.config.modelProvider,
      modelBaseUrl: this.config.modelBaseUrl,
      modelName: this.config.modelName || null,
      openRouterConfigured: isModelConfigured(this.config),
      openRouterBaseUrl: this.config.modelBaseUrl,
      openRouterModel: this.config.modelName || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
      ...summarizeRunPolicies(this.config),
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.workspaces.ensureCanaryToken(agentAtStart, this.config.guardrailCanaryToken);
    } catch {
      // workspace directory might be initialized by runner
    }
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
      this.appendRunEvent(database, {
        runId: run.id,
        agentId: run.agentId,
        type: "run.started",
        severity: "info",
        title: "Run started",
        detail: "Codex execution began inside the Agent workspace.",
        createdAt: now(),
      });
    });

    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }

      let stepViolation: RunPolicyViolationError | null = null;
      const onStep = async (step: RunnerStepEvent) => {
        if (this.cancellationRequests.has(agentAtStart.id)) {
          throw new RunCancelledError();
        }
        // 1. Canary exfiltration tripwire check
        if (
          this.config.guardrailCanaryToken &&
          (step.detail.includes(this.config.guardrailCanaryToken) ||
            JSON.stringify(step.rawPayload ?? "").includes(this.config.guardrailCanaryToken))
        ) {
          stepViolation = new RunPolicyViolationError(
            "canary",
            409,
            "Tool call or shell execution attempted to exfiltrate the canary token outside the workspace boundary.",
          );
          void this.runner.cancel(agentAtStart.id);
          return;
        }

        // 2. Action Risk Assessment (Human-in-the-Loop Gate)
        const risk = evaluateActionRisk(step);
        if (risk.requiresApproval && step.phase !== "before") {
          const explicitlyAfterExecution = step.phase === "after";
          await this.store.mutate((database) => {
            this.appendRunEvent(database, {
              runId: run.id,
              agentId: agentAtStart.id,
              type: "step.risk_observed",
              severity: "warning",
              title: explicitlyAfterExecution
                ? `Risk observed after execution (${risk.ruleId})`
                : `Risk observed without a pre-execution guarantee (${risk.ruleId})`,
              detail: explicitlyAfterExecution
                ? `Telemetry only; this Runtime event arrived after execution. ${risk.reason}`
                : `Telemetry only; this Runtime event did not assert a trusted before phase. ${risk.reason}`,
              createdAt: now(),
            });
          });
        } else if (risk.requiresApproval) {
          const approvalId = randomUUID();
          const timestamp = now();
          const approvalReq: ApprovalRequest = {
            id: approvalId,
            runId: run.id,
            agentId: agentAtStart.id,
            actionType: step.type === "message" ? "tool_call" : step.type,
            actionDetail: step.detail,
            ruleId: risk.ruleId,
            reason: risk.reason,
            riskLevel: risk.riskLevel,
            status: "pending",
            createdAt: timestamp,
            resolvedAt: null,
            resolvedBy: null,
          };

          const pause = (this.runner as Partial<AgentRunner>).pause;
          if (typeof pause !== "function") {
            stepViolation = new RunPolicyViolationError(
              "runtime_control",
              409,
              `Runtime does not support pausing; high-risk action was cancelled before approval (${risk.ruleId}).`,
            );
            await this.runner.cancel(agentAtStart.id).catch(() => false);
            throw stepViolation;
          }

          let paused = false;
          try {
            paused = await pause.call(this.runner, agentAtStart.id);
          } catch {
            paused = false;
          }
          if (!paused) {
            stepViolation = new RunPolicyViolationError(
              "runtime_control",
              409,
              `Runtime pause failed; high-risk action was cancelled before approval (${risk.ruleId}).`,
            );
            await this.runner.cancel(agentAtStart.id).catch(() => false);
            throw stepViolation;
          }

          let resolveDecision!: (approved: boolean) => void;
          const approvalDecision = new Promise<boolean>((resolve) => {
            resolveDecision = resolve;
          });
          const timeout = setTimeout(() => {
            void this.resolveApproval(approvalId, "denied", "System (Approval timed out)")
              .catch(() => undefined);
          }, 300_000);
          this.pendingApprovals.set(approvalId, {
            resolve: resolveDecision,
            timeout,
            request: approvalReq,
          });

          try {
            await this.store.mutate((database) => {
              if (this.cancellationRequests.has(agentAtStart.id)) {
                throw new RunCancelledError();
              }
              database.approvals.push(approvalReq);
              const agent = database.agents.find((item) => item.id === agentAtStart.id);
              if (agent) {
                agent.status = "waiting_approval";
                agent.updatedAt = timestamp;
              }
              this.appendRunEvent(database, {
                runId: run.id,
                agentId: agentAtStart.id,
                type: "step.approval_requested",
                severity: "warning",
                title: `High-Risk Action Intercepted (${risk.ruleId})`,
                detail: `Human approval required: ${this.redact(step.detail)}. Policy: ${risk.reason}`,
                createdAt: timestamp,
              });
            });
          } catch (error) {
            const pending = this.pendingApprovals.get(approvalId);
            if (pending) {
              clearTimeout(pending.timeout);
              this.pendingApprovals.delete(approvalId);
              pending.resolve(false);
            }
            await this.runner.cancel(agentAtStart.id).catch(() => false);
            if (error instanceof RunCancelledError) throw error;
            stepViolation = new RunPolicyViolationError(
              "runtime_control",
              409,
              `Approval gate persistence failed after pausing; execution was cancelled (${risk.ruleId}).`,
            );
            throw stepViolation;
          }

          const approved = await approvalDecision;

          if (!approved) {
            if (this.cancellationRequests.has(agentAtStart.id)) {
              throw new RunCancelledError();
            }
            stepViolation = new RunPolicyViolationError(
              "approval",
              403,
              `Action blocked by operator denial (${risk.ruleId}): ${step.detail}`,
            );
            await this.runner.cancel(agentAtStart.id).catch(() => false);
            throw stepViolation;
          }

          const resume = (this.runner as Partial<AgentRunner>).resume;
          let resumed = false;
          let resumeFailure = "Runtime resume failed after approval";
          if (typeof resume === "function") {
            try {
              resumed = await resume.call(this.runner, agentAtStart.id);
            } catch {
              resumed = false;
            }
          } else {
            resumeFailure = "Runtime does not support resuming after approval";
          }
          if (!resumed) {
            stepViolation = new RunPolicyViolationError(
              "runtime_control",
              409,
              `${resumeFailure}; execution was cancelled (${risk.ruleId}).`,
            );
            await this.runner.cancel(agentAtStart.id).catch(() => false);
            throw stepViolation;
          }
        } else if (step.type === "command" || step.type === "tool_call") {
          await this.store.mutate((database) => {
            this.appendRunEvent(database, {
              runId: run.id,
              agentId: agentAtStart.id,
              type: "step.auto_approved",
              severity: "info",
              title: `Action Auto-Approved (${risk.ruleId})`,
              detail: `Safe execution policy auto-approved: ${this.redact(step.detail)}`,
              createdAt: now(),
            });
          });
        }

        const typeMap: Record<RunnerStepEvent["type"], RunEventType> = {
          command: "step.command",
          tool_call: "step.tool_call",
          file_change: "step.file_change",
          message: "step.message",
        };

        await this.store.mutate((database) => {
          this.appendRunEvent(database, {
            runId: run.id,
            agentId: agentAtStart.id,
            type: typeMap[step.type] ?? "step.command",
            severity: "info",
            title: step.title,
            detail: this.redact(step.detail),
            createdAt: now(),
          });
        });
      };

      const session = this.store.snapshot().sessions.find((s) => s.id === run.sessionId);
      const threadId = session ? session.codexThreadId : agentAtStart.codexThreadId;
      const memory = this.buildSessionMemory(run);
      const prompt = memory ? `${memory}\n\n## Current request\n${run.prompt}` : run.prompt;

      if (memory) {
        await this.store.mutate((database) => {
          this.appendRunEvent(database, {
            runId: run.id,
            agentId: agentAtStart.id,
            type: "run.memory_injected",
            severity: "info",
            title: "Session memory injected",
            detail: "Added the previous " + MEMORY_MESSAGE_LIMIT + " messages from this chat as context.",
            createdAt: now(),
          });
        });
      }

      // Under enforcement the agent gets no route off-box; its only path out
      // is the proxy, which authorizes every connection against live grants.
      let egressProxyUrl: string | undefined;
      if (this.egress && this.config.runtimeProvider === "container") {
        await this.egress.ensure();
        egressProxyUrl = this.egress.proxyUrlFor(agentAtStart.principalId);
      }

      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        sessionId: run.sessionId,
        workspacePath: agentAtStart.workspacePath,
        prompt,
        threadId,
        onStep,
        egressProxyUrl,
      });

      if (stepViolation) {
        throw stepViolation;
      }

      rejectOutputIfCanaryPresent(this.config, result.output);
      const costUsd = estimateRunCostUsd(result.usage, this.config.modelName);
      const enrichedUsage = result.usage ? { ...result.usage, costUsd } : null;
      rejectRunIfBudgetExceeded(this.config, enrichedUsage, Date.now() - startedAt);
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        const storedSession = database.sessions.find((item) => item.id === run.sessionId);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = this.redact(result.output);
        storedRun.usage = enrichedUsage;
        storedRun.completedAt = completedAt;

        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          sessionId: run.sessionId,
          runId: run.id,
          role: "assistant",
          content: this.redact(result.output),
          createdAt: completedAt,
        });
        this.appendRunEvent(database, {
          runId: run.id,
          agentId: agent.id,
          type: "run.completed",
          severity: "success",
          title: "Run completed",
          detail: this.redact(
            "Output preview: " + result.output.slice(0, PREVIEW_LENGTH),
          ),
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        if (storedSession) {
          storedSession.codexThreadId = result.threadId;
          storedSession.updatedAt = completedAt;
        }
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });

    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const policyViolation = error instanceof RunPolicyViolationError;
      const isApprovalDenial = policyViolation && error.kind === "approval";
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = this.redact(message);
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled || isApprovalDenial ? "ready" : policyViolation ? "stopped" : "error";
          }
          agent.lastError = cancelled ? null : this.redact(message);
          agent.updatedAt = completedAt;
        }
        this.appendRunEvent(database, {
          runId: run.id,
          agentId: run.agentId,
          type: cancelled ? "run.cancelled" : policyViolation ? "run.blocked" : "run.failed",
          severity: cancelled ? "warning" : policyViolation ? "warning" : "error",
          title: cancelled
            ? "Run cancelled"
            : isApprovalDenial
              ? "Run blocked by human operator denial"
              : policyViolation
                ? "Run blocked by guardrail"
                : "Run failed",
          detail: this.redact(message),
          createdAt: completedAt,
        });
      });
    }
  }

  private promptViolation(prompt: string): string | null {
    if (!this.config.guardrailCanaryToken) return null;
    if (!prompt.includes(this.config.guardrailCanaryToken)) return null;
    return "Prompt contains the configured canary token and was blocked before execution.";
  }

  private buildSessionMemory(run: AgentRun): string | null {
    if (!run.sessionId) return null;
    const messages = this.store
      .snapshot()
      .messages.filter((message) => message.sessionId === run.sessionId && message.runId !== run.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(-MEMORY_MESSAGE_LIMIT);
    if (messages.length === 0) return null;

    const history = messages
      .map((message) => {
        const speaker = message.role === "user" ? "User" : "Assistant";
        const text = message.content.replace(/\s+/g, " ").trim().slice(0, MEMORY_MESSAGE_CHAR_LIMIT);
        return `${speaker}: ${text}`;
      })
      .join("\n");
    return "## Session memory\nUse this prior conversation only as context; follow the current request below.\n" + history;
  }

  private redact(value: string): string {
    if (!value) return value;
    let output = value;
    for (const secret of [
      this.config.guardrailCanaryToken,
      this.config.modelApiKey,
      this.config.modelRuntimeApiKey,
    ]) {
      if (secret) {
        output = output.split(secret).join("[redacted]");
      }
    }
    return output;
  }

  private appendRunEvent(database: {
    runEvents: RunEvent[];
  }, event: Omit<RunEvent, "id">): void {
    database.runEvents.push({
      id: randomUUID(),
      ...event,
    });
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (
        status === "ready" &&
        (hasActiveLifecycle(agent.status) || this.lifecycleMutations.has(id))
      ) {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async denyPendingApprovals(agentId: string, resolvedBy: string): Promise<void> {
    const timestamp = now();
    await this.store.mutate((database) => {
      for (const approval of database.approvals) {
        if (approval.agentId !== agentId || approval.status !== "pending") continue;
        approval.status = "denied";
        approval.resolvedAt = timestamp;
        approval.resolvedBy = resolvedBy;
        this.appendRunEvent(database, {
          runId: approval.runId,
          agentId: approval.agentId,
          type: "step.approval_denied",
          severity: "error",
          title: "Pending action cancelled",
          detail: `Denied by ${resolvedBy}: ${this.redact(approval.actionDetail)}`,
          createdAt: timestamp,
        });
      }
    });
    for (const [approvalId, pending] of this.pendingApprovals.entries()) {
      if (pending.request.agentId !== agentId) continue;
      clearTimeout(pending.timeout);
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener("abort", pending.onAbort);
      }
      this.pendingApprovals.delete(approvalId);
      pending.resolve(false);
    }
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      const cancellation = this.runner.cancel(agentId).then(
        () => null,
        (error: unknown) => error,
      );
      await this.denyPendingApprovals(agentId, "System (Execution cancelled)");
      const cancellationError = await cancellation;
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
      if (cancellationError) {
        throw cancellationError;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}

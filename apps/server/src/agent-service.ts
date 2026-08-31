import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isOpenRouterConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  AgentSession,
  ApprovalActor,
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
const SYSTEM_RESTART_ACTOR: ApprovalActor = {
  principalId: "system:server-restart",
  displayName: "System (Server restarted)",
};
const SYSTEM_TIMEOUT_ACTOR: ApprovalActor = {
  principalId: "system:approval-timeout",
  displayName: "System (Approval timed out)",
};
const SYSTEM_CANCEL_ACTOR: ApprovalActor = {
  principalId: "system:run-cancelled",
  displayName: "System (Run cancelled)",
};
const SYSTEM_PAUSE_FAILURE_ACTOR: ApprovalActor = {
  principalId: "system:pause-failed",
  displayName: "System (Runner failed to pause)",
};

function actionResource(detail: string, ruleId: string): string {
  const url = detail.match(/https?:\/\/[^\s"'`]+/i)?.[0];
  if (url) return url.replace(/[),.;]+$/, "");
  const absolutePath = detail.match(/(?:^|\s)(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+)/)?.[1];
  if (absolutePath) return absolutePath;
  if (ruleId === "SEC-CREDENTIALS-002") {
    return detail.match(/(?:^|[\s/])((?:\.env(?:\.[\w-]+)?)|credentials\.env|id_rsa|id_ed25519|\.aws\/credentials)/i)?.[1]
      ?? "unknown credential resource";
  }
  if (ruleId === "SEC-EGRESS-003") {
    return detail.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"'`]*)?/i)?.[0]
      ?? "unknown network destination";
  }
  if (ruleId === "SEC-SUPPLY-004") {
    const target = detail.match(/\b(?:npm|pnpm|yarn|twine|cargo|pip)\s+(?:publish|upload)\s+([^\s"'`]+)/i)?.[1];
    return target && !target.startsWith("-") ? target : "unknown package registry resource";
  }
  if (ruleId === "SEC-PRIVILEGE-005") return "host privilege boundary";
  return "unknown resource";
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly runnerLifecycleQueues = new Map<string, Promise<void>>();
  private readonly pendingApprovals = new Map<
    string,
    {
      resolve: (approved: boolean) => void;
      timeout: NodeJS.Timeout;
      request: ApprovalRequest;
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
      const cancelledRunIds = new Set<string>();
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          cancelledRunIds.add(run.id);
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
        if (approval.status === "approved" && cancelledRunIds.has(approval.runId)) {
          approval.evidence.result = "execution_cancelled";
        } else if (approval.status === "pending") {
          const resolvedAt = now();
          approval.status = "denied";
          approval.resolvedAt = resolvedAt;
          approval.resolvedByPrincipalId = SYSTEM_RESTART_ACTOR.principalId;
          approval.resolvedByDisplayName = SYSTEM_RESTART_ACTOR.displayName;
          approval.evidence.decision = "denied";
          approval.evidence.result = "execution_cancelled";
          approval.evidence.resolvedBy = SYSTEM_RESTART_ACTOR;
          this.appendRunEvent(database, {
            runId: approval.runId,
            agentId: approval.agentId,
            type: "step.approval_denied",
            severity: "error",
            title: "System denied action after server restart",
            detail: this.redact(JSON.stringify(approval.evidence)),
            createdAt: resolvedAt,
          });
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
    await this.cancelExecution(agentId);
    await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === agentId);
      if (!agent) return;
      agent.status = "stopped";
      agent.lastError = reason;
      agent.updatedAt = now();
    });
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
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
    if (currentAgent.status === "busy") {
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
    if (currentAgent.status === "busy") {
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
    this.onAgentStarted?.(id);
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
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
    actor: ApprovalActor,
  ): Promise<ApprovalRequest> {
    const timestamp = now();
    const updated = await this.store.mutate((database) => {
      const approval = database.approvals.find((item) => item.id === id);
      if (!approval) {
        throw new HttpError(404, "Approval request not found");
      }
      if (approval.status !== "pending") {
        throw new HttpError(409, `Approval request is already ${approval.status}`);
      }
      approval.status = decision;
      approval.resolvedAt = timestamp;
      approval.resolvedByPrincipalId = actor.principalId;
      approval.resolvedByDisplayName = actor.displayName;
      approval.evidence.decision = decision;
      approval.evidence.result = decision === "approved"
        ? "execution_authorized"
        : actor.principalId === SYSTEM_CANCEL_ACTOR.principalId
          ? "execution_cancelled"
          : actor.principalId === SYSTEM_PAUSE_FAILURE_ACTOR.principalId
            ? "execution_failed"
            : "execution_blocked";
      approval.evidence.resolvedBy = actor;

      const agent = database.agents.find((item) => item.id === approval.agentId);
      if (agent && agent.status === "waiting_approval") {
        agent.status = decision === "approved" ? "busy" : "ready";
        agent.updatedAt = timestamp;
      }

      this.appendRunEvent(database, {
        runId: approval.runId,
        agentId: approval.agentId,
        type: decision === "approved" ? "step.approval_granted" : "step.approval_denied",
        severity: decision === "approved" ? "success" : "error",
        title: decision === "approved" ? "Operator approved action" : "Operator denied action",
        detail: this.redact(JSON.stringify(approval.evidence)),
        createdAt: timestamp,
      });

      return structuredClone(approval);
    });

    const pending = this.pendingApprovals.get(id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingApprovals.delete(id);
      pending.resolve(decision === "approved");
    }

    return updated;
  }



  async sendMessage(
    agentId: string,
    prompt: string,
    initiatingHuman?: ApprovalActor,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isOpenRouterConfigured(this.config)) {
      throw new HttpError(
        503,
        "OpenRouter is not configured. Set OPENROUTER_API_KEY and OPENROUTER_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const promptViolation = this.promptViolation(prompt);
    const run: AgentRun = {
      id: runId,
      agentId,
      sessionId: null,
      initiatedByPrincipalId: initiatingHuman?.principalId ?? "",
      initiatedByDisplayName: initiatingHuman?.displayName ?? "",
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
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      const activeSessionId = storedAgent.activeSessionId ?? null;
      if (!initiatingHuman) {
        const owner = database.principals.find((principal) => principal.id === storedAgent.ownerId);
        run.initiatedByPrincipalId = storedAgent.ownerId;
        run.initiatedByDisplayName = owner?.name ?? storedAgent.ownerId;
      }
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
      openRouterConfigured: isOpenRouterConfigured(this.config),
      openRouterBaseUrl: this.config.openRouterBaseUrl,
      openRouterModel: this.config.openRouterModel || null,
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
        if (risk.requiresApproval) {
          const approvalId = randomUUID();
          const timestamp = now();
          const actionType = step.type === "message" ? "tool_call" : step.type;
          const approvalReq: ApprovalRequest = {
            id: approvalId,
            runId: run.id,
            agentId: agentAtStart.id,
            actionType,
            actionDetail: step.detail,
            ruleId: risk.ruleId,
            reason: risk.reason,
            riskLevel: risk.riskLevel,
            status: "pending",
            createdAt: timestamp,
            resolvedAt: null,
            resolvedByPrincipalId: null,
            resolvedByDisplayName: null,
            evidence: {
              initiatingHuman: {
                principalId: run.initiatedByPrincipalId,
                displayName: run.initiatedByDisplayName,
              },
              executingAgent: {
                principalId: agentAtStart.principalId,
                displayName: agentAtStart.name,
              },
              action: { type: actionType, detail: step.detail },
              resource: actionResource(step.detail, risk.ruleId),
              decision: null,
              result: "pending",
              resolvedBy: null,
            },
          };

          let resolveDecision!: (approved: boolean) => void;
          const decisionPromise = new Promise<boolean>((resolve) => {
            resolveDecision = resolve;
          });
          const timeout = setTimeout(() => {
            void this.resolveApproval(approvalId, "denied", SYSTEM_TIMEOUT_ACTOR)
              .catch(() => undefined);
          }, 300_000);
          this.pendingApprovals.set(approvalId, {
            resolve: resolveDecision,
            timeout,
            request: approvalReq,
          });

          try {
            await this.store.mutate((database) => {
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
            const paused = await this.withRunnerLifecycle(agentAtStart.id, () => {
              if (this.cancellationRequests.has(agentAtStart.id)) return Promise.resolve(false);
              return this.runner.pause?.(agentAtStart.id) ?? Promise.resolve(undefined);
            });
            if (paused === false) {
              await this.resolveApproval(approvalId, "denied", SYSTEM_PAUSE_FAILURE_ACTOR);
              throw new Error("Runner failed to pause for required approval");
            }
          } catch (error) {
            const stored = this.store.snapshot().approvals.find((item) => item.id === approvalId);
            if (stored?.status === "pending") {
              await this.resolveApproval(approvalId, "denied", SYSTEM_PAUSE_FAILURE_ACTOR)
                .catch(() => undefined);
            }
            clearTimeout(timeout);
            this.pendingApprovals.delete(approvalId);
            void this.withRunnerLifecycle(agentAtStart.id, () =>
              this.runner.cancel(agentAtStart.id)
            );
            throw error;
          }

          const approved = await decisionPromise;

          if (this.cancellationRequests.has(agentAtStart.id)) {
            throw new RunCancelledError();
          }
          if (!approved) {
            stepViolation = new RunPolicyViolationError(
              "approval",
              403,
              `Action blocked by operator denial (${risk.ruleId}): ${step.detail}`,
            );
            void this.runner.cancel(agentAtStart.id);
            throw stepViolation;
          }

          const resumed = await this.withRunnerLifecycle(agentAtStart.id, () => {
            if (this.cancellationRequests.has(agentAtStart.id)) return Promise.resolve(false);
            return this.runner.resume?.(agentAtStart.id) ?? Promise.resolve(undefined);
          });
          if (this.cancellationRequests.has(agentAtStart.id)) {
            throw new RunCancelledError();
          }
          if (resumed === false) {
            throw new Error("Runner failed to resume after approval");
          }
          await this.store.mutate((database) => {
            const approval = database.approvals.find((item) => item.id === approvalId);
            if (approval?.status === "approved") {
              approval.evidence.result = "execution_resumed";
            }
          });
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
      const costUsd = estimateRunCostUsd(result.usage, this.config.openRouterModel);
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
        for (const approval of database.approvals) {
          if (approval.runId === run.id && approval.status === "approved") {
            approval.evidence.result = cancelled ? "execution_cancelled" : "execution_failed";
          }
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
      this.config.geminiApiKey,
      this.config.geminiAdapterToken,
      this.config.openRouterApiKey,
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
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async withRunnerLifecycle<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runnerLifecycleQueues.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.runnerLifecycleQueues.set(agentId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.runnerLifecycleQueues.get(agentId) === queued) {
        this.runnerLifecycleQueues.delete(agentId);
      }
    }
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    for (const [approvalId, pending] of [...this.pendingApprovals.entries()]) {
      if (pending.request.agentId !== agentId) continue;
      try {
        await this.resolveApproval(approvalId, "denied", SYSTEM_CANCEL_ACTOR);
      } catch (error) {
        if (!(error instanceof HttpError) || error.statusCode !== 409) throw error;
      }
    }
    try {
      await this.withRunnerLifecycle(agentId, () => this.runner.cancel(agentId));
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}

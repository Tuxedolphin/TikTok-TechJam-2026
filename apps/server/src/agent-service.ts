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
  ApprovalRequest,
  ApprovalStatus,
  CreateAgentInput,
  Message,
  RunEvent,
  RunEventSeverity,
  RunEventType,
  RunnerStepEvent,
  UpdateAgentInput,
} from "./types.js";

import { WorkspaceManager } from "./workspace.js";
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

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
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

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const initialSessionId = randomUUID();
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
      ownerId: "user-a",
      principalId: `agent-${id}`,
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
    });
    return agent;
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
      approval.resolvedBy = operatorName;

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
        detail: `${decision === "approved" ? "Approved" : "Denied"} by ${operatorName}: ${this.redact(approval.actionDetail)}`,
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
      content: prompt,
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

          await this.runner.pause?.(agentAtStart.id);

          const approved = await new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => {
              void this.resolveApproval(approvalId, "denied", "System (Approval timed out)");
            }, 300_000);
            this.pendingApprovals.set(approvalId, { resolve, timeout, request: approvalReq });
          });

          if (!approved) {
            stepViolation = new RunPolicyViolationError(
              "approval",
              403,
              `Action blocked by operator denial (${risk.ruleId}): ${step.detail}`,
            );
            void this.runner.cancel(agentAtStart.id);
            throw stepViolation;
          }

          await this.runner.resume?.(agentAtStart.id);
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

      const result = await this.runner.run({
        agentId: agentAtStart.id,
        sessionId: run.sessionId,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId,
        onStep,
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
        storedRun.output = result.output;
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

  private redact(value: string): string {
    if (!value) return value;
    let output = value;
    for (const secret of [this.config.guardrailCanaryToken, this.config.openRouterApiKey]) {
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

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    for (const [approvalId, pending] of this.pendingApprovals.entries()) {
      if (pending.request.agentId === agentId) {
        clearTimeout(pending.timeout);
        this.pendingApprovals.delete(approvalId);
        pending.resolve(false);
      }
    }
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}

import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isOpenRouterConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
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
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
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
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent, this.config.guardrailCanaryToken);
    await this.store.mutate((database) => database.agents.push(agent));
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
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
      database.runEvents = database.runEvents.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
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

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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
      const onStep = (step: RunnerStepEvent) => {
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

        const typeMap: Record<RunnerStepEvent["type"], RunEventType> = {
          command: "step.command",
          tool_call: "step.tool_call",
          file_change: "step.file_change",
          message: "step.message",
        };

        void this.store.mutate((database) => {
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

      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
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
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = enrichedUsage;
        storedRun.completedAt = completedAt;

        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
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
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const policyViolation = error instanceof RunPolicyViolationError;
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
            agent.status = cancelled ? "ready" : policyViolation ? "stopped" : "error";
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

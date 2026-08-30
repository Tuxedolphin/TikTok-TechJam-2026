export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

export interface AgentSession {
  id: string;
  agentId: string;
  title: string;
  codexThreadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  activeSessionId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  sessionId?: string | null | undefined;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
}

export type RunEventSeverity = "info" | "success" | "warning" | "error";
export type RunEventType =
  | "run.created"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.blocked"
  | "run.cancelled"
  | "step.command"
  | "step.tool_call"
  | "step.file_change"
  | "step.message";

export interface RunEvent {
  id: string;
  runId: string;
  agentId: string;
  type: RunEventType;
  severity: RunEventSeverity;
  title: string;
  detail: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  sessionId?: string | null | undefined;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 3;
  agents: Agent[];
  sessions: AgentSession[];
  messages: Message[];
  runs: AgentRun[];
  runEvents: RunEvent[];
}


export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerStepEvent {
  type: "command" | "tool_call" | "file_change" | "message";
  title: string;
  detail: string;
  rawPayload?: unknown;
}

export interface RunnerRequest {
  agentId: string;
  sessionId?: string | null | undefined;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  onStep?: ((step: RunnerStepEvent) => void) | undefined;
}



export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}


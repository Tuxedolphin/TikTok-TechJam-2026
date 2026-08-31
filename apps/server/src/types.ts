export type AgentStatus = "ready" | "busy" | "waiting_approval" | "stopped" | "error";
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
  ownerId: string;
  principalId: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  activeSessionId: string | null;
  lastError: string | null;
  authorityBlocked?: boolean;
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
  | "step.message"
  | "step.auto_approved"
  | "step.approval_requested"
  | "step.approval_granted"
  | "step.approval_denied"
  | "policy.decision"
  | "grant.created"
  | "grant.revoked"
  | "grant.expired"
  | "egress.blocked"
  | "memory.recalled"
  | "memory.quarantined"
  | "agent.terminated";

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

export type ApprovalStatus = "pending" | "approved" | "denied";
export type ActionRiskLevel = "low" | "medium" | "high" | "critical";

export interface ApprovalRequest {
  id: string;
  runId: string;
  agentId: string;
  actionType: "command" | "tool_call" | "file_change";
  actionDetail: string;
  ruleId: string;
  reason: string;
  riskLevel: ActionRiskLevel;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
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

export type PrincipalKind = "human" | "agent";

export interface Principal {
  id: string;              // "user-a", "user-b", "agent-<agentId>"
  kind: PrincipalKind;
  name: string;
  createdAt: string;
}

export type GrantScope = "resource:read" | "resource:write" | "network:egress";

export interface Grant {
  id: string;
  principalId: string;     // agent principal receiving the grant
  grantedBy: string;       // human principal id
  scope: GrantScope;
  target: string;          // resourceId for resource:*, hostname for network:egress
  expiresAt: string | null; // ISO; null = no expiry
  revokedAt: string | null;
  createdAt: string;
}

/** Where a memory came from. Only an operator write is trusted. */
export type MemorySourceType = "operator" | "agent-output" | "tool-result" | "web-content";
export type MemoryTrust = "trusted" | "untrusted";

/**
 * A belief the agent carries between sessions.
 *
 * Memory is the one store that survives a run, which makes it the one store
 * worth poisoning: content written in one session steers behaviour in the
 * next. So a memory is never just text -- it carries where it came from, how
 * long it lives, and whether an operator has pulled it out of circulation.
 * A memory confers no permissions; grants remain the only source of authority.
 */
export interface MemoryEntry {
  id: string;
  agentId: string;
  content: string;
  provenance: {
    runId: string | null;
    sourceType: MemorySourceType;
    /** Human-readable origin: a URL, a tool name, or "operator". */
    sourceDetail: string;
  };
  /** Derived at write time: only "operator" provenance is trusted. */
  trust: MemoryTrust;
  createdAt: string;
  expiresAt: string | null;
  quarantinedAt: string | null;
  quarantinedBy: string | null;
}

export interface MockResource {
  id: string;
  ownerId: string;         // human principal id
  name: string;
  content: string;
}

export interface PolicyDecision {
  allowed: boolean;
  ruleId: string;          // e.g. "AUTHZ-OWNER-010", "AUTHZ-GRANT-011", "NET-EGRESS-020"
  reason: string;
  principalId: string | null;
  grantId: string | null;
}




export interface Database {
  version: 5;
  agents: Agent[];
  sessions: AgentSession[];
  messages: Message[];
  runs: AgentRun[];
  runEvents: RunEvent[];
  approvals: ApprovalRequest[];
  principals: Principal[];
  grants: Grant[];
  resources: MockResource[];
  memories: MemoryEntry[];
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
  onStep?: ((step: RunnerStepEvent) => Promise<void> | void) | undefined;
  /**
   * Set when egress enforcement is on. Its presence puts the container on the
   * internal network with no route off-box, reachable outward only through
   * this proxy. Absent, the container keeps the default bridge networking.
   */
  egressProxyUrl?: string | undefined;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  pause?(agentId: string): Promise<"paused" | "idle" | "failed">;
  resume?(agentId: string): Promise<boolean>;
  isRunning?(agentId: string): boolean;
  isAvailable(): Promise<boolean>;
}

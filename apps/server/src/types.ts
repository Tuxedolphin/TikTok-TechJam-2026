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
  | "run.memory_injected"
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
  | "eval.captured"
  | "eval.replayed"
  | "budget.anomaly"
  | "budget.degraded"
  | "fleet.turn"
  | "fleet.timeout";

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

export interface EvalCase {                 // WS-D
  id: string;
  sourceRunId: string;
  agentId: string;
  prompt: string;
  failureReason: string;
  expectation: "completes" | "blocked" | "denied";
  createdAt: string;
  lastReplayRunId: string | null;
  lastReplayStatus: "pending" | "passed" | "failed" | null;
}

export interface FleetTopic {               // WS-E
  id: string;
  name: string;
  participantAgentIds: string[];
  state: Record<string, unknown>;           // e.g. { current: 10, target: 1 }
  turnAgentId: string | null;
  status: "active" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface FleetTurn {
  id: string;
  topicId: string;
  agentId: string;
  runId: string | null;
  value: string;                            // payload published this turn
  createdAt: string;
}

export interface Database {
  version: 4;
  agents: Agent[];
  sessions: AgentSession[];
  messages: Message[];
  runs: AgentRun[];
  runEvents: RunEvent[];
  approvals: ApprovalRequest[];
  principals: Principal[];
  grants: Grant[];
  resources: MockResource[];
  evalCases: EvalCase[];
  fleetTopics: FleetTopic[];
  fleetTurns: FleetTurn[];
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
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  pause?(agentId: string): Promise<boolean>;
  resume?(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}


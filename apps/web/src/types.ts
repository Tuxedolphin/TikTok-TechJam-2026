export type AgentStatus = "ready" | "busy" | "waiting_approval" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

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
  sessionId?: string | null;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  sessionId?: string | null;

  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    costUsd?: number | null;
  } | null;
  createdAt: string;
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

export interface SystemInfo {
  openRouterConfigured: boolean;
  openRouterBaseUrl: string;
  openRouterModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
  egressEnforcement: boolean;
  egressQuarantineThreshold: number;
  guardrailCanaryEnabled: boolean;
  runBudgetMaxInputTokens: number | null;
  runBudgetMaxOutputTokens: number | null;
  runBudgetMaxTotalTokens: number | null;
  runBudgetMaxDurationMs: number | null;
}

export type PrincipalKind = "human" | "agent";

export interface Principal {
  id: string;
  kind: PrincipalKind;
  name: string;
  createdAt: string;
}

export type GrantScope = "resource:read" | "resource:write" | "network:egress";

export interface Grant {
  id: string;
  principalId: string;
  grantedBy: string;
  scope: GrantScope;
  target: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface MockResource {
  id: string;
  ownerId: string;
  name: string;
  content: string;
}

export interface PolicyDecision {
  allowed: boolean;
  ruleId: string;
  reason: string;
  principalId: string | null;
  grantId: string | null;
}

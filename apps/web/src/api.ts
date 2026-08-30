import type {
  Agent,
  AgentRun,
  AgentSession,
  ApprovalRequest,
  Message,
  RunEvent,
  SystemInfo,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  sessions: (id: string) =>
    request<{ sessions: AgentSession[] }>("/api/agents/" + id + "/sessions"),
  createSession: (id: string, title?: string) =>
    request<{ session: AgentSession; agent: Agent }>("/api/agents/" + id + "/sessions", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  selectSession: (id: string, sessionId: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/sessions/" + sessionId + "/select", {
      method: "POST",
    }),
  messages: (id: string, sessionId?: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages" + (sessionId ? "?sessionId=" + sessionId : "")),
  runs: (id: string, sessionId?: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs" + (sessionId ? "?sessionId=" + sessionId : "")),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  runEvents: (id: string) => request<{ events: RunEvent[] }>("/api/runs/" + id + "/events"),
  listApprovals: (agentId?: string, status?: string) => {
    const params = new URLSearchParams();
    if (agentId) params.set("agentId", agentId);
    if (status) params.set("status", status);
    const qs = params.toString();
    return request<{ approvals: ApprovalRequest[] }>("/api/approvals" + (qs ? "?" + qs : ""));
  },
  getApproval: (id: string) => request<{ approval: ApprovalRequest }>("/api/approvals/" + id),
  approve: (id: string, operatorName = "Human Operator") =>
    request<{ approval: ApprovalRequest }>("/api/approvals/" + id + "/approve", {
      method: "POST",
      body: JSON.stringify({ operatorName }),
    }),
  deny: (id: string, operatorName = "Human Operator") =>
    request<{ approval: ApprovalRequest }>("/api/approvals/" + id + "/deny", {
      method: "POST",
      body: JSON.stringify({ operatorName }),
    }),
};


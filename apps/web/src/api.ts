import type {
  Agent,
  AgentRun,
  AgentSession,
  ApprovalRequest,
  Grant,
  GrantScope,
  Message,
  MockResource,
  PolicyDecision,
  Principal,
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

// The "human" principal driving the identity/delegation demo. Every request
// is sent as this principal via the x-principal-id header so grant issuance,
// revocation, and ownership checks reflect whoever is "acting as" in the UI.
let currentPrincipalId = "user-a";

export function getCurrentPrincipalId(): string {
  return currentPrincipalId;
}

export function setCurrentPrincipalId(principalId: string): void {
  currentPrincipalId = principalId;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    "x-principal-id": currentPrincipalId,
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
  agentEvents: (id: string) =>
    request<{ events: RunEvent[] }>("/api/agents/" + id + "/events"),
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
  listPrincipals: () => request<{ principals: Principal[] }>("/api/principals"),
  listGrants: (principalId: string) =>
    request<{ grants: Grant[] }>("/api/grants?principalId=" + encodeURIComponent(principalId)),
  createGrant: (body: {
    principalId: string;
    scope: GrantScope;
    target: string;
    ttlMinutes?: number;
  }) =>
    request<{ grant: Grant }>("/api/grants", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revokeGrant: (id: string) =>
    request<{ grant: Grant }>("/api/grants/" + id + "/revoke", {
      method: "POST",
    }),
  // The whole point of this probe is to surface a 403 denial, not throw it
  // away as an exception - so it bypasses request() and reads the body itself.
  readResourceAsAgent: async (
    resourceId: string,
    agentPrincipalId: string,
  ): Promise<{ resource: MockResource | null; decision: PolicyDecision }> => {
    const response = await fetch("/api/resources/" + resourceId, {
      headers: {
        ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
        "x-agent-principal-id": agentPrincipalId,
      },
    });
    const data = (await response.json().catch(() => ({}))) as {
      resource?: MockResource | null;
      decision?: PolicyDecision;
      error?: string;
    };
    if (!data.decision) {
      throw new ApiError(data.error ?? "Request failed", response.status);
    }
    return { resource: data.resource ?? null, decision: data.decision };
  },
};


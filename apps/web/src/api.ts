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
  principalSessionTokens.clear();
  principalSessionRequests.clear();
}

// The UI explicitly selects a mock human before acting. The server exchanges
// that selection for an opaque session token, so later action requests cannot
// rewrite their actor by supplying a display name or principal header.
let currentPrincipalId = "user-a";
const principalSessionTokens = new Map<string, string>();
const principalSessionRequests = new Map<string, Promise<string>>();

export function getCurrentPrincipalId(): string {
  return currentPrincipalId;
}

export function setCurrentPrincipalId(principalId: string): void {
  currentPrincipalId = principalId;
}

async function principalSessionToken(principalId: string): Promise<string> {
  const existing = principalSessionTokens.get(principalId);
  if (existing) return existing;
  const pending = principalSessionRequests.get(principalId);
  if (pending) return pending;

  const request = fetch("/api/mock-principal-session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    },
    body: JSON.stringify({ principalId }),
  }).then(async (response) => {
    const data = (await response.json().catch(() => ({}))) as {
      sessionToken?: string;
      error?: string;
    };
    if (!response.ok || !data.sessionToken) {
      throw new ApiError(data.error ?? "Failed to select mock principal", response.status);
    }
    principalSessionTokens.set(principalId, data.sessionToken);
    return data.sessionToken;
  }).finally(() => {
    principalSessionRequests.delete(principalId);
  });
  principalSessionRequests.set(principalId, request);
  return request;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const principalId = currentPrincipalId;
  let sessionToken = url === "/api/auth"
    ? null
    : await principalSessionToken(principalId);
  const send = (token: string | null) => fetch(url, {
    ...options,
    headers: {
      ...options?.headers,
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
      ...(token ? { "x-mock-principal-session": token } : {}),
    },
  });

  let response = await send(sessionToken);
  let data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (
    response.status === 401 &&
    sessionToken &&
    data.error === "A valid mock principal session is required"
  ) {
    principalSessionTokens.delete(principalId);
    sessionToken = await principalSessionToken(principalId);
    response = await send(sessionToken);
    data = (await response.json().catch(() => ({}))) as T & { error?: string };
  }
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
  probeEgress: (id: string, host: string) =>
    request<{ httpStatus: number | null; blocked: boolean; detail: string }>(
      "/api/agents/" + id + "/probe-egress",
      { method: "POST", body: JSON.stringify({ host }) },
    ),
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
  approve: (id: string) =>
    request<{ approval: ApprovalRequest }>("/api/approvals/" + id + "/approve", {
      method: "POST",
    }),
  deny: (id: string) =>
    request<{ approval: ApprovalRequest }>("/api/approvals/" + id + "/deny", {
      method: "POST",
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

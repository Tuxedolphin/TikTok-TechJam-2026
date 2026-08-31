import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Agent,
  AgentRun,
  AgentSession,
  ApprovalRequest,
  Database,
  Message,
  MockResource,
  Principal,
  RunEvent,
} from "./types.js";

const SEED_HUMANS: Principal[] = [
  { id: "user-a", kind: "human", name: "User A", createdAt: "2026-08-30T00:00:00.000Z" },
  { id: "user-b", kind: "human", name: "User B", createdAt: "2026-08-30T00:00:00.000Z" },
];
const SEED_RESOURCES: MockResource[] = [
  { id: "res-a", ownerId: "user-a", name: "User A customer list", content: "alpha,beta,gamma" },
  { id: "res-b", ownerId: "user-b", name: "User B payroll", content: "confidential-b" },
];

const emptyDatabase = (): Database => ({
  version: 4,
  agents: [],
  sessions: [],
  messages: [],
  runs: [],
  runEvents: [],
  approvals: [],
  principals: [...SEED_HUMANS],
  grants: [],
  resources: [...SEED_RESOURCES],
});

type AgentV3 = Omit<Agent, "ownerId" | "principalId">;

interface Database3Shape {
  version: 3;
  agents: AgentV3[];
  sessions: AgentSession[];
  messages: Message[];
  runs: AgentRun[];
  runEvents: RunEvent[];
  approvals: ApprovalRequest[];
}

function migrateV3ToV4(v3: Database3Shape): Database {
  const principals: Principal[] = [
    ...SEED_HUMANS,
    ...v3.agents.map((a) => ({
      id: `agent-${a.id}`,
      kind: "agent" as const,
      name: a.name,
      createdAt: a.createdAt,
    })),
  ];
  return {
    version: 4,
    agents: v3.agents.map((a) => ({ ...a, ownerId: "user-a", principalId: `agent-${a.id}` })),
    sessions: v3.sessions,
    messages: v3.messages,
    runs: v3.runs,
    runEvents: v3.runEvents,
    approvals: v3.approvals,
    principals,
    grants: [],
    resources: SEED_RESOURCES,
        };
}

function migrateDatabase(parsed: Partial<Database> & { version?: number; sessions?: unknown[]; approvals?: unknown[] }): Database {
  if (parsed.version === 4) {
    const principals = Array.isArray(parsed.principals) ? parsed.principals : [];
    const agentPrincipals = new Set(
      principals.filter((principal) => principal.kind === "agent").map((principal) => principal.id),
    );
    const migratedAt = new Date().toISOString();
    const grants = (Array.isArray(parsed.grants) ? parsed.grants : []).map((grant) => {
      const parentGrantId = grant.parentGrantId ?? null;
      // Version 4 predates explicit lineage. Any agent-issued grant without a
      // parent is an unverifiable legacy root (including the self-clone bypass),
      // so fail it closed during load rather than blessing it forever.
      const unsafeLegacyRoot = parentGrantId === null && agentPrincipals.has(grant.grantedBy);
      return {
        ...grant,
        parentGrantId,
        revokedAt: unsafeLegacyRoot && grant.revokedAt === null ? migratedAt : grant.revokedAt,
      };
    });
    return {
      version: 4,
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      runEvents: Array.isArray(parsed.runEvents) ? parsed.runEvents : [],
      approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
      principals,
      grants,
      resources: Array.isArray(parsed.resources) ? parsed.resources : [],
    };
  }
  if (parsed.version === 3) {
    return migrateV3ToV4({
      version: 3,
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      runEvents: Array.isArray(parsed.runEvents) ? parsed.runEvents : [],
      approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
    } as Database3Shape);
  }
  if (parsed.version === 2 || parsed.version === 1) {
    const rawAgents = Array.isArray(parsed.agents) ? parsed.agents : [];
    const rawSessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    const rawMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const rawRuns = Array.isArray(parsed.runs) ? parsed.runs : [];
    const rawRunEvents = Array.isArray(parsed.runEvents) ? parsed.runEvents : [];
    const rawApprovals = Array.isArray(parsed.approvals) ? parsed.approvals : [];

    const sessions = [...rawSessions];
    const agents = rawAgents.map((a) => {
      let session = sessions.find((s) => s.agentId === a.id);
      if (!session) {
        session = {
          id: a.activeSessionId || randomUUID(),
          agentId: a.id,
          title: "Chat 1",
          codexThreadId: a.codexThreadId ?? null,
          createdAt: a.createdAt || new Date().toISOString(),
          updatedAt: a.updatedAt || new Date().toISOString(),
        };
        sessions.push(session);
      }
      return {
        ...a,
        activeSessionId: a.activeSessionId ?? session.id,
      };
    });


    const messages = rawMessages.map((m) => {
      if (m.sessionId) return m;
      const session = sessions.find((s) => s.agentId === m.agentId);
      return { ...m, sessionId: session?.id ?? null };
    });

    const runs = rawRuns.map((r) => {
      if (r.sessionId) return r;
      const session = sessions.find((s) => s.agentId === r.agentId);
      return { ...r, sessionId: session?.id ?? null };
    });

    return migrateV3ToV4({
      version: 3,
      agents,
      sessions,
      messages,
      runs,
      runEvents: rawRunEvents,
      approvals: rawApprovals,
    } as Database3Shape);
  }
  throw new Error("Unsupported database format");
}


/**
 * Most recent run for an agent, or null when it has never run. Decisions that
 * happen outside a run (issuing a grant, probing a resource) anchor their trace
 * event here so the operator sees them on the timeline they are already
 * watching.
 */
export function latestRunFor(runs: AgentRun[], agentId: string): AgentRun | null {
  let latest: AgentRun | null = null;
  for (const run of runs) {
    if (run.agentId !== agentId) continue;
    if (!latest || run.createdAt.localeCompare(latest.createdAt) > 0) latest = run;
  }
  return latest;
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.data = migrateDatabase(JSON.parse(raw) as Partial<Database> & { version?: number });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

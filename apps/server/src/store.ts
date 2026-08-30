import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 3,
  agents: [],
  sessions: [],
  messages: [],
  runs: [],
  runEvents: [],
});

function migrateDatabase(parsed: Partial<Database> & { version?: number; sessions?: unknown[] }): Database {
  if (parsed.version === 3) {
    return {
      version: 3,
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      runEvents: Array.isArray(parsed.runEvents) ? parsed.runEvents : [],
    };
  }
  if (parsed.version === 2 || parsed.version === 1) {
    const rawAgents = Array.isArray(parsed.agents) ? parsed.agents : [];
    const rawSessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    const rawMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const rawRuns = Array.isArray(parsed.runs) ? parsed.runs : [];
    const rawRunEvents = Array.isArray(parsed.runEvents) ? parsed.runEvents : [];

    const sessions = [...rawSessions];
    const agents = rawAgents.map((a) => {
      let session = sessions.find((s) => s.agentId === a.id);
      if (!session) {
        session = {
          id: a.activeSessionId || a.id + "-default-session",
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

    return {
      version: 3,
      agents,
      sessions,
      messages,
      runs,
      runEvents: rawRunEvents,
    };
  }
  throw new Error("Unsupported database format");
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

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 2,
  agents: [],
  messages: [],
  runs: [],
  runEvents: [],
});

function migrateDatabase(parsed: Partial<Database> & { version?: number }): Database {
  if (parsed.version === 2) {
    return {
      version: 2,
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      runEvents: Array.isArray(parsed.runEvents) ? parsed.runEvents : [],
    };
  }
  if (parsed.version === 1) {
    return {
      version: 2,
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      runEvents: [],
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

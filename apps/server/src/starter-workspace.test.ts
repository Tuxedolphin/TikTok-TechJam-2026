import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const execFileAsync = promisify(execFile);
const starterPrompt = "Safe turn: Run pwd, then list workspace files with ls -la (Auto-Approved)";

describe("fresh workspace starter action", () => {
  it("succeeds without package.json or Git and records the safe trace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad starter smoke "));
    try {
      const config = loadConfig({
        NODE_ENV: "test",
        MODEL_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "test-key",
        OPENROUTER_MODEL: "openrouter/test-model",
        APP_DATA_DIR: path.join(root, "data"),
        AGENT_WORKSPACE_ROOT: path.join(root, "workspaces with spaces"),
        CODEX_HOME: path.join(root, "codex"),
      });
      const store = new JsonStore(path.join(root, "data", "db.json"));
      const runner: AgentRunner = {
        run: async (request) => {
          const { stdout } = await execFileAsync("sh", ["-c", "pwd && ls -la"], {
            cwd: request.workspacePath,
          });
          await request.onStep?.({
            type: "command",
            title: "Inspect fresh workspace",
            detail: "pwd && ls -la (exit 0)",
          });
          return { output: stdout, threadId: "starter-thread", usage: null };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      };
      const service = new AgentService(
        config,
        store,
        new WorkspaceManager(config.workspaceRoot),
        runner,
      );
      await service.initialize();
      const agent = await service.createAgent({ name: "Fresh Starter" });

      await expect(access(path.join(agent.workspacePath, "package.json"))).rejects.toThrow();
      await expect(access(path.join(agent.workspacePath, ".git"))).rejects.toThrow();
      const appSource = await readFile(
        new URL("../../web/src/App.tsx", import.meta.url),
        "utf8",
      );
      expect(appSource).toContain(starterPrompt);
      expect(appSource).not.toContain("Safe turn: Run npm test");

      const { run } = await service.sendMessage(agent.id, starterPrompt);
      await expect.poll(() => service.getRun(run.id).status).toBe("completed");
      const completed = service.getRun(run.id);
      expect(completed.output).toContain(path.basename(agent.workspacePath));
      expect(completed.output).toContain("AGENTS.md");
      expect(completed.output).toContain("README.md");

      const events = service.getRunEvents(run.id);
      expect(events.map((event) => event.type)).toEqual([
        "run.created",
        "run.started",
        "step.auto_approved",
        "step.command",
        "run.completed",
      ]);
      expect(events.find((event) => event.type === "step.auto_approved")?.title)
        .toContain("ALLOW-STANDARD-000");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { buildCodexArgs, parseCodexEventLine, signalProcessTree } from "./codex-runner.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 6, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 6,
      outputTokens: 4,
    });
  });

  it.skipIf(process.platform === "win32")(
    "signals the complete local Runtime process group",
    async () => {
      const parent = spawn(
        process.execPath,
        [
          "-e",
          [
            "const { spawn } = require('node:child_process');",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);",
            "console.log(child.pid);",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      const [chunk] = await once(parent.stdout!, "data") as [Buffer];
      const descendantPid = Number(chunk.toString("utf8").trim());

      try {
        expect(signalProcessTree(parent, "SIGTERM")).toBe(true);
        await once(parent, "close");
        await expect.poll(() => {
          try {
            process.kill(descendantPid, 0);
            return true;
          } catch {
            return false;
          }
        }, { timeout: 3_000 }).toBe(false);
      } finally {
        try {
          process.kill(-parent.pid!, "SIGKILL");
        } catch {
          // The group is already gone.
        }
      }
    },
  );

  it("emits onStep events for commands and tools", () => {
    const steps: unknown[] = [];
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({
        type: "item.started",
        item: { type: "command_execution", command: "npm test", status: "in_progress" },
      }),
      parsed,
      (step) => steps.push(step),
    );
    expect(steps).toEqual([
      {
        type: "command",
        title: "Starting shell command",
        detail: "npm test",
        rawPayload: { type: "command_execution", command: "npm test", status: "in_progress" },
      },
    ]);
  });
});

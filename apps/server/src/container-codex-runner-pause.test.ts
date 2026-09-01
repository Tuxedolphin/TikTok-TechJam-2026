import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import type { RunnerRequest } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeFakeContainerEngine(actualPauseState: boolean): Promise<{
  engine: string;
  state: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "launchpad-container-test-"));
  temporaryDirectories.push(directory);
  const state = path.join(directory, "paused-state");
  const engine = path.join(directory, "fake-container-engine");
  await writeFile(state, "false");
  await writeFile(
    engine,
    `#!/usr/bin/env node
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const state = ${JSON.stringify(state)};
const command = process.argv[2];

if (command === "ps") {
  process.stdout.write("");
} else if (command === "run") {
  writeFileSync(state + ".keep", "true");
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "done" },
  }) + "\\n");
  const waitForRemoval = setInterval(() => {
    if (!existsSync(state + ".keep")) {
      clearInterval(waitForRemoval);
      process.exit(0);
    }
  }, 10);
} else if (command === "pause") {
  ${actualPauseState ? 'writeFileSync(state, "true");' : ""}
} else if (command === "unpause") {
  writeFileSync(state, "false");
} else if (command === "inspect") {
  process.stdout.write(readFileSync(state, "utf8") + "\\n");
} else if (command === "rm") {
  if (existsSync(state + ".keep")) unlinkSync(state + ".keep");
} else {
  process.exit(1);
}
`,
  );
  await chmod(engine, 0o755);
  return { engine, state };
}

describe("Container runtime pause verification", () => {
  it.each([false, true] as const)(
    "checks the container state instead of trusting a successful pause command (%s)",
    async (actualPauseState) => {
      const { engine, state } = await makeFakeContainerEngine(actualPauseState);
      const config = loadConfig({
        NODE_ENV: "test",
        OPENROUTER_API_KEY: "test-key",
        OPENROUTER_MODEL: "openrouter/test-model",
        CODEX_HOME: path.join(path.dirname(engine), "codex-home"),
        RUNTIME_PROVIDER: "container",
        CONTAINER_ENGINE: engine,
        CONTAINER_RUNTIME_IMAGE: "runtime:test",
        CODEX_TIMEOUT_MS: "10000",
      });
      const runner = new ContainerCodexRunner(config);
      const request: RunnerRequest = {
        agentId: "agent",
        workspacePath: path.dirname(engine),
        prompt: "run",
        threadId: null,
      };

      const run = runner.run(request);
      // Attach the rejection handler immediately: cancellation can close the
      // fake runtime before the final assertion is reached on a fast CI host.
      const cancelledRun = expect(run).rejects.toThrow("cancelled");
      // `run` awaits an orphan-container reconciliation pass before it
      // registers the agent as active, so a pause issued immediately would
      // race that registration rather than exercising the pause path itself.
      await vi.waitFor(() => {
        if (!runner.isRunning(request.agentId)) throw new Error("not yet running");
      });
      expect(await runner.pause(request.agentId)).toBe(actualPauseState ? "paused" : "failed");
      expect(await runner.resume(request.agentId)).toBe(true);
      expect(await readFile(state, "utf8")).toBe("false");
      await runner.cancel(request.agentId);
      await cancelledRun;
    },
    15_000,
  );
});

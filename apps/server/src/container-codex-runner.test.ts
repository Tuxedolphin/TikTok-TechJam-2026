import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildContainerRunArgs,
  containerName,
  ContainerCodexRunner,
} from "./container-codex-runner.js";
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

if (command === "run") {
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

describe("Container Codex runner", () => {
  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      OPENROUTER_API_KEY: "secret-that-must-not-appear-in-argv",
      OPENROUTER_MODEL: "openrouter/test-model",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent/unsafe",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    expect(args).toContain("type=bind,src=/tmp/codex-home,dst=/codex-home");
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
  });

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
      expect(await runner.pause(request.agentId)).toBe(actualPauseState);
      expect(await runner.resume(request.agentId)).toBe(true);
      expect(await readFile(state, "utf8")).toBe("false");
      await runner.cancel(request.agentId);
      await expect(run).rejects.toThrow("cancelled");
    },
  );
});

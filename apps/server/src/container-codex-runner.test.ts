import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildContainerRunArgs,
  ContainerCodexRunner,
  containerEngineEnvironment,
  containerName,
} from "./container-codex-runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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
    expect(args).toContain("--add-host");
    expect(args).toContain("host.docker.internal:host-gateway");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it.each(["docker", "podman"] as const)(
    "keeps provider and adapter credentials out of %s argv while passing only env names",
    (engine) => {
      const providerKey = "provider/key?$&= with spaces";
      const config = loadConfig({
        NODE_ENV: "test",
        RUNTIME_PROVIDER: "container",
        CONTAINER_ENGINE: engine,
        CONTAINER_RUNTIME_IMAGE: "runtime:test",
        GEMINI_API_KEY: providerKey,
        GEMINI_MODEL: "gemini-test-model",
      });
      const args = buildContainerRunArgs(
        {
          agentId: "agent",
          workspacePath: "/tmp/workspace",
          prompt: "run safely",
          threadId: null,
        },
        config,
      );
      const argv = args.join("\0");

      expect(argv).not.toContain(providerKey);
      expect(argv).not.toContain(config.geminiAdapterToken);
      expect(args).toContain("MODEL_API_KEY");
      expect(args.some((arg) => /^MODEL_API_KEY=/.test(arg))).toBe(false);
      expect(args).not.toContain("OPENROUTER_API_KEY");
      expect(args).not.toContain("OPENAI_API_KEY");
    },
  );

  it("passes the Runtime credential only to run, not container control commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-container-secrets-"));
    temporaryDirectories.push(root);
    const recordPath = path.join(root, "engine-env.log");
    const enginePath = path.join(root, "podman");
    await writeFile(
      enginePath,
      `#!/bin/sh
printf '%s|%s\\n' "$1" "\${MODEL_API_KEY-<unset>}" >> "${recordPath}"
if [ "$1" = "run" ]; then
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
fi
`,
      "utf8",
    );
    await chmod(enginePath, 0o755);
    const config = loadConfig({
      NODE_ENV: "test",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: enginePath,
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      GEMINI_API_KEY: "real-provider-key",
      GEMINI_MODEL: "gemini-test-model",
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex-home"),
    });
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const runner = new ContainerCodexRunner(config);

    expect(containerEngineEnvironment(config)).not.toMatchObject({
      MODEL_API_KEY: expect.anything(),
    });
    expect(containerEngineEnvironment(config, true)).toMatchObject({
      MODEL_API_KEY: config.geminiAdapterToken,
    });

    expect(await runner.isAvailable()).toBe(true);
    await runner.run({
      agentId: "agent",
      workspacePath,
      prompt: "run safely",
      threadId: null,
    });

    const records = (await readFile(recordPath, "utf8")).trim().split("\n");
    expect(records[0]).toBe("version|<unset>");
    expect(records[1]).toBe("image|<unset>");
    expect(records[2]).toBe(`run|${config.geminiAdapterToken}`);
    expect(records[2]).not.toContain(config.geminiApiKey);
  });

  it("handles empty credentials without synthesizing secret-bearing argv values", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNTIME_PROVIDER: "container",
      OPENROUTER_API_KEY: "",
      OPENROUTER_MODEL: "",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "run safely",
        threadId: null,
      },
      config,
    );

    expect(args.join("\0")).not.toContain("undefined");
    expect(args.join("\0")).not.toContain("null");
    expect(args).toContain("MODEL_API_KEY");
    expect(args.some((arg) => arg.startsWith("MODEL_API_KEY="))).toBe(false);
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
    expect(args).toContain("host.docker.internal:host-gateway");
    expect(args).not.toContain("keep-id");
  });

  it("routes the host adapter through the proxy under egress enforcement", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      GEMINI_API_KEY: "google-provider-key",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "connect to the adapter",
        threadId: null,
        egressProxyUrl: "http://launchpad-egress-proxy:8888",
      },
      config,
    );

    expect(config.openRouterBaseUrl).toBe(
      "http://host.docker.internal:3000/api/adapter",
    );
    expect(args).toContain("HTTP_PROXY=http://launchpad-egress-proxy:8888");
    expect(args).toContain("NO_PROXY=localhost,127.0.0.1");
    expect(args).not.toContain("host.docker.internal:host-gateway");
  });
});

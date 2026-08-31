import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isModelConfigured, loadConfig, writeCodexConfig } from "./config.js";

describe("egress enforcement configuration", () => {
  it("enforces by default under the container runtime", () => {
    const config = loadConfig({ NODE_ENV: "test", RUNTIME_PROVIDER: "container" });
    expect(config.egressEnforcement).toBe(true);
  });

  it("never claims to enforce when agents run as host processes", () => {
    // Containment is a property of the container network topology. A host
    // process has no such boundary, so reporting "enforcing" here would tell
    // an operator they are covered when nothing is contained.
    const config = loadConfig({
      NODE_ENV: "test",
      RUNTIME_PROVIDER: "local-process",
      EGRESS_ENFORCEMENT: "on",
    });
    expect(config.egressEnforcement).toBe(false);
  });

  it("can be switched off explicitly", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNTIME_PROVIDER: "container",
      EGRESS_ENFORCEMENT: "off",
    });
    expect(config.egressEnforcement).toBe(false);
  });
});

describe("model provider configuration", () => {
  const mixedEnvironment = {
    NODE_ENV: "test",
    PORT: "4321",
    ARK_API_KEY: "ark-key",
    ARK_MODEL: "ep-ark-model",
    ARK_BASE_URL: "https://ark.example/api/v3/",
    OPENROUTER_API_KEY: "openrouter-key",
    OPENROUTER_MODEL: "openrouter/model",
    OPENROUTER_BASE_URL: "https://openrouter.example/v1/",
    GEMINI_API_KEY: "gemini-key",
    GEMINI_MODEL: "gemini-test-model",
  } as const;

  it.each([
    ["ark", "ark-key", "ep-ark-model", "https://ark.example/api/v3"],
    ["openrouter", "openrouter-key", "openrouter/model", "https://openrouter.example/v1"],
    ["gemini", "gemini-key", "gemini-test-model", "http://host.docker.internal:4321/api/adapter"],
  ] as const)("uses only explicitly selected %s variables", (provider, key, model, baseUrl) => {
    const config = loadConfig({ ...mixedEnvironment, MODEL_PROVIDER: provider });

    expect(config.modelProvider).toBe(provider);
    expect(config.modelApiKey).toBe(key);
    expect(config.modelRuntimeApiKey).toBe(
      provider === "gemini" ? "internal-gemini-adapter" : key,
    );
    expect(config.modelName).toBe(model);
    expect(config.modelBaseUrl).toBe(baseUrl);
    expect(isModelConfigured(config)).toBe(true);
  });

  it("requires an explicit provider when multiple credentials are usable", () => {
    expect(() => loadConfig(mixedEnvironment)).toThrow(
      "MODEL_PROVIDER is required when multiple provider credentials are configured",
    );
  });

  it("keeps Ark-only deployments backward compatible", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: " ark-key ",
      ARK_MODEL: " ep-test ",
      ARK_BASE_URL: "https://ark.cn-beijing.volces.com/api/v3/",
    });

    expect(config).toMatchObject({
      modelProvider: "ark",
      modelApiKey: "ark-key",
      modelName: "ep-test",
      modelBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    });
  });

  it("does not fall back to another provider when the selected provider is incomplete", () => {
    const config = loadConfig({
      ...mixedEnvironment,
      MODEL_PROVIDER: "ark",
      ARK_API_KEY: " ",
      ARK_MODEL: "replace-with-your-ark-model",
    });

    expect(config.modelApiKey).toBe("");
    expect(config.modelName).toBe("replace-with-your-ark-model");
    expect(config.modelApiKey).not.toBe(mixedEnvironment.OPENROUTER_API_KEY);
    expect(config.modelApiKey).not.toBe(mixedEnvironment.GEMINI_API_KEY);
    expect(isModelConfigured(config)).toBe(false);
  });

  it("generates an Ark-specific Codex provider without competing provider values", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "launchpad-ark-config-"));
    try {
      const config = loadConfig({
        ...mixedEnvironment,
        MODEL_PROVIDER: "ark",
        CODEX_HOME: codexHome,
      });
      await writeCodexConfig(config);
      const toml = await readFile(path.join(codexHome, "config.toml"), "utf8");

      expect(toml).toContain('model_provider = "ark"');
      expect(toml).toContain('name = "BytePlus ModelArk"');
      expect(toml).toContain('model = "ep-ark-model"');
      expect(toml).toContain('base_url = "https://ark.example/api/v3"');
      expect(toml).toContain('env_key = "MODEL_API_KEY"');
      expect(toml).not.toContain("openrouter/model");
      expect(toml).not.toContain("gemini-test-model");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});

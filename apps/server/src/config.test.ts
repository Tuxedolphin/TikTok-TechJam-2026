import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isModelConfigured, loadConfig, writeCodexConfig } from "./config.js";

describe("output token budget configuration", () => {
  it.each([
    [
      "OpenRouter",
      {
        MODEL_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "openrouter-provider-key",
        OPENROUTER_MODEL: "provider/model",
      },
    ],
    [
      "Gemini adapter",
      {
        MODEL_PROVIDER: "gemini",
        GEMINI_API_KEY: "gemini-provider-key",
      },
    ],
    [
      "ModelArk",
      {
        MODEL_PROVIDER: "ark",
        ARK_API_KEY: "ark-provider-key",
        ARK_MODEL: "endpoint-id",
      },
    ],
  ])("does not emit the unsupported Codex output-cap key for %s", async (_label, overrides) => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "launchpad-budget-"));
    try {
      const config = loadConfig({
        NODE_ENV: "test",
        CODEX_HOME: codexHome,
        RUN_BUDGET_MAX_OUTPUT_TOKENS: "321",
        ...overrides,
      });
      await writeCodexConfig(config);
      const generated = await readFile(path.join(codexHome, "config.toml"), "utf8");
      expect(generated).not.toContain("model_max_output_tokens");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it.each(["0", "-1", "1.5", "not-a-number"])(
    "rejects invalid output cap %s",
    (limit) => {
      expect(() =>
        loadConfig({ NODE_ENV: "test", RUN_BUDGET_MAX_OUTPUT_TOKENS: limit }),
      ).toThrow();
    },
  );
});

describe("production authentication configuration", () => {
  it.each(["127.0.0.1", "::1", "localhost"])(
    "accepts loopback host %s without a token",
    (host) => {
      const config = loadConfig({
        NODE_ENV: "production",
        HOST: host,
        APP_AUTH_TOKEN: "",
        OPENROUTER_API_KEY: "provider-key",
        OPENROUTER_MODEL: "openai/gpt-4o-mini",
      });

      expect(config.host).toBe(host);
      expect(config.authToken).toBe("");
    },
  );

  it("accepts the copied example after adding only Gemini credentials", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      APP_AUTH_TOKEN: "",
      GEMINI_API_KEY: "gemini-provider-key",
      GEMINI_MODEL: "gemini-3.5-flash-lite",
      OPENROUTER_API_KEY: "replace-with-your-openrouter-api-key",
      OPENROUTER_MODEL: "openai/gpt-4o-mini",
    });

    expect(config.geminiApiKey).toBe("gemini-provider-key");
    expect(config.openRouterModel).toBe("gemini-3.5-flash-lite");
    // Deliberately not asserting what openRouterApiKey holds: #13 replaces it
    // with a dedicated Runtime credential so the provider key stays server-side.
  });

  it("accepts the documented Compose bind with a generated token", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      APP_AUTH_TOKEN: "a".repeat(24),
      OPENROUTER_API_KEY: "provider-key",
      OPENROUTER_MODEL: "openai/gpt-4o-mini",
    });

    expect(config.host).toBe("0.0.0.0");
    expect(config.authToken).toBe("a".repeat(24));
  });

  it.each(["", "too-short", "replace-with-a-secure-token"])(
    "rejects a non-loopback production bind with unsafe token %j",
    (authToken) => {
      expect(() =>
        loadConfig({
          NODE_ENV: "production",
          HOST: "0.0.0.0",
          APP_AUTH_TOKEN: authToken,
        }),
      ).toThrow(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    },
  );
});

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

  it("keeps the Gemini provider key in the control plane and scopes the Runtime key", () => {
    const providerKey = "AIza/provider?$&=with-special-chars";
    const config = loadConfig({
      NODE_ENV: "test",
      RUNTIME_PROVIDER: "container",
      GEMINI_API_KEY: providerKey,
      GEMINI_MODEL: "gemini-test-model",
    });

    expect(config.geminiApiKey).toBe(providerKey);
    expect(config.openRouterBaseUrl).toContain("/api/adapter");
    // One Runtime credential, and it is never the provider key.
    expect(config.openRouterApiKey).toBe(config.geminiAdapterToken);
    expect(config.geminiAdapterToken).not.toBe(providerKey);
    expect(config.geminiAdapterToken).toMatch(/^[A-Za-z0-9._~-]{24,}$/);
  });

  it("represents empty provider credentials as empty rather than a placeholder", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNTIME_PROVIDER: "container",
      GEMINI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      OPENROUTER_MODEL: "",
    });

    expect(config.geminiApiKey).toBe("");
    expect(config.openRouterApiKey).toBe("");
    expect(config.geminiAdapterToken).toBe("");
  });
});

describe("Gemini adapter credentials", () => {
  it("gives the Runtime a dedicated adapter token instead of the provider key", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_AUTH_TOKEN: "browser-token",
      GEMINI_API_KEY: "google-provider-key",
      GEMINI_ADAPTER_TOKEN: "runtime-only-token-1234567890",
    });

    expect(config.geminiAdapterToken).toBe("runtime-only-token-1234567890");
    expect(config.openRouterApiKey).toBe(config.geminiAdapterToken);
    expect(config.openRouterApiKey).not.toBe(config.geminiApiKey);
    expect(config.openRouterApiKey).not.toBe(config.authToken);
  });

  it("generates a URL-safe Runtime credential when none is configured", () => {
    const config = loadConfig({ NODE_ENV: "test", GEMINI_API_KEY: "google-provider-key" });

    expect(config.geminiAdapterToken).toMatch(/^[A-Za-z0-9._~-]{24,}$/);
    expect(config.openRouterApiKey).toBe(config.geminiAdapterToken);
    expect(config.openRouterApiKey).not.toBe(config.geminiApiKey);
  });

  it("disables Gemini mode for placeholder provider credentials", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      GEMINI_API_KEY: "replace-with-your-gemini-key",
      GEMINI_ADAPTER_TOKEN: "runtime-only-token-1234567890",
      OPENROUTER_API_KEY: "openrouter-provider-key",
      OPENROUTER_MODEL: "openai/test",
    });

    expect(config.geminiApiKey).toBe("");
    expect(config.geminiAdapterToken).toBe("");
    expect(config.openRouterApiKey).toBe("openrouter-provider-key");
    expect(config.openRouterBaseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("rejects the documented adapter-token placeholder", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        GEMINI_API_KEY: "google-provider-key",
        GEMINI_ADAPTER_TOKEN: "replace-with-a-random-runtime-token",
      }),
    ).toThrow("GEMINI_ADAPTER_TOKEN must not use the documented placeholder value");
  });

  it.each(["APP_AUTH_TOKEN", "GEMINI_API_KEY"] as const)(
    "rejects an adapter token reused as %s",
    (sharedWith) => {
      const sharedSecret = "shared-runtime-secret-1234567890";
      expect(() =>
        loadConfig({
          NODE_ENV: "test",
          GEMINI_API_KEY:
            sharedWith === "GEMINI_API_KEY" ? sharedSecret : "google-provider-key",
          APP_AUTH_TOKEN: sharedWith === "APP_AUTH_TOKEN" ? sharedSecret : "browser-token",
          GEMINI_ADAPTER_TOKEN: sharedSecret,
        }),
      ).toThrow(
        sharedWith === "APP_AUTH_TOKEN"
          ? "GEMINI_ADAPTER_TOKEN must be distinct from APP_AUTH_TOKEN"
          : "GEMINI_ADAPTER_TOKEN must be distinct from the provider API key",
      );
    },
  );
});

describe("guardrail canary configuration", () => {
  it("rejects non-empty canary values that are too short for safe redaction", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "test", GUARDRAIL_CANARY_TOKEN: "short" }),
    ).toThrow("GUARDRAIL_CANARY_TOKEN must be empty or at least 12 characters");
  });

  it("continues to treat an empty canary as disabled", () => {
    expect(loadConfig({ NODE_ENV: "test", GUARDRAIL_CANARY_TOKEN: "" })
      .guardrailCanaryToken).toBe("");
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
    GEMINI_ADAPTER_TOKEN: "runtime-only-token-1234567890",
  } as const;

  it.each([
    ["ark", "ark-key", "ep-ark-model", "https://ark.example/api/v3"],
    ["openrouter", "openrouter-key", "openrouter/model", "https://openrouter.example/v1"],
    ["gemini", "gemini-key", "gemini-test-model", "http://127.0.0.1:4321/api/adapter"],
  ] as const)("uses only explicitly selected %s variables", (provider, key, model, baseUrl) => {
    const config = loadConfig({ ...mixedEnvironment, MODEL_PROVIDER: provider });

    expect(config.modelProvider).toBe(provider);
    expect(config.modelApiKey).toBe(key);
    expect(config.modelRuntimeApiKey).toBe(
      provider === "gemini" ? mixedEnvironment.GEMINI_ADAPTER_TOKEN : key,
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

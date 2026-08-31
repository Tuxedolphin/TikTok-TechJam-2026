import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, writeCodexConfig } from "./config.js";

describe("output token budget configuration", () => {
  it.each([
    ["OpenRouter", {}],
    ["Gemini", { GEMINI_API_KEY: "gemini-key" }],
  ])("requests no more than the preventive cap from %s", async (_provider, providerEnv) => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "launchpad-budget-"));
    try {
      const config = loadConfig({
        NODE_ENV: "test",
        CODEX_HOME: codexHome,
        RUN_BUDGET_MAX_OUTPUT_TOKENS: "37",
        ...providerEnv,
      });
      await writeCodexConfig(config);

      const generated = await readFile(path.join(codexHome, "config.toml"), "utf8");
      expect(generated).toContain("model_max_output_tokens = 37");
      expect(generated).not.toContain("model_max_output_tokens = 4096");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("retains the lower built-in provider cap when the budget is higher", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "launchpad-budget-"));
    try {
      const config = loadConfig({
        NODE_ENV: "test",
        CODEX_HOME: codexHome,
        RUN_BUDGET_MAX_OUTPUT_TOKENS: "8192",
      });
      await writeCodexConfig(config);

      const generated = await readFile(path.join(codexHome, "config.toml"), "utf8");
      expect(generated).toContain("model_max_output_tokens = 4096");
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
  it("generates an unpredictable internal secret independently of browser auth", () => {
    const first = loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "shared-browser-token" });
    const second = loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "shared-browser-token" });
    expect(first.internalAgentSecret).toHaveLength(64);
    expect(first.internalAgentSecret).not.toBe(first.authToken);
    expect(first.internalAgentSecret).not.toBe(second.internalAgentSecret);
  });

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
});

import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

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

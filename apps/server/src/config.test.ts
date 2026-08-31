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

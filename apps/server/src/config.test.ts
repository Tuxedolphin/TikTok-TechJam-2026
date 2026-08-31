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

describe("Gemini adapter routing", () => {
  it.each([
    ["local-process", "127.0.0.1"],
    ["container", "host.docker.internal"],
  ] as const)("uses %s routing through %s", (runtimeProvider, expectedHost) => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNTIME_PROVIDER: runtimeProvider,
      PORT: "4317",
      GEMINI_API_KEY: "google-provider-key",
    });

    expect(config.openRouterBaseUrl).toBe(
      `http://${expectedHost}:4317/api/adapter`,
    );
  });
});

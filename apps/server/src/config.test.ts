import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

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
});

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

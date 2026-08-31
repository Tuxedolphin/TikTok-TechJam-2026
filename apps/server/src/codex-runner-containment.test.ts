import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CodexRunner } from "./codex-runner.js";
import { loadConfig } from "./config.js";

/**
 * The local-process runtime signals a process *group* so a stop or kill reaches
 * tool descendants. `confirmStopped` is what turns that from a hope into an
 * observation: it asks the OS whether the group still has members, so a
 * termination receipt cannot claim containment while a spawned command is
 * still running.
 */
describe("CodexRunner containment confirmation", () => {
  const config = loadConfig({
    NODE_ENV: "test",
    OPENROUTER_API_KEY: "k",
    OPENROUTER_MODEL: "m",
    CODEX_HOME: "/tmp/codex-home",
  });

  it("reports a still-live process group as not stopped", async () => {
    const runner = new CodexRunner(config);
    // Stand in for a run whose descendants outlived the parent: its own group,
    // sleeping, nothing signalled.
    const survivor = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    (runner as unknown as { lastGroupPid: Map<string, number> })
      .lastGroupPid.set("agent-live", survivor.pid!);

    // A live group must read as "not stopped", never as an all-clear.
    expect(await runner.confirmStopped("agent-live")).toBe(false);

    process.kill(-survivor.pid!, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await runner.confirmStopped("agent-live")).toBe(true);
  });

  it("cannot confirm when no run was ever recorded", async () => {
    const runner = new CodexRunner(config);
    // null, not true: absence of a record is not evidence of containment.
    expect(await runner.confirmStopped("agent-unknown")).toBeNull();
  });
});

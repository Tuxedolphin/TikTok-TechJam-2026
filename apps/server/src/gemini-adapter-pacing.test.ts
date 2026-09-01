import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * Pacing state is module-global, so this file holds the concurrency test alone
 * -- a sibling test that consumed a slot first would mask the behavior.
 */
describe("Gemini adapter request pacing", () => {
  it("spaces concurrent requests instead of releasing them in a burst", async () => {
    const firedAt: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        firedAt.push(Date.now());
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const config = loadConfig({
      NODE_ENV: "test",
      PORT: "4317",
      GEMINI_API_KEY: "AIzaSy-provider-key",
    });
    const app = await createApp(config, service);

    try {
      vi.useFakeTimers();
      // Three turns started together, as a fleet of agents would. Reading a
      // shared "last request" timestamp makes all three compute the same delay
      // and wake together, so the 15 RPM ceiling is breached by exactly the
      // concurrency the platform is built to run.
      const inflight = [0, 1, 2].map(() =>
        app.inject({
          method: "POST",
          url: "/api/adapter/responses",
          headers: { authorization: "Bearer " + config.geminiAdapterToken },
          payload: { input: [{ type: "message", role: "user", content: "hello" }] },
        }),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      const responses = await Promise.all(inflight);

      expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
      expect(firedAt).toHaveLength(3);
      expect(firedAt[1]! - firedAt[0]!).toBeGreaterThanOrEqual(4200);
      expect(firedAt[2]! - firedAt[1]!).toBeGreaterThanOrEqual(4200);
    } finally {
      await app.close();
    }
  });
});

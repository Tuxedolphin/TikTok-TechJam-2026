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
 * Pacing state is module-global, so this file holds one test alone: a sibling
 * that consumed slots first would change how deep the queue already is.
 */
describe("Gemini adapter pacing queue depth", () => {
  it("refuses a turn it could only serve past the run deadline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const config = loadConfig({
      NODE_ENV: "test",
      PORT: "4317",
      GEMINI_API_KEY: "AIzaSy-provider-key",
    });
    const app = await createApp(config, service);

    try {
      vi.useFakeTimers();
      // Far more turns than the pace can serve. Queueing all of them silently
      // pushes the last ones past CODEX_TIMEOUT_MS, where the run dies to a
      // timeout that says nothing about rate limiting. Shedding load says so.
      const inflight = Array.from({ length: 40 }, () =>
        app.inject({
          method: "POST",
          url: "/api/adapter/responses",
          headers: { authorization: "Bearer " + config.geminiAdapterToken },
          payload: { input: [{ type: "message", role: "user", content: "hello" }] },
        }),
      );
      await vi.advanceTimersByTimeAsync(600_000);
      const codes = (await Promise.all(inflight)).map((response) => response.statusCode);

      const shed = codes.filter((code) => code === 429);
      expect(shed.length).toBeGreaterThan(0);
      expect(codes.every((code) => code === 200 || code === 429)).toBe(true);
    } finally {
      await app.close();
    }
  });
});

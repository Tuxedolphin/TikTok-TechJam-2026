import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Gemini adapter credential boundary", () => {
  it("rejects missing and wrong credentials, then forwards only the real key upstream", async () => {
    const providerKey = "AIza/provider?$&=with-special-chars";
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "adapter response" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(`upstream rejected ${providerKey} and ${"wrong-adapter"}`, { status: 502 }),
      );
    vi.stubGlobal("fetch", upstream);
    const config = loadConfig({
      NODE_ENV: "test",
      RUNTIME_PROVIDER: "container",
      PORT: "4317",
      GEMINI_API_KEY: providerKey,
      RUN_BUDGET_MAX_OUTPUT_TOKENS: "37",
    });
    const app = await createApp(config, service);

    try {
      const payload = { input: [{ type: "message", role: "user", content: "hello" }] };
      const missing = await app.inject({
        method: "POST",
        url: "/api/adapter/responses",
        payload,
      });
      const wrong = await app.inject({
        method: "POST",
        url: "/api/adapter/responses",
        headers: { authorization: "Bearer wrong-adapter" },
        payload,
      });
      expect(missing.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(`${missing.body}\n${wrong.body}`).not.toContain(providerKey);
      expect(`${missing.body}\n${wrong.body}`).not.toContain(config.geminiAdapterToken);
      expect(upstream).not.toHaveBeenCalled();

      const accepted = await app.inject({
        method: "POST",
        url: "/api/adapter/responses",
        headers: { authorization: "Bearer " + config.geminiAdapterToken },
        payload,
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.body).toContain("response.completed");
      expect(accepted.body).not.toContain(providerKey);
      expect(accepted.body).not.toContain(config.geminiAdapterToken);
      const upstreamInit = upstream.mock.calls[0]?.[1] as RequestInit;
      expect((upstreamInit.headers as Record<string, string>).Authorization).toBe(
        "Bearer " + providerKey,
      );
      expect(JSON.parse(String(upstreamInit.body))).toMatchObject({
        max_tokens: 37,
      });

      const currentTime = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(currentTime + 5_000);
      const upstreamError = await app.inject({
        method: "POST",
        url: "/api/adapter/responses",
        headers: { authorization: "Bearer " + config.geminiAdapterToken },
        payload,
      });
      expect(upstreamError.statusCode).toBe(502);
      expect(upstreamError.body).not.toContain(providerKey);
      expect(upstreamError.body).not.toContain(config.geminiAdapterToken);
    } finally {
      await app.close();
    }
  });
});

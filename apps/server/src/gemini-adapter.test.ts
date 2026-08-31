import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { handleGeminiResponsesAdapter } from "./gemini-adapter.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Gemini Responses adapter budgets", () => {
  it("never requests more output tokens than the preventive cap", async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(JSON.stringify({
        choices: [{ message: { content: "done" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const raw = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const reply = {
      hijack: vi.fn(),
      raw,
      code: vi.fn().mockReturnThis(),
      send: vi.fn(),
    } as unknown as FastifyReply;
    const request = {
      body: {
        model: "gemini-3.5-flash-lite",
        input: [],
        max_output_tokens: 100,
      },
    } as unknown as FastifyRequest;
    const config = loadConfig({
      NODE_ENV: "test",
      GEMINI_API_KEY: "gemini-key",
      RUN_BUDGET_MAX_OUTPUT_TOKENS: "37",
    });

    await handleGeminiResponsesAdapter(request, reply, config);

    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({
      max_completion_tokens: 37,
    });
  });
});

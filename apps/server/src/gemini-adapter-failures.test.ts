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

/**
 * The adapter paces itself to stay under Google's per-minute cap by sleeping
 * between calls. Tests advance the clock instead of waiting it out.
 */
// The adapter's pacing state is module-global and outlives each test, so the
// clock has to keep moving forward across the whole file rather than restart.
let clock = Date.now() + 3_600_000;
function skipPacing(): void {
  vi.spyOn(Date, "now").mockImplementation(() => (clock += 60_000));
}

async function harness(): Promise<{
  app: Awaited<ReturnType<typeof createApp>>;
  token: string;
}> {
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "4317",
    GEMINI_API_KEY: "AIzaSy-provider-key",
  });
  return { app: await createApp(config, service), token: config.geminiAdapterToken };
}

const payload = { input: [{ type: "message", role: "user", content: "hello" }] };

describe("Gemini adapter upstream failure reporting", () => {
  it("reports a rejected API key as an auth failure, not a malformed request", async () => {
    skipPacing();
    // Google's OpenAI-compatibility layer answers a dead, revoked, or
    // mistyped key with HTTP 400 INVALID_ARGUMENT -- verified live against
    // generativelanguage.googleapis.com. Forwarded verbatim, Codex reports a
    // bad request and the operator hunts for a payload bug instead of
    // checking their key.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 400, message: "Please pass a valid API key", status: "INVALID_ARGUMENT" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { app, token } = await harness();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/adapter/responses",
        headers: { authorization: "Bearer " + token },
        payload,
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).toMatch(/api key/i);
    } finally {
      await app.close();
    }
  });

  it("preserves a genuine upstream request error as a request error", async () => {
    skipPacing();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 400, message: "Invalid JSON payload received.", status: "INVALID_ARGUMENT" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { app, token } = await harness();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/adapter/responses",
        headers: { authorization: "Bearer " + token },
        payload,
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("fails loudly when the model's whole budget went to reasoning tokens", async () => {
    skipPacing();
    // Gemini 3 models always reason and reasoning cannot be disabled. When the
    // output cap is consumed before any text is emitted, the upstream call is
    // a 200 carrying nothing. Replaying that as a successful, output-less
    // response tells the operator the agent chose to do nothing.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "", tool_calls: [] }, finish_reason: "length" }],
            usage: { prompt_tokens: 12, completion_tokens: 4096, total_tokens: 4108 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { app, token } = await harness();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/adapter/responses",
        headers: { authorization: "Bearer " + token },
        payload,
      });
      expect(response.statusCode).toBe(502);
      expect(response.body).toMatch(/reasoning/i);
      // A silent success is the failure mode being guarded against.
      expect(response.body).not.toContain("response.completed");
    } finally {
      await app.close();
    }
  });

  it("arms a deadline on the upstream call", async () => {
    skipPacing();
    const upstream = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", upstream);
    const { app, token } = await harness();
    try {
      await app.inject({
        method: "POST",
        url: "/api/adapter/responses",
        headers: { authorization: "Bearer " + token },
        payload,
      });
      // Without a signal a stalled Google connection pins the run open until
      // the far longer Codex timeout fires, with nothing said about why.
      const init = upstream.mock.calls[0]?.[1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await app.close();
    }
  });

  it("reports an upstream that never answered as a gateway timeout", async () => {
    skipPacing();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
      ),
    );
    const { app, token } = await harness();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/adapter/responses",
        headers: { authorization: "Bearer " + token },
        payload,
      });
      expect(response.statusCode).toBe(504);
      expect(response.body).toMatch(/timed out|timeout/i);
    } finally {
      await app.close();
    }
  });

  it("evicts the oldest thought signatures rather than growing without bound", async () => {
    skipPacing();
    const total = 600;
    const toolCalls = Array.from({ length: total }, (_value, index) => ({
      id: `call_${index}`,
      type: "function" as const,
      function: { name: "probe", arguments: "{}" },
      extra_content: { google: { thought_signature: `sig_${index}` } },
    }));
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "", tool_calls: toolCalls } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", upstream);
    const { app, token } = await harness();
    try {
      await app.inject({
        method: "POST",
        url: "/api/adapter/responses",
        headers: { authorization: "Bearer " + token },
        payload,
      });
      // Replay the oldest and the newest call back as prior turns.
      await app.inject({
        method: "POST",
        url: "/api/adapter/responses",
        headers: { authorization: "Bearer " + token },
        payload: {
          input: [
            { type: "function_call", call_id: "call_0", name: "probe", arguments: "{}" },
            { type: "function_call", call_id: `call_${total - 1}`, name: "probe", arguments: "{}" },
          ],
        },
      });

      const replayed = JSON.parse(
        String((upstream.mock.calls[1]?.[1] as RequestInit).body),
      ) as { messages: Array<{ tool_calls?: Array<{ id: string; extra_content?: unknown }> }> };
      const byId = new Map(
        replayed.messages
          .flatMap((message) => message.tool_calls ?? [])
          .map((call) => [call.id, call.extra_content]),
      );
      // The newest signature is still worth replaying; the oldest must have
      // been dropped, or the map grows for the life of the process.
      expect(byId.get(`call_${total - 1}`)).toBeDefined();
      expect(byId.get("call_0")).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("still streams a normal answer through unchanged", async () => {
    skipPacing();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "hello back" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { app, token } = await harness();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/adapter/responses",
        headers: { authorization: "Bearer " + token },
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("response.completed");
      expect(response.body).toContain("hello back");
    } finally {
      await app.close();
    }
  });
});

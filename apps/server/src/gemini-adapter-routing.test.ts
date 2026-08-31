import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("reaches the adapter over loopback in the same-container profile", async () => {
    const port = await availableLoopbackPort();
    const realFetch = globalThis.fetch;
    const upstreamFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "loopback reached" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", upstreamFetch);
    const config = loadConfig({
      NODE_ENV: "test",
      RUNTIME_PROVIDER: "local-process",
      PORT: String(port),
      GEMINI_API_KEY: "google-provider-key",
    });
    const app = await createApp(config, service);
    await app.listen({ host: "127.0.0.1", port });

    try {
      const response = await realFetch(config.openRouterBaseUrl + "/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer " + config.openRouterApiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: [] }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("response.completed");
      expect(upstreamFetch).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});

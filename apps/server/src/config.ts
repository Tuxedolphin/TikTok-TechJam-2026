import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

function resolveServerDistPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  if (existsSync(path.join(currentDir, "egress-proxy-main.js"))) {
    return currentDir;
  }
  const siblingDist = path.resolve(currentDir, "../dist");
  if (existsSync(path.join(siblingDist, "egress-proxy-main.js"))) {
    return siblingDist;
  }
  const cwdDist = path.resolve(process.cwd(), "dist");
  if (existsSync(path.join(cwdDist, "egress-proxy-main.js"))) {
    return cwdDist;
  }
  const rootDist = path.resolve(process.cwd(), "apps/server/dist");
  if (existsSync(path.join(rootDist, "egress-proxy-main.js"))) {
    return rootDist;
  }
  return siblingDist;
}

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  EGRESS_ENFORCEMENT: z
    .enum(["off", "on"])
    .default("on")
    .describe("On by default: agent containers run with no route off-box and reach the network only through the authorizing proxy. Set to off to restore plain bridge networking."),
  EGRESS_PROXY_PORT: z.coerce.number().int().min(1).max(65535).default(8888),
  EGRESS_PROXY_IMAGE: z.string().min(1).default("node:22-alpine"),
  EGRESS_QUARANTINE_THRESHOLD: z.coerce.number().int().min(1).default(3),
  EGRESS_PROBE_IMAGE: z.string().min(1).default("curlimages/curl:latest"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().optional(),
  OPENROUTER_BASE_URL: z
    .string()
    .url()
    .default("https://openrouter.ai/api/v1"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
  GEMINI_ADAPTER_TOKEN: z
    .string()
    .trim()
    .min(24)
    .max(128)
    .regex(/^[A-Za-z0-9._~-]+$/, "GEMINI_ADAPTER_TOKEN must use URL-safe characters")
    .optional(),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z.string().url().optional(),
  GUARDRAIL_CANARY_TOKEN: z.string().trim().max(256).optional(),
  RUN_BUDGET_MAX_INPUT_TOKENS: z.coerce.number().int().positive().optional(),
  RUN_BUDGET_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().optional(),
  RUN_BUDGET_MAX_TOTAL_TOKENS: z.coerce.number().int().positive().optional(),
  RUN_BUDGET_MAX_DURATION_MS: z.coerce.number().int().positive().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: Record<string, unknown> = process.env) {

  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  // Both sides are wanted: this branch's agent-attestation secret and main's
  // dedicated Runtime->adapter token. They protect different boundaries.
  const internalAgentSecret = randomBytes(32).toString("hex");
  const configuredGeminiApiKey = env.GEMINI_API_KEY?.trim() ?? "";
  const geminiApiKey =
    configuredGeminiApiKey.length > 0 && !configuredGeminiApiKey.startsWith("replace-")
      ? configuredGeminiApiKey
      : "";
  const isGeminiMode = geminiApiKey.length > 0;
  const geminiAdapterToken = isGeminiMode
    ? env.GEMINI_ADAPTER_TOKEN?.trim() || randomBytes(32).toString("base64url")
    : "";

  const openRouterApiKey = isGeminiMode
    ? geminiAdapterToken
    : env.OPENROUTER_API_KEY?.trim() ?? env.ARK_API_KEY?.trim() ?? "";
  const openRouterModel = isGeminiMode
    ? env.GEMINI_MODEL?.trim() || env.OPENROUTER_MODEL?.trim() || "gemini-3.5-flash-lite"
    : env.OPENROUTER_MODEL?.trim() ?? env.ARK_MODEL?.trim() ?? "";
  const geminiAdapterHost =
    env.RUNTIME_PROVIDER === "container" ? "host.docker.internal" : "127.0.0.1";
  const openRouterBaseUrl = isGeminiMode
    ? "http://" + geminiAdapterHost + ":" + env.PORT + "/api/adapter"
    : env.OPENROUTER_BASE_URL.trim().replace(/\/+$/, "") ||
      env.ARK_BASE_URL?.trim().replace(/\/+$/, "") ||
      "https://openrouter.ai/api/v1";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server. " +
          "Run ./scripts/bootstrap-local.sh to generate one in .env.",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    // Enforcement is a property of the container topology, so it is only ever
    // true when the container runtime is in use. Collapsing both conditions here
    // keeps every consumer from having to remember the second one.
    egressEnforcement:
      env.EGRESS_ENFORCEMENT === "on" && env.RUNTIME_PROVIDER === "container",
    egressProxyPort: env.EGRESS_PROXY_PORT,
    egressProxyImage: env.EGRESS_PROXY_IMAGE,
    egressQuarantineThreshold: env.EGRESS_QUARANTINE_THRESHOLD,
    egressProbeImage: env.EGRESS_PROBE_IMAGE,
    serverDistPath: resolveServerDistPath(),
    authToken,
    // Random per process so source access does not reveal agent credentials.
    internalAgentSecret,
    geminiApiKey,
    geminiAdapterToken,
    openRouterApiKey,
    openRouterModel,
    openRouterBaseUrl,
    guardrailCanaryToken: env.GUARDRAIL_CANARY_TOKEN?.trim() ?? "",
    runBudgetMaxInputTokens: env.RUN_BUDGET_MAX_INPUT_TOKENS ?? null,
    runBudgetMaxOutputTokens: env.RUN_BUDGET_MAX_OUTPUT_TOKENS ?? null,
    runBudgetMaxTotalTokens: env.RUN_BUDGET_MAX_TOTAL_TOKENS ?? null,
    runBudgetMaxDurationMs: env.RUN_BUDGET_MAX_DURATION_MS ?? null,
    nodeEnv: env.NODE_ENV,
  };
}

export function isOpenRouterConfigured(config: AppConfig): boolean {
  return (
    config.openRouterApiKey.length > 0 &&
    !config.openRouterApiKey.startsWith("replace-") &&
    config.openRouterModel.length > 0 &&
    !config.openRouterModel.includes("replace-")
  );
}

const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 4096;

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const providerName = config.geminiApiKey ? "gemini_adapter" : "openrouter";
  const modelMaxOutputTokens = Math.min(
    DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
    config.runBudgetMaxOutputTokens ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  );
  const toml = [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.openRouterModel || "openrouter-not-configured"),
    "model_provider = " + JSON.stringify(providerName),
    "model_max_output_tokens = " + modelMaxOutputTokens,
    "",
    "[model_providers." + providerName + "]",
    "name = " + JSON.stringify(config.geminiApiKey ? "Gemini Adapter" : "OpenRouter"),
    "base_url = " + JSON.stringify(config.openRouterBaseUrl),
    'env_key = "OPENROUTER_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}

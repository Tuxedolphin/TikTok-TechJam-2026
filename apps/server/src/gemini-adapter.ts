import type { FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";

const thoughtSignatureStore = new Map<string, unknown>();
let lastRequestTime = 0;

function redactSecrets(value: string, config: AppConfig): string {
  let output = value;
  for (const secret of [
    config.geminiApiKey,
    config.geminiAdapterToken,
    config.openRouterApiKey,
  ]) {
    if (secret) output = output.split(secret).join("[redacted]");
  }
  return output;
}
const MIN_REQUEST_INTERVAL_MS = 4200; // Cap pacing strictly at 14.3 RPM (under Google 15 RPM limit)

/**
 * Google reports a bad credential as 400 INVALID_ARGUMENT, so the status alone
 * cannot separate "your key is dead" from "your payload is wrong". The message
 * body is the only signal that distinguishes them.
 */
function isCredentialRejection(status: number, body: string): boolean {
  if (status === 401 || status === 403) return true;
  if (status !== 400) return false;
  return /api[\s_-]?key(?:[\s_-]?(?:is[\s_-]?)?(?:not[\s_-]?valid|invalid|expired))?/i.test(body) &&
    /invalid|not valid|expired|pass a valid|permission/i.test(body);
}

export async function handleGeminiResponsesAdapter(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
): Promise<void> {
  const body = (request.body || {}) as Record<string, unknown>;
  const apiKey = config.geminiApiKey;
  if (config.modelProvider !== "gemini" || !apiKey) {
    return reply.code(404).send({ error: "Gemini adapter is not configured" });
  }

  let targetModel =
    typeof body.model === "string" && body.model.length > 0
      ? body.model.replace(/^google\//, "").replace(/:free$/, "")
      : config.modelName || "gemini-3.5-flash-lite";
  if (targetModel === "gemini-2.0-flash" || targetModel === "gemini-2.5-flash-lite" || !targetModel.includes("gemini")) {
    targetModel = "gemini-3.5-flash-lite";
  }

  // Translate input into OpenAI/Gemini chat messages
  const messages: Array<{
    role: string;
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
  }> = [];

  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions.trim() });
  }

  const input = Array.isArray(body.input) ? body.input : [];
  for (const rawItem of input) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;

    if (item.type === "message") {
      let role = String(item.role || "user");
      if (role === "developer") role = "system";
      let text = "";
      if (typeof item.content === "string") {
        text = item.content;
      } else if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part && typeof part === "object" && typeof (part as { text?: string }).text === "string") {
            text += (part as { text: string }).text;
          }
        }
      }
      messages.push({ role, content: text });
    } else if (item.type === "function_call") {
      const fnName = String(item.name || "");
      const fnArgs =
        typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments || {});
      const callId = String(item.call_id || randomUUID());
      const extra = thoughtSignatureStore.get(callId);
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: {
              name: fnName,
              arguments: fnArgs,
            },
            ...(extra ? { extra_content: extra } : {}),
          },
        ],
      });
    } else if (item.type === "function_call_output") {
      const out =
        typeof item.output === "string"
          ? item.output
          : JSON.stringify(item.output || "");
      messages.push({
        role: "tool",
        tool_call_id: String(item.call_id || ""),
        content: out,
      });
    }
  }

  // Format tools for Gemini OpenAI endpoint
  const rawTools = Array.isArray(body.tools) ? body.tools : [];
  const tools = rawTools
    .map((t: Record<string, unknown>) => {
      if (!t || typeof t !== "object") return null;
      if (t.type === "function") {
        const fn = (t.function as Record<string, unknown>) || {};
        return {
          type: "function",
          function: {
            name: t.name || fn.name,
            description: t.description || fn.description,
            parameters: t.parameters || fn.parameters || { type: "object", properties: {} },
          },
        };
      }
      return null;
    })
    .filter(Boolean);

  const requestedMaxOutputTokens =
    typeof body.max_output_tokens === "number" &&
    Number.isInteger(body.max_output_tokens) &&
    body.max_output_tokens > 0
      ? body.max_output_tokens
      : null;
  const maxCompletionTokens = [
    requestedMaxOutputTokens,
    config.runBudgetMaxOutputTokens,
  ].reduce<number | null>(
    (lowest, value) =>
      value === null ? lowest : lowest === null ? value : Math.min(lowest, value),
    null,
  );
  const geminiPayload = {
    model: targetModel,
    messages,
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    // Google's OpenAI-compatibility layer documents `max_tokens` and silently
    // ignores parameters it does not recognize, so an unrecognized name would
    // make this cap decorative. It counts reasoning plus output tokens, which
    // is stricter than the budget name suggests -- never looser.
    ...(maxCompletionTokens !== null ? { max_tokens: maxCompletionTokens } : {}),
    stream: false,
  };

  // Google AI Studio free tier rate limit is 15 RPM.
  // Pacing ensures autonomous agent loops stay strictly under the 15 RPM cap.
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();

  let response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify(geminiPayload),
    },
  );

  if (response.status === 429) {
    // If rate limited, wait 6 seconds and retry once
    await new Promise((resolve) => setTimeout(resolve, 6000));
    lastRequestTime = Date.now();
    response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify(geminiPayload),
      },
    );
  }

  if (!response.ok) {
    const errorText = await response.text();
    // Google's OpenAI-compatibility layer answers a missing, mistyped, revoked,
    // or expired key with HTTP 400 INVALID_ARGUMENT rather than 401. Forwarded
    // verbatim that reads as "the request was malformed", so the operator goes
    // looking for a bug in the payload while the real fault is the credential.
    // Re-label it as the auth failure it is; every other 4xx passes through.
    if (isCredentialRejection(response.status, errorText)) {
      return reply.code(401).send({
        error:
          "Gemini rejected the API key in GEMINI_API_KEY. Check that the key is " +
          "current and enabled for the Generative Language API. Upstream said: " +
          redactSecrets(errorText, config),
      });
    }
    return reply.code(response.status).send({ error: redactSecrets(errorText, config) });
  }

  const geminiResult = (await response.json()) as {
    choices?: Array<{
      finish_reason?: string | null;
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const choice = geminiResult.choices?.[0]?.message;
  const content = choice?.content || "";
  const toolCalls = choice?.tool_calls || [];
  const finishReason = geminiResult.choices?.[0]?.finish_reason ?? null;

  // A 200 carrying neither text nor a tool call is a failed turn wearing a
  // success status. Replayed as a `response.completed` with an empty output
  // list it reaches the operator as "the agent decided to do nothing", which
  // is indistinguishable from the model genuinely having nothing to say and
  // sends them debugging the prompt. Reasoning is the usual culprit: Gemini 3
  // models always think, thinking is billed against the same output cap, and
  // a cap set low enough can be spent before a single visible token lands.
  if (!content && toolCalls.length === 0) {
    const cap = maxCompletionTokens === null ? "the model's output cap" : `${maxCompletionTokens} tokens`;
    const detail =
      finishReason === "length"
        ? `the response hit ${cap} before producing any output. Gemini 3 models ` +
          "always spend reasoning tokens against that same cap, so raise " +
          "RUN_BUDGET_MAX_OUTPUT_TOKENS (or drop the run's max_output_tokens)."
        : `the model returned no content and no tool calls (finish_reason: ${finishReason ?? "unreported"}).`;
    return reply.code(502).send({ error: `Gemini returned an empty turn: ${detail}` });
  }

  const responseId = "resp_" + randomUUID().replace(/-/g, "");

  // Hijack response from Fastify lifecycle so it flushes immediately without waiting for timeout
  reply.hijack();
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "close");
  reply.raw.flushHeaders?.();

  let seq = 0;
  const sendEvent = (event: Record<string, unknown>) => {
    const payload = JSON.stringify(
      { ...event, sequence_number: seq++ },
      (_key, value) =>
        typeof value === "string" ? redactSecrets(value, config) : value,
    );
    reply.raw.write("data: " + payload + "\n\n");
  };

  sendEvent({
    type: "response.created",
    response: {
      id: responseId,
      object: "response",
      status: "in_progress",
      output: [],
    },
  });

  sendEvent({
    type: "response.in_progress",
    response: {
      id: responseId,
      object: "response",
      status: "in_progress",
      output: [],
    },
  });

  const outputItems: Array<Record<string, unknown>> = [];

  if (content) {
    const itemId = "msg_" + randomUUID().replace(/-/g, "");
    sendEvent({
      type: "response.output_item.added",
      output_index: outputItems.length,
      item: {
        id: itemId,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    });

    sendEvent({
      type: "response.content_part.added",
      output_index: outputItems.length,
      item_id: itemId,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [], logprobs: [] },
    });

    sendEvent({
      type: "response.output_text.delta",
      output_index: outputItems.length,
      item_id: itemId,
      content_index: 0,
      delta: content,
      logprobs: [],
    });

    sendEvent({
      type: "response.output_text.done",
      output_index: outputItems.length,
      item_id: itemId,
      content_index: 0,
      text: content,
      logprobs: [],
    });

    sendEvent({
      type: "response.content_part.done",
      output_index: outputItems.length,
      item_id: itemId,
      content_index: 0,
      part: { type: "output_text", text: content, annotations: [], logprobs: [] },
    });

    const completedMsg = {
      id: itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: content, annotations: [], logprobs: [] }],
    };
    sendEvent({
      type: "response.output_item.done",
      output_index: outputItems.length,
      item: completedMsg,
    });
    outputItems.push(completedMsg);
  }

  for (const tc of toolCalls) {
    const fcId = "fc_" + randomUUID().replace(/-/g, "");
    const callId = tc.id || "call_" + randomUUID().replace(/-/g, "");
    const fnName = tc.function.name;
    const fnArgs = tc.function.arguments || "{}";
    const extra = (tc as unknown as { extra_content?: unknown }).extra_content;
    if (extra) {
      thoughtSignatureStore.set(callId, extra);
    }

    sendEvent({
      type: "response.output_item.added",
      output_index: outputItems.length,
      item: {
        id: fcId,
        type: "function_call",
        status: "in_progress",
        call_id: callId,
        name: fnName,
        arguments: "",
      },
    });

    sendEvent({
      type: "response.function_call_arguments.delta",
      output_index: outputItems.length,
      item_id: fcId,
      delta: fnArgs,
    });

    sendEvent({
      type: "response.function_call_arguments.done",
      output_index: outputItems.length,
      item_id: fcId,
      name: fnName,
      arguments: fnArgs,
    });

    const completedFc = {
      id: fcId,
      type: "function_call",
      status: "completed",
      call_id: callId,
      name: fnName,
      arguments: fnArgs,
    };
    sendEvent({
      type: "response.output_item.done",
      output_index: outputItems.length,
      item: completedFc,
    });
    outputItems.push(completedFc);
  }

  const usage = geminiResult.usage || {};
  sendEvent({
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      status: "completed",
      output: outputItems,
      usage: {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
      },
    },
  });

  reply.raw.write("data: [DONE]\n\n");
  reply.raw.end();
}

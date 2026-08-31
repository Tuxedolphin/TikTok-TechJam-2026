import type { FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";

const thoughtSignatureStore = new Map<string, unknown>();
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 4200; // Cap pacing strictly at 14.3 RPM (under Google 15 RPM limit)

export async function handleGeminiResponsesAdapter(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
): Promise<void> {
  const body = (request.body || {}) as Record<string, unknown>;
  const apiKey = config.geminiApiKey;
  if (!apiKey) {
    return reply.code(404).send({ error: "Gemini adapter is not configured" });
  }

  let targetModel =
    typeof body.model === "string" && body.model.length > 0
      ? body.model.replace(/^google\//, "").replace(/:free$/, "")
      : config.openRouterModel || "gemini-3.5-flash-lite";
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

  const geminiPayload = {
    model: targetModel,
    messages,
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
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
    return reply.code(response.status).send({ error: errorText });
  }

  const geminiResult = (await response.json()) as {
    choices?: Array<{
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
  const responseId = "resp_" + randomUUID().replace(/-/g, "");

  // Hijack response from Fastify lifecycle so it flushes immediately without waiting for timeout
  reply.hijack();
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "close");
  reply.raw.flushHeaders?.();

  let seq = 0;
  const sendEvent = (event: Record<string, unknown>) => {
    reply.raw.write("data: " + JSON.stringify({ ...event, sequence_number: seq++ }) + "\n\n");
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

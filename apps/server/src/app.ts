import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import { handleGeminiResponsesAdapter } from "./gemini-adapter.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const sessionParams = z.object({
  id: z.string().uuid(),
  sessionId: z.string().trim().min(1).max(128),
});
const createSessionBody = z.object({
  title: z.string().trim().max(80).optional(),
}).optional();
const queryWithSession = z.object({
  sessionId: z.string().trim().min(1).max(128).optional(),
});
const approvalIdParams = z.object({ id: z.string().uuid() });
const approvalQuery = z.object({
  agentId: z.string().uuid().optional(),
  status: z.enum(["pending", "approved", "denied"]).optional(),
});
const resolveApprovalBody = z.object({
  operatorName: z.string().trim().min(1).max(80).optional(),
}).optional();



export async function createApp(
  config: AppConfig,
  service: AgentService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth" ||
      request.url.startsWith("/api/adapter/")
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/sessions", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { sessions: service.listSessions(id) };
  });

  app.post("/api/agents/:id/sessions", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = createSessionBody.parse(request.body);
    const result = await service.createSession(id, body?.title);
    return reply.code(201).send(result);
  });

  app.post("/api/agents/:id/sessions/:sessionId/select", async (request) => {
    const { id, sessionId } = sessionParams.parse(request.params);
    const agent = await service.selectSession(id, sessionId);
    return { agent };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const query = queryWithSession.parse(request.query);
    return { messages: service.getMessages(id, query.sessionId) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const query = queryWithSession.parse(request.query);
    return { runs: service.getRuns(id, query.sessionId) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content);
    return reply.code(202).send(result);
  });


  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  app.get("/api/runs/:id/events", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { events: service.getRunEvents(id) };
  });

  app.get("/api/approvals", async (request) => {
    const query = approvalQuery.parse(request.query);
    return { approvals: service.listApprovals(query.agentId, query.status) };
  });

  app.get("/api/approvals/:id", async (request) => {
    const { id } = approvalIdParams.parse(request.params);
    return { approval: service.getApproval(id) };
  });

  app.post("/api/approvals/:id/approve", async (request) => {
    const { id } = approvalIdParams.parse(request.params);
    const body = resolveApprovalBody.parse(request.body);
    const approval = await service.resolveApproval(id, "approved", body?.operatorName);
    return { approval };
  });

  app.post("/api/approvals/:id/deny", async (request) => {
    const { id } = approvalIdParams.parse(request.params);
    const body = resolveApprovalBody.parse(request.body);
    const approval = await service.resolveApproval(id, "denied", body?.operatorName);
    return { approval };
  });

  app.post("/api/adapter/responses", async (request, reply) => {
    await handleGeminiResponsesAdapter(request, reply, config);
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}

import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { ApprovalActor } from "./types.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import { handleGeminiResponsesAdapter } from "./gemini-adapter.js";
import type { IdentityService } from "./identity.js";
import type { EgressAuthorizer } from "./egress-authorizer.js";
import type { EgressNetworkManager } from "./egress-network.js";

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
const resolveApprovalBody = z.object({}).strict().optional();
const mockPrincipalSessionBody = z.object({
  principalId: z.string().trim().min(1).max(128),
}).strict();
const grantBody = z.object({
  principalId: z.string().min(1).max(128),
  scope: z.enum(["resource:read", "resource:write", "network:egress"]),
  target: z.string().min(1).max(256),
  ttlMinutes: z.number().int().positive().max(10_080).nullish(),
});
const grantQuery = z.object({ principalId: z.string().min(1).max(128).optional() });
const grantIdParams = z.object({ id: z.string().uuid() });
const egressProbeBody = z.object({
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.-]+$/, "host must be a bare hostname"),
});
const egressAuthorizeBody = z.object({
  agentPrincipalId: z.string().min(1).max(128),
  host: z.string().min(1).max(253),
  port: z.coerce.number().int().min(1).max(65535),
  method: z.string().min(1).max(16),
  secret: z.string().max(256).optional(),
});
const resourceIdParams = z.object({ id: z.string().min(1).max(128) });
const MOCK_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_MOCK_SESSIONS = 1_000;

interface MockPrincipalSession {
  actor: ApprovalActor;
  expiresAt: number;
}

function sessionActor(
  sessionHeader: string | string[] | undefined,
  sessions: Map<string, MockPrincipalSession>,
): ApprovalActor {
  const sessionToken = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
  const session = sessionToken ? sessions.get(sessionToken) : undefined;
  if (!session || session.expiresAt <= Date.now()) {
    if (sessionToken) sessions.delete(sessionToken);
    throw new HttpError(401, "A valid mock principal session is required");
  }
  return session.actor;
}

export async function createApp(
  config: AppConfig,
  service: AgentService,
  identity?: IdentityService,
  egressAuthorizer?: EgressAuthorizer,
  egressNetwork?: EgressNetworkManager,
): Promise<FastifyInstance> {
  const principalSessions = new Map<string, MockPrincipalSession>();
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

  app.post("/api/mock-principal-session", async (request, reply) => {
    if (!identity) {
      throw new HttpError(503, "Mock identity service is unavailable");
    }
    const { principalId } = mockPrincipalSessionBody.parse(request.body);
    const principal = identity.listPrincipals().find((candidate) => candidate.id === principalId);
    if (!principal) {
      throw new HttpError(404, "Unknown mock principal");
    }
    if (principal.kind !== "human") {
      throw new HttpError(403, "Only human principals may start mock sessions");
    }
    const timestamp = Date.now();
    for (const [token, session] of principalSessions) {
      if (session.expiresAt <= timestamp) principalSessions.delete(token);
    }
    while (principalSessions.size >= MAX_MOCK_SESSIONS) {
      const oldestToken = principalSessions.keys().next().value as string | undefined;
      if (!oldestToken) break;
      principalSessions.delete(oldestToken);
    }
    const sessionToken = randomUUID();
    const actor = { principalId: principal.id, displayName: principal.name };
    const expiresAt = timestamp + MOCK_SESSION_TTL_MS;
    principalSessions.set(sessionToken, { actor, expiresAt });
    return reply.code(201).send({
      sessionToken,
      expiresAt: new Date(expiresAt).toISOString(),
      principal: actor,
    });
  });

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const actor = sessionActor(request.headers["x-mock-principal-session"], principalSessions);
    const agent = await service.createAgent(body, actor.principalId);
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
    const actor = sessionActor(request.headers["x-mock-principal-session"], principalSessions);
    const result = await service.sendMessage(id, body.content, actor);
    return reply.code(202).send(result);
  });


  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  if (egressNetwork) {
    // Stages one real outbound connection from the agent's own network
    // position so containment can be demonstrated in the product itself
    // rather than only from a terminal.
    app.post("/api/agents/:id/probe-egress", async (request) => {
      const { id } = agentIdParams.parse(request.params);
      const { host } = egressProbeBody.parse(request.body);
      const agent = service.getAgent(id);
      return egressNetwork.probeAsAgent(agent.principalId, host);
    });
  }

  app.get("/api/agents/:id/events", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { events: service.getAgentEvents(id) };
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
    resolveApprovalBody.parse(request.body);
    const actor = sessionActor(request.headers["x-mock-principal-session"], principalSessions);
    const approval = await service.resolveApproval(id, "approved", actor);
    return { approval };
  });

  app.post("/api/approvals/:id/deny", async (request) => {
    const { id } = approvalIdParams.parse(request.params);
    resolveApprovalBody.parse(request.body);
    const actor = sessionActor(request.headers["x-mock-principal-session"], principalSessions);
    const approval = await service.resolveApproval(id, "denied", actor);
    return { approval };
  });

  if (identity) {
    app.get("/api/principals", async () => ({ principals: identity.listPrincipals() }));

    app.get("/api/grants", async (request) => {
      const { principalId } = grantQuery.parse(request.query);
      return { grants: identity.listGrants(principalId) };
    });

    app.post("/api/grants", async (request, reply) => {
      const body = grantBody.parse(request.body);
      const actor = sessionActor(request.headers["x-mock-principal-session"], principalSessions);
      const grant = await identity.createGrant({
        principalId: body.principalId,
        scope: body.scope,
        target: body.target,
        ttlMinutes: body.ttlMinutes ?? null,
        grantedBy: actor.principalId,
      });
      return reply.code(201).send({ grant });
    });

    app.post("/api/grants/:id/revoke", async (request) => {
      const { id } = grantIdParams.parse(request.params);
      const actor = sessionActor(request.headers["x-mock-principal-session"], principalSessions);
      return { grant: await identity.revokeGrant(id, actor.principalId) };
    });

    app.get("/api/resources/:id", async (request, reply) => {
      const { id } = resourceIdParams.parse(request.params);
      const agentPrincipalId = request.headers["x-agent-principal-id"] as string | undefined;
      if (!agentPrincipalId) {
        return reply.code(400).send({ error: "x-agent-principal-id header required" });
      }
      const { resource, decision } = await identity.readResourceAsAgent(id, agentPrincipalId);
      if (!decision.allowed) {
        return reply.code(403).send({ error: decision.reason, decision });
      }
      return { resource, decision };
    });
  }

  if (egressAuthorizer) {
    // Called by the egress proxy sidecar for EVERY outbound connection an
    // agent container attempts. Answering slowly or failing here makes the
    // proxy fail closed, which is the safe direction.
    app.post("/api/egress/authorize", async (request) => {
      const body = egressAuthorizeBody.parse(request.body);
      const result = await egressAuthorizer.authorize(body);
      return {
        allowed: result.allowed,
        ruleId: result.ruleId,
        reason: result.reason,
        allowPrivate: result.allowPrivate === true,
      };
    });
  }

  app.post("/api/adapter/responses", async (request, reply) => {
    await handleGeminiResponsesAdapter(request, reply, config);
  });

  // Docker Compose development still serves the built UI; only authentication
  // behavior differs from production.
  if (config.nodeEnv !== "test") {
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

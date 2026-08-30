import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";

/**
 * Verdict returned by the authorizer for one outbound connection attempt.
 * `ruleId` and `reason` travel back to the agent in the denial body so a
 * blocked command explains itself in the container's own output.
 */
export interface EgressVerdict {
  allowed: boolean;
  ruleId: string;
  reason: string;
}

export type EgressAuthorizer = (input: {
  agentPrincipalId: string;
  host: string;
  port: number;
  method: string;
  secret: string;
}) => Promise<EgressVerdict>;

export interface EgressProxyOptions {
  authorize: EgressAuthorizer;
  /** Called for every verdict so the caller can log; must never throw. */
  onVerdict?: (input: { agentPrincipalId: string; host: string; verdict: EgressVerdict }) => void;
}

/**
 * Splits an authority (`host:port`, `[::1]:443`) into its parts. Ports default
 * per scheme because a proxied plain-HTTP request may omit one entirely.
 */
export function parseAuthority(authority: string, defaultPort: number): { host: string; port: number } {
  const trimmed = authority.trim();
  const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(trimmed);
  if (bracketed) {
    return { host: bracketed[1] ?? "", port: bracketed[2] ? Number(bracketed[2]) : defaultPort };
  }
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) return { host: trimmed, port: defaultPort };
  const port = Number(trimmed.slice(lastColon + 1));
  if (!Number.isInteger(port)) return { host: trimmed, port: defaultPort };
  return { host: trimmed.slice(0, lastColon), port };
}

/**
 * Resolves the principal a proxied request is acting as. Identity travels as
 * proxy-auth credentials so one proxy can serve every agent container: the
 * username is the agent's principal id.
 */
export function principalFromProxyAuth(
  header: string | undefined,
): { principalId: string; secret: string } | null {
  if (!header) return null;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  const username = separator === -1 ? decoded : decoded.slice(0, separator);
  const secret = separator === -1 ? "" : decoded.slice(separator + 1);
  return username.length > 0 ? { principalId: decodeURIComponent(username), secret } : null;
}

const DENIED_BODY = (verdict: EgressVerdict, host: string): string =>
  JSON.stringify(
    {
      error: "egress_denied",
      host,
      ruleId: verdict.ruleId,
      reason: verdict.reason,
    },
    null,
    2,
  ) + "\n";

/**
 * A default-deny forward proxy. Every request and every CONNECT tunnel is
 * authorized before a byte leaves; there is no cached decision, so revoking a
 * grant takes effect on the agent's very next connection.
 */
export function createEgressProxy(options: EgressProxyOptions): Server {
  const server = createServer();

  const decide = async (
    caller: { principalId: string; secret: string } | null,
    host: string,
    port: number,
    method: string,
  ): Promise<EgressVerdict> => {
    if (!caller) {
      return {
        allowed: false,
        ruleId: "NET-EGRESS-NOAUTH-022",
        reason: "No agent principal presented; default-deny.",
      };
    }
    try {
      const verdict = await options.authorize({
        agentPrincipalId: caller.principalId,
        host,
        port,
        method,
        secret: caller.secret,
      });
      options.onVerdict?.({ agentPrincipalId: caller.principalId, host, verdict });
      return verdict;
    } catch (error) {
      // An authorizer that cannot answer must fail closed, never open.
      return {
        allowed: false,
        ruleId: "NET-EGRESS-020",
        reason:
          "Egress authorizer unavailable, failing closed: " +
          (error instanceof Error ? error.message : String(error)),
      };
    }
  };

  // Plain HTTP: the absolute-form request URI carries the target.
  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const target = new URL(
        request.url?.startsWith("http") ? request.url : `http://${request.headers.host ?? ""}`,
      );
      const port = target.port ? Number(target.port) : 80;
      const principal = principalFromProxyAuth(request.headers["proxy-authorization"]);
      const verdict = await decide(principal, target.hostname, port, request.method ?? "GET");

      if (!verdict.allowed) {
        const unauthenticated = verdict.ruleId === "NET-EGRESS-NOAUTH-022";
        response.writeHead(unauthenticated ? 407 : 403, {
          "content-type": "application/json",
          ...(unauthenticated
            ? { "proxy-authenticate": 'Basic realm="agent-passport"' }
            : {}),
        });
        response.end(DENIED_BODY(verdict, target.hostname));
        return;
      }

      const headers = { ...request.headers };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];

      const upstream = httpRequest(
        {
          host: target.hostname,
          port,
          method: request.method ?? "GET",
          path: target.pathname + target.search,
          headers,
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
        response.end("upstream error\n");
      });
      request.pipe(upstream);
    })();
  });

  // HTTPS and any other TCP protocol arrives as CONNECT. Only the hostname is
  // visible here — never the path — so authorization is host-scoped.
  server.on("connect", (request: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    void (async () => {
      const { host, port } = parseAuthority(request.url ?? "", 443);
      const principal = principalFromProxyAuth(request.headers["proxy-authorization"]);
      const verdict = await decide(principal, host, port, "CONNECT");

      if (!verdict.allowed) {
        const body = DENIED_BODY(verdict, host);
        clientSocket.write(
          "HTTP/1.1 403 Forbidden\r\n" +
            "content-type: application/json\r\n" +
            `content-length: ${Buffer.byteLength(body)}\r\n` +
            "\r\n" +
            body,
        );
        clientSocket.end();
        return;
      }

      const upstream = connect(port, host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => clientSocket.end());
      clientSocket.on("error", () => upstream.destroy());
    })();
  });

  return server;
}

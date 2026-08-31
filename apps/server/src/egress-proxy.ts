import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * Verdict returned by the authorizer for one outbound connection attempt.
 * `ruleId` and `reason` travel back to the agent in the denial body so a
 * blocked command explains itself in the container's own output.
 */
export interface EgressVerdict {
  allowed: boolean;
  ruleId: string;
  reason: string;
  /**
   * Set for platform endpoints (the model adapter on the host) whose addresses
   * are legitimately private. Without it the private-address guard would refuse
   * the very callback the agent needs in order to think.
   */
  allowPrivate?: boolean;
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
  /**
   * Stamps the authenticated agent identity onto forwarded requests. Because
   * the agent has no route off-box except this proxy, a header applied here
   * cannot be omitted or forged by the agent -- the containment topology is
   * what makes the attestation trustworthy.
   */
  attest?: (agentPrincipalId: string) => Record<string, string>;
  /** Called for every verdict so the caller can log; must never throw. */
  onVerdict?: (input: { agentPrincipalId: string; host: string; verdict: EgressVerdict }) => void;
  /** Idle/connect timeout for upstream connections. */
  connectTimeoutMs?: number;
  /** Test-only escape hatch: upstreams on loopback are otherwise refused. */
  allowPrivateAddresses?: boolean;
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

/**
 * Addresses an agent must never reach even with a grant: loopback, link-local
 * (which covers cloud metadata at 169.254.169.254), and private ranges. A
 * granted hostname could otherwise be re-pointed at an internal service after
 * the grant was issued, so the check is on the resolved address, not the name.
 */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fe80:") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p))) return false;
  const [a = 0, b = 0] = parts;
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

const privateAddressVerdict = (host: string): EgressVerdict => ({
  allowed: false,
  ruleId: "NET-EGRESS-PRIVATE-024",
  reason: `${host} resolves to a private or loopback address.`,
});

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
  const connectTimeoutMs = options.connectTimeoutMs ?? 30_000;

  /**
   * Resolves a host once and refuses private targets, then hands back the
   * literal address so the later connect() cannot land somewhere else.
   */
  const resolveTarget = async (host: string, permitPrivate = false): Promise<string | null> => {
    if (options.allowPrivateAddresses || permitPrivate) return host;
    if (isIP(host)) return isPrivateAddress(host) ? null : host;
    try {
      const { address } = await dnsLookup(host);
      return isPrivateAddress(address) ? null : address;
    } catch {
      return null;
    }
  };

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
      // Absolute-form (`GET http://host/path`) is what a proxy normally sees,
      // but origin-form (`GET /path` + Host header) is legal too; joining the
      // two keeps the path instead of silently rewriting every request to "/".
      const rawUrl = request.url ?? "/";
      const target = rawUrl.startsWith("http")
        ? new URL(rawUrl)
        : new URL(rawUrl, `http://${request.headers.host ?? ""}`);
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

      const resolved = await resolveTarget(target.hostname, verdict.allowPrivate === true);
      if (!resolved) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(DENIED_BODY(privateAddressVerdict(target.hostname), target.hostname));
        return;
      }

      const headers = { ...request.headers };
      // Never let the caller supply its own attestation; only this proxy may.
      for (const forged of Object.keys(headers)) {
        if (forged.toLowerCase().startsWith("x-agent-attested")) delete headers[forged];
      }
      Object.assign(headers, principal ? (options.attest?.(principal.principalId) ?? {}) : {});
      // Hop-by-hop headers are meaningful only on the agent->proxy leg.
      for (const hop of [
        "proxy-authorization",
        "proxy-connection",
        "connection",
        "keep-alive",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
      ]) {
        delete headers[hop];
      }
      headers.host = target.host;

      const upstream = httpRequest(
        {
          host: resolved,
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
      upstream.setTimeout(connectTimeoutMs, () => upstream.destroy());
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
        response.end("upstream error\n");
      });
      // A client that vanishes mid-body must not strand the upstream socket.
      request.on("error", () => upstream.destroy());
      request.pipe(upstream);
    })();
  });

  // HTTPS and any other TCP protocol arrives as CONNECT. Only the hostname is
  // visible here — never the path — so authorization is host-scoped.
  /** CONNECT has no ServerResponse, so denials are written as raw bytes. */
  const denyConnect = (clientSocket: Socket, verdict: EgressVerdict, host: string): void => {
    const body = DENIED_BODY(verdict, host);
    clientSocket.write(
      "HTTP/1.1 403 Forbidden\r\n" +
        "content-type: application/json\r\n" +
        `content-length: ${Buffer.byteLength(body)}\r\n` +
        "\r\n" +
        body,
    );
    clientSocket.end();
  };

  server.on("clientError", (_err, socket) => {
    socket.destroy();
  });

  server.on("connect", (request: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    clientSocket.on("error", () => {});
    void (async () => {
      const { host, port } = parseAuthority(request.url ?? "", 443);
      const principal = principalFromProxyAuth(request.headers["proxy-authorization"]);
      const verdict = await decide(principal, host, port, "CONNECT");

      if (!verdict.allowed) {
        denyConnect(clientSocket, verdict, host);
        return;
      }

      const resolved = await resolveTarget(host, verdict.allowPrivate === true);
      if (!resolved) {
        denyConnect(clientSocket, privateAddressVerdict(host), host);
        return;
      }

      const upstream = connect(port, resolved, () => {
        upstream.setTimeout(connectTimeoutMs, () => upstream.destroy());
        clientSocket.setTimeout(connectTimeoutMs, () => clientSocket.destroy());
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

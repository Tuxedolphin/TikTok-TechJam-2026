import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { timingSafeEqual } from "node:crypto";

/** Constant-time comparison, matching how the rest of the codebase checks secrets. */
function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

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
  /**
   * The control plane, which must never be reachable through a CONNECT tunnel.
   * A tunnel is opaque -- this proxy pipes bytes without parsing them -- so a
   * request sent through one carries no attestation and would reach the
   * control plane looking like it came from a human operator.
   */
  controlPlane?: { host: string; port: number };
  /** Called for every verdict so the caller can log; must never throw. */
  onVerdict?: (input: { agentPrincipalId: string; host: string; verdict: EgressVerdict }) => void;
  /** Idle/connect timeout for upstream connections. */
  connectTimeoutMs?: number;
  /**
   * How often an established CONNECT tunnel is re-authorized. Authorization is
   * otherwise per-connection, so a long-lived tunnel opened while a grant was
   * live keeps flowing after that grant is revoked -- revocation would only be
   * felt on the next connection. Set to 0 to disable.
   */
  reauthorizeIntervalMs?: number;
  /** Test-only escape hatch: upstreams on loopback are otherwise refused. */
  allowPrivateAddresses?: boolean;
  /**
   * Bearer token gating the in-band drain control request. When set, a
   * `POST /__egress_control/drain` carrying this token and an
   * `x-egress-principal` header drains that principal's live connections. The
   * control plane uses this during termination; agent containers never learn
   * the token.
   */
  controlToken?: string;
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
    // An IPv4-mapped address (::ffff:a.b.c.d, and its hex ::ffff:aabb:ccdd
    // form) reaches the same host as the bare IPv4. Anything less than
    // normalizing it back to v4 lets a partial prefix list leak: the previous
    // check listed ::ffff:10/192.168 but not ::ffff:172.16/12 or, worse,
    // ::ffff:169.254.169.254 -- cloud metadata behind a mapped address.
    const mapped = mappedIpv4(normalized);
    if (mapped) return isPrivateAddress(mapped);
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fe80:") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd")
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

/**
 * The dotted-quad inside an IPv6 address that actually reaches an IPv4 host:
 * the v4-mapped form (::ffff:a.b.c.d and its hex ::ffff:aabb:ccdd spelling) and
 * the deprecated v4-compatible form (::a.b.c.d). Both are decoded so one policy
 * covers every spelling -- listing prefixes by hand is what let
 * ::ffff:169.254.169.254 through as "public".
 */
function mappedIpv4(normalized: string): string | null {
  const dotted = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized);
  if (dotted?.[1]) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (hex?.[1] && hex[2]) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return null;
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
/** A proxy that can also drain the connections it is piping for a principal. */
export type EgressProxyServer = Server & {
  /**
   * Destroys every connection currently piping for this principal and returns
   * how many were closed. Authorization is per-connection, so an already-
   * established tunnel keeps flowing after its grant is revoked and its agent
   * killed; termination must drain these, or an in-flight exfiltration can
   * complete after the receipt claims containment.
   */
  closePrincipalConnections(agentPrincipalId: string): number;
};

interface Closable {
  destroy(): void;
}

export function createEgressProxy(options: EgressProxyOptions): EgressProxyServer {
  const server = createServer() as EgressProxyServer;
  const connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
  const reauthorizeIntervalMs = options.reauthorizeIntervalMs ?? 15_000;

  // Live connections, indexed by the principal they were authorized for.
  const liveByPrincipal = new Map<string, Set<Closable>>();
  const track = (principalId: string, ...closables: Closable[]): void => {
    let set = liveByPrincipal.get(principalId);
    if (!set) {
      set = new Set();
      liveByPrincipal.set(principalId, set);
    }
    for (const closable of closables) {
      set.add(closable);
      const forget = () => {
        set!.delete(closable);
        if (set!.size === 0) liveByPrincipal.delete(principalId);
      };
      // ClientRequest / ServerResponse / Socket all emit "close".
      (closable as unknown as { once(event: string, cb: () => void): void }).once("close", forget);
    }
  };

  server.closePrincipalConnections = (agentPrincipalId: string): number => {
    const set = liveByPrincipal.get(agentPrincipalId);
    if (!set) return 0;
    let closed = 0;
    for (const closable of [...set]) {
      try {
        closable.destroy();
        closed += 1;
      } catch {
        // Already gone; the "close" handler will have removed it.
      }
    }
    liveByPrincipal.delete(agentPrincipalId);
    return closed;
  };

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
      // In-band control channel: the control plane asks the proxy to drain a
      // terminated principal's live connections. Origin-form path, bearer
      // token, no forwarding. A wrong or missing token is a 404 so the endpoint
      // is invisible to an agent probing for it.
      if (request.url === "/__egress_control/drain" && request.method === "POST") {
        const presented = (request.headers["x-egress-control-token"] as string | undefined) ?? "";
        const principalId = (request.headers["x-egress-principal"] as string | undefined) ?? "";
        if (!options.controlToken || !secretsMatch(presented, options.controlToken)) {
          response.writeHead(404).end();
          return;
        }
        const closed = server.closePrincipalConnections(principalId);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ closed }));
        return;
      }
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
      // Registered so termination can drain an in-flight request for a
      // principal whose authority was just revoked.
      if (principal) track(principal.principalId, upstream, response);
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

      // Refuse to tunnel to the control plane: attestation cannot be applied
      // to bytes this proxy never parses, and an unattested request there
      // would be indistinguishable from a human operator's.
      if (
        options.controlPlane &&
        host === options.controlPlane.host &&
        port === options.controlPlane.port
      ) {
        denyConnect(
          clientSocket,
          {
            allowed: false,
            ruleId: "NET-EGRESS-TUNNEL-025",
            reason:
              "The control plane cannot be reached through a tunnel; use a proxied request so it can be attributed to this agent.",
          },
          host,
        );
        return;
      }

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
        if (principal) track(principal.principalId, clientSocket, upstream);

        // Keep asking. A tunnel authorized once would otherwise outlive the
        // grant that opened it -- revocation felt only on the next connection,
        // which for a long-lived stream may be never. Re-checking on a timer
        // makes revocation bite mid-flight, and a re-check that throws tears
        // the tunnel down (fail closed), matching the initial decision.
        if (principal && reauthorizeIntervalMs > 0) {
          const recheck = setInterval(() => {
            void (async () => {
              const current = await decide(principal, host, port, "CONNECT");
              if (!current.allowed) {
                options.onVerdict?.({
                  agentPrincipalId: principal.principalId,
                  host,
                  verdict: current,
                });
                upstream.destroy();
                clientSocket.destroy();
              }
            })();
          }, reauthorizeIntervalMs);
          recheck.unref();
          const stopRecheck = () => clearInterval(recheck);
          upstream.once("close", stopRecheck);
          clientSocket.once("close", stopRecheck);
        }
      });
      // Tear the tunnel down fully when either end goes, on clean close as well
      // as error. Handling only "error" left a half-open tunnel able to keep
      // flushing upstream bytes after the agent's own socket had closed.
      upstream.on("error", () => clientSocket.destroy());
      upstream.on("close", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
      clientSocket.on("close", () => upstream.destroy());
    })();
  });

  return server;
}

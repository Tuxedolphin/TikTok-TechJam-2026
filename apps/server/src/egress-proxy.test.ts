import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import { connect as netConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEgressProxy,
  isPrivateAddress,
  parseAuthority,
  principalFromProxyAuth,
} from "./egress-proxy.js";
import type { EgressVerdict } from "./egress-proxy.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  return address.port;
}

/** Upstream the proxy is asked to reach; stands in for the public internet. */
async function startUpstream(): Promise<number> {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("upstream-payload");
  });
  return listen(upstream);
}

function proxyFetch(
  proxyPort: number,
  targetUrl: string,
  principal: string | null,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: new URL(targetUrl).host };
    if (principal) {
      headers["proxy-authorization"] =
        "Basic " + Buffer.from(`${principal}:token`).toString("base64");
    }
    const proxied = httpRequest(
      { host: "127.0.0.1", port: proxyPort, method: "GET", path: targetUrl, headers },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    proxied.on("error", reject);
    proxied.end();
  });
}

const allow: EgressVerdict = { allowed: true, ruleId: "NET-EGRESS-020", reason: "granted" };
const deny: EgressVerdict = { allowed: false, ruleId: "NET-EGRESS-020", reason: "no grant" };

describe("parseAuthority", () => {
  it("splits host and port", () => {
    expect(parseAuthority("example.com:8443", 443)).toEqual({ host: "example.com", port: 8443 });
  });
  it("defaults the port when absent", () => {
    expect(parseAuthority("example.com", 443)).toEqual({ host: "example.com", port: 443 });
  });
  it("handles bracketed IPv6 authorities", () => {
    expect(parseAuthority("[::1]:9000", 443)).toEqual({ host: "::1", port: 9000 });
  });
});

describe("principalFromProxyAuth", () => {
  it("reads the principal and its secret from basic auth", () => {
    const header = "Basic " + Buffer.from("agent-42:s3cret").toString("base64");
    expect(principalFromProxyAuth(header)).toEqual({ principalId: "agent-42", secret: "s3cret" });
  });
  it("url-decodes the principal so encoded ids survive the round trip", () => {
    const header = "Basic " + Buffer.from("agent%2D7:s3cret").toString("base64");
    expect(principalFromProxyAuth(header)?.principalId).toBe("agent-7");
  });
  it("returns null when the header is absent or carries no principal", () => {
    expect(principalFromProxyAuth(undefined)).toBeNull();
    expect(principalFromProxyAuth("Basic " + Buffer.from(":secret").toString("base64"))).toBeNull();
  });
});

describe("isPrivateAddress", () => {
  it("flags loopback, private ranges, and cloud metadata", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });
  it("permits public addresses", () => {
    for (const address of ["93.184.216.34", "8.8.8.8", "172.32.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
  it("sees through IPv4-mapped IPv6 to the private range behind it", () => {
    // A mapped address reaches the same host as the bare IPv4. Missing one of
    // these was a metadata-server SSRF: ::ffff:169.254.169.254 read as public.
    for (const address of [
      "::ffff:172.16.0.1",
      "::ffff:169.254.169.254",
      "::ffff:10.0.0.1",
      "::ffff:192.168.1.1",
      "::ffff:a9fe:a9fe", // hex form of 169.254.169.254
      "::169.254.169.254", // deprecated IPv4-compatible form
      "::127.0.0.1",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });
});

function drainRequest(
  proxyPort: number,
  principal: string,
  token: string | null,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "x-egress-principal": principal };
    if (token) headers["x-egress-control-token"] = token;
    const req = httpRequest(
      { host: "127.0.0.1", port: proxyPort, method: "POST", path: "/__egress_control/drain", headers },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("egress proxy drain", () => {
  it("closes a principal's in-flight connection on demand", async () => {
    // An upstream that accepts the connection but never answers, standing in
    // for a slow transfer already past authorization.
    const stuck = createServer(() => {});
    const upstreamPort = await listen(stuck);
    const proxy = createEgressProxy({ authorize: async () => allow, allowPrivateAddresses: true });
    const proxyPort = await listen(proxy);

    // Fire a proxied request and leave it hanging.
    const pending = proxyFetch(proxyPort, `http://127.0.0.1:${upstreamPort}/`, "agent-1").catch(
      (error) => ({ status: -1, body: String(error) }),
    );
    // Give the proxy a moment to open and register the upstream connection.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const closed = proxy.closePrincipalConnections("agent-1");
    expect(closed).toBeGreaterThanOrEqual(1);
    // A different principal has nothing to close.
    expect(proxy.closePrincipalConnections("agent-2")).toBe(0);
    // The hung request resolves once its upstream is destroyed.
    await pending;
  });

  it("cancels authorization that was already in flight when draining", async () => {
    let releaseAuthorization!: () => void;
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    let authorizationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      authorizationStarted = resolve;
    });
    const proxy = createEgressProxy({
      allowPrivateAddresses: true,
      authorize: async () => {
        authorizationStarted();
        await authorizationGate;
        return allow;
      },
    });
    const proxyPort = await listen(proxy);
    const outcome = proxyFetch(proxyPort, "http://127.0.0.1:9/", "agent-1")
      .then((result) => result.status)
      .catch(() => -1);

    await started;
    expect(proxy.closePrincipalConnections("agent-1")).toBeGreaterThanOrEqual(1);
    releaseAuthorization();
    await expect(outcome).resolves.not.toBe(200);
  });

  it("gates the drain control endpoint on the control token", async () => {
    const proxy = createEgressProxy({ authorize: async () => allow, controlToken: "s3cr3t" });
    const proxyPort = await listen(proxy);

    const noToken = await drainRequest(proxyPort, "agent-1", null);
    expect(noToken.status).toBe(404); // invisible without the token

    const wrongToken = await drainRequest(proxyPort, "agent-1", "guess");
    expect(wrongToken.status).toBe(404);

    const authorized = await drainRequest(proxyPort, "agent-1", "s3cr3t");
    expect(authorized.status).toBe(200);
    expect(JSON.parse(authorized.body)).toEqual({ closed: 0 });
  });
});

describe("egress proxy", () => {
  it("refuses a granted host that resolves to a private address", async () => {
    // Authorization says yes; the address guard still refuses, which is what
    // stops a granted domain being re-pointed at an internal service.
    const proxyPort = await listen(createEgressProxy({ authorize: async () => allow }));
    const result = await proxyFetch(proxyPort, "http://127.0.0.1:9/", "agent-1");
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body).ruleId).toBe("NET-EGRESS-PRIVATE-024");
  });

  it("lets a platform verdict reach a private address so the model stays reachable", async () => {
    // The model adapter runs on the host, whose address is private. If the
    // private-address guard refused it, every agent would lose the ability to
    // think the moment enforcement was switched on.
    const upstreamPort = await startUpstream();
    const proxyPort = await listen(
      createEgressProxy({
        authorize: async () => ({
          allowed: true,
          ruleId: "NET-EGRESS-PLATFORM-021",
          reason: "platform endpoint",
          allowPrivate: true,
        }),
      }),
    );
    const result = await proxyFetch(proxyPort, `http://127.0.0.1:${upstreamPort}/`, "agent-1");
    expect(result.status).toBe(200);
    expect(result.body).toBe("upstream-payload");
  });

  it("still refuses a private address when the verdict is not a platform one", async () => {
    const upstreamPort = await startUpstream();
    const proxyPort = await listen(createEgressProxy({ authorize: async () => allow }));
    const result = await proxyFetch(proxyPort, `http://127.0.0.1:${upstreamPort}/`, "agent-1");
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body).ruleId).toBe("NET-EGRESS-PRIVATE-024");
  });

  it("refuses to tunnel to the control plane", async () => {
    // A CONNECT tunnel is opaque: the proxy pipes bytes without parsing them,
    // so nothing can be attested. Allowing one to the control plane would let
    // an agent's request arrive looking like a human operator's.
    const proxyPort = await listen(
      createEgressProxy({
        allowPrivateAddresses: true,
        controlPlane: { host: "control.internal", port: 3000 },
        authorize: async () => allow,
      }),
    );
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: "control.internal:3000",
        headers: {
          "proxy-authorization": "Basic " + Buffer.from("agent-1:token").toString("base64"),
        },
      });
      request.on("connect", (response) => resolve(response.statusCode ?? 0));
      request.on("response", (response) => resolve(response.statusCode ?? 0));
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(403);
  });

  it("still tunnels to ordinary hosts", async () => {
    const proxyPort = await listen(
      createEgressProxy({
        allowPrivateAddresses: true,
        controlPlane: { host: "control.internal", port: 3000 },
        authorize: async () => allow,
      }),
    );
    // A different port on the same host is not the control plane.
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: "control.internal:9999",
        headers: {
          "proxy-authorization": "Basic " + Buffer.from("agent-1:token").toString("base64"),
        },
      });
      request.on("connect", (response) => resolve(response.statusCode ?? 0));
      request.on("response", (response) => resolve(response.statusCode ?? 0));
      request.on("error", () => resolve(-1)); // upstream unreachable, but not refused by policy
      request.end();
    });
    expect(status).not.toBe(403);
  });

  it("stamps attestation and strips any the caller supplied", async () => {
    const seen: Record<string, string | string[] | undefined> = {};
    const upstream = createServer((request, response) => {
      Object.assign(seen, request.headers);
      response.writeHead(200);
      response.end("ok");
    });
    const upstreamPort = await listen(upstream);
    const proxyPort = await listen(
      createEgressProxy({
        allowPrivateAddresses: true,
        authorize: async () => allow,
        attest: () => ({ "x-agent-attested-principal": "agent-real" }),
      }),
    );
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1", port: proxyPort, method: "GET",
          path: `http://127.0.0.1:${upstreamPort}/`,
          headers: {
            host: `127.0.0.1:${upstreamPort}`,
            "x-agent-attested-principal": "agent-forged",
            "proxy-authorization": "Basic " + Buffer.from("agent-1:token").toString("base64"),
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve());
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(seen["x-agent-attested-principal"]).toBe("agent-real");
  });

  it("preserves the request path for origin-form requests", async () => {
    const paths: string[] = [];
    const upstream = createServer((request, response) => {
      paths.push(request.url ?? "");
      response.writeHead(200);
      response.end("ok");
    });
    const upstreamPort = await listen(upstream);
    const proxyPort = await listen(
      createEgressProxy({ allowPrivateAddresses: true, authorize: async () => allow }),
    );
    await new Promise<void>((resolve, reject) => {
      const proxied = httpRequest(
        {
          host: "127.0.0.1",
          port: proxyPort,
          method: "GET",
          path: "/deep/path?q=1",
          headers: {
            host: `127.0.0.1:${upstreamPort}`,
            "proxy-authorization": "Basic " + Buffer.from("agent-1:token").toString("base64"),
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve());
        },
      );
      proxied.on("error", reject);
      proxied.end();
    });
    expect(paths).toEqual(["/deep/path?q=1"]);
  });

  it("forwards a request the authorizer allows", async () => {
    const upstreamPort = await startUpstream();
    const proxyPort = await listen(createEgressProxy({ allowPrivateAddresses: true, authorize: async () => allow }));
    const result = await proxyFetch(
      proxyPort,
      `http://127.0.0.1:${upstreamPort}/data`,
      "agent-1",
    );
    expect(result.status).toBe(200);
    expect(result.body).toBe("upstream-payload");
  });

  it("blocks a request the authorizer denies and explains why", async () => {
    const upstreamPort = await startUpstream();
    const proxyPort = await listen(createEgressProxy({ allowPrivateAddresses: true, authorize: async () => deny }));
    const result = await proxyFetch(
      proxyPort,
      `http://127.0.0.1:${upstreamPort}/data`,
      "agent-1",
    );
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toMatchObject({
      error: "egress_denied",
      ruleId: "NET-EGRESS-020",
    });
    expect(result.body).not.toContain("upstream-payload");
  });

  it("challenges for credentials when no principal is presented", async () => {
    const upstreamPort = await startUpstream();
    let authorizeCalls = 0;
    const proxyPort = await listen(
      createEgressProxy({
        allowPrivateAddresses: true,
        authorize: async () => {
          authorizeCalls += 1;
          return allow;
        },
      }),
    );
    const result = await proxyFetch(proxyPort, `http://127.0.0.1:${upstreamPort}/data`, null);
    // 407 invites a credentialed retry; the connection is still refused and the
    // authorizer is never consulted for an anonymous caller.
    expect(result.status).toBe(407);
    expect(authorizeCalls).toBe(0);
    expect(result.body).not.toContain("upstream-payload");
  });

  it("fails closed when the authorizer throws", async () => {
    const upstreamPort = await startUpstream();
    const proxyPort = await listen(
      createEgressProxy({
        allowPrivateAddresses: true,
        authorize: async () => {
          throw new Error("grants store unreachable");
        },
      }),
    );
    const result = await proxyFetch(
      proxyPort,
      `http://127.0.0.1:${upstreamPort}/data`,
      "agent-1",
    );
    expect(result.status).toBe(403);
    expect(result.body).toContain("failing closed");
  });

  it("re-authorizes every request so revocation bites immediately", async () => {
    const upstreamPort = await startUpstream();
    let granted = true;
    const proxyPort = await listen(
      createEgressProxy({ allowPrivateAddresses: true, authorize: async () => (granted ? allow : deny) }),
    );
    const before = await proxyFetch(proxyPort, `http://127.0.0.1:${upstreamPort}/`, "agent-1");
    expect(before.status).toBe(200);

    granted = false; // the operator revokes mid-run
    const after = await proxyFetch(proxyPort, `http://127.0.0.1:${upstreamPort}/`, "agent-1");
    expect(after.status).toBe(403);
  });

  it("authorizes each host independently", async () => {
    const upstreamPort = await startUpstream();
    const seen: string[] = [];
    const proxyPort = await listen(
      createEgressProxy({
        allowPrivateAddresses: true,
        authorize: async ({ host }) => {
          seen.push(host);
          return host === "127.0.0.1" ? allow : deny;
        },
      }),
    );
    await proxyFetch(proxyPort, `http://127.0.0.1:${upstreamPort}/`, "agent-1");
    const blocked = await proxyFetch(proxyPort, "http://attacker.example/", "agent-1");
    expect(blocked.status).toBe(403);
    expect(seen).toEqual(["127.0.0.1", "attacker.example"]);
  });

  it("tears down an established tunnel when its grant is revoked", async () => {
    // The finding this closes: a tunnel authorized once kept flowing after the
    // grant was revoked, because authorization was per-connection only.
    let allowed = true;
    const upstreamPort = await listen(createServer(() => {}));
    const proxy = createEgressProxy({
      authorize: async () => (allowed ? allow : deny),
      allowPrivateAddresses: true,
      reauthorizeIntervalMs: 50,
    });
    const proxyPort = await listen(proxy);

    const client = netConnect(proxyPort, "127.0.0.1");
    await once(client, "connect");
    client.write(
      `CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\n` +
        `Proxy-Authorization: Basic ${Buffer.from("agent-1:token").toString("base64")}\r\n\r\n`,
    );
    const [established] = await once(client, "data");
    expect(String(established)).toContain("200 Connection Established");

    // Still open while the grant stands.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(client.destroyed).toBe(false);

    // Revoke: the next re-check must close the live tunnel.
    allowed = false;
    await once(client, "close");
    expect(client.destroyed).toBe(true);
  });
});

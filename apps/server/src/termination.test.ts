import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  receiptKeyId,
  signReceipt,
  verifyReceipt,
  type TerminationReceipt,
  type UnsignedReceipt,
} from "./termination.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();
const KEY_ID = receiptKeyId(PUBLIC_KEY);

function receipt(over: Partial<UnsignedReceipt> = {}): TerminationReceipt {
  const body: UnsignedReceipt = {
    version: 2,
    keyId: KEY_ID,
    agentId: "agent-1",
    agentPrincipalId: "agent-agent-1",
    reason: "Operator terminated the agent",
    issuedAt: "2026-08-31T00:00:00.000Z",
    steps: [
      { step: "freeze", ok: true, detail: "container paused", at: "2026-08-31T00:00:00.000Z" },
      { step: "revoke", ok: true, detail: "2 grants revoked", at: "2026-08-31T00:00:01.000Z" },
      { step: "kill", ok: true, detail: "container removed", at: "2026-08-31T00:00:02.000Z" },
      { step: "verify", ok: true, detail: "no route off-box", at: "2026-08-31T00:00:03.000Z" },
    ],
    grantsRevoked: ["grant-a", "grant-b"],
    memoriesQuarantined: ["memory-a"],
    contained: true,
    ...over,
  };
  return { ...body, signature: signReceipt(body, PRIVATE_KEY) };
}

describe("canonicalize", () => {
  it("produces the same bytes regardless of key order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });
  it("preserves array order, which is meaningful", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });
});

describe("verifyReceipt", () => {
  it("accepts a receipt signed with the same key", () => {
    expect(verifyReceipt(receipt(), PUBLIC_KEY)).toMatchObject({ valid: true });
  });

  it("rejects a receipt signed with a different key", () => {
    const other = generateKeyPairSync("ed25519").publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    expect(verifyReceipt(receipt(), other).valid).toBe(false);
  });

  it("rejects a receipt whose body was edited after signing", () => {
    const tampered = receipt();
    tampered.reason = "Something else entirely";
    expect(verifyReceipt(tampered, PUBLIC_KEY)).toMatchObject({
      valid: false,
      reason: expect.stringContaining("Signature"),
    });
  });

  it("rejects a forged containment claim", () => {
    const { signature: _ignored, ...base } = receipt();
    const body: UnsignedReceipt = {
      ...base,
      contained: true,
      steps: [
        { step: "freeze", ok: true, detail: "paused", at: "2026-08-31T00:00:00.000Z" },
        { step: "revoke", ok: true, detail: "revoked", at: "2026-08-31T00:00:01.000Z" },
        { step: "kill", ok: true, detail: "killed", at: "2026-08-31T00:00:02.000Z" },
        { step: "verify", ok: false, detail: "route still open", at: "2026-08-31T00:00:03.000Z" },
      ],
    };
    const selfConsistent = { ...body, signature: signReceipt(body, PRIVATE_KEY) };
    expect(verifyReceipt(selfConsistent, PUBLIC_KEY)).toMatchObject({
      valid: false,
      reason: expect.stringContaining("structure"),
    });
  });

  it("accepts an honest receipt that records failure", () => {
    const { signature: _unused, ...honestBase } = receipt();
    const body: UnsignedReceipt = {
      ...honestBase,
      contained: false,
      steps: [
        { step: "freeze", ok: true, detail: "paused", at: "2026-08-31T00:00:00.000Z" },
        { step: "revoke", ok: true, detail: "revoked", at: "2026-08-31T00:00:01.000Z" },
        { step: "kill", ok: false, detail: "engine unreachable", at: "2026-08-31T00:00:02.000Z" },
        { step: "verify", ok: false, detail: "runtime remains", at: "2026-08-31T00:00:03.000Z" },
      ],
    };
    const honest = { ...body, signature: signReceipt(body, PRIVATE_KEY) };
    const result = verifyReceipt(honest, PUBLIC_KEY);
    expect(result.valid).toBe(true);
    expect(result.reason).toContain("not achieved");
  });

  it("rejects a receipt with no signature at all", () => {
    const unsigned = { ...receipt(), signature: "" };
    expect(verifyReceipt(unsigned, PUBLIC_KEY).valid).toBe(false);
  });

  it("rejects a signed receipt that omits required steps", () => {
    const { signature: _signature, ...base } = receipt();
    const body = { ...base, steps: [], contained: true } as UnsignedReceipt;
    expect(
      verifyReceipt(
        { ...body, signature: signReceipt(body, PRIVATE_KEY) },
        PUBLIC_KEY,
      ),
    ).toMatchObject({ valid: false, reason: expect.stringContaining("structure") });
  });
});

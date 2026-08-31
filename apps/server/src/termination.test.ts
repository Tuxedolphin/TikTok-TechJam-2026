import { describe, expect, it } from "vitest";
import {
  canonicalize,
  signReceipt,
  verifyReceipt,
  type TerminationReceipt,
  type UnsignedReceipt,
} from "./termination.js";

const KEY = "server-key";

function receipt(over: Partial<UnsignedReceipt> = {}): TerminationReceipt {
  const body: UnsignedReceipt = {
    version: 1,
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
    contained: true,
    ...over,
  };
  return { ...body, signature: signReceipt(body, KEY) };
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
    expect(verifyReceipt(receipt(), KEY)).toMatchObject({ valid: true });
  });

  it("rejects a receipt signed with a different key", () => {
    expect(verifyReceipt(receipt(), "other-key").valid).toBe(false);
  });

  it("rejects a receipt whose body was edited after signing", () => {
    const tampered = receipt();
    tampered.reason = "Something else entirely";
    expect(verifyReceipt(tampered, KEY)).toMatchObject({
      valid: false,
      reason: expect.stringContaining("Signature"),
    });
  });

  it("rejects a forged containment claim", () => {
    // Flipping `contained` re-signs nothing, so this is caught by the
    // signature -- but the same check must also hold for a legitimately
    // re-signed receipt whose steps contradict its claim.
    const { signature: _ignored, ...base } = receipt();
    const body: UnsignedReceipt = {
      ...base,
      contained: true,
      steps: [
        { step: "freeze", ok: true, detail: "paused", at: "2026-08-31T00:00:00.000Z" },
        { step: "verify", ok: false, detail: "route still open", at: "2026-08-31T00:00:03.000Z" },
      ],
    };
    const selfConsistent = { ...body, signature: signReceipt(body, KEY) };
    expect(verifyReceipt(selfConsistent, KEY)).toMatchObject({
      valid: false,
      reason: expect.stringContaining("claims containment"),
    });
  });

  it("accepts an honest receipt that records failure", () => {
    const { signature: _unused, ...honestBase } = receipt();
    const body: UnsignedReceipt = {
      ...honestBase,
      contained: false,
      steps: [
        { step: "freeze", ok: true, detail: "paused", at: "2026-08-31T00:00:00.000Z" },
        { step: "kill", ok: false, detail: "engine unreachable", at: "2026-08-31T00:00:02.000Z" },
      ],
    };
    const honest = { ...body, signature: signReceipt(body, KEY) };
    const result = verifyReceipt(honest, KEY);
    expect(result.valid).toBe(true);
    expect(result.reason).toContain("NOT achieved");
  });

  it("rejects a receipt with no signature at all", () => {
    const unsigned = { ...receipt(), signature: "" };
    expect(verifyReceipt(unsigned, KEY).valid).toBe(false);
  });
});

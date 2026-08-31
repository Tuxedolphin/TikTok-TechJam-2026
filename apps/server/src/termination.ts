import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Terminating an agent is four steps, in an order that matters.
 *
 * Revoking a grant only stops the *next* connection. An agent mid-request has
 * already passed the check, so revoke-then-kill leaves a window in which an
 * in-flight action completes after the operator believed it was stopped. This
 * freezes the process first, so nothing can advance through that window, and
 * only then revokes, kills, and re-probes to confirm the containment holds.
 *
 * The receipt records what was actually observed. It deliberately claims only
 * that no live route, session, or grant remains -- not that the agent's
 * effects were undone. Files it already wrote stay written.
 */

export type TerminationStepName = "freeze" | "revoke" | "kill" | "verify";

export interface TerminationStep {
  step: TerminationStepName;
  ok: boolean;
  detail: string;
  at: string;
}

export interface TerminationReceipt {
  version: 1;
  agentId: string;
  agentPrincipalId: string;
  reason: string;
  issuedAt: string;
  steps: TerminationStep[];
  grantsRevoked: string[];
  /** True only when every step succeeded and the re-probe found no route out. */
  contained: boolean;
  signature: string;
}

/** Everything the signature covers; the signature itself is excluded. */
export type UnsignedReceipt = Omit<TerminationReceipt, "signature">;

/**
 * Canonical JSON so a verifier reproduces the exact bytes that were signed,
 * independent of key insertion order.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function signReceipt(receipt: UnsignedReceipt, key: string): string {
  return createHmac("sha256", key).update(canonicalize(receipt)).digest("hex");
}

/**
 * Recomputes the signature over the receipt's own contents. A receipt whose
 * body was edited after issue -- to claim containment that did not happen --
 * fails here.
 */
export function verifyReceipt(
  receipt: TerminationReceipt,
  key: string,
): { valid: boolean; reason: string } {
  const { signature, ...body } = receipt;
  const expected = signReceipt(body as UnsignedReceipt, key);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature ?? "");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "Signature does not match the receipt contents." };
  }
  const failed = receipt.steps.filter((step) => !step.ok).map((step) => step.step);
  if (receipt.contained && failed.length > 0) {
    return {
      valid: false,
      reason: `Receipt claims containment but these steps failed: ${failed.join(", ")}.`,
    };
  }
  return {
    valid: true,
    reason: receipt.contained
      ? "Signature valid. No live route, session, or grant remained at issue time."
      : "Signature valid. Receipt honestly records that containment was NOT achieved.",
  };
}

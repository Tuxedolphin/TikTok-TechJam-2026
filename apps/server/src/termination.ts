import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type TerminationStepName = "freeze" | "revoke" | "kill" | "verify";

export interface TerminationStep {
  step: TerminationStepName;
  ok: boolean;
  detail: string;
  at: string;
}

export interface TerminationReceipt {
  version: 2;
  keyId: string;
  agentId: string;
  agentPrincipalId: string;
  reason: string;
  issuedAt: string;
  steps: TerminationStep[];
  grantsRevoked: string[];
  /** Memories pulled from circulation, so a restart cannot resurrect a belief. */
  memoriesQuarantined: string[];
  /** True only when every required step succeeded. */
  contained: boolean;
  signature: string;
}

export type UnsignedReceipt = Omit<TerminationReceipt, "signature">;

export interface ReceiptKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(",")}}`;
}

export function receiptKeyId(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 16);
}

export async function loadOrCreateReceiptKeyPair(dataDirectory: string): Promise<ReceiptKeyPair> {
  const privateKeyPath = path.join(dataDirectory, "receipt-signing-private.pem");
  const publicKeyPath = path.join(dataDirectory, "receipt-signing-public.pem");
  await mkdir(dataDirectory, { recursive: true });

  try {
    const [privateKeyPem, publicKeyPem] = await Promise.all([
      readFile(privateKeyPath, "utf8"),
      readFile(publicKeyPath, "utf8"),
    ]);
    return { privateKeyPem, publicKeyPem, keyId: receiptKeyId(publicKeyPem) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  await writeFile(privateKeyPath, privateKeyPem, { encoding: "utf8", mode: 0o600 });
  await writeFile(publicKeyPath, publicKeyPem, { encoding: "utf8", mode: 0o644 });
  return { privateKeyPem, publicKeyPem, keyId: receiptKeyId(publicKeyPem) };
}

export function signReceipt(receipt: UnsignedReceipt, privateKey: string): string {
  return signBytes(null, Buffer.from(canonicalize(receipt)), privateKey).toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateReceiptStructure(value: unknown): value is TerminationReceipt {
  if (!isRecord(value)) return false;
  if (
    value.version !== 2 ||
    typeof value.keyId !== "string" ||
    typeof value.agentId !== "string" ||
    typeof value.agentPrincipalId !== "string" ||
    typeof value.reason !== "string" ||
    typeof value.issuedAt !== "string" ||
    typeof value.contained !== "boolean" ||
    typeof value.signature !== "string" ||
    !Array.isArray(value.grantsRevoked) ||
    value.grantsRevoked.some((id) => typeof id !== "string") ||
    new Set(value.grantsRevoked).size !== value.grantsRevoked.length ||
    !Array.isArray(value.memoriesQuarantined) ||
    value.memoriesQuarantined.some((id) => typeof id !== "string") ||
    new Set(value.memoriesQuarantined).size !== value.memoriesQuarantined.length ||
    !Array.isArray(value.steps) ||
    value.steps.length !== 4
  ) {
    return false;
  }

  const names = value.steps.map((step) => isRecord(step) ? step.step : null);
  const expectedSuccessOrder: TerminationStepName[] = ["freeze", "revoke", "kill", "verify"];
  const expectedFallbackOrder: TerminationStepName[] = ["freeze", "kill", "revoke", "verify"];
  const matchesOrder = (expected: TerminationStepName[]) =>
    expected.every((name, index) => names[index] === name);
  const successOrder = matchesOrder(expectedSuccessOrder);
  const fallbackOrder = matchesOrder(expectedFallbackOrder);
  if (!successOrder && !fallbackOrder) return false;

  for (const step of value.steps) {
    if (
      !isRecord(step) ||
      typeof step.step !== "string" ||
      typeof step.ok !== "boolean" ||
      typeof step.detail !== "string" ||
      typeof step.at !== "string"
    ) {
      return false;
    }
  }

  const everyStepSucceeded = value.steps.every(
    (step) => (step as Record<string, unknown>).ok === true,
  );
  if (fallbackOrder && ((value.steps[0] as Record<string, unknown>).ok !== false || value.contained)) {
    return false;
  }
  return value.contained === everyStepSucceeded;
}

export function verifyReceipt(
  receipt: unknown,
  publicKey: string,
): { valid: boolean; reason: string } {
  if (!validateReceiptStructure(receipt)) {
    return { valid: false, reason: "Receipt structure or step sequence is invalid." };
  }
  if (receipt.keyId !== receiptKeyId(publicKey)) {
    return { valid: false, reason: "Receipt key ID does not match the trusted public key." };
  }
  const { signature, ...body } = receipt;
  const validSignature = verifyBytes(
    null,
    Buffer.from(canonicalize(body)),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
  if (!validSignature) {
    return { valid: false, reason: "Signature does not match the receipt contents." };
  }
  return {
    valid: true,
    reason: receipt.contained
      ? "Signature and required termination evidence are valid."
      : "Signature is valid; the receipt records that containment was not achieved.",
  };
}

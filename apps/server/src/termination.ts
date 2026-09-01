import { constants } from "node:fs";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
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

type KeyPairState = "absent" | "partial" | "complete";

const INITIALIZATION_RETRY_MS = 10;
const INITIALIZATION_TIMEOUT_MS = 10_000;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function keyPairState(privateKeyPath: string, publicKeyPath: string): Promise<KeyPairState> {
  const [privateKeyExists, publicKeyExists] = await Promise.all([
    pathExists(privateKeyPath),
    pathExists(publicKeyPath),
  ]);
  if (!privateKeyExists && !publicKeyExists) return "absent";
  if (!privateKeyExists || !publicKeyExists) return "partial";
  return "complete";
}

async function readKeyFile(filePath: string, privateKey: boolean): Promise<string> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const file = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error(`Receipt signing key is not a regular file: ${filePath}`);

    if (privateKey) {
      const getuid = process.getuid;
      if (getuid && stats.uid !== getuid()) {
        throw new Error("Receipt signing private key is not owned by the current user.");
      }
      const mode = stats.mode & 0o7777;
      if ((mode & 0o077) !== 0 || (mode & 0o7000) !== 0) {
        await file.chmod(0o600);
      }
    }

    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

function validateReceiptKeyPair(privateKeyPem: string, publicKeyPem: string): void {
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    const publicKey = createPublicKey(publicKeyPem);
    if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Receipt signing keys must be Ed25519 keys.");
    }

    const derivedPublicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    const configuredPublicKey = publicKey.export({ type: "spki", format: "der" });
    if (!Buffer.from(derivedPublicKey).equals(Buffer.from(configuredPublicKey))) {
      throw new Error("Receipt signing private key does not correspond to the public key.");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Receipt signing private key does not correspond to the public key.") {
      throw error;
    }
    throw new Error("Receipt signing key pair is invalid or mismatched.", { cause: error });
  }
}

async function loadExistingReceiptKeyPair(
  privateKeyPath: string,
  publicKeyPath: string,
): Promise<ReceiptKeyPair> {
  const [privateKeyPem, publicKeyPem] = await Promise.all([
    readKeyFile(privateKeyPath, true),
    readKeyFile(publicKeyPath, false),
  ]);
  validateReceiptKeyPair(privateKeyPem, publicKeyPem);
  return { privateKeyPem, publicKeyPem, keyId: receiptKeyId(publicKeyPem) };
}

async function waitForInitialization(lockPath: string): Promise<void> {
  const deadline = Date.now() + INITIALIZATION_TIMEOUT_MS;
  while (await pathExists(lockPath)) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for receipt signing key initialization.");
    }
    await new Promise((resolve) => setTimeout(resolve, INITIALIZATION_RETRY_MS));
  }
}

async function acquireInitializationLock(lockPath: string): Promise<FileHandle> {
  const deadline = Date.now() + INITIALIZATION_TIMEOUT_MS;
  while (true) {
    try {
      return await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for receipt signing key initialization.");
      }
      await new Promise((resolve) => setTimeout(resolve, INITIALIZATION_RETRY_MS));
    }
  }
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function createReceiptKeyPair(
  privateKeyPath: string,
  publicKeyPath: string,
): Promise<ReceiptKeyPair> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const suffix = `${process.pid}-${randomUUID()}`;
  const privateKeyTempPath = `${privateKeyPath}.tmp-${suffix}`;
  const publicKeyTempPath = `${publicKeyPath}.tmp-${suffix}`;

  try {
    await writeFile(privateKeyTempPath, privateKeyPem, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(privateKeyTempPath, 0o600);
    await writeFile(publicKeyTempPath, publicKeyPem, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await rename(privateKeyTempPath, privateKeyPath);
    await rename(publicKeyTempPath, publicKeyPath);
    return await loadExistingReceiptKeyPair(privateKeyPath, publicKeyPath);
  } finally {
    await removeIfPresent(privateKeyTempPath);
    await removeIfPresent(publicKeyTempPath);
  }
}

export async function loadOrCreateReceiptKeyPair(dataDirectory: string): Promise<ReceiptKeyPair> {
  const privateKeyPath = path.join(dataDirectory, "receipt-signing-private.pem");
  const publicKeyPath = path.join(dataDirectory, "receipt-signing-public.pem");
  const lockPath = path.join(dataDirectory, "receipt-signing-initialization.lock");
  await mkdir(dataDirectory, { recursive: true });

  while (true) {
    const state = await keyPairState(privateKeyPath, publicKeyPath);
    if (state === "complete") {
      return loadExistingReceiptKeyPair(privateKeyPath, publicKeyPath);
    }
    if (state === "partial") {
      if (await pathExists(lockPath)) {
        await waitForInitialization(lockPath);
        continue;
      }
      throw new Error("Receipt signing key pair is incomplete; refusing to rotate trust.");
    }

    const lock = await acquireInitializationLock(lockPath);
    try {
      const lockedState = await keyPairState(privateKeyPath, publicKeyPath);
      if (lockedState === "complete") {
        return loadExistingReceiptKeyPair(privateKeyPath, publicKeyPath);
      }
      if (lockedState === "partial") {
        throw new Error("Receipt signing key pair is incomplete; refusing to rotate trust.");
      }
      return await createReceiptKeyPair(privateKeyPath, publicKeyPath);
    } finally {
      try {
        await lock.close();
      } finally {
        await removeIfPresent(lockPath);
      }
    }
  }
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

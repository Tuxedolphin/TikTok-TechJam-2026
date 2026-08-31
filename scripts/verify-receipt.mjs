#!/usr/bin/env node
// Verify a termination receipt against the public key published before issue.
//
// Usage:
//   node scripts/verify-receipt.mjs <receipt.json> --public-key <public.pem>
//   cat receipt.json | node scripts/verify-receipt.mjs --public-key <public.pem>

import { createHash, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const keyIndex = argv.indexOf("--public-key");
const keyPath = keyIndex === -1 ? null : argv[keyIndex + 1];
if (!keyPath) {
  console.error("--public-key <public.pem> is required.");
  process.exit(2);
}
const file = argv.find((argument, index) =>
  !argument.startsWith("--") && index !== keyIndex + 1
);
const publicKey = readFileSync(keyPath, "utf8");

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(",")}}`;
}

function hasValidStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  if (
    receipt.version !== 1 ||
    typeof receipt.keyId !== "string" ||
    typeof receipt.agentId !== "string" ||
    typeof receipt.agentPrincipalId !== "string" ||
    typeof receipt.reason !== "string" ||
    typeof receipt.issuedAt !== "string" ||
    typeof receipt.contained !== "boolean" ||
    typeof receipt.signature !== "string" ||
    !Array.isArray(receipt.grantsRevoked) ||
    receipt.grantsRevoked.some((id) => typeof id !== "string") ||
    new Set(receipt.grantsRevoked).size !== receipt.grantsRevoked.length ||
    !Array.isArray(receipt.steps) ||
    receipt.steps.length !== 4
  ) {
    return false;
  }

  const names = receipt.steps.map((step) => step?.step);
  const normal = ["freeze", "revoke", "kill", "verify"];
  const fallback = ["freeze", "kill", "revoke", "verify"];
  const matches = (expected) => expected.every((name, index) => names[index] === name);
  const normalOrder = matches(normal);
  const fallbackOrder = matches(fallback);
  if (!normalOrder && !fallbackOrder) return false;
  if (receipt.steps.some((step) =>
    !step ||
    typeof step.ok !== "boolean" ||
    typeof step.detail !== "string" ||
    typeof step.at !== "string"
  )) {
    return false;
  }
  if (fallbackOrder && (receipt.steps[0].ok !== false || receipt.contained)) return false;
  return receipt.contained === receipt.steps.every((step) => step.ok);
}

const raw = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
let receipt;
try {
  receipt = JSON.parse(raw);
} catch {
  console.error("Not valid JSON.");
  process.exit(2);
}
if (receipt.receipt) receipt = receipt.receipt;

if (!hasValidStructure(receipt)) {
  console.log("INVALID — receipt structure or step sequence is invalid.");
  process.exit(1);
}

const trustedKeyId = createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
if (receipt.keyId !== trustedKeyId) {
  console.log("INVALID — receipt key ID does not match the trusted public key.");
  process.exit(1);
}

const { signature, ...body } = receipt;
const signatureValid = verify(
  null,
  Buffer.from(canonicalize(body)),
  publicKey,
  Buffer.from(signature, "base64url"),
);
if (!signatureValid) {
  console.log("INVALID — the signature does not match these contents.");
  process.exit(1);
}

console.log(`Agent:      ${receipt.agentId} (${receipt.agentPrincipalId})`);
console.log(`Issued:     ${receipt.issuedAt}`);
console.log(`Key:        ${receipt.keyId}`);
console.log(`Reason:     ${receipt.reason}`);
console.log("");
for (const step of receipt.steps) {
  console.log(`  ${step.ok ? "ok  " : "FAIL"}  ${String(step.step).padEnd(7)} ${step.detail}`);
}
console.log("");
console.log(`Grants revoked: ${receipt.grantsRevoked.length}`);
console.log(
  receipt.contained
    ? "\nVALID — signature, step sequence, and containment claim are internally consistent."
    : "\nVALID — signature matches; containment was not achieved.",
);

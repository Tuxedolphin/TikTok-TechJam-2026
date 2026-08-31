#!/usr/bin/env node
// Independently verify an Agent Passport termination receipt.
//
// Run this yourself, on your own machine, against a receipt the platform
// handed you. It re-derives the signature from the receipt's own contents, so
// a receipt edited after issue -- to claim a containment that never happened
// -- fails here rather than being taken on trust.
//
// Usage:
//   node scripts/verify-receipt.mjs <receipt.json> [--key <server-key>]
//   cat receipt.json | node scripts/verify-receipt.mjs --key <server-key>
//
// The key is the platform's APP_AUTH_TOKEN (empty by default in the local POC).

import { readFileSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";

const argv = process.argv.slice(2);
const keyIndex = argv.indexOf("--key");
const key = keyIndex === -1 ? (process.env.APP_AUTH_TOKEN ?? "") : (argv[keyIndex + 1] ?? "");
const file = argv.find((arg, i) => !arg.startsWith("--") && i !== keyIndex + 1);

/** Byte-for-byte stable regardless of key order, so the signature reproduces. */
function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
    .join(",")}}`;
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

const { signature, ...body } = receipt;
const expected = createHmac("sha256", key).update(canonicalize(body)).digest("hex");
const a = Buffer.from(expected);
const b = Buffer.from(signature ?? "");
const signatureValid = a.length === b.length && timingSafeEqual(a, b);

console.log(`Agent:      ${receipt.agentId} (${receipt.agentPrincipalId})`);
console.log(`Issued:     ${receipt.issuedAt}`);
console.log(`Reason:     ${receipt.reason}`);
console.log("");
for (const step of receipt.steps ?? []) {
  console.log(`  ${step.ok ? "ok  " : "FAIL"}  ${String(step.step).padEnd(7)} ${step.detail}`);
}
console.log("");
console.log(`Grants revoked: ${(receipt.grantsRevoked ?? []).length}`);

if (!signatureValid) {
  console.log("\nINVALID — the signature does not match these contents.");
  console.log("This receipt was altered after it was issued, or signed with a different key.");
  process.exit(1);
}

const failed = (receipt.steps ?? []).filter((step) => !step.ok).map((step) => step.step);
if (receipt.contained && failed.length > 0) {
  console.log(`\nINVALID — claims containment while these steps failed: ${failed.join(", ")}.`);
  process.exit(1);
}

console.log(
  receipt.contained
    ? "\nVALID — signature matches, and every step succeeded.\nNo live route, session, or grant remained at the moment this was issued.\n(This does not claim the agent's earlier effects were undone.)"
    : "\nVALID — signature matches. The receipt honestly records that containment was NOT achieved.",
);

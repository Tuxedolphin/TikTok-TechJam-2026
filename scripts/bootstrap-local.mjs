#!/usr/bin/env node
/**
 * Prepares .env and the local state directories for the Docker Compose path.
 *
 * Node rather than bash on purpose. Compose forces NODE_ENV=production and
 * HOST=0.0.0.0, so the server refuses to start without a real APP_AUTH_TOKEN --
 * and this script is the documented way to get one. A bash-only remedy strands
 * every Windows user at that error with no way forward, since the only exit
 * from it is a file their shell cannot run.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(repoRoot, ".env");
const examplePath = path.join(repoRoot, ".env.example");

if (!existsSync(envPath)) {
  copyFileSync(examplePath, envPath);
  console.log("Created .env from .env.example.");
}

/** Mirrors the validation in apps/server/src/config.ts, so a token this script keeps is one the server accepts. */
function isUsable(token) {
  return (
    token.length >= 24 &&
    token.length <= 128 &&
    !token.startsWith("replace-") &&
    /^[A-Za-z0-9._~-]+$/.test(token)
  );
}

const input = readFileSync(envPath, "utf8");
const match = input.match(/^APP_AUTH_TOKEN=(.*)$/m);
const configured = (match?.[1] ?? "").trim().replace(/^["']|["']$/g, "");

if (isUsable(configured)) {
  console.log("Kept the valid APP_AUTH_TOKEN already configured in .env.");
} else {
  const generated = randomBytes(24).toString("base64url");
  writeFileSync(
    envPath,
    match
      ? input.replace(/^APP_AUTH_TOKEN=.*$/m, `APP_AUTH_TOKEN=${generated}`)
      : `${input.replace(/\n?$/, "\n")}APP_AUTH_TOKEN=${generated}\n`,
    { encoding: "utf8" },
  );
  console.log("Generated APP_AUTH_TOKEN in .env for the production 0.0.0.0 bind.");
}

try {
  chmodSync(envPath, 0o600);
} catch {
  // Windows has no POSIX mode bits; the file is still created with the
  // account's own ACL, which is the platform equivalent.
}

for (const directory of ["data", "workspaces", "codex-home"]) {
  mkdirSync(path.join(repoRoot, directory), { recursive: true });
}

console.log("Next:");
console.log("  1. Fill GEMINI_API_KEY, ARK_API_KEY, or OPENROUTER_API_KEY in .env");
console.log("  2. Run: docker compose up --build");

#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi

auth_status="$(node <<'NODE'
const { randomBytes } = require("node:crypto");
const { chmodSync, readFileSync, writeFileSync } = require("node:fs");

const path = ".env";
const input = readFileSync(path, "utf8");
const match = input.match(/^APP_AUTH_TOKEN=(.*)$/m);
const configured = match?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
const valid =
  configured.length >= 24 &&
  configured.length <= 128 &&
  !configured.startsWith("replace-") &&
  /^[A-Za-z0-9._~-]+$/.test(configured);

if (valid) {
  process.stdout.write("kept");
} else {
  const generated = randomBytes(24).toString("base64url");
  const output = match
    ? input.replace(/^APP_AUTH_TOKEN=.*$/m, `APP_AUTH_TOKEN=${generated}`)
    : `${input.replace(/\n?$/, "\n")}APP_AUTH_TOKEN=${generated}\n`;
  writeFileSync(path, output, { encoding: "utf8" });
  process.stdout.write("generated");
}
chmodSync(path, 0o600);
NODE
)"

if [[ "$auth_status" == "generated" ]]; then
  echo "Generated APP_AUTH_TOKEN in .env for the production 0.0.0.0 bind."
else
  echo "Kept the valid APP_AUTH_TOKEN already configured in .env."
fi

mkdir -p data workspaces codex-home

echo "Next:"
echo "  1. Fill GEMINI_API_KEY or OPENROUTER_API_KEY and OPENROUTER_MODEL in .env"
echo "  2. Run: docker compose up --build"

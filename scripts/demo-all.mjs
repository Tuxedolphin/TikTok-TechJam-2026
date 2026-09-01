// Agent Passport - every attack class, one command.
//
// The individual demos each prove one boundary. Run separately they are five
// things a reviewer has to remember; run together they are one number. This
// runs all of them, hides the request logs that would otherwise scroll the
// results off a projector, and prints a single combined tally.
//
// Exits non-zero if any invariant did not hold, so CI and a live demo fail
// the same way.
//
// Usage:  npm run demo:all

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

// Order matters: the two that need no container engine run first, so a broken
// engine still leaves you with something to show.
const DEMOS = [
  ["escalation", "Authority cannot widen itself"],
  ["passport", "Identity, grants, and revocation"],
  ["tunnel-bypass", "CONNECT tunnels to the control plane"],
  ["egress", "The network border"],
  ["kill", "Termination and the signed receipt"],
];

/** Pino writes structured request logs to stdout; they are noise on a screen. */
const isLogLine = (line) => /^\s*\{"level":\d+,"time":/.test(line);

/** Demos end with e.g. `Attenuation invariants: 10/10 held`. */
const TALLY = /^(.+?) invariants: (\d+)\/(\d+) held$/;

function run(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, `demo-${name}.mjs`)], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let tally = null;
    let buffered = "";

    const consume = (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (isLogLine(line)) continue;
        const match = TALLY.exec(line.trim());
        if (match) tally = { held: Number(match[2]), total: Number(match[3]) };
        process.stdout.write(`${line}\n`);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);

    child.on("close", (code) => {
      if (buffered && !isLogLine(buffered)) process.stdout.write(`${buffered}\n`);
      resolve({ name, code, tally });
    });
  });
}

const results = [];
for (const [name, description] of DEMOS) {
  process.stdout.write(`\n════ ${name} — ${description} ════\n`);
  results.push(await run(name));
}

const held = results.reduce((sum, r) => sum + (r.tally?.held ?? 0), 0);
const total = results.reduce((sum, r) => sum + (r.tally?.total ?? 0), 0);
const broken = results.filter((r) => r.code !== 0 || !r.tally);

process.stdout.write(`\n${"═".repeat(56)}\n`);
for (const result of results) {
  const count = result.tally ? `${result.tally.held}/${result.tally.total}` : "no tally";
  const mark = result.code === 0 && result.tally ? "ok  " : "FAIL";
  process.stdout.write(`   ${mark}  ${result.name.padEnd(16)} ${count}\n`);
}
process.stdout.write(
  `\n   ${held}/${total} invariants held across ${results.length} attack classes\n`,
);

if (broken.length > 0) {
  process.stdout.write(`\n>>> ${broken.length} demo(s) did not hold: ${broken.map((r) => r.name).join(", ")}\n`);
  process.exitCode = 1;
}

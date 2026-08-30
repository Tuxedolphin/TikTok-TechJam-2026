# WS-C: HITL Diff-Review Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an agent's `file_change` step trips the HITL approval gate, the operator reviews the actual unified diff of the pending change in the web UI — approve applies it (existing flow), deny reverts the files on disk.

**Architecture:** The server snapshots workspace file contents at run start (`diff-capture.ts`, new). When `evaluateActionRisk` demands approval for a `file_change` step, the service computes a git-style unified diff (snapshot vs. disk — Codex has already written the change by the time `item.completed` fires), stores it on the `ApprovalRequest` (`diff?: string`), and on denial restores the snapshot content before cancelling the run. The web app renders the diff inside the existing approval banner using diff components ported from `@codegraff/diffs` (Apache-2.0) into `apps/web/src/components/diffs/` — unified-diff parser, word-level (LCS) intra-line highlighting, and a collapsible files-changed list.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` on server), Node 22, Fastify 5, Vitest 4 (server tests), React 19 + Vite 7 (web, no test runner — UI verified manually per spec).

**Spec:** `docs/superpowers/specs/2026-08-30-agent-passport-design.md` (Workstream C row of the workstream table; testing requirement C).

## Global Constraints

- Baseline preserved: Agent CRUD, lifecycle, Playground, sessions, canary guardrail, budget breaker, HITL approvals, trace timeline all keep working. `npm run check` stays green.
- WS-C owns exactly: `apps/web/src/components/diffs/*` (ported), `apps/web/src/App.tsx`, server `agent-service.ts` (attach file diff to ApprovalRequest), server `types.ts` (`ApprovalRequest.diff?: string`). This plan also adds server `diff-capture.ts` (the diff logic must live somewhere focused, not inline in `agent-service.ts`) and touches `apps/web/src/types.ts` / `styles.css` / `api-adjacent` UI wiring — all inside the WS-C surface. Do NOT touch `store.ts`, `run-policies.ts`, `identity.ts`, `egress-guard.ts`, or the `Database` version (an optional field on `ApprovalRequest` needs no migration; `Database.version: 4` belongs to WS-A).
- Testing requirement C (spec, verbatim): "approval request carries diff; approve applies, deny discards (server-side tests; UI manual)". Vitest, existing patterns in `*.test.ts`.
- Server code uses NodeNext modules: relative imports need `.js` extensions. Web code uses Bundler resolution: extensionless relative imports.
- The canary token and API key must never reach stored records unredacted — pass every stored diff through `AgentService.redact` like all other approval/event text.
- Every run event uses existing `RunEventType` values — WS-C adds no new event types.

## Chosen approach for the diff UI (decision record)

The reference `github.com/justrach/codegraff` `packages/diffs` was fetched and inspected. The package is **Apache-2.0** (its `package.json` `"license": "Apache-2.0"`), dependency-free (React peer dep only), and small (~860 lines). **Decision: port (vendor) it** into `apps/web/src/components/diffs/` at pinned commit `72e9a008f78813043e8c3e3e0c4ff95a9f549670`, rather than writing a minimal equivalent. Its component API, used by this plan:

- `parsePatch(patch: string): ParsedPatch` — tolerant git-unified-diff parser (`parse.ts`); `ParsedPatch = { files: FileDiff[]; stats: {additions, deletions} }`.
- `diffWords(before, after)` — LCS word-level segments (`wordDiff.ts`), applied by `DiffBody.tsx` to paired deletion/addition runs.
- `PatchDiff({ patch, options })` — renders one parsed patch with per-file headers.
- `FilesChanged({ files: FilesChangedItem[] })` — collapsible per-file rows; `FilesChangedItem = { key, path, patch, additions, deletions, badge?, defaultOpen? }`.
- `highlight.ts` — tiny per-line tokenizer for syntax color; `style.css` — all colors via `--cgd-*` CSS variables meant to be overridden by the host theme.

## What content is available for a file_change (investigation record)

`container-codex-runner.ts` pipes Codex CLI `--json` lines through `parseCodexEventLine` (`codex-runner.ts:82-89`). For `item.type === "file_change"` the emitted `RunnerStepEvent` is `{ type: "file_change", title: "File modified", detail: <path string>, rawPayload: <the codex item> }`. The codex item carries **paths only** — either `item.path` (what the current parser reads) or, in current Codex CLI payloads, `item.changes: [{ path, kind }]`. There is **no before/after content and no patch text** in the event, and the change is already applied to the mounted workspace when `item.completed` arrives. Therefore the server must (a) snapshot workspace file contents at run start to know "before", (b) read the file from disk at approval time to know "after", (c) build the unified diff itself, and (d) restore the snapshot content on denial ("deny discards"). Container paths arrive as `/workspace/...` (the bind-mount target in `buildContainerRunArgs`), so paths must be mapped back to workspace-relative form and path-escapes rejected.

## File Structure

**Server (`apps/server/src/`):**
- `diff-capture.ts` (create) — all diff logic: `buildUnifiedDiff`, `truncateDiff`, `WorkspaceSnapshot`, `toWorkspaceRelativePath`, `extractChangedPaths`, `captureFileChangeDiff`. One responsibility: turning a file_change step into a reviewable/revertible diff.
- `diff-capture.test.ts` (create) — unit tests for the above.
- `types.ts` (modify) — `ApprovalRequest` gains `diff?: string | undefined`.
- `agent-service.ts` (modify) — snapshot at run start; attach diff to file_change approvals; revert on denial; refresh snapshot after applied file changes.
- `agent-service.test.ts` (modify) — carries-diff/approve-applies/deny-discards tests.
- `app.test.ts` (modify) — approval API payload includes `diff`. (No `app.ts` change needed: routes already return the whole `ApprovalRequest` object, so the new field flows through `GET /api/approvals`, `GET /api/approvals/:id`, and the approve/deny responses automatically.)

**Web (`apps/web/src/`):**
- `components/diffs/types.ts`, `parse.ts`, `wordDiff.ts`, `highlight.ts`, `diffs.css` (create — vendored from codegraff `packages/diffs/src/`, `style.css` renamed `diffs.css`).
- `components/diffs/react/DiffBody.tsx`, `PatchDiff.tsx`, `FilesChanged.tsx` (create — vendored; internal imports like `../parse` keep working because the directory layout is preserved).
- `components/diffs/ApprovalDiff.tsx` (create — the one new component: splits a multi-file patch, feeds `FilesChanged`).
- `types.ts` (modify) — `ApprovalRequest` gains `diff?: string`.
- `App.tsx` (modify) — render `ApprovalDiff` in the approval banner; add a diff-demo starter prompt.
- `styles.css` (modify) — diff card chrome + `--cgd-*` theme mapping.

---

### Task 1: Unified diff builder (`buildUnifiedDiff`)

**Files:**
- Create: `apps/server/src/diff-capture.ts`
- Test: `apps/server/src/diff-capture.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (Tasks 2–3 rely on these exact signatures):
  - `buildUnifiedDiff(filePath: string, before: string | null, after: string | null): string` — git-style unified diff for one file; `null` before = new file, `null` after = deleted file; `""` when contents are identical. Output is parseable by codegraff's `parsePatch` (`diff --git a/<p> b/<p>` header, `--- a/<p>` / `+++ b/<p>` or `/dev/null`, `@@ -s,c +s,c @@` hunks, 3 context lines).
  - `truncateDiff(patch: string): string` — caps a patch at 100,000 chars, appending `\n… diff truncated …\n`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/diff-capture.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { buildUnifiedDiff, truncateDiff } from "./diff-capture.js";

describe("buildUnifiedDiff", () => {
  it("produces a git-style unified diff for an update", () => {
    const before = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    const after = "const a = 1;\nconst b = 20;\nconst c = 3;\n";
    const patch = buildUnifiedDiff("src/config.ts", before, after);
    expect(patch).toContain("diff --git a/src/config.ts b/src/config.ts");
    expect(patch).toContain("--- a/src/config.ts");
    expect(patch).toContain("+++ b/src/config.ts");
    expect(patch).toContain("@@ -1,4 +1,4 @@");
    expect(patch).toContain("-const b = 2;");
    expect(patch).toContain("+const b = 20;");
    expect(patch).toContain(" const a = 1;");
  });

  it("marks new files with /dev/null and new file mode", () => {
    const patch = buildUnifiedDiff("notes.md", null, "hello\n");
    expect(patch).toContain("new file mode 100644");
    expect(patch).toContain("--- /dev/null");
    expect(patch).toContain("+++ b/notes.md");
    expect(patch).toContain("+hello");
  });

  it("marks deleted files with /dev/null and deleted file mode", () => {
    const patch = buildUnifiedDiff("old.txt", "bye\n", null);
    expect(patch).toContain("deleted file mode 100644");
    expect(patch).toContain("--- a/old.txt");
    expect(patch).toContain("+++ /dev/null");
    expect(patch).toContain("-bye");
  });

  it("returns an empty string when contents are identical", () => {
    expect(buildUnifiedDiff("same.txt", "x\n", "x\n")).toBe("");
    expect(buildUnifiedDiff("absent.txt", null, null)).toBe("");
  });

  it("separates distant changes into multiple hunks", () => {
    const before =
      Array.from({ length: 20 }, (_, index) => "line " + (index + 1)).join("\n") + "\n";
    const after = before.replace("line 2", "line two").replace("line 18", "line eighteen");
    const patch = buildUnifiedDiff("big.txt", before, after);
    expect(patch.match(/^@@ /gm)).toHaveLength(2);
  });
});

describe("truncateDiff", () => {
  it("caps oversized patches with a marker", () => {
    const truncated = truncateDiff("x".repeat(200_000));
    expect(truncated).toContain("… diff truncated …");
    expect(truncated.length).toBeLessThan(101_000);
  });

  it("leaves small patches untouched", () => {
    expect(truncateDiff("small")).toBe("small");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @launchpad/server -- src/diff-capture.test.ts`
Expected: FAIL — `Cannot find module './diff-capture.js'` (file does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `apps/server/src/diff-capture.ts`:

```typescript
// Diff capture for HITL file_change approvals (WS-C).
// Codex applies file changes before reporting them, so "before" content comes
// from a snapshot taken at run start and "after" comes from the workspace disk.

const LCS_CELL_BUDGET = 4_000_000;
const DIFF_CONTEXT_LINES = 3;
const MAX_DIFF_CHARS = 100_000;

interface LineOp {
  kind: "same" | "add" | "del";
  text: string;
}

interface NumberedOp extends LineOp {
  beforeLine: number | null;
  afterLine: number | null;
}

/** Standard LCS line diff; bails to whole-file replace when the table is too big. */
function diffLineOps(before: string[], after: string[]): LineOp[] {
  const n = before.length;
  const m = after.length;
  if (n * m > LCS_CELL_BUDGET) {
    return [
      ...before.map((text): LineOp => ({ kind: "del", text })),
      ...after.map((text): LineOp => ({ kind: "add", text })),
    ];
  }
  const lcs: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        before[i] === after[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: "same", text: before[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: "del", text: before[i]! });
      i += 1;
    } else {
      ops.push({ kind: "add", text: after[j]! });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", text: before[i]! });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "add", text: after[j]! });
    j += 1;
  }
  return ops;
}

function numberOps(ops: LineOp[]): NumberedOp[] {
  let beforeLine = 1;
  let afterLine = 1;
  return ops.map((op) => {
    const numbered: NumberedOp = {
      ...op,
      beforeLine: op.kind === "add" ? null : beforeLine,
      afterLine: op.kind === "del" ? null : afterLine,
    };
    if (op.kind !== "add") beforeLine += 1;
    if (op.kind !== "del") afterLine += 1;
    return numbered;
  });
}

/** Cap a patch so pathological changes cannot bloat the JSON store or API payloads. */
export function truncateDiff(patch: string): string {
  if (patch.length <= MAX_DIFF_CHARS) return patch;
  return patch.slice(0, MAX_DIFF_CHARS) + "\n… diff truncated …\n";
}

/**
 * Build a git-style unified diff for one file.
 * `before === null` means the file did not exist (new file);
 * `after === null` means it no longer exists (deleted file).
 * Returns "" when there is nothing to show.
 */
export function buildUnifiedDiff(
  filePath: string,
  before: string | null,
  after: string | null,
): string {
  if (before === after) return "";
  const beforeLines = before === null ? [] : before.split("\n");
  const afterLines = after === null ? [] : after.split("\n");
  const ops = numberOps(diffLineOps(beforeLines, afterLines));
  const changedIndexes = ops.flatMap((op, index) => (op.kind === "same" ? [] : [index]));
  if (changedIndexes.length === 0) return "";

  // Merge changed indexes into hunk ranges whose context windows touch.
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changedIndexes) {
    const start = Math.max(0, index - DIFF_CONTEXT_LINES);
    const end = Math.min(ops.length - 1, index + DIFF_CONTEXT_LINES);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = end;
    } else {
      ranges.push({ start, end });
    }
  }

  const lines: string[] = [
    `diff --git a/${filePath} b/${filePath}`,
    ...(before === null ? ["new file mode 100644"] : []),
    ...(after === null ? ["deleted file mode 100644"] : []),
    `--- ${before === null ? "/dev/null" : `a/${filePath}`}`,
    `+++ ${after === null ? "/dev/null" : `b/${filePath}`}`,
  ];
  for (const range of ranges) {
    const slice = ops.slice(range.start, range.end + 1);
    const beforeStart = slice.find((op) => op.beforeLine !== null)?.beforeLine ?? 0;
    const afterStart = slice.find((op) => op.afterLine !== null)?.afterLine ?? 0;
    const beforeCount = slice.filter((op) => op.kind !== "add").length;
    const afterCount = slice.filter((op) => op.kind !== "del").length;
    lines.push(`@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`);
    for (const op of slice) {
      lines.push((op.kind === "add" ? "+" : op.kind === "del" ? "-" : " ") + op.text);
    }
  }
  return truncateDiff(lines.join("\n") + "\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w @launchpad/server -- src/diff-capture.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck -w @launchpad/server
git add apps/server/src/diff-capture.ts apps/server/src/diff-capture.test.ts
git commit -m "feat(hitl): add unified diff builder for approval capture"
```

---

### Task 2: Workspace snapshot, path mapping, and diff capture/revert

**Files:**
- Modify: `apps/server/src/diff-capture.ts` (append to the Task 1 file)
- Test: `apps/server/src/diff-capture.test.ts` (append)

**Interfaces:**
- Consumes: `buildUnifiedDiff`, `truncateDiff` from Task 1; `RunnerStepEvent` from `./types.js` (existing: `{ type; title; detail; rawPayload?: unknown }`).
- Produces (Task 3 relies on these exact signatures):
  - `class WorkspaceSnapshot` with `static capture(workspacePath: string): Promise<WorkspaceSnapshot>`, `before(relativePath: string): string | null`, `refresh(relativePath: string): Promise<void>`, `restore(relativePath: string): Promise<void>`.
  - `toWorkspaceRelativePath(workspacePath: string, rawPath: string): string | null` — maps `/workspace/...` container paths, absolute host paths, and relative paths to a workspace-relative path; `null` for escapes.
  - `extractChangedPaths(step: RunnerStepEvent, workspacePath: string): string[]` — reads `rawPayload.changes[].path`, `rawPayload.path`, or falls back to `step.detail`.
  - `captureFileChangeDiff(snapshot: WorkspaceSnapshot, workspacePath: string, changedPaths: string[]): Promise<string>` — concatenated per-file unified diffs, truncated.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/diff-capture.test.ts` (extend the top-of-file imports too):

```typescript
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

import {
  captureFileChangeDiff,
  extractChangedPaths,
  toWorkspaceRelativePath,
  WorkspaceSnapshot,
} from "./diff-capture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "diff-capture-test-"));
  temporaryDirectories.push(root);
  return root;
}

describe("toWorkspaceRelativePath", () => {
  it("maps container, absolute, and relative paths into the workspace", () => {
    expect(toWorkspaceRelativePath("/tmp/ws", "/workspace/src/a.ts")).toBe("src/a.ts");
    expect(toWorkspaceRelativePath("/tmp/ws", "src/a.ts")).toBe("src/a.ts");
    expect(toWorkspaceRelativePath("/tmp/ws", "/tmp/ws/src/a.ts")).toBe("src/a.ts");
  });

  it("rejects paths that escape the workspace", () => {
    expect(toWorkspaceRelativePath("/tmp/ws", "../outside.txt")).toBeNull();
    expect(toWorkspaceRelativePath("/tmp/ws", "/etc/passwd")).toBeNull();
    expect(toWorkspaceRelativePath("/tmp/ws", "src/../../escape.txt")).toBeNull();
  });
});

describe("extractChangedPaths", () => {
  it("reads the changes array, single path, and detail fallback", () => {
    const workspacePath = "/tmp/ws";
    expect(
      extractChangedPaths(
        {
          type: "file_change",
          title: "File modified",
          detail: "app.env",
          rawPayload: {
            type: "file_change",
            changes: [{ path: "/workspace/app.env", kind: "update" }],
          },
        },
        workspacePath,
      ),
    ).toEqual(["app.env"]);
    expect(
      extractChangedPaths(
        {
          type: "file_change",
          title: "File modified",
          detail: "src/a.ts",
          rawPayload: { type: "file_change", path: "src/a.ts" },
        },
        workspacePath,
      ),
    ).toEqual(["src/a.ts"]);
    expect(
      extractChangedPaths(
        { type: "file_change", title: "File modified", detail: "notes.md" },
        workspacePath,
      ),
    ).toEqual(["notes.md"]);
  });
});

describe("WorkspaceSnapshot", () => {
  it("captures before-content and produces per-file patches for later edits", async () => {
    const root = await makeWorkspace();
    await writeFile(path.join(root, "app.env"), "A=1\n", "utf8");
    const snapshot = await WorkspaceSnapshot.capture(root);
    await writeFile(path.join(root, "app.env"), "A=2\n", "utf8");
    await writeFile(path.join(root, "new.txt"), "created\n", "utf8");

    const diff = await captureFileChangeDiff(snapshot, root, ["app.env", "new.txt"]);
    expect(diff).toContain("diff --git a/app.env b/app.env");
    expect(diff).toContain("-A=1");
    expect(diff).toContain("+A=2");
    expect(diff).toContain("new file mode 100644");
    expect(diff).toContain("+created");
  });

  it("restores denied changes, including deleting newly created files", async () => {
    const root = await makeWorkspace();
    await writeFile(path.join(root, "app.env"), "A=1\n", "utf8");
    const snapshot = await WorkspaceSnapshot.capture(root);
    await writeFile(path.join(root, "app.env"), "A=2\n", "utf8");
    await writeFile(path.join(root, "new.txt"), "created\n", "utf8");

    await snapshot.restore("app.env");
    await snapshot.restore("new.txt");

    expect(await readFile(path.join(root, "app.env"), "utf8")).toBe("A=1\n");
    await expect(readFile(path.join(root, "new.txt"), "utf8")).rejects.toThrow();
  });

  it("refresh re-baselines a file so later diffs start from the applied state", async () => {
    const root = await makeWorkspace();
    await writeFile(path.join(root, "app.env"), "A=1\n", "utf8");
    const snapshot = await WorkspaceSnapshot.capture(root);
    await writeFile(path.join(root, "app.env"), "A=2\n", "utf8");
    await snapshot.refresh("app.env");
    await writeFile(path.join(root, "app.env"), "A=3\n", "utf8");

    const diff = await captureFileChangeDiff(snapshot, root, ["app.env"]);
    expect(diff).toContain("-A=2");
    expect(diff).toContain("+A=3");
    expect(diff).not.toContain("-A=1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @launchpad/server -- src/diff-capture.test.ts`
Expected: FAIL — the new exports do not exist yet (`WorkspaceSnapshot` etc. undefined / not exported).

- [ ] **Step 3: Write the implementation**

Append to `apps/server/src/diff-capture.ts` (and add these imports at the top of the file):

```typescript
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunnerStepEvent } from "./types.js";
```

```typescript
const MAX_SNAPSHOT_FILE_BYTES = 262_144;
const MAX_SNAPSHOT_FILES = 500;
const SKIP_DIRECTORIES = new Set(["node_modules", ".git"]);

async function readTextFile(absolutePath: string): Promise<string | null> {
  try {
    const info = await stat(absolutePath);
    if (!info.isFile() || info.size > MAX_SNAPSHOT_FILE_BYTES) return null;
    return await readFile(absolutePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Point-in-time copy of workspace text files, taken at run start.
 * Backs both diff capture ("what changed?") and denial revert ("discard it").
 */
export class WorkspaceSnapshot {
  private constructor(
    private readonly workspacePath: string,
    private readonly files: Map<string, string>,
  ) {}

  static async capture(workspacePath: string): Promise<WorkspaceSnapshot> {
    const files = new Map<string, string>();
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.size >= MAX_SNAPSHOT_FILES) return;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRECTORIES.has(entry.name)) await walk(absolute);
        } else if (entry.isFile()) {
          const content = await readTextFile(absolute);
          if (content !== null) {
            files.set(path.relative(workspacePath, absolute), content);
          }
        }
      }
    };
    await walk(workspacePath);
    return new WorkspaceSnapshot(workspacePath, files);
  }

  /** Content at run start; null = file did not exist (or was too large to snapshot). */
  before(relativePath: string): string | null {
    return this.files.get(relativePath) ?? null;
  }

  /** Re-baseline one file to its current on-disk state (after an approved change). */
  async refresh(relativePath: string): Promise<void> {
    const content = await readTextFile(path.join(this.workspacePath, relativePath));
    if (content === null) {
      this.files.delete(relativePath);
    } else {
      this.files.set(relativePath, content);
    }
  }

  /** Put one file back to its snapshot state (deny discards): rewrite or delete. */
  async restore(relativePath: string): Promise<void> {
    const absolute = path.join(this.workspacePath, relativePath);
    const previous = this.files.get(relativePath) ?? null;
    if (previous === null) {
      await unlink(absolute).catch(() => undefined);
    } else {
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, previous, "utf8");
    }
  }
}

/**
 * Map a path reported by the runner to a workspace-relative path.
 * Container runs mount the workspace at /workspace (see buildContainerRunArgs),
 * local runs may report absolute host paths or relative paths.
 * Returns null for anything that escapes the workspace.
 */
export function toWorkspaceRelativePath(
  workspacePath: string,
  rawPath: string,
): string | null {
  const withoutMount =
    rawPath === "/workspace"
      ? ""
      : rawPath.startsWith("/workspace/")
        ? rawPath.slice("/workspace/".length)
        : rawPath;
  const base = path.isAbsolute(withoutMount)
    ? path.relative(workspacePath, withoutMount)
    : withoutMount;
  const normalized = path.normalize(base);
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(".." + path.sep) ||
    path.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized;
}

/**
 * Changed paths for a file_change step. Codex payloads carry either
 * `changes: [{ path, kind }]` (current CLI) or a single `path` (what
 * parseCodexEventLine reads); `step.detail` is the last-resort fallback.
 */
export function extractChangedPaths(
  step: RunnerStepEvent,
  workspacePath: string,
): string[] {
  const candidates: string[] = [];
  const raw = step.rawPayload;
  if (raw && typeof raw === "object") {
    const item = raw as Record<string, unknown>;
    if (typeof item.path === "string") candidates.push(item.path);
    if (Array.isArray(item.changes)) {
      for (const change of item.changes) {
        if (change && typeof change === "object") {
          const changePath = (change as Record<string, unknown>).path;
          if (typeof changePath === "string") candidates.push(changePath);
        }
      }
    }
  }
  if (candidates.length === 0 && step.detail) candidates.push(step.detail);

  const resolved = new Set<string>();
  for (const candidate of candidates) {
    const relative = toWorkspaceRelativePath(workspacePath, candidate);
    if (relative !== null) resolved.add(relative);
  }
  return [...resolved];
}

/** Concatenated per-file unified diffs (snapshot vs. current disk), truncated. */
export async function captureFileChangeDiff(
  snapshot: WorkspaceSnapshot,
  workspacePath: string,
  changedPaths: string[],
): Promise<string> {
  const patches: string[] = [];
  for (const relativePath of changedPaths) {
    const before = snapshot.before(relativePath);
    const after = await readTextFile(path.join(workspacePath, relativePath));
    const patch = buildUnifiedDiff(relativePath, before, after);
    if (patch.length > 0) patches.push(patch);
  }
  return truncateDiff(patches.join(""));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w @launchpad/server -- src/diff-capture.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck -w @launchpad/server
git add apps/server/src/diff-capture.ts apps/server/src/diff-capture.test.ts
git commit -m "feat(hitl): workspace snapshot, path mapping, and diff capture/revert"
```

---

### Task 3: Attach diffs to approvals; revert on denial (server wiring)

**Files:**
- Modify: `apps/server/src/types.ts` (ApprovalRequest, ~line 76-89)
- Modify: `apps/server/src/agent-service.ts` (executeRun ~line 472, onStep approval branch ~lines 518-588)
- Test: `apps/server/src/agent-service.test.ts` (append to the existing `describe("Agent lifecycle")` file)
- Test: `apps/server/src/app.test.ts` (append one route-payload test)

**Interfaces:**
- Consumes (from Tasks 1-2, all imported from `./diff-capture.js`): `WorkspaceSnapshot.capture(workspacePath)`, `snapshot.restore(relativePath)`, `snapshot.refresh(relativePath)`, `extractChangedPaths(step, workspacePath)`, `captureFileChangeDiff(snapshot, workspacePath, changedPaths)`.
- Produces: `ApprovalRequest.diff?: string | undefined` persisted in the store and returned by the existing approval routes (`GET /api/approvals`, `GET /api/approvals/:id`, `POST /api/approvals/:id/approve|deny`) with no `app.ts` change. Web Task 5 reads this field.

- [ ] **Step 1: Add the spec-required field to the type**

In `apps/server/src/types.ts`, `interface ApprovalRequest`, add one field after `actionDetail: string;`:

```typescript
  /** Unified diff of the pending change; present only for file_change approvals. */
  diff?: string | undefined;
```

- [ ] **Step 2: Write the failing service tests**

Append inside `describe("Agent lifecycle", ...)` in `apps/server/src/agent-service.test.ts`. Also extend the first import line of the file from `import { mkdtemp, readFile } from "node:fs/promises";` to `import { mkdtemp, readFile, writeFile } from "node:fs/promises";`.

A shared runner factory for these tests (place directly above the new tests, inside the describe block or at module level next to `FakeRunner`):

```typescript
function fileChangeRunner(fileName: string, newContent: string): AgentRunner {
  return {
    run: async (request) => {
      await writeFile(path.join(request.workspacePath, fileName), newContent, "utf8");
      await request.onStep?.({
        type: "file_change",
        title: "File modified",
        detail: fileName,
        rawPayload: {
          type: "file_change",
          changes: [{ path: "/workspace/" + fileName, kind: "update" }],
        },
      });
      return { output: "updated " + fileName, threadId: "thread", usage: null };
    },
    cancel: async () => true,
    isAvailable: async () => true,
  };
}
```

The tests (note: `app.env` matches the `SEC-CREDENTIALS-002` `\.env` pattern in `evaluateActionRisk`, so the file_change step requires approval; the seeded `credentials.env` is deliberately avoided to keep canary redaction out of these assertions):

```typescript
  it("attaches a unified diff to file_change approvals and applies on approve", async () => {
    const service = await makeService(fileChangeRunner("app.env", "SECRET=new-value\n"));
    const agent = await service.createAgent({ name: "DiffWriter" });
    await writeFile(path.join(agent.workspacePath, "app.env"), "SECRET=old-value\n", "utf8");

    const { run } = await service.sendMessage(agent.id, "rotate the secret");
    await expect.poll(() => service.getAgent(agent.id).status).toBe("waiting_approval");

    const approvals = service.listApprovals(agent.id, "pending");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.actionType).toBe("file_change");
    expect(approvals[0]?.ruleId).toBe("SEC-CREDENTIALS-002");
    expect(approvals[0]?.diff).toContain("diff --git a/app.env b/app.env");
    expect(approvals[0]?.diff).toContain("-SECRET=old-value");
    expect(approvals[0]?.diff).toContain("+SECRET=new-value");

    await service.resolveApproval(approvals[0]!.id, "approved", "SecurityOfficer");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(await readFile(path.join(agent.workspacePath, "app.env"), "utf8")).toBe(
      "SECRET=new-value\n",
    );
  });

  it("discards the pending file change when the operator denies", async () => {
    const service = await makeService(fileChangeRunner("app.env", "SECRET=stolen\n"));
    const agent = await service.createAgent({ name: "DiffDenied" });
    await writeFile(path.join(agent.workspacePath, "app.env"), "SECRET=old-value\n", "utf8");

    const { run } = await service.sendMessage(agent.id, "overwrite the secret");
    await expect.poll(() => service.getAgent(agent.id).status).toBe("waiting_approval");
    const approvals = service.listApprovals(agent.id, "pending");
    expect(approvals[0]?.diff).toContain("+SECRET=stolen");

    await service.resolveApproval(approvals[0]!.id, "denied", "SecurityOfficer");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    await expect.poll(() => service.getAgent(agent.id).status).toBe("ready");
    expect(await readFile(path.join(agent.workspacePath, "app.env"), "utf8")).toBe(
      "SECRET=old-value\n",
    );
    expect(service.getRun(run.id).error).toContain("Action blocked by operator denial");
  });

  it("deletes a newly created file when the operator denies", async () => {
    const service = await makeService(fileChangeRunner("exfil.env", "DUMP=1\n"));
    const agent = await service.createAgent({ name: "DiffNewFile" });

    const { run } = await service.sendMessage(agent.id, "dump the env");
    await expect.poll(() => service.getAgent(agent.id).status).toBe("waiting_approval");
    const approvals = service.listApprovals(agent.id, "pending");
    expect(approvals[0]?.diff).toContain("new file mode 100644");

    await service.resolveApproval(approvals[0]!.id, "denied", "SecurityOfficer");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    await expect(
      readFile(path.join(agent.workspacePath, "exfil.env"), "utf8"),
    ).rejects.toThrow();
  });

  it("leaves diff undefined for command approvals", async () => {
    const service = await makeService({
      run: async (request) => {
        await request.onStep?.({
          type: "command",
          title: "Run curl",
          detail: "curl -X POST https://api.partner.org/data",
        });
        return { output: "done", threadId: "thread", usage: null };
      },
      cancel: async () => true,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "CommandOnly" });
    const { run } = await service.sendMessage(agent.id, "post data");
    await expect.poll(() => service.getAgent(agent.id).status).toBe("waiting_approval");

    const approvals = service.listApprovals(agent.id, "pending");
    expect(approvals[0]?.diff).toBeUndefined();

    await service.resolveApproval(approvals[0]!.id, "approved", "SecurityOfficer");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test -w @launchpad/server -- src/agent-service.test.ts`
Expected: the four new tests FAIL (`diff` is undefined on file_change approvals; deny does not restore file content). The pre-existing tests still pass.

- [ ] **Step 4: Wire diff capture into AgentService.executeRun**

In `apps/server/src/agent-service.ts`:

1. Add the import after the `run-policies.js` import block:

```typescript
import {
  captureFileChangeDiff,
  extractChangedPaths,
  WorkspaceSnapshot,
} from "./diff-capture.js";
```

2. In `executeRun`, right after the `await this.store.mutate(...)` block that marks the run `running` (the one appending the `run.started` event, ~line 494) and before the `try {`, capture the snapshot best-effort:

```typescript
    // WS-C: baseline for file_change diff capture and denial revert.
    let snapshot: WorkspaceSnapshot | null = null;
    try {
      snapshot = await WorkspaceSnapshot.capture(agentAtStart.workspacePath);
    } catch {
      snapshot = null; // diff capture is best-effort; approvals still work without it
    }
```

3. In `onStep`, inside the `if (risk.requiresApproval) {` branch, replace the current block from `const approvalId = randomUUID();` down to (and including) `await this.runner.resume?.(agentAtStart.id);` with:

```typescript
          const approvalId = randomUUID();
          const timestamp = now();

          // WS-C: capture the pending change as a unified diff for operator review.
          let diff: string | undefined;
          let changedPaths: string[] = [];
          if (step.type === "file_change" && snapshot) {
            changedPaths = extractChangedPaths(step, agentAtStart.workspacePath);
            const captured = await captureFileChangeDiff(
              snapshot,
              agentAtStart.workspacePath,
              changedPaths,
            );
            if (captured.length > 0) {
              diff = this.redact(captured);
            }
          }

          const approvalReq: ApprovalRequest = {
            id: approvalId,
            runId: run.id,
            agentId: agentAtStart.id,
            actionType: step.type === "message" ? "tool_call" : step.type,
            actionDetail: step.detail,
            ...(diff !== undefined ? { diff } : {}),
            ruleId: risk.ruleId,
            reason: risk.reason,
            riskLevel: risk.riskLevel,
            status: "pending",
            createdAt: timestamp,
            resolvedAt: null,
            resolvedBy: null,
          };

          await this.store.mutate((database) => {
            database.approvals.push(approvalReq);
            const agent = database.agents.find((item) => item.id === agentAtStart.id);
            if (agent) {
              agent.status = "waiting_approval";
              agent.updatedAt = timestamp;
            }
            this.appendRunEvent(database, {
              runId: run.id,
              agentId: agentAtStart.id,
              type: "step.approval_requested",
              severity: "warning",
              title: `High-Risk Action Intercepted (${risk.ruleId})`,
              detail: `Human approval required: ${this.redact(step.detail)}. Policy: ${risk.reason}`,
              createdAt: timestamp,
            });
          });

          await this.runner.pause?.(agentAtStart.id);

          const approved = await new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => {
              void this.resolveApproval(approvalId, "denied", "System (Approval timed out)");
            }, 300_000);
            this.pendingApprovals.set(approvalId, { resolve, timeout, request: approvalReq });
          });

          if (!approved) {
            // WS-C: deny discards — put the files back before failing the run.
            if (step.type === "file_change" && snapshot && changedPaths.length > 0) {
              for (const relativePath of changedPaths) {
                await snapshot.restore(relativePath);
              }
              await this.store.mutate((database) => {
                this.appendRunEvent(database, {
                  runId: run.id,
                  agentId: agentAtStart.id,
                  type: "step.file_change",
                  severity: "warning",
                  title: "File change reverted",
                  detail: this.redact(
                    "Denied change discarded; restored: " + changedPaths.join(", "),
                  ),
                  createdAt: now(),
                });
              });
            }
            stepViolation = new RunPolicyViolationError(
              "approval",
              403,
              `Action blocked by operator denial (${risk.ruleId}): ${step.detail}`,
            );
            void this.runner.cancel(agentAtStart.id);
            throw stepViolation;
          }

          await this.runner.resume?.(agentAtStart.id);
```

(The only changes versus the existing block are: the `diff`/`changedPaths` capture before building `approvalReq`, the `...(diff !== undefined ? { diff } : {})` spread inside it, and the revert block inside `if (!approved)`. Everything else is byte-identical — keep it that way.)

4. At the end of `onStep`, after the final `await this.store.mutate(...)` that appends the `typeMap` step event, add the re-baseline so a second change to the same file diffs against the applied state:

```typescript
        // WS-C: applied file changes become the new baseline for later diffs.
        if (step.type === "file_change" && snapshot) {
          for (const relativePath of extractChangedPaths(step, agentAtStart.workspacePath)) {
            await snapshot.refresh(relativePath);
          }
        }
```

- [ ] **Step 5: Run service tests to verify they pass**

Run: `npm run test -w @launchpad/server -- src/agent-service.test.ts`
Expected: PASS — all pre-existing tests plus the four new ones.

- [ ] **Step 6: Write the failing route-payload test**

Append inside `describe("HTTP boundary", ...)` in `apps/server/src/app.test.ts`:

```typescript
  it("includes the captured diff in approval API payloads", async () => {
    const approvalId = "44444444-4444-4444-8444-444444444444";
    const service = {
      listAgents: () => [],
      systemInfo: async () => ({}),
      listApprovals: () => [
        {
          id: approvalId,
          runId: "run-1",
          agentId: "agent-1",
          actionType: "file_change",
          actionDetail: "app.env",
          diff: "diff --git a/app.env b/app.env\n--- a/app.env\n+++ b/app.env\n@@ -1,1 +1,1 @@\n-SECRET=old\n+SECRET=new\n",
          ruleId: "SEC-CREDENTIALS-002",
          reason: "Access to protected credentials or private keys detected.",
          riskLevel: "high",
          status: "pending",
          createdAt: new Date().toISOString(),
          resolvedAt: null,
          resolvedBy: null,
        },
      ],
    } as unknown as AgentService;

    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const response = await app.inject({ method: "GET", url: "/api/approvals" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { approvals: Array<{ diff?: string }> };
    expect(body.approvals[0]?.diff).toContain("diff --git a/app.env b/app.env");
    expect(body.approvals[0]?.diff).toContain("+SECRET=new");
    await app.close();
  });
```

- [ ] **Step 7: Run the route test**

Run: `npm run test -w @launchpad/server -- src/app.test.ts`
Expected: PASS immediately (routes serialize the whole approval object; this test pins that contract so a future response-schema change cannot silently drop `diff`). If it fails, something is filtering approval fields — fix that, do not change the test.

- [ ] **Step 8: Full server check and commit**

```bash
npm run typecheck -w @launchpad/server
npm run test -w @launchpad/server
git add apps/server/src/types.ts apps/server/src/agent-service.ts apps/server/src/agent-service.test.ts apps/server/src/app.test.ts
git commit -m "feat(hitl): attach unified diffs to file_change approvals; deny reverts files"
```

---

### Task 4: Vendor the codegraff diff renderer into the web app

**Files:**
- Create: `apps/web/src/components/diffs/types.ts`
- Create: `apps/web/src/components/diffs/parse.ts`
- Create: `apps/web/src/components/diffs/wordDiff.ts`
- Create: `apps/web/src/components/diffs/highlight.ts`
- Create: `apps/web/src/components/diffs/diffs.css`
- Create: `apps/web/src/components/diffs/react/DiffBody.tsx`
- Create: `apps/web/src/components/diffs/react/PatchDiff.tsx`
- Create: `apps/web/src/components/diffs/react/FilesChanged.tsx`

**Interfaces:**
- Consumes: nothing from other tasks (self-contained vendored package; React 19 peer).
- Produces (Task 5 relies on): `parsePatch(patch: string): ParsedPatch` from `./parse`; `FilesChanged({ files: FilesChangedItem[], diffOptions? })` and `type FilesChangedItem = { key: string; path: string; patch: string; additions: number; deletions: number; badge?: string; headerExtra?: ReactNode; defaultOpen?: boolean }` from `./react/FilesChanged`; all `--cgd-*` CSS variables defined on `.cgd-root` in `diffs.css`.

- [ ] **Step 1: Fetch the vendored sources at the pinned commit**

Requires `gh` (authenticated) and network — both verified available when this plan was written. Run from the repo root:

```bash
CG_SHA=72e9a008f78813043e8c3e3e0c4ff95a9f549670
CG_BASE="repos/justrach/codegraff/contents/packages/diffs/src"
DEST=apps/web/src/components/diffs
mkdir -p "$DEST/react"
for f in types.ts parse.ts wordDiff.ts highlight.ts; do
  gh api "$CG_BASE/$f?ref=$CG_SHA" --jq '.content' | base64 -d > "$DEST/$f"
done
gh api "$CG_BASE/style.css?ref=$CG_SHA" --jq '.content' | base64 -d > "$DEST/diffs.css"
for f in DiffBody.tsx PatchDiff.tsx FilesChanged.tsx; do
  gh api "$CG_BASE/react/$f?ref=$CG_SHA" --jq '.content' | base64 -d > "$DEST/react/$f"
done
wc -l "$DEST"/*.ts "$DEST"/diffs.css "$DEST"/react/*.tsx
```

(If `gh` is unavailable, the same files are at `https://raw.githubusercontent.com/justrach/codegraff/72e9a008f78813043e8c3e3e0c4ff95a9f549670/packages/diffs/src/<file>` via `curl -fsSL`.)

- [ ] **Step 2: Verify the fetched content**

Expected line counts (exact, at the pinned commit): `types.ts` 49, `parse.ts` 185, `wordDiff.ts` 82, `highlight.ts` 199, `diffs.css` 232, `react/DiffBody.tsx` 162, `react/PatchDiff.tsx` 58, `react/FilesChanged.tsx` 75. Spot-check the key exports exist: `parse.ts` exports `parsePatch` and `getPatchStats`; `react/FilesChanged.tsx` exports `FilesChanged` and `interface FilesChangedItem`; `react/DiffBody.tsx` exports `DiffBody` and `type LineDiffType`. Internal imports (`../parse`, `../types`, `../wordDiff`, `../highlight`, `./DiffBody`, `./PatchDiff`) resolve unchanged because the directory layout is preserved; none of the fetched files references `style.css`, so the rename to `diffs.css` breaks nothing.

- [ ] **Step 3: Add attribution headers**

Prepend this exact comment to each of the seven `.ts`/`.tsx` files (adjust to `/* ... */` for `diffs.css`):

```typescript
// Vendored from @codegraff/diffs (https://github.com/justrach/codegraff,
// packages/diffs @ 72e9a00, Apache-2.0). Local changes are marked "CodeJam:".
```

- [ ] **Step 4: Typecheck the web workspace**

Run: `npm run typecheck -w @launchpad/web`
Expected: PASS. The vendored code compiles under the web tsconfig (`strict`, Bundler resolution, `react-jsx`); it uses non-null assertions internally so it is also `noUncheckedIndexedAccess`-clean. If an unused-export warning appears for `getPatchStats` or `DiffBody`'s standalone export, leave them — Task 5 consumes `parsePatch`/`FilesChanged`, and vendored files stay unmodified beyond the attribution header.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/diffs
git commit -m "feat(web): vendor @codegraff/diffs renderer (Apache-2.0) for HITL diff review"
```

---

### Task 5: Diff review inside the approval gate UI

**Files:**
- Create: `apps/web/src/components/diffs/ApprovalDiff.tsx`
- Modify: `apps/web/src/types.ts` (ApprovalRequest, ~line 86-99)
- Modify: `apps/web/src/App.tsx` (imports ~line 1-11, starterPrompts ~line 13-18, approval banner ~lines 742-791)
- Modify: `apps/web/src/styles.css` (append)

**Interfaces:**
- Consumes: `ApprovalRequest.diff` from the approval API (Task 3); `parsePatch`, `FilesChanged`, `FilesChangedItem`, `diffs.css` from Task 4.
- Produces: `ApprovalDiff({ patch: string })` — renders a files-changed list with word-level highlighting; `splitPatchByFile(patch: string): string[]` (exported for reuse).

- [ ] **Step 1: Add the diff field to the web ApprovalRequest type**

In `apps/web/src/types.ts`, `interface ApprovalRequest`, add after `actionDetail: string;`:

```typescript
  /** Unified diff of the pending change; present only for file_change approvals. */
  diff?: string;
```

- [ ] **Step 2: Create the ApprovalDiff component**

Create `apps/web/src/components/diffs/ApprovalDiff.tsx`:

```tsx
import { useMemo } from "react";
import { parsePatch } from "./parse";
import { FilesChanged, type FilesChangedItem } from "./react/FilesChanged";
import "./diffs.css";

/** Split a multi-file unified diff into one raw patch chunk per file. */
export function splitPatchByFile(patch: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.some((line) => line.trim().length > 0)) {
    chunks.push(current.join("\n"));
  }
  return chunks;
}

/** Files-changed review list for a pending HITL approval. */
export function ApprovalDiff({ patch }: { patch: string }) {
  const items = useMemo<FilesChangedItem[]>(() => {
    return splitPatchByFile(patch).map((chunk, index) => {
      const parsed = parsePatch(chunk);
      const file = parsed.files[0];
      return {
        key: `${file?.path ?? "file"}-${index}`,
        path: file?.path ?? "unknown file",
        patch: chunk,
        additions: parsed.stats.additions,
        deletions: parsed.stats.deletions,
        badge: file?.isNew ? "added" : file?.isDeleted ? "deleted" : undefined,
        defaultOpen: index === 0,
      };
    });
  }, [patch]);

  return (
    <div className="hitl-diff-body">
      <FilesChanged files={items} diffOptions={{ lineDiffType: "word" }} />
    </div>
  );
}
```

(The server appends a `… diff truncated …` line to oversized patches; `parsePatch` ignores unknown lines by design, so no special handling is needed here.)

- [ ] **Step 3: Render the diff in the approval banner**

In `apps/web/src/App.tsx`:

1. Add the import after the `./types` import block:

```tsx
import { ApprovalDiff } from "./components/diffs/ApprovalDiff";
```

2. In the approval banner (inside `{pendingApprovals.length > 0 && (...)}`), directly after the existing `hitl-command-card` `<div>` closes and before `<div className="hitl-actions-bar">`, insert:

```tsx
                    {pendingApprovals[0]!.diff && (
                      <div className="hitl-diff-card">
                        <div className="hitl-command-header">
                          Pending file changes — review before approving
                        </div>
                        <ApprovalDiff patch={pendingApprovals[0]!.diff} />
                      </div>
                    )}
```

(The existing `hitl-command-card` with the raw `actionDetail` stays — it names the intercepted action; the diff card below it shows what the change actually does. Approve keeps the existing `handleApprove` flow — the change is already applied and the run resumes; Deny keeps `handleDeny` — the server now reverts the files.)

3. Add a diff-demo starter prompt to `starterPrompts` (after the "Destructive demo" entry):

```typescript
  "Diff review demo: create app.env containing DEMO_KEY=alpha, then edit it to DEMO_KEY=beta",
```

- [ ] **Step 4: Theme the diff components**

Append to `apps/web/src/styles.css`:

```css
/* ==========================================================================
   HITL diff review (WS-C)
   ========================================================================== */

.hitl-diff-card {
  margin-top: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  overflow: hidden;
}

.hitl-diff-card .hitl-command-header {
  border-bottom: 1px solid var(--border);
}

.hitl-diff-body {
  padding: 10px;
  max-height: 340px;
  overflow-y: auto;
}

/* Map vendored --cgd-* tokens onto the app theme (higher specificity than
   the .cgd-root fallbacks in components/diffs/diffs.css). */
.hitl-approval-banner .cgd-root {
  --cgd-border: var(--border);
  --cgd-fg: var(--ink);
  --cgd-muted: var(--muted);
  --cgd-font: var(--font-mono);
}
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck -w @launchpad/web && npm run build -w @launchpad/web`
Expected: PASS (vite bundles `diffs.css` via the component import).

- [ ] **Step 6: Manual UI verification (spec: "UI manual")**

Requires a configured runtime (`OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, container/codex available — same prerequisites as the existing Playground demos).

1. `npm run dev`, open `http://localhost:5173`, create an agent.
2. Send the new starter prompt ("Diff review demo: create app.env containing DEMO_KEY=alpha, then edit it to DEMO_KEY=beta").
3. When the agent's file_change on `app.env` trips `SEC-CREDENTIALS-002`, verify the approval banner shows: risk badge, rule id, the intercepted-action card, and below it the "Pending file changes" card with a collapsible `app.env` row, `+`/`-` counts, green/red lines, and word-level highlight on the changed token.
4. Click **Deny** → run fails with "blocked by human operator denial"; the trace drawer shows a "File change reverted" event; ask the agent (new message) to `cat app.env` or check the workspace folder — the denied content is gone.
5. Re-run the prompt and click **Approve & Continue** → run completes and `app.env` keeps the change.
6. Send the "Abuse / Deny demo" starter prompt (a command approval) → banner renders exactly as before, with no diff card (no `diff` on command approvals).

If no runtime is configured, the fallback check is: `npm run dev`, then `curl -s -X POST localhost:3000/api/...` cannot fabricate an approval — instead rely on the server tests from Task 3 (they cover the payload) and verify the banner renders by temporarily hard-coding `pendingApprovals` is NOT acceptable to commit; do the visual pass when a runtime is available.

- [ ] **Step 7: Full repo check and commit**

```bash
npm run check
git add apps/web/src/components/diffs/ApprovalDiff.tsx apps/web/src/types.ts apps/web/src/App.tsx apps/web/src/styles.css
git commit -m "feat(web): render pending file-change diffs in the HITL approval gate"
```

---

## Self-review results (already applied)

- **Spec coverage:** WS-C row — diff components ported under `apps/web/src/components/diffs/*` (Tasks 4-5), `App.tsx` wiring (Task 5), `agent-service.ts` diff attach (Task 3), `types.ts` `ApprovalRequest.diff?: string` (Task 3, both server and web). Testing requirement C — "approval request carries diff" (Task 3 tests 1-3 + app.test.ts payload test), "approve applies" (Task 3 test 1), "deny discards" (Task 3 tests 2-3), "UI manual" (Task 5 Step 6). Failure semantics unchanged: denial still surfaces as `RunPolicyViolationError("approval", 403, ...)` and the existing `run.blocked` path.
- **Type consistency:** `buildUnifiedDiff(filePath, before, after)`, `truncateDiff(patch)`, `WorkspaceSnapshot.capture/before/refresh/restore`, `toWorkspaceRelativePath(workspacePath, rawPath)`, `extractChangedPaths(step, workspacePath)`, `captureFileChangeDiff(snapshot, workspacePath, changedPaths)` are spelled identically in Tasks 1, 2, and 3; `FilesChangedItem` fields in Task 5 match the vendored interface listed in Task 4; `diff?: string | undefined` (server, `exactOptionalPropertyTypes`) vs `diff?: string` (web, that flag off) is deliberate.
- **Known trade-offs (documented, not placeholders):** files over 256KB or unreadable as UTF-8 are skipped by the snapshot, so their approvals fall back to the no-diff banner (same UX as command approvals); snapshot walk caps at 500 files; the deny-revert restores only the paths named by the approving step, which is exactly what the operator reviewed.

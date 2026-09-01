// Turns a demo from a thing you read into a thing that can fail.
//
// The demo scripts print what they observed. That is honest, but it means a
// reader has to compare every line by eye, and CI cannot tell a working
// containment boundary from a broken one. Each demo now states its invariants
// through `check`, so a regression exits non-zero instead of scrolling past.

const results = [];

/** Records one invariant. `detail` is shown only when it fails. */
export function check(label, passed, detail = "") {
  results.push({ label, passed: Boolean(passed), detail });
  return Boolean(passed);
}

/**
 * Prints the invariants and sets a failing exit code if any did not hold.
 * Call once, at the end of a demo.
 */
export function finish(title = "Invariants") {
  const failed = results.filter((result) => !result.passed);
  console.log(`\n${title}: ${results.length - failed.length}/${results.length} held`);
  for (const result of results) {
    const detail = !result.passed && result.detail ? `  (${result.detail})` : "";
    console.log(`   ${result.passed ? "ok  " : "FAIL"}  ${result.label}${detail}`);
  }
  if (failed.length > 0) {
    console.log(`\n>>> ${failed.length} invariant(s) did not hold.`);
    process.exitCode = 1;
  }
  return failed.length === 0;
}

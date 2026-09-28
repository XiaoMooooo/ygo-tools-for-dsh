// Shared, dependency-free test harness. No test framework is used on purpose:
// the suite must run on a bare `node` in CI and on a developer machine.
import { fileURLToPath } from 'node:url';

/** Repository root, derived from this file's location. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

export function reporter() {
  let failures = 0;
  let checks = 0;
  return {
    check(label, actual, expected) {
      checks += 1;
      if (Object.is(actual, expected)) {
        console.log(`PASS  ${label}`);
        return;
      }
      failures += 1;
      console.log(`FAIL  ${label}\n        got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
    },
    assert(label, condition, detail) {
      checks += 1;
      if (condition) {
        console.log(`PASS  ${label}`);
        return;
      }
      failures += 1;
      console.log(`FAIL  ${label}${detail === undefined ? '' : `\n        ${detail}`}`);
    },
    section(title) {
      console.log(`\n--- ${title} ---`);
    },
    note(text) {
      console.log(`      ${text}`);
    },
    finish() {
      console.log(failures === 0
        ? `\nALL CHECKS PASS (${checks})`
        : `\n${failures} of ${checks} CHECK(S) FAILED`);
      process.exit(failures === 0 ? 0 : 1);
    },
  };
}

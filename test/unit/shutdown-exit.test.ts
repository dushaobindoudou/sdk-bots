import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { preservedExitCode } from "../../source/host/main.ts";

describe("preservedExitCode()", () => {
  test("keeps a failing process.exitCode so SIGTERM shutdown cannot green-wash tests", () => {
    assert.equal(preservedExitCode(1), 1);
    assert.equal(preservedExitCode("1"), 1);
  });

  test("treats unset / 0 as a clean shutdown", () => {
    assert.equal(preservedExitCode(undefined), 0);
    assert.equal(preservedExitCode(null), 0);
    assert.equal(preservedExitCode(0), 0);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { wizardEmptyMessage } from "../../src/install/wizard-prompt.js";

test("wizard distinguishes hidden undetected clients from a truly empty model", () => {
  assert.equal(
    wizardEmptyMessage(0, 2, false),
    "No clients detected. Press v to review manual opt-in clients."
  );
  assert.equal(wizardEmptyMessage(0, 2, true), undefined);
  assert.equal(wizardEmptyMessage(1, 2, false), undefined);
  assert.equal(
    wizardEmptyMessage(0, 0, false),
    "No safely configurable clients are available."
  );
});

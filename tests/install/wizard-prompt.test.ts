import assert from "node:assert/strict";
import test from "node:test";
import {
  initialWizardDesiredState,
  wizardEmptyMessage,
} from "../../src/install/wizard-prompt.js";

test("wizard initial desired state follows authoritative saved ownership", () => {
  assert.deepEqual(
    initialWizardDesiredState([
      {
        id: "detected-owned",
        name: "Detected owned",
        detected: true,
        current: true,
      },
      {
        id: "undetected-owned",
        name: "Undetected owned",
        detected: false,
        current: true,
      },
      {
        id: "detected-absent",
        name: "Detected absent",
        detected: true,
        current: false,
      },
      {
        id: "undetected-absent",
        name: "Undetected absent",
        detected: false,
        current: false,
      },
    ]),
    {
      "detected-owned": true,
      "undetected-owned": true,
      "detected-absent": false,
      "undetected-absent": false,
    }
  );
});

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

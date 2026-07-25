import { describe, expect, test } from "bun:test";
import type {
  AppPorts,
  ClientConfiguration,
  MeetingListItem,
  OperationContext,
  UiResult,
} from "../../src/app/ports.js";

function stateName<Value>(result: UiResult<Value>): string {
  switch (result.state) {
    case "loading":
    case "ok":
    case "empty":
    case "unavailable":
    case "invalid":
    case "error":
    case "cancelled":
      return result.state;
  }
}

describe("presentation-free UI ports", () => {
  test("keeps every operation state explicit and exhaustively discriminated", () => {
    const states: UiResult<unknown>[] = [
      { state: "loading" },
      { state: "ok", value: {} },
      { state: "empty" },
      { state: "unavailable", reason: "offline", action: "check-network" },
      { state: "invalid", issues: [{ code: "invalid" }] },
      { state: "error", error: { code: "failed", retryable: false } },
      { state: "cancelled" },
    ];
    expect(states.map(stateName)).toEqual([
      "loading",
      "ok",
      "empty",
      "unavailable",
      "invalid",
      "error",
      "cancelled",
    ]);
  });

  test("defines all required boundaries without dispatcher or store objects", () => {
    const expected: readonly (keyof AppPorts)[] = [
      "session",
      "status",
      "meetings",
      "search",
      "transcript",
      "summary",
      "participants",
      "recording",
      "auth",
      "clients",
      "daemon",
    ];
    expect(expected).toHaveLength(11);

    const item: MeetingListItem = {
      id: "synthetic-meeting-id",
      title: "Example",
      startedAtMs: 1,
      transcript: "ready",
    };
    const context: OperationContext = { signal: new AbortController().signal };
    expect(item.id).toBe("synthetic-meeting-id");
    expect(context.signal.aborted).toBe(false);

    const unavailable: ClientConfiguration = {
      id: "synthetic-client",
      name: "Example client",
      presence: {
        state: "unavailable",
        reason: "permission-denied",
        action: "check-permissions",
        detail: "configuration location could not be inspected",
      },
      registration: {
        state: "unavailable",
        reason: "ownership-unproven",
        action: "resolve-ownership",
        detail: "registration ownership could not be proven",
      },
    };
    expect(unavailable.presence.state).toBe("unavailable");
  });
});

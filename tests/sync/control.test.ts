import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearDaemonControl,
  daemonControlReady,
  daemonStopRequested,
  publishDaemonControl,
  requestDaemonStop,
} from "../../src/sync/control.js";

const roots: string[] = [];

function temporaryControlRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-control-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("cooperative daemon control", () => {
  test("targets the exact published instance and cleans its records", () => {
    const directory = temporaryControlRoot();
    const options = {
      directory,
      instanceId: "00000000-0000-4000-8000-000000000001",
    };
    expect(
      daemonControlReady(1234, options.instanceId, options),
    ).toBe(false);
    const identity = publishDaemonControl(1234, options);

    expect(
      daemonControlReady(1234, options.instanceId, options),
    ).toBe(true);
    expect(
      daemonControlReady(5678, options.instanceId, options),
    ).toBe(false);
    expect(
      daemonControlReady(
        1234,
        "00000000-0000-4000-8000-000000000099",
        options,
      ),
    ).toBe(false);
    expect(daemonStopRequested(identity.instanceId, options)).toBe(false);
    expect(requestDaemonStop(1234, options)).toEqual(identity);
    expect(daemonStopRequested(identity.instanceId, options)).toBe(true);
    expect(
      daemonStopRequested("00000000-0000-4000-8000-000000000002", options),
    ).toBe(false);

    clearDaemonControl(identity, options);
    expect(
      daemonControlReady(1234, options.instanceId, options),
    ).toBe(false);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  test("refuses a PID that does not match the active control record", () => {
    const directory = temporaryControlRoot();
    const options = {
      directory,
      instanceId: "00000000-0000-4000-8000-000000000003",
    };
    publishDaemonControl(1234, options);

    expect(() => requestDaemonStop(5678, options)).toThrow(
      /no matching cooperative control record/u,
    );
    expect(
      fs.existsSync(path.join(directory, "daemon-stop.json")),
    ).toBe(false);
  });

  test("an old cleanup cannot remove a successor instance", () => {
    const directory = temporaryControlRoot();
    const first = publishDaemonControl(1234, {
      directory,
      instanceId: "00000000-0000-4000-8000-000000000004",
    });
    const successor = publishDaemonControl(5678, {
      directory,
      instanceId: "00000000-0000-4000-8000-000000000005",
    });

    clearDaemonControl(first, { directory });
    expect(requestDaemonStop(5678, { directory })).toEqual(successor);
  });
});

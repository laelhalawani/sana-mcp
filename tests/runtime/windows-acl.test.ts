import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureWindowsPrivateRoot,
  resolveWindowsAclExecutable,
} from "../../src/runtime/windows-acl.js";

describe("Windows private-root ACL adapter", () => {
  test("requires an authoritative local SystemRoot", () => {
    expect(() => resolveWindowsAclExecutable("")).toThrow();
    expect(() => resolveWindowsAclExecutable("\\\\server\\share")).toThrow();
    expect(() => resolveWindowsAclExecutable("relative")).toThrow();
  });

  test.skipIf(process.platform !== "win32")(
    "establishes each independent root once and trusts only a verified receipt",
    { timeout: 30_000 },
    () => {
      const roots = [
        fs.mkdtempSync(path.join(os.tmpdir(), "sana-acl-root-a-")),
        fs.mkdtempSync(path.join(os.tmpdir(), "sana-acl-root-b-")),
      ];
      try {
        const systemRoot = process.env.SystemRoot;
        expect(systemRoot).toBeTruthy();
        for (const root of roots) {
          const child = path.join(root, "session.json");
          fs.writeFileSync(child, "{}");
          ensureWindowsPrivateRoot({
            root,
            knownPaths: [root, child],
            systemRoot,
          });
          expect(
            fs.existsSync(path.join(root, ".sana-acl-setup-v1.json")),
          ).toBe(true);
        }

        const outside = fs.mkdtempSync(
          path.join(os.tmpdir(), "sana-acl-outside-"),
        );
        roots.push(outside);
        expect(() =>
          ensureWindowsPrivateRoot({
            root: roots[0]!,
            knownPaths: [outside],
            systemRoot,
          }),
        ).toThrow(/outside the canonical private root/);

        // A valid receipt returns before resolving or launching another helper.
        for (const root of roots.slice(0, 2)) {
          ensureWindowsPrivateRoot({
            root,
            knownPaths: [root],
            systemRoot: "invalid",
          });
        }
      } finally {
        for (const root of roots) {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );
});

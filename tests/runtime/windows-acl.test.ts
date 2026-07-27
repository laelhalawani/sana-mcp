import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureWindowsPrivateRoot,
  resolveWindowsAclExecutable,
} from "../../src/runtime/windows-acl.js";

const ACL_RECEIPT_NAME = ".sana-acl-setup-v1.json";

function readAccessSddl(
  executable: string,
  target: string,
  systemRoot: string,
  modulePath: string,
): string {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String($env:SANA_ACL_SENTINEL)
)
$sections = [Security.AccessControl.AccessControlSections]::Access
$acl = [IO.File]::GetAccessControl($target, $sections)
[Console]::Out.Write($acl.GetSecurityDescriptorSddlForm($sections))
`;
  const result = spawnSync(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PSModulePath: modulePath,
        SANA_ACL_SENTINEL: Buffer.from(target, "utf8").toString("base64"),
        SystemRoot: systemRoot,
      },
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `ACL sentinel inspection failed: ${
        result.error?.message || result.stderr || result.stdout
      }`,
    );
  }
  return result.stdout;
}

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
            fs.existsSync(path.join(root, ACL_RECEIPT_NAME)),
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

  test.skipIf(process.platform !== "win32")(
    "does not depend on PSModulePath and verifies the exact published ACL",
    { timeout: 30_000 },
    () => {
      const sandbox = fs.mkdtempSync(
        path.join(os.tmpdir(), "sana-acl-module-independent-"),
      );
      try {
        const root = path.join(sandbox, "private");
        const child = path.join(root, "session.json");
        const incompatibleModulePath = path.join(sandbox, "empty-modules");
        const outsideSentinel = path.join(sandbox, "outside-sentinel.json");
        fs.mkdirSync(root);
        fs.mkdirSync(incompatibleModulePath);
        fs.writeFileSync(child, "{}");
        fs.writeFileSync(outsideSentinel, "outside");

        const systemRoot = process.env.SystemRoot;
        expect(systemRoot).toBeTruthy();
        const executable = resolveWindowsAclExecutable(systemRoot!);
        const sentinelAclBefore = readAccessSddl(
          executable,
          outsideSentinel,
          systemRoot!,
          incompatibleModulePath,
        );
        const request = { root, knownPaths: [root, child], systemRoot };
        const inheritedEnvironment = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              key.toLowerCase() !== "sana_acl_setup" &&
              key.toLowerCase() !== "systemroot",
          ),
        );
        const adapterUrl = pathToFileURL(
          path.resolve(import.meta.dir, "../../src/runtime/windows-acl.ts"),
        ).href;
        const source = [
          `import { ensureWindowsPrivateRoot } from ${JSON.stringify(adapterUrl)};`,
          "const serialized = process.env.SANA_ACL_REGRESSION_REQUEST;",
          'if (!serialized) throw new Error("missing ACL regression request");',
          "const attackerSetup = process.env.SANA_ACL_ATTACKER_SETUP;",
          "const attackerSystemRoot = process.env.SANA_ACL_ATTACKER_SYSTEM_ROOT;",
          'if (!attackerSetup || !attackerSystemRoot) throw new Error("missing attacker values");',
          "for (const key of Object.keys(process.env)) {",
          '  if (key.toLowerCase() === "sana_acl_setup" || key.toLowerCase() === "systemroot") {',
          "    delete process.env[key];",
          "  }",
          "}",
          "process.env.sana_acl_setup = attackerSetup;",
          "process.env.systemroot = attackerSystemRoot;",
          "ensureWindowsPrivateRoot(JSON.parse(serialized));",
        ].join("\n");
        const applied = spawnSync(process.execPath, ["-e", source], {
          cwd: sandbox,
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...inheritedEnvironment,
            PSModulePath: incompatibleModulePath,
            SystemRoot: systemRoot!,
            SANA_ACL_ATTACKER_SETUP: JSON.stringify({
              root: sandbox,
              paths: [outsideSentinel],
            }),
            SANA_ACL_ATTACKER_SYSTEM_ROOT: incompatibleModulePath,
            SANA_ACL_REGRESSION_REQUEST: JSON.stringify(request),
          },
        });
        expect(applied.error).toBeUndefined();
        expect(applied.status, applied.stderr || applied.stdout).toBe(0);

        const canonicalRoot = fs.realpathSync.native(root);
        const receiptPath = path.join(canonicalRoot, ACL_RECEIPT_NAME);
        expect(fs.lstatSync(receiptPath).isFile()).toBe(true);
        expect(JSON.parse(fs.readFileSync(receiptPath, "utf8"))).toEqual({
          version: 1,
          root: canonicalRoot,
          setup: "complete",
        });
        expect(fs.readFileSync(outsideSentinel, "utf8")).toBe("outside");
        expect(
          readAccessSddl(
            executable,
            outsideSentinel,
            systemRoot!,
            incompatibleModulePath,
          ),
        ).toBe(sentinelAclBefore);

        const verifyScript = String.raw`
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$sections = [Security.AccessControl.AccessControlSections]::Access
$targets = @(
  @([string]$env:SANA_ACL_VERIFY_ROOT, $true),
  @([string]$env:SANA_ACL_VERIFY_CHILD, $false)
)
foreach ($expected in $targets) {
  $target = [string]$expected[0]
  $isDirectory = [bool]$expected[1]
  $inheritance = if ($isDirectory) {
    [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else {
    [Security.AccessControl.InheritanceFlags]::None
  }
  $acl = if ($isDirectory) {
    [IO.Directory]::GetAccessControl($target, $sections)
  } else {
    [IO.File]::GetAccessControl($target, $sections)
  }
  $rules = @($acl.GetAccessRules(
    $true,
    $true,
    [Security.Principal.SecurityIdentifier]
  ))
  if ($acl.AreAccessRulesProtected -ne $true -or
      $rules.Count -ne 1 -or
      $rules[0].IsInherited -ne $false -or
      $rules[0].AccessControlType -ne
        [Security.AccessControl.AccessControlType]::Allow -or
      $rules[0].IdentityReference.Value -ne $sid.Value -or
      $rules[0].FileSystemRights -ne
        [Security.AccessControl.FileSystemRights]::FullControl -or
      $rules[0].InheritanceFlags -ne $inheritance -or
      $rules[0].PropagationFlags -ne
        [Security.AccessControl.PropagationFlags]::None) {
    throw "unexpected ACL: $target"
  }
}
`;
        const verified = spawnSync(
          executable,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            verifyScript,
          ],
          {
            encoding: "utf8",
            timeout: 10_000,
            env: {
              ...process.env,
              PSModulePath: incompatibleModulePath,
              SANA_ACL_VERIFY_ROOT: canonicalRoot,
              SANA_ACL_VERIFY_CHILD: fs.realpathSync.native(child),
              SystemRoot: systemRoot!,
            },
          },
        );
        expect(verified.error).toBeUndefined();
        expect(verified.status, verified.stderr || verified.stdout).toBe(0);
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
        expect(fs.existsSync(sandbox)).toBe(false);
      }
    },
  );
});

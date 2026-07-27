import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const RECEIPT_NAME = ".sana-acl-setup-v1.json";
const RECEIPT_VERSION = 1;
const SETUP_TIMEOUT_MS = 8_000;
const MAX_RECEIPT_BYTES = 16 * 1024;
const RESERVED_ACL_ENVIRONMENT_KEYS = new Set([
  "sana_acl_setup",
  "systemroot",
]);

export interface WindowsAclSetupRequest {
  readonly root: string;
  readonly knownPaths: readonly string[];
  readonly systemRoot: string | undefined;
}

export type WindowsAclSetup = (request: WindowsAclSetupRequest) => void;

interface SetupReceipt {
  readonly version: 1;
  readonly root: string;
  readonly setup: "complete";
}

function isReparse(stats: fs.Stats): boolean {
  const tag = (stats as fs.Stats & { reparsePointTag?: number }).reparsePointTag;
  return stats.isSymbolicLink() || (tag !== undefined && tag !== 0);
}

function assertOrdinaryDirectory(target: string): string {
  const stats = fs.lstatSync(target);
  if (!stats.isDirectory() || isReparse(stats)) {
    throw new Error(`Windows private root is not an ordinary directory: ${target}`);
  }
  return fs.realpathSync.native(target);
}

function assertOrdinaryFile(target: string): string {
  const stats = fs.lstatSync(target);
  if (!stats.isFile() || isReparse(stats)) {
    throw new Error(`Windows system ACL executable is not a regular file: ${target}`);
  }
  return fs.realpathSync.native(target);
}

export function resolveWindowsAclExecutable(systemRoot: string): string {
  if (
    typeof systemRoot !== "string" ||
    systemRoot.trim() === "" ||
    !path.win32.isAbsolute(systemRoot) ||
    systemRoot.startsWith("\\\\")
  ) {
    throw new Error(
      "SystemRoot must be an authoritative local absolute Windows directory",
    );
  }
  const canonicalRoot = assertOrdinaryDirectory(systemRoot);
  const system32 = assertOrdinaryDirectory(
    path.win32.join(canonicalRoot, "System32"),
  );
  const executable = assertOrdinaryFile(
    path.win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
  );
  const relative = path.win32.relative(system32, executable);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.win32.sep}`) ||
    path.win32.isAbsolute(relative)
  ) {
    throw new Error("Windows ACL executable resolved outside canonical System32");
  }
  return executable;
}

function receiptFor(root: string): SetupReceipt {
  return { version: RECEIPT_VERSION, root, setup: "complete" };
}

function validReceipt(root: string): boolean {
  const receiptPath = path.join(root, RECEIPT_NAME);
  try {
    const stats = fs.lstatSync(receiptPath);
    if (!stats.isFile() || isReparse(stats) || stats.size > MAX_RECEIPT_BYTES) {
      return false;
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    return (
      Object.keys(record).length === 3 &&
      record.version === RECEIPT_VERSION &&
      record.root === root &&
      record.setup === "complete"
    );
  } catch {
    return false;
  }
}

function publishReceipt(root: string): void {
  const target = path.join(root, RECEIPT_NAME);
  const temporary = path.join(
    root,
    `.${RECEIPT_NAME}.tmp.${process.pid}.${crypto.randomUUID()}`,
  );
  const serialized = `${JSON.stringify(receiptFor(root), null, 2)}\n`;
  let descriptor: number | undefined;
  let published = false;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.writeFileSync(descriptor, serialized);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      const existing = fs.lstatSync(target);
      if (!existing.isFile() || isReparse(existing)) {
        throw new Error("Windows ACL setup receipt target is unsafe");
      }
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )
      ) {
        throw error;
      }
    }
    fs.renameSync(temporary, target);
    published = true;

    const stats = fs.lstatSync(target);
    if (
      !stats.isFile() ||
      isReparse(stats) ||
      fs.readFileSync(target, "utf8") !== serialized ||
      !validReceipt(root)
    ) {
      throw new Error("Windows ACL setup receipt verification failed");
    }
  } catch (error) {
    const cleanup: unknown[] = [];
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (closeError) {
        cleanup.push(closeError);
      }
    }
    if (!published) {
      try {
        fs.unlinkSync(temporary);
      } catch (unlinkError) {
        if (
          !(
            unlinkError instanceof Error &&
            "code" in unlinkError &&
            (unlinkError as NodeJS.ErrnoException).code === "ENOENT"
          )
        ) {
          cleanup.push(unlinkError);
        }
      }
    }
    if (cleanup.length > 0) {
      throw new AggregateError(
        [error, ...cleanup],
        `Windows ACL receipt publication and cleanup failed for ${root}`,
      );
    }
    throw error;
  }
}

function aclEnvironment(
  systemRoot: string,
  setup: { readonly root: string; readonly paths: readonly string[] },
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (RESERVED_ACL_ENVIRONMENT_KEYS.has(key.toLowerCase())) continue;
    environment[key] = value;
  }
  environment.SystemRoot = systemRoot;
  environment.SANA_ACL_SETUP = JSON.stringify(setup);
  return environment;
}

const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$payload = ConvertFrom-Json -InputObject $env:SANA_ACL_SETUP
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
$targets = [Collections.Generic.List[string]]::new()
foreach ($candidate in @($payload.paths)) {
  if (-not $targets.Contains([string]$candidate)) { $targets.Add([string]$candidate) }
}
foreach ($child in @(Get-ChildItem -LiteralPath ([string]$payload.root) -Force -Recurse)) {
  if (-not $targets.Contains($child.FullName)) { $targets.Add($child.FullName) }
}
foreach ($target in $targets) {
  $item = Get-Item -LiteralPath $target -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "ACL target is a reparse point: $target"
  }
  $isDirectory = $item.PSIsContainer
  $sections = [Security.AccessControl.AccessControlSections]::Access
  $acl = if ($isDirectory) {
    [IO.Directory]::GetAccessControl($target, $sections)
  } else {
    [IO.File]::GetAccessControl($target, $sections)
  }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($existing in @($acl.Access)) {
    [void]$acl.RemoveAccessRuleSpecific($existing)
  }
  $inheritance = if ($isDirectory) {
    [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else {
    [Security.AccessControl.InheritanceFlags]::None
  }
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
  if ($isDirectory) {
    [IO.Directory]::SetAccessControl($target, $acl)
  } else {
    [IO.File]::SetAccessControl($target, $acl)
  }
  $verified = if ($isDirectory) {
    [IO.Directory]::GetAccessControl($target, $sections)
  } else {
    [IO.File]::GetAccessControl($target, $sections)
  }
  $verifiedRules = @($verified.GetAccessRules(
    $true,
    $true,
    [Security.Principal.SecurityIdentifier]
  ))
  if ($verified.AreAccessRulesProtected -ne $true -or
      $verifiedRules.Count -ne 1 -or
      $verifiedRules[0].IsInherited -ne $false -or
      $verifiedRules[0].AccessControlType -ne
        [Security.AccessControl.AccessControlType]::Allow -or
      $verifiedRules[0].IdentityReference.Value -ne $sid.Value -or
      $verifiedRules[0].FileSystemRights -ne
        [Security.AccessControl.FileSystemRights]::FullControl -or
      $verifiedRules[0].InheritanceFlags -ne $inheritance -or
      $verifiedRules[0].PropagationFlags -ne
        [Security.AccessControl.PropagationFlags]::None) {
    throw "ACL verification failed: $target"
  }
}
`;

export const ensureWindowsPrivateRoot: WindowsAclSetup = (request): void => {
  const canonicalRoot = assertOrdinaryDirectory(request.root);
  const known = [...new Set([canonicalRoot, ...request.knownPaths])].map(
    (target) => fs.realpathSync.native(target),
  );
  for (const target of known) {
    const relative = path.win32.relative(canonicalRoot, target);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.win32.sep}`) ||
      path.win32.isAbsolute(relative)
    ) {
      throw new Error(
        `Windows ACL setup path is outside the canonical private root: ${target}`,
      );
    }
  }
  if (validReceipt(canonicalRoot)) return;
  if (!request.systemRoot) {
    throw new Error(
      `SystemRoot is required to establish Windows private storage at ${canonicalRoot}`,
    );
  }
  const executable = resolveWindowsAclExecutable(request.systemRoot);
  const result = spawnSync(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      ACL_SCRIPT,
    ],
    {
      windowsHide: true,
      timeout: SETUP_TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: aclEnvironment(request.systemRoot, {
        root: canonicalRoot,
        paths: known,
      }),
    },
  );
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ||
      result.stderr.trim() ||
      `PowerShell exited with status ${String(result.status)}`;
    throw new Error(
      `Windows private-storage ACL setup failed for ${canonicalRoot}: ${detail}`,
      { cause: result.error },
    );
  }
  publishReceipt(canonicalRoot);
};

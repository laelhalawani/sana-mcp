import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { BUILD_INFO } from "../runtime/build-info.js";
import { isReleaseSemver, isReleaseTag } from "../release/contract.js";

const REPOSITORY = "Etals-AiApp/sana-ai-mcp";
const RECEIPT_NAME = ".sana-mcp-install-v1";
const CHECKSUM = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const RECEIPT_KEYS = new Set([
  "format",
  "version",
  "target",
  "sourceCommit",
  "binarySha256",
  "pathManaged",
  "pathProfile",
  "pathBlockSha256",
  "installerProtocol",
  "lifecycleProtocol",
  "inspectProtocol",
  "stateCompatibility",
]);
const RELEASE_KEYS = new Set([
  "format",
  "manifestVersion",
  "manifestSha256",
  "packageVersion",
  "releaseTag",
  "sourceCommit",
  "installerProtocol",
  "lifecycleProtocol",
  "inspectProtocol",
  "stateCompatibility",
  "semanticCapability",
  "installerAssetName",
  "installerSha256",
  "target",
  "libc",
  "assetName",
  "checksumFileName",
  "sha256",
]);

export type UpdateResult =
  | Readonly<{ state: "current"; version: string }>
  | Readonly<{ state: "newer"; version: string; latestVersion: string }>
  | Readonly<{ state: "cancelled"; version: string }>
  | Readonly<{ state: "updated"; version: string }>
  | Readonly<{ state: "handed-off"; version: string; resultFile: string }>;

function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function parseProperties(
  body: string,
  allowedKeys: ReadonlySet<string>,
  label: string,
): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of body.split(/\r?\n/u)) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`${label} properties are malformed`);
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (
      !/^[A-Za-z][A-Za-z0-9]*$/u.test(key) ||
      !allowedKeys.has(key) ||
      value === "" ||
      /[\r\n]/u.test(value) ||
      values.has(key)
    ) {
      throw new Error(`${label} properties are malformed`);
    }
    values.set(key, value);
  }
  return values;
}

function required(
  values: Map<string, string>,
  key: string,
  label = "release",
): string {
  const value = values.get(key);
  if (value === undefined) throw new Error(`${label} properties are missing ${key}`);
  return value;
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function semverParts(version: string): {
  core: readonly [bigint, bigint, bigint];
  prerelease: readonly (bigint | string)[];
} {
  if (!isReleaseSemver(version)) throw new Error("release version is invalid");
  const withoutBuild = version.split("+", 1)[0]!;
  const prereleaseSeparator = withoutBuild.indexOf("-");
  const coreText =
    prereleaseSeparator === -1
      ? withoutBuild
      : withoutBuild.slice(0, prereleaseSeparator);
  const prereleaseText =
    prereleaseSeparator === -1
      ? undefined
      : withoutBuild.slice(prereleaseSeparator + 1);
  const core = coreText.split(".").map(BigInt) as [bigint, bigint, bigint];
  const prerelease =
    prereleaseText === undefined
      ? []
      : prereleaseText
          .split(".")
          .map((part) => (/^(0|[1-9][0-9]*)$/u.test(part) ? BigInt(part) : part));
  return { core, prerelease };
}

function compareSemver(left: string, right: string): number {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index]! < b.core[index]! ? -1 : 1;
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length
      ? 0
      : a.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    if (typeof x === "bigint" && typeof y === "string") return -1;
    if (typeof x === "string" && typeof y === "bigint") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function readInstalledReceipt(): {
  installDirectory: string;
  stateCompatibility: number;
  version: string;
  target: string;
  binarySha256: string;
} {
  if (!BUILD_INFO.standalone || BUILD_INFO.target === null) {
    throw new Error(
      "sana-mcp update is available only from an installed standalone release",
    );
  }
  const executable = path.resolve(process.execPath);
  const installDirectory = path.dirname(executable);
  const expectedName = BUILD_INFO.target.startsWith("bun-windows-")
    ? "sana-mcp.exe"
    : "sana-mcp";
  if (path.basename(executable) !== expectedName) {
    throw new Error(
      "This executable is not at the canonical installed path; use the one-line installer",
    );
  }
  const receiptFile = path.join(installDirectory, RECEIPT_NAME);
  const receipt = parseProperties(
    fs.readFileSync(receiptFile, "utf8"),
    RECEIPT_KEYS,
    "installer receipt",
  );
  const format = required(receipt, "format", "installer receipt");
  if (format !== "sana-mcp-install-v1" && format !== "sana-mcp-install-v2") {
    throw new Error("The adjacent installer receipt is unsupported");
  }
  for (const key of [
    "version",
    "target",
    "sourceCommit",
    "binarySha256",
  ]) {
    required(receipt, key, "installer receipt");
  }
  if (
    !/^[a-f0-9]{40}$/u.test(required(receipt, "sourceCommit", "installer receipt")) ||
    !/^[a-f0-9]{64}$/u.test(
      required(receipt, "binarySha256", "installer receipt"),
    )
  ) {
    throw new Error("The adjacent installer receipt is malformed");
  }
  if (
    required(receipt, "version", "installer receipt") !== BUILD_INFO.version ||
    required(receipt, "target", "installer receipt") !== BUILD_INFO.target
  ) {
    throw new Error("The adjacent installer receipt does not match this runtime");
  }
  const expectedHash = required(receipt, "binarySha256", "installer receipt");
  if (BUILD_INFO.target.startsWith("bun-windows-")) {
    if (
      !/^(?:true|false)$/u.test(
        required(receipt, "pathManaged", "installer receipt"),
      ) ||
      receipt.has("pathProfile") ||
      receipt.has("pathBlockSha256")
    ) {
      throw new Error("The adjacent Windows installer receipt is malformed");
    }
  } else {
    const profile = required(receipt, "pathProfile", "installer receipt");
    const blockSha256 = required(
      receipt,
      "pathBlockSha256",
      "installer receipt",
    );
    if (
      !/^(?:bashrc|zshrc|profile|none)$/u.test(profile) ||
      (profile === "none"
        ? blockSha256 !== "none"
        : !/^[a-f0-9]{64}$/u.test(blockSha256)) ||
      receipt.has("pathManaged")
    ) {
      throw new Error("The adjacent POSIX installer receipt is malformed");
    }
  }
  const actualHash = sha256(fs.readFileSync(executable));
  if (expectedHash !== actualHash) {
    throw new Error("The installed executable no longer matches its receipt");
  }
  let stateCompatibility: number;
  if (format === "sana-mcp-install-v1") {
    for (const key of [
      "installerProtocol",
      "lifecycleProtocol",
      "inspectProtocol",
      "stateCompatibility",
    ]) {
      if (receipt.has(key)) {
        throw new Error("The adjacent v1 installer receipt contains v2 state");
      }
    }
    stateCompatibility = 1;
  } else {
    for (const [key, expected] of [
      ["installerProtocol", BUILD_INFO.installerProtocol],
      ["lifecycleProtocol", BUILD_INFO.lifecycleProtocol],
      ["inspectProtocol", BUILD_INFO.inspectProtocol],
    ] as const) {
      if (
        parsePositiveInteger(
          required(receipt, key, "installer receipt"),
          `receipt ${key}`,
        ) !== expected
      ) {
        throw new Error(`The installed receipt has an unsupported ${key}`);
      }
    }
    stateCompatibility = parsePositiveInteger(
      required(receipt, "stateCompatibility", "installer receipt"),
      "receipt state compatibility",
    );
  }
  if (stateCompatibility !== BUILD_INFO.stateCompatibility) {
    throw new Error("The installed receipt and runtime disagree on state compatibility");
  }
  return {
    installDirectory,
    stateCompatibility,
    version: BUILD_INFO.version,
    target: BUILD_INFO.target,
    binarySha256: expectedHash,
  };
}

async function fetchBytes(url: string, maximumBytes: number): Promise<Uint8Array> {
  let current = new URL(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (current.protocol !== "https:") {
      throw new Error("download refused a non-HTTPS URL");
    }
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(300_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null || redirects === 5) {
        throw new Error("download returned an invalid redirect");
      }
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      throw new Error(`download failed with HTTP ${response.status}`);
    }
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength) ||
        BigInt(declaredLength) > BigInt(maximumBytes))
    ) {
      throw new Error("download exceeded its size limit");
    }
    if (response.body === null) {
      return new Uint8Array();
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error("download exceeded its size limit");
      }
      chunks.push(next.value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  }
  throw new Error("download exceeded its redirect limit");
}

async function fetchLatestMetadata(target: string): Promise<{
  version: string;
  tag: string;
  stateCompatibility: number;
  installerName: "install.ps1" | "install.sh";
  installerSha256: string;
}> {
  const name = `manifest-${target}.properties`;
  const base = `https://github.com/${REPOSITORY}/releases/latest/download`;
  const [body, checksumBody] = await Promise.all([
    fetchBytes(`${base}/${name}`, 1024 * 1024),
    fetchBytes(`${base}/${name}.sha256`, 4096),
  ]);
  const checksumText = new TextDecoder().decode(checksumBody).trimEnd();
  const match = CHECKSUM.exec(checksumText);
  if (match === null || match[2] !== name || match[1] !== sha256(body)) {
    throw new Error("latest release metadata checksum mismatch");
  }
  const values = parseProperties(
    new TextDecoder().decode(body),
    RELEASE_KEYS,
    "release",
  );
  for (const key of [
    "format",
    "manifestVersion",
    "manifestSha256",
    "packageVersion",
    "releaseTag",
    "sourceCommit",
    "installerProtocol",
    "lifecycleProtocol",
    "inspectProtocol",
    "stateCompatibility",
    "semanticCapability",
    "installerAssetName",
    "installerSha256",
    "target",
    "assetName",
    "checksumFileName",
    "sha256",
  ]) {
    required(values, key);
  }
  if (
    required(values, "format") !== "sana-mcp-release-v1" ||
    required(values, "manifestVersion") !== "1" ||
    !/^[a-f0-9]{64}$/u.test(required(values, "manifestSha256")) ||
    !/^[a-f0-9]{40}$/u.test(required(values, "sourceCommit")) ||
    required(values, "installerProtocol") !==
      String(BUILD_INFO.installerProtocol) ||
    required(values, "lifecycleProtocol") !==
      String(BUILD_INFO.lifecycleProtocol) ||
    required(values, "inspectProtocol") !== String(BUILD_INFO.inspectProtocol)
  ) {
    throw new Error("latest release metadata uses an unsupported contract");
  }
  const version = required(values, "packageVersion");
  const tag = required(values, "releaseTag");
  if (!isReleaseSemver(version) || !isReleaseTag(tag) || tag !== `v${version}`) {
    throw new Error("latest release metadata has an invalid version");
  }
  if (required(values, "target") !== target) {
    throw new Error("latest release metadata targets a different runtime");
  }
  const expectedInstaller = target.startsWith("bun-windows-")
    ? "install.ps1"
    : "install.sh";
  const installerName = required(values, "installerAssetName");
  if (installerName !== expectedInstaller) {
    throw new Error("latest release metadata names the wrong installer");
  }
  const installerSha256 = required(values, "installerSha256");
  if (!/^[a-f0-9]{64}$/u.test(installerSha256)) {
    throw new Error("latest release metadata has an invalid installer checksum");
  }
  return {
    version,
    tag,
    stateCompatibility: parsePositiveInteger(
      required(values, "stateCompatibility"),
      "release state compatibility",
    ),
    installerName,
    installerSha256,
  };
}

function systemPowerShell(): string {
  const windows = process.env.SystemRoot;
  if (windows === undefined || !path.win32.isAbsolute(windows)) {
    throw new Error("Windows did not provide an authoritative system directory");
  }
  const executable = path.win32.join(
    windows,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (!fs.statSync(executable).isFile()) {
    throw new Error("System Windows PowerShell is unavailable");
  }
  return executable;
}

function currentProcessStartTicks(powershell: string): string {
  const result = spawnSync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const value = result.stdout.trim();
  if (result.status !== 0 || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("Could not establish the updater process identity");
  }
  return value;
}

const WINDOWS_WRAPPER = String.raw`param(
  [int] $ParentId,
  [long] $ParentStartTicks,
  [string] $ReadyFile,
  [string] $ResultFile,
  [string] $InstallerFile,
  [string] $InstallDirectory,
  [string] $ReleaseTag,
  [string] $TemporaryDirectory,
  [string] $InstallerSha256,
  [string] $ExpectedInstalledVersion,
  [string] $ExpectedInstalledTarget,
  [string] $ExpectedInstalledSha256,
  [int] $ExpectedInstalledStateCompatibility,
  [int] $ReplaceIncompatible
)
$ErrorActionPreference = "Stop"
try {
  if ($ReplaceIncompatible -ne 0 -and $ReplaceIncompatible -ne 1) {
    throw "invalid incompatible-replacement handoff state"
  }
  $Parent = Get-Process -Id $ParentId -ErrorAction Stop
  if ($Parent.StartTime.ToUniversalTime().Ticks -ne $ParentStartTicks) {
    throw "update parent identity changed before handoff"
  }
  $ActualInstallerSha256 = (Get-FileHash -LiteralPath $InstallerFile -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ActualInstallerSha256 -cne $InstallerSha256) {
    throw "update installer changed before handoff"
  }
  [IO.File]::WriteAllText($ReadyFile, "ready" + [Environment]::NewLine, [Text.Encoding]::ASCII)
  $Parent.WaitForExit()
  $ActualInstallerSha256 = (Get-FileHash -LiteralPath $InstallerFile -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ActualInstallerSha256 -cne $InstallerSha256) {
    throw "update installer changed while waiting for the parent to exit"
  }
  $env:SANA_MCP_VERSION = $ReleaseTag
  $env:SANA_MCP_INSTALL_DIR = $InstallDirectory
  $env:SANA_MCP_UPDATE = "1"
  $env:SANA_MCP_EXPECTED_INSTALLED_VERSION = $ExpectedInstalledVersion
  $env:SANA_MCP_EXPECTED_INSTALLED_TARGET = $ExpectedInstalledTarget
  $env:SANA_MCP_EXPECTED_INSTALLED_SHA256 = $ExpectedInstalledSha256
  $env:SANA_MCP_EXPECTED_INSTALLED_STATE_COMPATIBILITY = [string] $ExpectedInstalledStateCompatibility
  Remove-Item Env:SANA_MCP_REPLACE_INCOMPATIBLE -ErrorAction SilentlyContinue
  if ($ReplaceIncompatible -eq 1) {
    $env:SANA_MCP_REPLACE_INCOMPATIBLE = "1"
  }
  & $InstallerFile
  [IO.File]::WriteAllText($ResultFile, "state=updated" + [Environment]::NewLine, [Text.Encoding]::ASCII)
} catch {
  [Console]::Error.WriteLine("sana-mcp update failed: " + $_.Exception.Message)
  try {
    [IO.File]::WriteAllText(
      $ResultFile,
      "state=failed" + [Environment]::NewLine +
        "message=" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.ToString())) +
        [Environment]::NewLine,
      [Text.Encoding]::ASCII
    )
  } catch {}
  [Console]::Error.WriteLine("Update diagnostics were retained at " + $TemporaryDirectory)
  exit 1
}
try {
  Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force
} catch {
  [Console]::Error.WriteLine("sana-mcp update succeeded, but temporary files could not be removed: " + $_.Exception.Message)
}
`;

async function handOffWindows(options: {
  installer: Uint8Array;
  installDirectory: string;
  tag: string;
  installerSha256: string;
  expectedInstalledVersion: string;
  expectedInstalledTarget: string;
  expectedInstalledSha256: string;
  expectedInstalledStateCompatibility: number;
  replaceIncompatible: boolean;
}): Promise<UpdateResult> {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sana-mcp-update-"));
  let preserveDiagnostics = false;
  try {
    fs.chmodSync(temporary, 0o700);
    const installerFile = path.join(temporary, "install.ps1");
    const wrapperFile = path.join(temporary, "update-wrapper.ps1");
    const readyFile = path.join(temporary, "ready");
    const resultFile = path.join(temporary, "result.properties");
    fs.writeFileSync(installerFile, options.installer, { mode: 0o600 });
    fs.writeFileSync(wrapperFile, WINDOWS_WRAPPER, { mode: 0o600 });
    const powershell = systemPowerShell();
    const startTicks = currentProcessStartTicks(powershell);
    const child = spawn(
      powershell,
      [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      wrapperFile,
      "-ParentId",
      String(process.pid),
      "-ParentStartTicks",
      startTicks,
      "-ReadyFile",
      readyFile,
      "-ResultFile",
      resultFile,
      "-InstallerFile",
      installerFile,
      "-InstallDirectory",
      options.installDirectory,
      "-ReleaseTag",
      options.tag,
      "-TemporaryDirectory",
      temporary,
      "-InstallerSha256",
      options.installerSha256,
      "-ExpectedInstalledVersion",
      options.expectedInstalledVersion,
      "-ExpectedInstalledTarget",
      options.expectedInstalledTarget,
      "-ExpectedInstalledSha256",
      options.expectedInstalledSha256,
      "-ExpectedInstalledStateCompatibility",
      String(options.expectedInstalledStateCompatibility),
      "-ReplaceIncompatible",
      options.replaceIncompatible ? "1" : "0",
      ],
      { stdio: "inherit", windowsHide: false },
    );
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(readyFile)) {
      if (child.exitCode !== null) {
        preserveDiagnostics = true;
        throw new Error(
          `Windows updater handoff exited with ${child.exitCode}; diagnostics were retained at ${temporary}`,
        );
      }
      if (Date.now() >= deadline) {
        child.kill();
        preserveDiagnostics = true;
        throw new Error(
          `Windows updater did not acknowledge the handoff; diagnostics were retained at ${temporary}`,
        );
      }
      await Bun.sleep(25);
    }
    child.unref();
    return { state: "handed-off", version: options.tag.slice(1), resultFile };
  } catch (error) {
    if (!preserveDiagnostics) {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function runUpdate(options: {
  confirmIncompatible?: (current: number, next: number) => Promise<boolean>;
  /** Injected only by isolated contract tests before any platform operation. */
  platform?: NodeJS.Platform;
} = {}): Promise<UpdateResult> {
  const platform = options.platform ?? process.platform;
  const installed = readInstalledReceipt();
  const target = BUILD_INFO.target!;
  const latest = await fetchLatestMetadata(target);
  const comparison = compareSemver(BUILD_INFO.version, latest.version);
  if (comparison === 0) return { state: "current", version: BUILD_INFO.version };
  if (comparison > 0) {
    return {
      state: "newer",
      version: BUILD_INFO.version,
      latestVersion: latest.version,
    };
  }
  const incompatible =
    latest.stateCompatibility !== installed.stateCompatibility;
  if (
    incompatible &&
    platform !== "win32"
  ) {
    throw new Error(
      "This release changes local Sana state compatibility; automatic replacement is currently available only on Windows",
    );
  }
  if (
    incompatible &&
    process.env.SANA_MCP_REPLACE_INCOMPATIBLE !== "1" &&
    !(await options.confirmIncompatible?.(
      installed.stateCompatibility,
      latest.stateCompatibility,
    ))
  ) {
    return { state: "cancelled", version: BUILD_INFO.version };
  }
  const releaseBase = `https://github.com/${REPOSITORY}/releases/download/${latest.tag}`;
  const [installer, checksumBody] = await Promise.all([
    fetchBytes(`${releaseBase}/${latest.installerName}`, 512 * 1024 * 1024),
    fetchBytes(`${releaseBase}/${latest.installerName}.sha256`, 4096),
  ]);
  const checksum = CHECKSUM.exec(
    new TextDecoder().decode(checksumBody).trimEnd(),
  );
  if (
    checksum === null ||
    checksum[2] !== latest.installerName ||
    checksum[1] !== latest.installerSha256 ||
    sha256(installer) !== latest.installerSha256
  ) {
    throw new Error("release installer checksum mismatch");
  }
  if (platform === "win32") {
    return await handOffWindows({
      installer,
      installDirectory: installed.installDirectory,
      tag: latest.tag,
      installerSha256: latest.installerSha256,
      expectedInstalledVersion: installed.version,
      expectedInstalledTarget: installed.target,
      expectedInstalledSha256: installed.binarySha256,
      expectedInstalledStateCompatibility: installed.stateCompatibility,
      replaceIncompatible: incompatible,
    });
  }
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(`sana-mcp update does not support ${platform}`);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sana-mcp-update-"));
  try {
    const installerFile = path.join(temporary, "install.sh");
    fs.writeFileSync(installerFile, installer, { mode: 0o700 });
    const result = spawnSync("/bin/sh", [installerFile], {
      stdio: "inherit",
      env: {
        ...process.env,
        SANA_MCP_VERSION: latest.tag,
        SANA_MCP_INSTALL_DIR: installed.installDirectory,
        SANA_MCP_UPDATE: "1",
        SANA_MCP_EXPECTED_INSTALLED_VERSION: installed.version,
        SANA_MCP_EXPECTED_INSTALLED_TARGET: installed.target,
        SANA_MCP_EXPECTED_INSTALLED_SHA256: installed.binarySha256,
        SANA_MCP_EXPECTED_INSTALLED_STATE_COMPATIBILITY: String(
          installed.stateCompatibility,
        ),
        SANA_MCP_REPLACE_INCOMPATIBLE: incompatible ? "1" : "",
      },
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      throw new Error(`installer exited with ${result.status ?? "no status"}`);
    }
    return { state: "updated", version: latest.version };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

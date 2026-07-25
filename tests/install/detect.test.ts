import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appData,
  combineDetections,
  detectPath,
  detectVscodeExtension,
  home,
  isAuthoritativeWindowsAbsolute,
  localAppData,
  resolveCommand,
  xdgConfig,
} from "../../src/install/detect.js";

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sana-mcp-detect-"));
}

test("path detection distinguishes present, absent, and unavailable", () => {
  const directory = temporaryDirectory();
  try {
    const present = path.join(directory, "present");
    fs.writeFileSync(present, "x");
    assert.equal(detectPath(present).state, "present");
    assert.equal(detectPath(path.join(directory, "missing")).state, "absent");
    assert.equal(detectPath(undefined).state, "unavailable");
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("combined detection retains errors unless positive evidence exists", () => {
  assert.deepEqual(
    combineDetections([{ state: "absent" }, { state: "unavailable", reason: "denied" }]),
    { state: "unavailable", reason: "denied" }
  );
  assert.deepEqual(
    combineDetections([
      { state: "unavailable", reason: "denied" },
      { state: "present", evidence: ["/client"] },
    ]),
    { state: "present", evidence: ["/client"] }
  );
});

test("PATH command resolution is shell-free and reports absence", () => {
  const directory = temporaryDirectory();
  const oldPath = process.env.PATH;
  const sentinel = path.join(directory, "launched");
  try {
    const executable = path.join(directory, process.platform === "win32" ? "client.cmd" : "client");
    fs.writeFileSync(
      executable,
      process.platform === "win32"
        ? `@echo launched>\"${sentinel}\"\r\n`
        : `#!/bin/sh\nprintf launched > \"${sentinel}\"\n`,
      { mode: 0o700 }
    );
    process.env.PATH = directory;
    const found = resolveCommand("client");
    assert.equal(found.state, "present");
    if (found.state === "present") assert.equal(found.path, executable);
    assert.equal(fs.existsSync(sentinel), false);
    assert.equal(resolveCommand("missing").state, "absent");
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    fs.rmSync(directory, { recursive: true });
  }
});

test("extension scanning validates the prefix", () => {
  assert.equal(detectVscodeExtension("../").state, "unavailable");
});

test("an explicit non-canonical XDG path is invalid rather than normalized", () => {
  const previous = process.env.XDG_CONFIG_HOME;
  try {
    const values =
      process.platform === "win32"
        ? ["relative/config", "C:\\config\\..\\other", "C:\\"]
        : ["relative/config", "/config/../other", "/config/", "/"];
    for (const value of values) {
      process.env.XDG_CONFIG_HOME = value;
      assert.equal(xdgConfig().state, "unavailable", value);
    }
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

test("native Windows app-data roots use canonical directory validation", () => {
  if (process.platform !== "win32") return;
  const previousAppData = process.env.APPDATA;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  try {
    process.env.APPDATA = "C:\\Users\\Sana\\AppData\\Roaming";
    process.env.LOCALAPPDATA = "C:\\Users\\Sana\\AppData\\Local";
    assert.equal(appData().state, "available");
    assert.equal(localAppData().state, "available");
    process.env.APPDATA = "C:\\Users\\Sana\\..\\Other";
    process.env.LOCALAPPDATA = "C:\\Users\\NUL\\AppData";
    assert.equal(appData().state, "unavailable");
    assert.equal(localAppData().state, "unavailable");
  } finally {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
  }
});

test("home-derived client paths reject relative HOME without a cwd fallback", () => {
  if (process.platform === "win32") return;
  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  try {
    process.env.HOME = "relative-home";
    delete process.env.XDG_CONFIG_HOME;
    assert.deepEqual(home(".cursor"), {
      state: "unavailable",
      reason: "HOME must be an absolute POSIX path",
    });
    assert.deepEqual(xdgConfig(), {
      state: "unavailable",
      reason: "HOME must be an absolute POSIX path",
    });
    assert.equal(detectVscodeExtension("continue.continue-").state, "unavailable");
    process.env.XDG_CONFIG_HOME = "/isolated/explicit-xdg";
    assert.deepEqual(xdgConfig(), {
      state: "available",
      path: "/isolated/explicit-xdg",
    });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  }
});

test("Windows absolute paths require a drive root or complete UNC share", () => {
  assert.equal(isAuthoritativeWindowsAbsolute("C:\\Users\\user"), true);
  assert.equal(isAuthoritativeWindowsAbsolute("\\\\server\\share\\config"), true);
  assert.equal(isAuthoritativeWindowsAbsolute("\\root-relative"), false);
  assert.equal(isAuthoritativeWindowsAbsolute("C:relative"), false);
  assert.equal(isAuthoritativeWindowsAbsolute("\\\\server"), false);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncInstallerPath } from "../../src/install/durability.js";

test("installer durability syncs the requested file and parent descriptors", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-durability-"));
  const originalFsync = fs.fsyncSync;
  const descriptors: number[] = [];
  try {
    fs.fsyncSync = ((descriptor: number) => {
      descriptors.push(descriptor);
      originalFsync(descriptor);
    }) as typeof fs.fsyncSync;
    const file = path.join(root, "published");
    fs.writeFileSync(file, "published\n");
    syncInstallerPath("file", file);
    syncInstallerPath("directory", root);
    assert.equal(descriptors.length, 3);
  } finally {
    fs.fsyncSync = originalFsync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installer durability accepts symlinked directory references and file ancestors", () => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-durability-"));
  const alias = `${root}-alias`;
  try {
    const file = path.join(root, "published");
    fs.writeFileSync(file, "published\n");
    fs.symlinkSync(root, alias, "dir");
    syncInstallerPath("file", path.join(alias, "published"));
    syncInstallerPath("directory", alias);
  } finally {
    fs.rmSync(alias, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installer durability rejects relative paths, wrong types, and file symlinks", () => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-durability-"));
  try {
    const file = path.join(root, "published");
    const link = path.join(root, "link");
    fs.writeFileSync(file, "published\n");
    fs.symlinkSync(file, link);
    assert.throws(() => syncInstallerPath("file", "relative"), /absolute/);
    assert.throws(() => syncInstallerPath("directory", file), /directory/);
    assert.throws(() => syncInstallerPath("file", link), /symbolic link/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

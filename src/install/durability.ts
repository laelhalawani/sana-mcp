import fs from "node:fs";
import path from "node:path";

export type InstallerSyncKind = "file" | "directory";

type BigIntStats = fs.BigIntStats;

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function inspectPath(target: string, kind: InstallerSyncKind): BigIntStats {
  const stats = fs.lstatSync(target, { bigint: true });
  if (stats.isSymbolicLink())
    throw new Error("installer durability path must not be a symbolic link");
  if (kind === "file" ? !stats.isFile() : !stats.isDirectory())
    throw new Error(`installer durability path must be a ${kind}`);
  return stats;
}

function openPath(target: string, expected: BigIntStats, kind: InstallerSyncKind) {
  const descriptor = fs.openSync(
    target,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !sameIdentity(opened, expected) ||
      (kind === "file" ? !opened.isFile() : !opened.isDirectory())
    ) {
      throw new Error("installer durability path changed while opening it");
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function assertPathIdentity(
  target: string,
  expected: BigIntStats,
  kind: InstallerSyncKind,
): void {
  const current = inspectPath(target, kind);
  if (!sameIdentity(current, expected))
    throw new Error("installer durability path changed while syncing it");
}

function inspectDirectoryReference(target: string): {
  reference: BigIntStats;
  canonical: string;
  directory: BigIntStats;
} {
  const reference = fs.lstatSync(target, { bigint: true });
  if (!reference.isSymbolicLink() && !reference.isDirectory())
    throw new Error("installer durability path must be a directory");
  const canonical = fs.realpathSync.native(target);
  const directory = inspectPath(canonical, "directory");
  if (!reference.isSymbolicLink() && !sameIdentity(reference, directory))
    throw new Error("installer durability path changed while resolving it");
  return { reference, canonical, directory };
}

function assertDirectoryReference(
  target: string,
  expected: BigIntStats,
  canonical: string,
): void {
  const current = fs.lstatSync(target, { bigint: true });
  if (
    !sameIdentity(current, expected) ||
    current.isSymbolicLink() !== expected.isSymbolicLink() ||
    fs.realpathSync.native(target) !== canonical
  )
    throw new Error("installer durability path changed while syncing it");
}

function syncDirectory(target: string): void {
  const before = inspectDirectoryReference(target);
  const descriptor = openPath(before.canonical, before.directory, "directory");
  try {
    fs.fsyncSync(descriptor);
    assertDirectoryReference(target, before.reference, before.canonical);
    assertPathIdentity(before.canonical, before.directory, "directory");
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncFile(target: string): void {
  const before = inspectPath(target, "file");
  const lexicalParent = path.dirname(target);
  const canonicalParent = fs.realpathSync.native(lexicalParent);
  const parentBefore = inspectPath(canonicalParent, "directory");
  const parentDescriptor = openPath(
    canonicalParent,
    parentBefore,
    "directory",
  );
  try {
    const canonicalTarget = path.join(canonicalParent, path.basename(target));
    const canonicalBefore = inspectPath(canonicalTarget, "file");
    if (!sameIdentity(before, canonicalBefore))
      throw new Error("installer durability path changed while resolving it");
    const descriptor = openPath(canonicalTarget, canonicalBefore, "file");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }

    if (fs.realpathSync.native(lexicalParent) !== canonicalParent)
      throw new Error("installer durability parent changed while syncing it");
    assertPathIdentity(target, before, "file");
    assertPathIdentity(canonicalTarget, canonicalBefore, "file");
    assertPathIdentity(canonicalParent, parentBefore, "directory");
    fs.fsyncSync(parentDescriptor);
    if (fs.realpathSync.native(lexicalParent) !== canonicalParent)
      throw new Error("installer durability parent changed while syncing it");
    assertPathIdentity(target, before, "file");
    assertPathIdentity(canonicalParent, parentBefore, "directory");
  } finally {
    fs.closeSync(parentDescriptor);
  }
}

export function syncInstallerPath(
  kind: InstallerSyncKind,
  target: string,
): void {
  if (!path.isAbsolute(target))
    throw new Error("installer durability path must be absolute");
  if (kind === "file") {
    syncFile(target);
  } else if (kind === "directory") {
    syncDirectory(target);
  } else {
    throw new Error("installer durability kind must be file or directory");
  }
}

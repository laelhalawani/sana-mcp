import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HomeDirectoryError,
  requireAuthoritativeHome,
  resolveCanonicalAbsoluteDirectory,
  resolveAuthoritativeHome,
} from "../../src/runtime/home.js";
import {
  EnvironmentConfigError,
  parseRuntimeDirectories,
} from "../../src/runtime/env.js";

describe("authoritative home directory", () => {
  test("accepts canonical POSIX and WSL homes", () => {
    expect(
      resolveAuthoritativeHome({
        platform: "linux",
        env: { HOME: "/home/sana" },
      }),
    ).toEqual({
      state: "available",
      path: "/home/sana",
      source: "HOME",
    });
    expect(
      resolveAuthoritativeHome({
        platform: "linux",
        env: { HOME: "/mnt/c/Users/Sana User" },
      }),
    ).toEqual({
      state: "available",
      path: "/mnt/c/Users/Sana User",
      source: "HOME",
    });
  });

  test("rejects explicit invalid POSIX homes without a system fallback", () => {
    for (const value of [
      "",
      "relative/home",
      "/home/sana/",
      "/home/sana/../other",
      "/",
      " /home/sana",
      "/home/sana\0other",
    ]) {
      let fallbackCalled = false;
      const resolution = resolveAuthoritativeHome({
        platform: "linux",
        env: { HOME: value },
        homedir: () => {
          fallbackCalled = true;
          return "/home/fallback";
        },
      });
      expect(resolution.state, value).toBe("unavailable");
      expect(fallbackCalled, value).toBe(false);
    }
  });

  test("uses a validated system POSIX home only when HOME is absent", () => {
    expect(
      resolveAuthoritativeHome({
        platform: "darwin",
        env: {},
        homedir: () => "/Users/sana",
      }),
    ).toEqual({
      state: "available",
      path: "/Users/sana",
      source: "system",
    });
    expect(
      resolveAuthoritativeHome({
        platform: "darwin",
        env: {},
        homedir: () => "relative/system-home",
      }).state,
    ).toBe("unavailable");
  });

  test("uses Windows primary home sources without drive-relative fallback", () => {
    expect(
      resolveAuthoritativeHome({
        platform: "win32",
        env: { USERPROFILE: "C:\\Users\\Sana" },
      }),
    ).toEqual({
      state: "available",
      path: "C:\\Users\\Sana",
      source: "USERPROFILE",
    });
    expect(
      resolveAuthoritativeHome({
        platform: "win32",
        env: {
          HOMEDRIVE: "D:",
          HOMEPATH: "\\Profiles\\Sana",
        },
      }),
    ).toEqual({
      state: "available",
      path: "D:\\Profiles\\Sana",
      source: "HOMEDRIVE+HOMEPATH",
    });
    expect(
      resolveAuthoritativeHome({
        platform: "win32",
        env: { USERPROFILE: "\\\\server\\share\\Sana" },
      }),
    ).toEqual({
      state: "available",
      path: "\\\\server\\share\\Sana",
      source: "USERPROFILE",
    });
  });

  test("rejects invalid or incomplete Windows primary homes", () => {
    for (const env of [
      { USERPROFILE: "Users\\Sana" },
      { USERPROFILE: "C:relative" },
      { USERPROFILE: "C:\\" },
      { USERPROFILE: "\\root-relative" },
      { USERPROFILE: "\\\\?\\C:\\Users\\Sana" },
      { HOMEDRIVE: "C:" },
      { HOMEPATH: "\\Users\\Sana" },
      { HOMEDRIVE: "C:\\", HOMEPATH: "\\Users\\Sana" },
      { HOMEDRIVE: "C:relative", HOMEPATH: "\\Users\\Sana" },
      { HOMEDRIVE: "C:", HOMEPATH: "Users\\Sana" },
      { HOMEDRIVE: "C:", HOMEPATH: "C:\\Users\\Sana" },
      { HOMEDRIVE: "C:", HOMEPATH: "\\\\server\\share\\Sana" },
      { HOMEDRIVE: "C:", HOMEPATH: "\\Users\\..\\Sana" },
    ]) {
      let fallbackCalled = false;
      const resolution = resolveAuthoritativeHome({
        platform: "win32",
        env,
        homedir: () => {
          fallbackCalled = true;
          return "C:\\Users\\Fallback";
        },
      });
      expect(resolution.state, JSON.stringify(env)).toBe("unavailable");
      expect(fallbackCalled, JSON.stringify(env)).toBe(false);
    }
  });

  test("canonical directory validation is platform-lexical and root-safe", () => {
    expect(
      resolveCanonicalAbsoluteDirectory(
        "/mnt/c/Users/Sana User/config",
        "XDG_CONFIG_HOME",
        "linux",
      ),
    ).toEqual({
      state: "available",
      path: "/mnt/c/Users/Sana User/config",
    });
    for (const value of [
      "relative/config",
      "/",
      "/home/sana/../config",
      "/home/sana/config/",
    ]) {
      expect(
        resolveCanonicalAbsoluteDirectory(value, "XDG_CONFIG_HOME", "linux")
          .state,
        value,
      ).toBe("unavailable");
    }

    expect(
      resolveCanonicalAbsoluteDirectory(
        "C:\\Users\\Sana\\AppData\\Roaming",
        "APPDATA",
        "win32",
      ),
    ).toEqual({
      state: "available",
      path: "C:\\Users\\Sana\\AppData\\Roaming",
    });
    for (const value of [
      "C:\\",
      "C:relative",
      "\\root-relative",
      "\\\\?\\C:\\Users\\Sana",
      "C:\\Users\\Sana\\..\\Other",
      "C:\\Users\\Sana\\AppData\\",
      "C:\\Users\\NUL\\AppData",
      "C:\\Users\\COM¹\\AppData",
      "C:\\Users\\COM².txt\\AppData",
      "C:\\Users\\COM³\\AppData",
      "C:\\Users\\LPT¹\\AppData",
      "C:\\Users\\LPT².txt\\AppData",
      "C:\\Users\\LPT³\\AppData",
      "C:\\Users\\Sana.\\AppData",
      "C:\\Users\\bad<name\\AppData",
      "C:\\Users\\bad>name\\AppData",
      "C:\\Users\\bad:name\\AppData",
      "\\\\server:80\\share\\AppData",
      "C:\\Users\\bad\"name\\AppData",
      "C:\\Users\\bad/name\\AppData",
      "C:\\Users\\\\name\\AppData",
      "C:\\Users\\bad|name\\AppData",
      "C:\\Users\\bad?name\\AppData",
      "C:\\Users\\bad*name\\AppData",
      "C:\\Users\\bad\u0001name\\AppData",
    ]) {
      expect(
        resolveCanonicalAbsoluteDirectory(value, "APPDATA", "win32").state,
        value,
      ).toBe("unavailable");
    }
  });

  test("UNC server and share grammar preserves valid descendants", () => {
    const share80 = "s".repeat(80);
    for (const value of [
      "\\\\server\\share\\folder",
      "\\\\server.example\\share name$\\folder",
      `\\\\server\\${share80}\\folder`,
    ]) {
      expect(
        resolveCanonicalAbsoluteDirectory(value, "APPDATA", "win32"),
        value,
      ).toEqual({ state: "available", path: value });
    }

    for (const character of ["[", "]", "+", "=", ";", ","]) {
      const value = `\\\\server\\bad${character}share\\folder`;
      expect(
        resolveCanonicalAbsoluteDirectory(value, "APPDATA", "win32").state,
        value,
      ).toBe("unavailable");
    }
    for (const value of [
      "\\\\server\\\\folder",
      "\\\\server\\.\\folder",
      "\\\\server\\..\\folder",
      "\\\\.\\share\\folder",
      "\\\\server.\\share\\folder",
      "\\\\bad server\\share\\folder",
      "\\\\server\\share.\\folder",
      "\\\\server\\share \\folder",
      `\\\\server\\${"s".repeat(81)}\\folder`,
    ]) {
      expect(
        resolveCanonicalAbsoluteDirectory(value, "APPDATA", "win32").state,
        value,
      ).toBe("unavailable");
    }
  });

  test("invalid Windows leaves fail with typed errors before ancestor creation", () => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "sana-windows-lexical-"),
    );
    try {
      const ancestor =
        process.platform === "win32"
          ? path.win32.join(temporary, "not-created")
          : "C:\\isolated\\not-created";
      for (const invalid of [
        path.win32.join(ancestor, "bad<leaf"),
        "\\\\server\\bad+share\\folder",
      ]) {
        expect(() =>
          requireAuthoritativeHome({
            platform: "win32",
            env: { USERPROFILE: invalid },
          }),
        ).toThrow(HomeDirectoryError);
        expect(() =>
          parseRuntimeDirectories(
            { SANA_DATA_DIR: invalid },
            "C:\\isolated\\work",
            "win32",
          ),
        ).toThrow(EnvironmentConfigError);
      }
      if (process.platform === "win32") {
        expect(fs.existsSync(ancestor)).toBe(false);
      }
      expect(fs.readdirSync(temporary)).toEqual([]);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("throws one typed actionable error when a home is required", () => {
    expect(() =>
      requireAuthoritativeHome({
        platform: "linux",
        env: { HOME: "relative/home" },
      }),
    ).toThrow(HomeDirectoryError);
    try {
      requireAuthoritativeHome({
        platform: "linux",
        env: { HOME: "relative/home" },
      });
      throw new Error("expected home resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HomeDirectoryError);
      expect((error as HomeDirectoryError).code).toBe(
        "HOME_DIRECTORY_UNAVAILABLE",
      );
      expect((error as Error).message).toContain(
        "Set an absolute home directory or configure an explicit absolute application data path",
      );
    }
  });
});

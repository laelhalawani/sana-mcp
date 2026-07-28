import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import {
  EnvironmentConfigError,
  parseRuntimeEnvironment,
  RUNTIME_DEFAULTS,
} from "../../src/runtime/env.js";

describe("runtime environment", () => {
  test("uses intentional product defaults only for absent variables", () => {
    const parsed = parseRuntimeEnvironment({}, "/isolated/work");
    expect(RUNTIME_DEFAULTS.semanticEnabled).toBe(true);
    expect(parsed).toEqual({
      dataDir: undefined,
      transcriptsDir: undefined,
      baseUrl: RUNTIME_DEFAULTS.baseUrl,
      maxRetryDelayAttempts: RUNTIME_DEFAULTS.maxRetryDelayAttempts,
      countWaitMs: RUNTIME_DEFAULTS.countWaitMs,
      syncIntervalMs: RUNTIME_DEFAULTS.syncIntervalMs,
      requestDelayMs: RUNTIME_DEFAULTS.requestDelayMs,
      maxNewTranscripts: RUNTIME_DEFAULTS.maxNewTranscripts,
      embedModel: RUNTIME_DEFAULTS.embedModel,
      embedDimension: RUNTIME_DEFAULTS.embedDimension,
      embedMinWords: RUNTIME_DEFAULTS.embedMinWords,
      embedIdleMs: RUNTIME_DEFAULTS.embedIdleMs,
      semanticEnabled: RUNTIME_DEFAULTS.semanticEnabled,
    });
  });

  test("accepts only canonical absolute explicit application directories", () => {
    const dataDir =
      process.platform === "win32"
        ? "C:\\isolated\\sana-data"
        : "/isolated/sana-data";
    const transcriptsDir =
      process.platform === "win32"
        ? "C:\\isolated\\sana-transcripts"
        : "/isolated/sana-transcripts";
    const parsed = parseRuntimeEnvironment(
      {
        SANA_DATA_DIR: dataDir,
        SANA_TRANSCRIPTS_DIR: transcriptsDir,
      },
      process.platform === "win32"
        ? "C:\\isolated\\work"
        : "/isolated/work",
    );
    expect(parsed.dataDir).toBe(dataDir);
    expect(parsed.transcriptsDir).toBe(transcriptsDir);
  });

  test("rejects relative and non-canonical explicit directories", () => {
    const invalid =
      process.platform === "win32"
        ? [
            "private-data",
            "C:\\isolated\\data\\..\\other",
            "C:\\isolated\\data\\",
            "C:\\isolated\\NUL",
          ]
        : [
            "private-data",
            "/isolated/data/../other",
            "/isolated/data/",
            " /isolated/data",
          ];
    for (const value of invalid) {
      expect(() =>
        parseRuntimeEnvironment({ SANA_DATA_DIR: value }),
      ).toThrow(EnvironmentConfigError);
      expect(() =>
        parseRuntimeEnvironment({ SANA_TRANSCRIPTS_DIR: value }),
      ).toThrow(EnvironmentConfigError);
    }
  });

  test.each([
    ["SANA_MAX_ATTEMPTS", ""],
    ["SANA_MAX_ATTEMPTS", "5.5"],
    ["SANA_MAX_ATTEMPTS", "-1"],
    ["SANA_COUNT_WAIT_MS", "0"],
    ["SANA_SYNC_INTERVAL_MS", "NaN"],
    ["SANA_REQUEST_DELAY_MS", "-1"],
    ["SANA_MAX_NEW_TRANSCRIPTS", " 2"],
    ["SANA_EMBED_DIM", "Infinity"],
    ["SANA_EMBED_MIN_WORDS", "0"],
    ["SANA_EMBED_IDLE_MS", "1e3"],
  ])("rejects explicit invalid numeric %s=%s", (name, value) => {
    expect(() => parseRuntimeEnvironment({ [name]: value })).toThrow(
      EnvironmentConfigError,
    );
  });

  test.each([
    ["SANA_MAX_ATTEMPTS", "101"],
    ["SANA_COUNT_WAIT_MS", "300001"],
    ["SANA_SYNC_INTERVAL_MS", "86400001"],
    ["SANA_REQUEST_DELAY_MS", "60001"],
    ["SANA_MAX_NEW_TRANSCRIPTS", "100001"],
    ["SANA_EMBED_DIM", "16385"],
    ["SANA_EMBED_MIN_WORDS", "33"],
    ["SANA_EMBED_IDLE_MS", "86400001"],
  ])("rejects runtime-unsafe numeric %s=%s", (name, value) => {
    expect(() => parseRuntimeEnvironment({ [name]: value })).toThrow(
      EnvironmentConfigError,
    );
  });

  test("accepts zero only for intentional non-negative settings", () => {
    const parsed = parseRuntimeEnvironment({
      SANA_REQUEST_DELAY_MS: "0",
      SANA_MAX_NEW_TRANSCRIPTS: "0",
    });
    expect(parsed.requestDelayMs).toBe(0);
    expect(parsed.maxNewTranscripts).toBe(0);
  });

  test.each([
    ["1", true],
    ["TRUE", true],
    ["yes", true],
    ["on", true],
    ["0", false],
    ["FALSE", false],
    ["no", false],
    ["off", false],
  ])("parses explicit semantic boolean %s", (value, expected) => {
    expect(parseRuntimeEnvironment({ SANA_SEMANTIC: value }).semanticEnabled).toBe(
      expected,
    );
  });

  test("rejects an explicitly empty or unknown semantic boolean", () => {
    expect(() => parseRuntimeEnvironment({ SANA_SEMANTIC: "" })).toThrow(
      EnvironmentConfigError,
    );
    expect(() => parseRuntimeEnvironment({ SANA_SEMANTIC: "sometimes" })).toThrow(
      EnvironmentConfigError,
    );
  });

  test("canonicalizes a valid configured origin and rejects non-origin URLs", () => {
    expect(
      parseRuntimeEnvironment({ SANA_BASE_URL: "https://example.test:8443" }).baseUrl,
    ).toBe("https://example.test:8443");
    for (const value of [
      "",
      "example.test",
      "ftp://example.test",
      "http://example.test",
      "https://user@example.test",
      "https://example.test/path",
      "https://example.test/?query=1",
      "https://example.test/#fragment",
    ]) {
      expect(() => parseRuntimeEnvironment({ SANA_BASE_URL: value })).toThrow(
        EnvironmentConfigError,
      );
    }
    expect(parseRuntimeEnvironment({ SANA_BASE_URL: "http://127.0.0.1:3000" }).baseUrl).toBe(
      "http://127.0.0.1:3000",
    );
  });

  test("rejects empty and NUL-bearing path/model values", () => {
    for (const [name, value] of [
      ["SANA_DATA_DIR", ""],
      ["SANA_TRANSCRIPTS_DIR", "bad\0path"],
      ["SANA_EMBED_MODEL", "  "],
    ]) {
      expect(() => parseRuntimeEnvironment({ [name]: value })).toThrow(
        EnvironmentConfigError,
      );
    }
  });

  test("rejects broad explicit managed roots before permission repair can run", () => {
    const workingDirectory = path.resolve("/isolated/work");
    for (const value of [
      path.parse(workingDirectory).root,
      workingDirectory,
      os.homedir(),
      os.tmpdir(),
    ]) {
      expect(() =>
        parseRuntimeEnvironment({ SANA_DATA_DIR: value }, workingDirectory),
      ).toThrow(EnvironmentConfigError);
      expect(() =>
        parseRuntimeEnvironment({ SANA_TRANSCRIPTS_DIR: value }, workingDirectory),
      ).toThrow(EnvironmentConfigError);
    }
  });
});

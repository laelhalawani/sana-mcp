import { expect, test } from "bun:test";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readJsonFile,
  writeJsonAtomic,
} from "../../src/runtime/private-json.js";

test("private-json can be consumed directly without facade initialization issues", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-private-json-direct-"));
  try {
    const file = path.join(root, "profile", "value.json");
    const schema = z.object({ enabled: z.boolean() }).strict();
    writeJsonAtomic(file, { enabled: true });
    expect(readJsonFile(file, schema)).toEqual({
      kind: "value",
      value: { enabled: true },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

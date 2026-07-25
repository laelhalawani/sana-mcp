import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import packageMetadata from "../../package.json" with { type: "json" };

const root = path.resolve(import.meta.dirname, "../..");

test("current release projections follow the package version", async () => {
  const tag = `v${packageMetadata.version}`;
  const [
    readme,
    posixInstaller,
    workflow,
    cliSpecs,
    validManifestText,
    invalidManifestText,
  ] = await Promise.all([
    readFile(path.join(root, "README.md"), "utf8"),
    readFile(path.join(root, "install.sh"), "utf8"),
    readFile(path.join(root, ".github/workflows/release.yml"), "utf8"),
    readFile(path.join(root, "docs/dev/cli-specs.md"), "utf8"),
    readFile(
      path.join(
        root,
        "tests/fixtures/manifest/valid-all-targets.json",
      ),
      "utf8",
    ),
    readFile(
      path.join(
        root,
        "tests/fixtures/manifest/invalid-unknown-field.json",
      ),
      "utf8",
    ),
  ]);
  const validManifest = JSON.parse(validManifestText) as {
    packageVersion: string;
    releaseTag: string;
  };
  const invalidManifest = JSON.parse(invalidManifestText) as {
    packageVersion: string;
    releaseTag: string;
  };

  assert.ok(
    readme.includes(
      `Set \`SANA_MCP_VERSION\` to an exact tag such as \`${tag}\``,
    ),
  );
  assert.ok(
    posixInstaller.includes(
      `SANA_MCP_VERSION=${tag}`,
    ),
  );
  assert.ok(
    posixInstaller.includes(
      `/releases/download/${tag}/install.sh`,
    ),
  );
  assert.ok(
    workflow.includes(
      `Existing package-matching tag to release (for example ${tag})`,
    ),
  );
  assert.ok(
    cliSpecs.includes(
      `- [shipped] - implemented in the current \`${tag}\` release candidate.`,
    ),
  );
  for (const manifest of [validManifest, invalidManifest]) {
    assert.equal(manifest.packageVersion, packageMetadata.version);
    assert.equal(manifest.releaseTag, tag);
  }
});

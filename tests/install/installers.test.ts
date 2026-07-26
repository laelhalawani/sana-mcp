import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import packageMetadata from "../../package.json" with { type: "json" };

const root = path.resolve(import.meta.dirname, "../..");
const currentVersion = packageMetadata.version;
const currentTag = `v${currentVersion}`;
const predecessorVersion = "0.4.5";
const predecessorTag = `v${predecessorVersion}`;
const predecessorWindowsFixture =
  `${predecessorTag}-sana-mcp-windows-x64.exe`;
const compatibleUpdateInstallerEnvironmentLines = [
  '  [void]$InstallerInfo.EnvironmentVariables.Remove("SANA_MCP_REPLACE_INCOMPATIBLE")',
  '  [void]$InstallerInfo.EnvironmentVariables.Remove("SANA_MCP_INCOMPATIBLE_RESET")',
  `  foreach ($Pair in @{ USERPROFILE=$Profile; HOME=$Profile; LOCALAPPDATA=$LocalAppData; APPDATA=$RoamingAppData; SANA_DATA_DIR=$Data; SANA_TRANSCRIPTS_DIR=$Transcripts; SANA_MCP_INSTALL_DIR=$Install; SANA_MCP_VERSION="${currentTag}"; SANA_MCP_YES="1"; SANA_MCP_TEST_RELEASE_DIR=$Release; PATH=$IsolatedProcessPath; PATHEXT=".COM;.EXE;.BAT;.CMD"; PSModulePath=$WindowsPowerShellModulePath }.GetEnumerator()) { $InstallerInfo.EnvironmentVariables[$Pair.Key] = $Pair.Value }`,
] as const;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await access(file);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ${file}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function createOfflineRelease(
  directory: string,
  version = "0.3.2",
): Promise<string> {
  const fixture = path.join(directory, `release-${version}`);
  const commands = path.join(directory, "commands");
  await mkdir(fixture);
  await mkdir(commands, { recursive: true });

  const binaryName = "sana-mcp-linux-x64";
  const binary = [
    "#!/bin/sh",
    'if [ "${1:-}" = "__inspect" ]; then',
    `  printf '%s\\n' inspectProtocol=1 version=${version} target=bun-linux-x64 installerProtocol=1 lifecycleProtocol=1 stateCompatibility=1 semanticCapability=keyword`,
    "  exit 0",
    "fi",
    'if [ "${1:-}" = "__lifecycle" ]; then',
    '  operation=${2:-}',
    '  state=stopped',
    '  if [ -n "${FAKE_LIFECYCLE_STATE_FILE:-}" ] && [ -f "$FAKE_LIFECYCLE_STATE_FILE" ]; then',
    '    state=$(cat "$FAKE_LIFECYCLE_STATE_FILE")',
    "  fi",
    '  case "$operation" in',
    '    health) if [ -n "${FAKE_CONFIGURED_FILE:-}" ] && [ -f "$FAKE_CONFIGURED_FILE" ]; then if [ -n "${FAKE_HEALTH_READY_FILE:-}" ]; then : > "$FAKE_HEALTH_READY_FILE"; fi; while [ -n "${FAKE_HEALTH_WAIT_FILE:-}" ] && [ ! -f "$FAKE_HEALTH_WAIT_FILE" ]; do sleep 0.02; done; if [ -n "${FAKE_POST_CONFIG_HEALTH_EXIT:-}" ]; then exit "$FAKE_POST_CONFIG_HEALTH_EXIT"; fi; fi; changed=false ;;',
    '    stop) changed=$([ "$state" = running ] && printf true || printf false); state=stopped ;;',
    '    start) if [ -n "${FAKE_CONFIGURED_FILE:-}" ] && [ -f "$FAKE_CONFIGURED_FILE" ] && [ -n "${FAKE_POST_CONFIG_START_EXIT:-}" ]; then if [ -n "${FAKE_START_READY_FILE:-}" ]; then : > "$FAKE_START_READY_FILE"; fi; while [ -n "${FAKE_START_WAIT_FILE:-}" ] && [ ! -f "$FAKE_START_WAIT_FILE" ]; do sleep 0.02; done; if [ -n "${FAKE_LIFECYCLE_LOG_FILE:-}" ]; then printf "%s:%s\\n" start-attempt "$state" >> "$FAKE_LIFECYCLE_LOG_FILE"; fi; exit "$FAKE_POST_CONFIG_START_EXIT"; fi; changed=$([ "$state" = stopped ] && printf true || printf false); state=running ;;',
    "    *) exit 64 ;;",
    "  esac",
    '  if [ -n "${FAKE_LIFECYCLE_STATE_FILE:-}" ]; then printf "%s\\n" "$state" > "$FAKE_LIFECYCLE_STATE_FILE"; fi',
    '  if [ -n "${FAKE_LIFECYCLE_LOG_FILE:-}" ]; then printf "%s:%s\\n" "$operation" "$state" >> "$FAKE_LIFECYCLE_LOG_FILE"; fi',
    "  printf '%s\\n' lifecycleProtocol=1 \"state=$state\" \"changed=$changed\"",
    "  exit 0",
    "fi",
    'if [ "${1:-}" = "__configure-transaction" ]; then',
    '  operation=${2:-}',
    '  shift 2',
    '  journal=""',
    '  while [ "$#" -gt 0 ]; do',
    '    case "$1" in',
    '      --journal) shift; journal=${1:-} ;;',
    '      --server-command) shift; server_command=${1:-} ;;',
    '      --yes) ;;',
    '      *) exit 64 ;;',
    '    esac',
    '    shift',
    '  done',
    '  [ -n "$journal" ] || exit 64',
    '  if [ "$operation" = "rollback" ]; then',
    '    outcome=${FAKE_ROLLBACK_OUTCOME:-failed-rolled-back}',
    '    exit_code=${FAKE_ROLLBACK_EXIT:-0}',
    '    if [ -n "${FAKE_ROLLBACK_READY_FILE:-}" ]; then : > "$FAKE_ROLLBACK_READY_FILE"; fi',
    '    while [ -n "${FAKE_ROLLBACK_WAIT_FILE:-}" ] && [ ! -f "$FAKE_ROLLBACK_WAIT_FILE" ]; do sleep 0.02; done',
    '    if [ -n "${FAKE_TRANSACTION_LOG_FILE:-}" ]; then printf "%s\\n" rollback >> "$FAKE_TRANSACTION_LOG_FILE"; fi',
    '    if [ "$exit_code" -eq 0 ] && [ "$outcome" = failed-rolled-back ]; then',
    '      printf "%s\\n" "{\\"transactionProtocol\\":1,\\"operation\\":\\"rollback\\",\\"outcome\\":\\"$outcome\\",\\"appliedCount\\":0,\\"noopCount\\":0,\\"journal\\":\\"$journal/client-config-transaction.json\\"}"',
    "    else",
    '      printf "%s\\n" "{\\"transactionProtocol\\":1,\\"operation\\":\\"rollback\\",\\"outcome\\":\\"$outcome\\",\\"appliedCount\\":0,\\"noopCount\\":0,\\"journal\\":\\"$journal/client-config-transaction.json\\",\\"errorCode\\":\\"FAKE_ROLLBACK_FAILED\\",\\"message\\":\\"fake rollback failed\\"}"',
    "    fi",
    '    exit "$exit_code"',
    '  fi',
    '  [ "$operation" = "apply" ] || exit 64',
    '  if [ -n "${FAKE_CONFIG_READY_FILE:-}" ]; then : > "$FAKE_CONFIG_READY_FILE"; fi',
    '  while [ -n "${FAKE_CONFIG_WAIT_FILE:-}" ] && [ ! -f "$FAKE_CONFIG_WAIT_FILE" ]; do sleep 0.02; done',
    '  if [ "${FAKE_CONFIG_START_DAEMON:-0}" = "1" ] && [ -n "${FAKE_LIFECYCLE_STATE_FILE:-}" ]; then',
    '    printf "%s\\n" running > "$FAKE_LIFECYCLE_STATE_FILE"',
    "  fi",
    '  if [ -n "${FAKE_CONFIGURED_FILE:-}" ]; then : > "$FAKE_CONFIGURED_FILE"; fi',
    '  outcome=${FAKE_CONFIG_OUTCOME:-applied}',
    '  exit_code=${FAKE_CONFIG_EXIT:-0}',
    '  authentication=${FAKE_CONFIG_AUTHENTICATION:-ready}',
    '  if [ "$exit_code" -ne 0 ] && [ -z "${FAKE_CONFIG_OUTCOME:-}" ]; then outcome=configuration-unavailable; exit_code=1; authentication=not-attempted; fi',
    '  applied_count=$([ "$outcome" = applied ] && printf 1 || printf 0)',
    '  if [ -n "${FAKE_CONFIG_APPLIED_COUNT:-}" ]; then applied_count=$FAKE_CONFIG_APPLIED_COUNT; fi',
    '  disposition=${FAKE_CONFIG_DISPOSITION:-configured}',
    '  if [ "$outcome" = no-mutation ]; then disposition=no-changes; fi',
    '  if [ "$outcome" = interaction-unavailable ]; then disposition=interaction-unavailable; fi',
    '  if [ "$outcome" = configuration-unavailable ]; then disposition=configuration-unavailable; fi',
    '  if [ "$outcome" = authentication-incomplete ]; then disposition=authentication-incomplete; fi',
    '  error_code=FAKE_CONFIG_FAILED',
    '  error_message="fake configuration failed"',
    '  if [ "$outcome" = interaction-unavailable ]; then error_code=CONFIG_TRANSACTION_INTERACTION_UNAVAILABLE; error_message="an interactive terminal is required for client selection"; fi',
    '  if [ "$outcome" = applied ] || [ "${FAKE_CONFIG_CREATE_JOURNAL:-0}" = "1" ]; then',
    '    mkdir -p "$journal"',
    '    printf "%s\\n" journal > "$journal/client-config-transaction.json"',
    "  fi",
    '  if [ "${FAKE_CONFIG_MALFORMED:-0}" = "1" ]; then printf "%s\\n" malformed; exit "$exit_code"; fi',
    '  if [ -n "${FAKE_TRANSACTION_LOG_FILE:-}" ]; then printf "%s\\n" apply >> "$FAKE_TRANSACTION_LOG_FILE"; fi',
    '  if [ "$exit_code" -eq 0 ]; then',
    '    if [ "$outcome" = applied ]; then',
    '      printf "%s\\n" "{\\"transactionProtocol\\":1,\\"operation\\":\\"apply\\",\\"outcome\\":\\"$outcome\\",\\"appliedCount\\":$applied_count,\\"noopCount\\":0,\\"journal\\":\\"$journal/client-config-transaction.json\\",\\"disposition\\":\\"$disposition\\",\\"authentication\\":\\"$authentication\\"}"',
    "    else",
    '      printf "%s\\n" "{\\"transactionProtocol\\":1,\\"operation\\":\\"apply\\",\\"outcome\\":\\"$outcome\\",\\"appliedCount\\":$applied_count,\\"noopCount\\":0,\\"disposition\\":\\"$disposition\\",\\"authentication\\":\\"$authentication\\"}"',
    "    fi",
    "  else",
    '    printf "%s\\n" "{\\"transactionProtocol\\":1,\\"operation\\":\\"apply\\",\\"outcome\\":\\"$outcome\\",\\"appliedCount\\":$applied_count,\\"noopCount\\":0,\\"disposition\\":\\"$disposition\\",\\"authentication\\":\\"$authentication\\",\\"errorCode\\":\\"$error_code\\",\\"message\\":\\"$error_message\\"}"',
    "  fi",
    '  exit "$exit_code"',
    "fi",
    'if [ "${1:-}" = "install" ]; then',
    '  if [ -n "${FAKE_INSTALL_ARGS_FILE:-}" ]; then printf "%s\\n" "$@" > "$FAKE_INSTALL_ARGS_FILE"; fi',
    "  exit 23",
    "fi",
    `# release fixture ${version}`,
    "exit 2",
    "",
  ].join("\n");
  const binaryHash = sha256(binary);
  const installerHash = sha256(
    await readFile(path.join(root, "install.sh")),
  );
  await writeFile(path.join(fixture, binaryName), binary);

  const manifest = '{"manifestVersion":1,"offlineInstallerTest":true}\n';
  const manifestHash = sha256(manifest);
  await writeFile(path.join(fixture, "manifest.json"), manifest);
  await writeFile(
    path.join(fixture, "manifest.json.sha256"),
    `${manifestHash}  manifest.json\n`,
  );
  await writeFile(
    path.join(fixture, `${binaryName}.sha256`),
    `${binaryHash}  ${binaryName}\n`,
  );

  const metadataName = "manifest-bun-linux-x64.properties";
  const metadata = [
    "format=sana-mcp-release-v1",
    "manifestVersion=1",
    `manifestSha256=${manifestHash}`,
    `packageVersion=${version}`,
    `releaseTag=v${version}`,
    "sourceCommit=0123456789abcdef0123456789abcdef01234567",
    "installerProtocol=1",
    "lifecycleProtocol=1",
    "inspectProtocol=1",
    "stateCompatibility=1",
    "semanticCapability=keyword",
    "installerAssetName=install.sh",
    `installerSha256=${installerHash}`,
    "target=bun-linux-x64",
    "libc=glibc",
    `assetName=${binaryName}`,
    `checksumFileName=${binaryName}.sha256`,
    `sha256=${binaryHash}`,
    "",
  ].join("\n");
  await writeFile(path.join(fixture, metadataName), metadata);
  await writeFile(
    path.join(fixture, `${metadataName}.sha256`),
    `${sha256(metadata)}  ${metadataName}\n`,
  );

  const fakeCurl = [
    "#!/bin/sh",
    'out=""',
    'url=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    -o) shift; out=$1 ;;',
    '    https://*) url=$1 ;;',
    "  esac",
    "  shift",
    "done",
    '[ -n "$out" ] && [ -n "$url" ] || exit 64',
    'name=${url##*/}',
    'exec /bin/cp "$FIXTURE_ROOT/$name" "$out"',
    "",
  ].join("\n");
  const fakeUname = [
    "#!/bin/sh",
    'case "${1:-}" in',
    "  -s) printf '%s\\n' Linux ;;",
    "  -m) printf '%s\\n' x86_64 ;;",
    "  *) exit 64 ;;",
    "esac",
    "",
  ].join("\n");
  await writeFile(path.join(commands, "curl"), fakeCurl);
  await writeFile(path.join(commands, "uname"), fakeUname);
  await chmod(path.join(commands, "curl"), 0o755);
  await chmod(path.join(commands, "uname"), 0o755);
  return fixture;
}

test("POSIX one-line installer verifies the tuple and does not mask config failure", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-installer-test-"));
  try {
    const fixture = await createOfflineRelease(temporary);
    const commands = path.join(temporary, "commands");
    const home = path.join(temporary, "home");
    await mkdir(home);

    const run = (installName: string, configExit: string) => {
      const installDirectory = path.join(temporary, installName);
      const runHome = path.join(temporary, `${installName}-home`);
      mkdirSync(runHome);
      const result = spawnSync("/bin/sh", [path.join(root, "install.sh")], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${commands}:/usr/bin:/bin`,
          HOME: runHome,
          FIXTURE_ROOT: fixture,
          SANA_MCP_INSTALL_DIR: installDirectory,
          SANA_MCP_VERSION: "v0.3.2",
          SANA_MCP_YES: "1",
          FAKE_CONFIG_EXIT: configExit,
        },
      });
      return { installDirectory, result };
    };

    const successful = run("success-bin", "0");
    assert.equal(successful.result.status, 0, successful.result.stderr);
    assert.match(successful.result.stdout, /Installing sana-mcp v0\.3\.2/);
    assert.match(successful.result.stdout, /Installed /);
    assert.equal(
      await readFile(
        path.join(successful.installDirectory, "sana-mcp"),
        "utf8",
      ),
      await readFile(
        path.join(fixture, "sana-mcp-linux-x64"),
        "utf8",
      ),
    );
    assert.match(
      await readFile(
        path.join(successful.installDirectory, ".sana-mcp-install-v1"),
        "utf8",
      ),
      /(?:^|\n)sourceCommit=0123456789abcdef0123456789abcdef01234567\n/,
    );

    const failed = run("failed-bin", "23");
    assert.notEqual(failed.result.status, 0);
    assert.match(
      failed.result.stderr,
      /client configuration did not complete before changing client files/,
    );
    await access(path.join(failed.installDirectory, "sana-mcp"));
    await access(
      path.join(failed.installDirectory, ".sana-mcp-install-v1"),
    );

    const corpus = JSON.parse(
      await readFile(path.join(root, "release", "semver-corpus.json"), "utf8"),
    ) as { valid: string[]; invalid: string[] };
    for (const validTag of corpus.valid) {
      const result = spawnSync("/bin/sh", [path.join(root, "install.sh")], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${commands}:/usr/bin:/bin`,
          HOME: home,
          FIXTURE_ROOT: fixture,
          SANA_MCP_INSTALL_DIR: path.join(temporary, "valid-bin"),
          SANA_MCP_VERSION: validTag,
          SANA_MCP_YES: "1",
        },
      });
      assert.doesNotMatch(
        result.stderr,
        /invalid tag/,
        `rejected valid tag ${validTag}`,
      );
    }
    for (const invalidTag of corpus.invalid) {
      if (invalidTag.length === 0) continue;
      const result = spawnSync("/bin/sh", [path.join(root, "install.sh")], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${commands}:/usr/bin:/bin`,
          HOME: home,
          FIXTURE_ROOT: fixture,
          SANA_MCP_INSTALL_DIR: path.join(temporary, "invalid-bin"),
          SANA_MCP_VERSION: invalidTag,
          SANA_MCP_YES: "1",
        },
      });
      assert.notEqual(result.status, 0, `accepted invalid tag ${invalidTag}`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX installer only writes startup files for explicitly supported shells", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-shell-profile-"));
  try {
    const fixture = await createOfflineRelease(temporary);
    const commands = path.join(temporary, "commands");
    const cases: Array<{
      name: string;
      shell?: string;
      bashrc: boolean;
      extraStartupFiles?: string[];
      expectedProfile: "bashrc" | "zshrc" | "profile" | "none";
    }> = [
      {
        name: "bash-with-bashrc",
        shell: "/bin/bash",
        bashrc: true,
        expectedProfile: "bashrc",
      },
      {
        name: "bash-without-bashrc",
        shell: "/usr/bin/bash",
        bashrc: false,
        expectedProfile: "bashrc",
      },
      {
        name: "bash-with-bash-profile",
        shell: "/bin/bash",
        bashrc: false,
        extraStartupFiles: [".bash_profile"],
        expectedProfile: "bashrc",
      },
      {
        name: "bash-with-bash-login",
        shell: "/bin/bash",
        bashrc: false,
        extraStartupFiles: [".bash_login"],
        expectedProfile: "bashrc",
      },
      {
        name: "zsh",
        shell: "/bin/zsh",
        bashrc: true,
        expectedProfile: "zshrc",
      },
      {
        name: "unset",
        bashrc: true,
        expectedProfile: "none",
      },
      {
        name: "unknown",
        shell: "/opt/custom-shell",
        bashrc: true,
        expectedProfile: "none",
      },
      {
        name: "fish",
        shell: "/usr/bin/fish",
        bashrc: true,
        expectedProfile: "none",
      },
      {
        name: "nushell",
        shell: "/usr/bin/nu",
        bashrc: true,
        expectedProfile: "none",
      },
    ];

    for (const entry of cases) {
      const home = path.join(temporary, `${entry.name}-home`);
      const installDirectory = path.join(temporary, `${entry.name}-bin`);
      await mkdir(home);
      const startupFiles = [".profile", ".zshrc"];
      if (entry.bashrc) startupFiles.push(".bashrc");
      startupFiles.push(...(entry.extraStartupFiles ?? []));
      const original = new Map<string, string>();
      for (const startupFile of startupFiles) {
        const body = `# ${entry.name} ${startupFile}\n`;
        original.set(startupFile, body);
        await writeFile(path.join(home, startupFile), body);
      }

      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${commands}:/usr/bin:/bin`,
        HOME: home,
        FIXTURE_ROOT: fixture,
        SANA_MCP_INSTALL_DIR: installDirectory,
        SANA_MCP_VERSION: "v0.3.2",
        SANA_MCP_YES: "1",
      };
      delete environment.SHELL;
      if (entry.shell !== undefined) environment.SHELL = entry.shell;
      const result = spawnSync(
        "/bin/sh",
        [path.join(root, "install.sh")],
        { encoding: "utf8", env: environment },
      );

      assert.equal(result.status, 0, `${entry.name}: ${result.stderr}`);
      const receipt = await readFile(
        path.join(installDirectory, ".sana-mcp-install-v1"),
        "utf8",
      );
      assert.match(
        receipt,
        new RegExp(`(?:^|\\n)pathProfile=${entry.expectedProfile}\\n`),
        entry.name,
      );

      if (entry.expectedProfile === "none") {
        assert.match(
          result.stdout,
          /PATH was not changed because no matching shell startup file exists\./,
          entry.name,
        );
        assert.ok(
          result.stdout.includes(
            `Add ${installDirectory} to PATH manually`,
          ),
          `${entry.name} did not print the manual PATH command`,
        );
        assert.doesNotMatch(result.stdout, /(?:Added|Verified) .* to PATH/);
        for (const [startupFile, body] of original) {
          assert.equal(
            await readFile(path.join(home, startupFile), "utf8"),
            body,
            `${entry.name} changed ${startupFile}`,
          );
        }
        continue;
      }

      const expectedFile = {
        bashrc: ".bashrc",
        zshrc: ".zshrc",
        profile: ".profile",
      }[entry.expectedProfile];
      assert.match(result.stdout, /Added .* to PATH in /, entry.name);
      assert.match(
        await readFile(path.join(home, expectedFile), "utf8"),
        /# >>> sana-mcp installer >>>/,
        entry.name,
      );
      for (const [startupFile, body] of original) {
        if (startupFile === expectedFile) continue;
        assert.equal(
          await readFile(path.join(home, startupFile), "utf8"),
          body,
          `${entry.name} changed ${startupFile}`,
        );
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX upgrades separate receipt-owned PATH state from current-shell availability", { timeout: 20_000 }, async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-shell-upgrade-"));
  try {
    const firstFixture = await createOfflineRelease(temporary, "0.3.2");
    const secondFixture = await createOfflineRelease(temporary, "0.3.3");
    const commands = path.join(temporary, "commands");
    const cases: Array<{
      name: string;
      shell?: string;
      expectedPresentation: "verified" | "unsupported" | "different";
      configExit?: string;
    }> = [
      {
        name: "same-bash",
        shell: "/bin/bash",
        expectedPresentation: "verified",
      },
      {
        name: "unset",
        expectedPresentation: "unsupported",
      },
      {
        name: "unknown",
        shell: "/opt/custom-shell",
        expectedPresentation: "unsupported",
      },
      {
        name: "fish",
        shell: "/usr/bin/fish",
        expectedPresentation: "unsupported",
      },
      {
        name: "nushell",
        shell: "/usr/bin/nu",
        expectedPresentation: "unsupported",
      },
      {
        name: "different-supported-zsh",
        shell: "/bin/zsh",
        expectedPresentation: "different",
      },
      {
        name: "fish-config-failure",
        shell: "/usr/bin/fish",
        expectedPresentation: "unsupported",
        configExit: "23",
      },
    ];

    for (const entry of cases) {
      const home = path.join(temporary, `${entry.name}-home`);
      const installDirectory = path.join(temporary, `${entry.name}-bin`);
      const bashrc = path.join(home, ".bashrc");
      await mkdir(home);
      await writeFile(bashrc, `# ${entry.name}\n`);

      const run = (
        fixture: string,
        version: string,
        shell: string | undefined,
        configExit = "0",
      ) => {
        const environment: NodeJS.ProcessEnv = {
          ...process.env,
          PATH: `${commands}:/usr/bin:/bin`,
          HOME: home,
          FIXTURE_ROOT: fixture,
          FAKE_CONFIG_EXIT: configExit,
          SANA_MCP_INSTALL_DIR: installDirectory,
          SANA_MCP_VERSION: `v${version}`,
          SANA_MCP_YES: "1",
        };
        delete environment.SHELL;
        if (shell !== undefined) environment.SHELL = shell;
        return spawnSync(
          "/bin/sh",
          [path.join(root, "install.sh")],
          { encoding: "utf8", env: environment },
        );
      };

      const first = run(firstFixture, "0.3.2", "/bin/bash");
      assert.equal(first.status, 0, `${entry.name}: ${first.stderr}`);
      const ownedProfile = await readFile(bashrc, "utf8");
      const managedBlock = [
        "# >>> sana-mcp installer >>>",
        `export PATH='${installDirectory}':"$PATH"`,
        "# <<< sana-mcp installer <<<",
        "",
      ].join("\n");
      const expectedBlockHash = sha256(managedBlock);

      const upgrade = run(
        secondFixture,
        "0.3.3",
        entry.shell,
        entry.configExit,
      );
      assert.equal(upgrade.status, 0, `${entry.name}: ${upgrade.stderr}`);
      assert.match(
        upgrade.stdout,
        /Existing client configuration was left unchanged\./,
      );

      assert.equal(
        await readFile(bashrc, "utf8"),
        ownedProfile,
        `${entry.name} changed the receipt-owned profile`,
      );
      const receipt = await readFile(
        path.join(installDirectory, ".sana-mcp-install-v1"),
        "utf8",
      );
      assert.match(receipt, /(?:^|\n)version=0\.3\.3\n/, entry.name);
      assert.match(receipt, /(?:^|\n)pathProfile=bashrc\n/, entry.name);
      assert.match(
        receipt,
        new RegExp(`(?:^|\\n)pathBlockSha256=${expectedBlockHash}\\n`),
        entry.name,
      );

      if (entry.expectedPresentation === "verified") {
        assert.match(upgrade.stdout, /Verified .* is already on PATH in /);
        assert.doesNotMatch(upgrade.stdout, /Add .* to PATH manually/);
      } else {
        assert.doesNotMatch(upgrade.stdout, /(?:Added|Verified) .* to PATH/);
        assert.ok(
          upgrade.stdout.includes(
            `Add ${installDirectory} to PATH manually`,
          ),
          `${entry.name} did not print the manual PATH command`,
        );
        if (entry.expectedPresentation === "unsupported") {
          assert.match(
            upgrade.stdout,
            /PATH was not changed because no matching shell startup file exists\./,
          );
        } else {
          assert.match(
            upgrade.stdout,
            /installer-owned PATH block belongs to a different shell startup file\./,
          );
        }
      }

      await assert.rejects(
        access(path.join(installDirectory, ".sana-mcp-install-lock")),
        undefined,
        `${entry.name} retained the install lock`,
      );
      await assert.rejects(
        access(path.join(home, ".sana-mcp-installer-path.lock")),
        undefined,
        `${entry.name} retained the PATH lock`,
      );
      await assert.rejects(
        access(path.join(home, ".zshrc")),
        undefined,
        `${entry.name} created an unowned zsh profile`,
      );
      await assert.rejects(
        access(path.join(home, ".profile")),
        undefined,
        `${entry.name} created an unowned generic profile`,
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX upgrades preserve legacy receipt-owned profiles without claiming current bash readiness", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-bash-profile-upgrade-"));
  try {
    const firstFixture = await createOfflineRelease(temporary, "0.3.2");
    const secondFixture = await createOfflineRelease(temporary, "0.3.3");
    const commands = path.join(temporary, "commands");
    const cases = [
      { name: "no-login-shadow", shadow: undefined, configExit: "0" },
      { name: "bash-profile", shadow: ".bash_profile", configExit: "0" },
      { name: "bash-login-failure", shadow: ".bash_login", configExit: "23" },
    ] as const;

    for (const entry of cases) {
      const home = path.join(temporary, `${entry.name}-home`);
      const installDirectory = path.join(temporary, `${entry.name}-bin`);
      const bashrc = path.join(home, ".bashrc");
      const profile = path.join(home, ".profile");
      const receiptFile = path.join(
        installDirectory,
        ".sana-mcp-install-v1",
      );
      await mkdir(home);

      const run = (
        fixture: string,
        version: string,
        configExit: string,
      ) =>
        spawnSync("/bin/sh", [path.join(root, "install.sh")], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${commands}:/usr/bin:/bin`,
            HOME: home,
            SHELL: "/bin/bash",
            FIXTURE_ROOT: fixture,
            FAKE_CONFIG_EXIT: configExit,
            SANA_MCP_INSTALL_DIR: installDirectory,
            SANA_MCP_VERSION: `v${version}`,
            SANA_MCP_YES: "1",
          },
        });

      const first = run(firstFixture, "0.3.2", "0");
      assert.equal(first.status, 0, `${entry.name}: ${first.stderr}`);
      const legacyProfile = await readFile(bashrc, "utf8");
      await writeFile(profile, legacyProfile);
      await rm(bashrc);
      const firstReceipt = await readFile(receiptFile, "utf8");
      assert.match(firstReceipt, /(?:^|\n)pathProfile=bashrc\n/);
      await writeFile(
        receiptFile,
        firstReceipt.replace(
          /(^|\n)pathProfile=bashrc\n/,
          "$1pathProfile=profile\n",
        ),
      );
      let shadowBody: string | undefined;
      if (entry.shadow !== undefined) {
        shadowBody = `# ${entry.name} remains authoritative to bash login\n`;
        await writeFile(path.join(home, entry.shadow), shadowBody);
      }

      const upgrade = run(
        secondFixture,
        "0.3.3",
        entry.configExit,
      );
      assert.equal(upgrade.status, 0, `${entry.name}: ${upgrade.stderr}`);
      assert.match(
        upgrade.stdout,
        /Existing client configuration was left unchanged\./,
      );
      assert.equal(
        await readFile(profile, "utf8"),
        legacyProfile,
        `${entry.name} changed the receipt-owned legacy profile`,
      );
      await assert.rejects(
        access(bashrc),
        undefined,
        `${entry.name} created a new unowned bashrc during upgrade`,
      );
      if (entry.shadow !== undefined) {
        assert.equal(
          await readFile(path.join(home, entry.shadow), "utf8"),
          shadowBody,
          `${entry.name} changed the login shadow file`,
        );
      }

      const receipt = await readFile(receiptFile, "utf8");
      assert.match(receipt, /(?:^|\n)version=0\.3\.3\n/, entry.name);
      assert.match(receipt, /(?:^|\n)pathProfile=profile\n/, entry.name);
      const managedBlock = [
        "# >>> sana-mcp installer >>>",
        `export PATH='${installDirectory}':"$PATH"`,
        "# <<< sana-mcp installer <<<",
        "",
      ].join("\n");
      assert.match(
        receipt,
        new RegExp(
          `(?:^|\\n)pathBlockSha256=${sha256(managedBlock)}\\n`,
        ),
        entry.name,
      );
      assert.doesNotMatch(upgrade.stdout, /(?:Added|Verified) .* to PATH/);
      assert.match(
        upgrade.stdout,
        /installer-owned PATH block belongs to a different shell startup file\./,
      );
      assert.ok(
        upgrade.stdout.includes(
          `Add ${installDirectory} to PATH manually`,
        ),
        `${entry.name} did not print manual PATH guidance`,
      );
      await assert.rejects(
        access(path.join(installDirectory, ".sana-mcp-install-lock")),
      );
      await assert.rejects(
        access(path.join(home, ".sana-mcp-installer-path.lock")),
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX cleanup attempts later targets and preserves the primary status", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-cleanup-failure-"));
  try {
    const fixture = await createOfflineRelease(temporary);
    const commands = path.join(temporary, "commands");
    const home = path.join(temporary, "home");
    const removalCount = path.join(temporary, "rm-count");
    const removalLog = path.join(temporary, "rm.log");
    await mkdir(home);
    await writeFile(
      path.join(commands, "rm"),
      [
        "#!/bin/sh",
        "count=0",
        'if [ -f "$FAKE_RM_COUNT_FILE" ]; then count=$(cat "$FAKE_RM_COUNT_FILE"); fi',
        "count=$((count + 1))",
        'printf "%s\\n" "$count" > "$FAKE_RM_COUNT_FILE"',
        'printf "%s\\n" "$*" >> "$FAKE_RM_LOG_FILE"',
        'if [ "$count" -eq 1 ]; then exit 73; fi',
        'exec /usr/bin/rm "$@"',
        "",
      ].join("\n"),
    );
    await chmod(path.join(commands, "rm"), 0o755);
    const result = spawnSync("/bin/sh", [path.join(root, "install.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${commands}:/usr/bin:/bin`,
        HOME: home,
        TMPDIR: temporary,
        FIXTURE_ROOT: fixture,
        FAKE_RM_COUNT_FILE: removalCount,
        FAKE_RM_LOG_FILE: removalLog,
        SANA_MCP_INSTALL_DIR: path.join(temporary, "managed-bin"),
        SANA_MCP_VERSION: "not-a-release-tag",
        SANA_MCP_YES: "1",
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid tag/);
    assert.match(
      result.stderr,
      /cleanup was incomplete: the downloaded temporary files could not be removed/,
    );
    assert.equal((await readFile(removalCount, "utf8")).trim(), "2");
    assert.equal(
      (await readFile(removalLog, "utf8")).trim().split("\n").length,
      2,
    );
    assert.deepEqual(
      (await readdir(temporary)).filter((entry) =>
        entry.startsWith("sana-mcp."),
      ),
      [],
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX retries installer-created lock cleanup after establishment faults", async () => {
  if (process.platform !== "linux") return;
  for (const lockKind of ["install", "path"] as const) {
    for (const faultKind of ["mktemp-rmdir", "token-write-rm"] as const) {
      const temporary = await mkdtemp(
        path.join(os.tmpdir(), `sana-${lockKind}-${faultKind}-`),
      );
      try {
        const fixture = await createOfflineRelease(temporary);
        const commands = path.join(temporary, "commands");
        const home = path.join(temporary, "home");
        const installDirectory = path.join(temporary, "managed-bin");
        const lockDirectory =
          lockKind === "install"
            ? path.join(installDirectory, ".sana-mcp-install-lock")
            : path.join(home, ".sana-mcp-installer-path.lock");
        const lockPattern =
          lockKind === "install"
            ? "*/.sana-mcp-install-lock/owner.*"
            : "*/.sana-mcp-installer-path.lock/owner.*";
        const cleanupFault = path.join(temporary, "cleanup-fault-used");
        await mkdir(home);
        await writeFile(
          path.join(commands, "mktemp"),
          [
            "#!/bin/sh",
            'case "$*" in',
            `  ${lockPattern})`,
            faultKind === "mktemp-rmdir"
              ? "    exit 73 ;;"
              : '    token=$(/usr/bin/mktemp "$@") || exit $?; chmod 400 "$token"; printf "%s\\n" "$token"; exit 0 ;;',
            "esac",
            'exec /usr/bin/mktemp "$@"',
            "",
          ].join("\n"),
        );
        if (faultKind === "mktemp-rmdir") {
          await writeFile(
            path.join(commands, "rmdir"),
            [
              "#!/bin/sh",
              'if [ "$1" = "$FAKE_LOCK_DIRECTORY" ] && [ ! -f "$FAKE_CLEANUP_FAULT_FILE" ]; then',
              '  : > "$FAKE_CLEANUP_FAULT_FILE"',
              "  exit 74",
              "fi",
              'exec /usr/bin/rmdir "$@"',
              "",
            ].join("\n"),
          );
          await chmod(path.join(commands, "rmdir"), 0o755);
        } else {
          await writeFile(
            path.join(commands, "rm"),
            [
              "#!/bin/sh",
              'for candidate in "$@"; do',
              '  case "$candidate" in',
              `    ${lockPattern})`,
              '      if [ ! -f "$FAKE_CLEANUP_FAULT_FILE" ]; then : > "$FAKE_CLEANUP_FAULT_FILE"; exit 75; fi ;;',
              "  esac",
              "done",
              'exec /usr/bin/rm "$@"',
              "",
            ].join("\n"),
          );
          await chmod(path.join(commands, "rm"), 0o755);
        }
        await chmod(path.join(commands, "mktemp"), 0o755);

        const result = spawnSync("/bin/sh", [path.join(root, "install.sh")], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${commands}:/usr/bin:/bin`,
            HOME: home,
            FIXTURE_ROOT: fixture,
            FAKE_LOCK_DIRECTORY: lockDirectory,
            FAKE_CLEANUP_FAULT_FILE: cleanupFault,
            SANA_MCP_INSTALL_DIR: installDirectory,
            SANA_MCP_VERSION: "v0.3.2",
            SANA_MCP_YES: "1",
          },
        });
        assert.equal(result.status, 1);
        assert.match(
          result.stderr,
          faultKind === "mktemp-rmdir"
            ? /could not establish ownership/
            : /could not record ownership/,
        );
        assert.match(
          result.stderr,
          faultKind === "mktemp-rmdir"
            ? /could not remove the installer-created .*lock directory/
            : /could not remove the unverified .*lock token/,
        );
        await access(cleanupFault);
        await assert.rejects(access(lockDirectory));
        await assert.rejects(
          access(path.join(installDirectory, ".sana-mcp-install-lock")),
        );
        await assert.rejects(
          access(path.join(home, ".sana-mcp-installer-path.lock")),
        );
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  }
});

test("PowerShell tag validation uses the shared strict SemVer corpus", async () => {
  const command =
    process.platform === "win32"
      ? "powershell.exe"
      : (
          spawnSync(
            "/bin/sh",
            ["-c", "command -v pwsh || command -v powershell.exe"],
            { encoding: "utf8" },
          ).stdout.trim()
        );
  if (command.length === 0) return;

  const installer = await readFile(path.join(root, "install.ps1"), "utf8");
  const functionStart = installer.indexOf("function Assert-ReleaseTag");
  const functionEnd = installer.indexOf("\nfunction Open-HttpsResponse");
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);
  const validator = installer.slice(functionStart, functionEnd);
  const corpus = JSON.parse(
    await readFile(path.join(root, "release", "semver-corpus.json"), "utf8"),
  ) as { valid: string[]; invalid: string[] };
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const script = [
    '$ErrorActionPreference = "Stop"',
    validator,
    `$ValidTags = @(${corpus.valid.map(quote).join(",")})`,
    "foreach ($Tag in $ValidTags) { Assert-ReleaseTag $Tag }",
    `$InvalidTags = @(${corpus.invalid.map(quote).join(",")})`,
    "foreach ($Tag in $InvalidTags) {",
    "  $Accepted = $true",
    "  try { Assert-ReleaseTag $Tag } catch { $Accepted = $false }",
    '  if ($Accepted) { throw "Accepted invalid tag: $Tag" }',
    "}",
    "",
  ].join("\n");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-ps-semver-"));
  try {
    const scriptPath = path.join(temporary, "semver.ps1");
    await writeFile(scriptPath, script);
    let executableScriptPath = scriptPath;
    if (
      process.platform === "linux" &&
      command.toLowerCase().endsWith(".exe")
    ) {
      const converted = spawnSync("wslpath", ["-w", scriptPath], {
        encoding: "utf8",
      });
      if (converted.status !== 0) return;
      executableScriptPath = converted.stdout.trim();
    }
    const result = spawnSync(
      command,
      ["-NoProfile", "-NonInteractive", "-File", executableScriptPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PowerShell IEX failures are catchable and direct-file failures remain nonzero", async () => {
  const command =
    process.platform === "win32"
      ? "powershell.exe"
      : (
          spawnSync(
            "/bin/sh",
            ["-c", "command -v pwsh || command -v powershell.exe"],
            { encoding: "utf8" },
          ).stdout.trim()
        );
  if (command.length === 0) return;

  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-ps-entrypoint-"));
  try {
    const installerPath = path.join(root, "install.ps1");
    let executableInstallerPath = installerPath;
    let executableTemporary = temporary;
    if (
      process.platform === "linux" &&
      command.toLowerCase().endsWith(".exe")
    ) {
      const convertedInstaller = spawnSync("wslpath", ["-w", installerPath], {
        encoding: "utf8",
      });
      const convertedTemporary = spawnSync("wslpath", ["-w", temporary], {
        encoding: "utf8",
      });
      if (
        convertedInstaller.status !== 0 ||
        convertedTemporary.status !== 0
      ) {
        return;
      }
      executableInstallerPath = convertedInstaller.stdout.trim();
      executableTemporary = convertedTemporary.stdout.trim();
    }
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const harnessPath = path.join(temporary, "iex-catch.ps1");
    const executableHarnessPath =
      process.platform === "linux" && command.toLowerCase().endsWith(".exe")
        ? `${executableTemporary}\\iex-catch.ps1`
        : harnessPath;
    await writeFile(
      harnessPath,
      [
        '$ErrorActionPreference = "Continue"',
        '$ProgressPreference = "Continue"',
        "$PSNativeCommandUseErrorActionPreference = $true",
        '$env:SANA_MCP_VERSION = "not-a-release-tag"',
        `$env:LOCALAPPDATA = ${quote(executableTemporary)}`,
        `$env:TEMP = ${quote(executableTemporary)}`,
        `$env:TMP = ${quote(executableTemporary)}`,
        `$Installer = Get-Content -Raw -LiteralPath ${quote(executableInstallerPath)}`,
        '$Repo = "caller-repo"',
        '$TempDir = "caller-temp"',
        "$LASTEXITCODE = 47",
        '$script:CleanupRemoveAttempts = 0',
        "function Remove-Item {",
        "  [CmdletBinding()]",
        "  param(",
        "    [Parameter(Mandatory = $true)] [string] $LiteralPath,",
        "    [switch] $Force,",
        "    [switch] $Recurse",
        "  )",
        "  $script:CleanupRemoveAttempts++",
        '  throw "injected cleanup failure"',
        "}",
        'if ($null -ne (Get-Command Assert-ReleaseTag -ErrorAction SilentlyContinue)) { throw "test function already exists" }',
        "$Caught = $false",
        "$CaughtMessage = $null",
        "try {",
        "  Invoke-Expression $Installer",
        "} catch {",
        "  $Caught = $true",
        "  $CaughtMessage = $_.Exception.Message",
        "}",
        'if (-not $Caught) { throw "IEX installer failure was not catchable" }',
        'if ($CaughtMessage -cnotmatch "^sana-mcp: Release metadata contains an invalid tag\\.; cleanup was incomplete:") { throw "primary failure did not remain authoritative: $CaughtMessage" }',
        'if ($CaughtMessage -cnotmatch "could not remove temporary installer files: injected cleanup failure") { throw "cleanup context was not attached: $CaughtMessage" }',
        'if ($script:CleanupRemoveAttempts -ne 1) { throw "unexpected cleanup attempt count" }',
        'if ($ErrorActionPreference -cne "Continue") { throw "ErrorActionPreference leaked" }',
        'if ($ProgressPreference -cne "Continue") { throw "ProgressPreference leaked" }',
        'if ($PSNativeCommandUseErrorActionPreference -ne $true) { throw "native error preference leaked" }',
        'if ($Repo -cne "caller-repo") { throw "Repo leaked" }',
        'if ($TempDir -cne "caller-temp") { throw "TempDir leaked" }',
        'if ($LASTEXITCODE -ne 47) { throw "LASTEXITCODE leaked" }',
        'if ($null -ne (Get-Command Assert-ReleaseTag -ErrorAction SilentlyContinue)) { throw "installer function leaked" }',
        'if ($null -ne (Get-Variable InstallFailure -Scope 0 -ErrorAction SilentlyContinue)) { throw "installer state leaked" }',
        'Get-ChildItem -LiteralPath $env:TEMP -Filter "sana-mcp-*" -Directory | ForEach-Object { Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $_.FullName -Recurse -Force }',
        'Write-Output "iex-caught-and-continued"',
        "",
      ].join("\n"),
    );
    const environment = {
      ...process.env,
      LOCALAPPDATA: executableTemporary,
      SANA_MCP_VERSION: "not-a-release-tag",
      WSLENV:
        process.platform === "linux" && command.toLowerCase().endsWith(".exe")
          ? [process.env.WSLENV, "LOCALAPPDATA", "SANA_MCP_VERSION"]
              .filter((value) => value && value.length > 0)
              .join(":")
          : process.env.WSLENV,
    };
    const iexResult = spawnSync(
      command,
      ["-NoProfile", "-NonInteractive", "-File", executableHarnessPath],
      { encoding: "utf8", env: environment },
    );
    assert.equal(iexResult.status, 0, iexResult.stderr);
    assert.match(iexResult.stdout, /iex-caught-and-continued/);

    const directResult = spawnSync(
      command,
      ["-NoProfile", "-NonInteractive", "-File", executableInstallerPath],
      { encoding: "utf8", env: environment },
    );
    assert.notEqual(directResult.status, 0);
    assert.match(directResult.stderr, /invalid tag/i);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PowerShell restores caller LASTEXITCODE after an installer native call", async () => {
  const command =
    process.platform === "win32"
      ? "powershell.exe"
      : (
          spawnSync(
            "/bin/sh",
            ["-c", "command -v pwsh || command -v powershell.exe"],
            { encoding: "utf8" },
          ).stdout.trim()
        );
  if (command.length === 0) return;

  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-ps-last-exit-"));
  try {
    const installer = await readFile(path.join(root, "install.ps1"), "utf8");
    const mainMarker = "try {\n  $NativeArchitecture";
    assert.ok(installer.includes(mainMarker));
    const injectedInstaller = installer.replace(
      mainMarker,
      [
        "try {",
        "  if ($env:ComSpec) {",
        '    & $env:ComSpec /d /c "exit 23"',
        "  } else {",
        '    & /bin/sh -c "exit 23"',
        "  }",
        '  if ($LASTEXITCODE -ne 23) { throw "native exit code was not observed inside installer scope" }',
        '  throw "injected failure after installer native call"',
        "  $NativeArchitecture",
      ].join("\n"),
    );
    const injectedPath = path.join(temporary, "install-native-exit.ps1");
    const harnessPath = path.join(temporary, "last-exit.ps1");
    await writeFile(injectedPath, injectedInstaller);

    let executableTemporary = temporary;
    if (
      process.platform === "linux" &&
      command.toLowerCase().endsWith(".exe")
    ) {
      const converted = spawnSync("wslpath", ["-w", temporary], {
        encoding: "utf8",
      });
      if (converted.status !== 0) return;
      executableTemporary = converted.stdout.trim();
    }
    const executableInjectedPath =
      process.platform === "linux" && command.toLowerCase().endsWith(".exe")
        ? `${executableTemporary}\\install-native-exit.ps1`
        : injectedPath;
    const executableHarnessPath =
      process.platform === "linux" && command.toLowerCase().endsWith(".exe")
        ? `${executableTemporary}\\last-exit.ps1`
        : harnessPath;
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    await writeFile(
      harnessPath,
      [
        '$ErrorActionPreference = "Stop"',
        `$Installer = Get-Content -Raw -LiteralPath ${quote(executableInjectedPath)}`,
        "if ($env:ComSpec) {",
        '  & $env:ComSpec /d /c "exit 41"',
        "} else {",
        '  & /bin/sh -c "exit 41"',
        "}",
        'if ($LASTEXITCODE -ne 41) { throw "caller setup did not establish LASTEXITCODE" }',
        "$Caught = $false",
        "try { Invoke-Expression $Installer } catch {",
        "  $Caught = $true",
        '  if ($_.Exception.Message -cnotmatch "injected failure after installer native call") { throw }',
        "}",
        'if (-not $Caught) { throw "injected installer failure was not catchable" }',
        'if ($LASTEXITCODE -ne 41) { throw "installer native call changed caller LASTEXITCODE" }',
        "& {",
        "  Remove-Variable -Name LASTEXITCODE -Scope Local -ErrorAction SilentlyContinue",
        '  if ($null -ne (Get-Variable -Name LASTEXITCODE -Scope 0 -ErrorAction SilentlyContinue)) { throw "LASTEXITCODE absence setup failed" }',
        "  try { Invoke-Expression $Installer } catch {",
        '    if ($_.Exception.Message -cnotmatch "injected failure after installer native call") { throw }',
        "  }",
        '  if ($null -ne (Get-Variable -Name LASTEXITCODE -Scope 0 -ErrorAction SilentlyContinue)) { throw "installer created caller LASTEXITCODE" }',
        "}",
        'Write-Output "last-exit-restored"',
        "",
      ].join("\n"),
    );
    const result = spawnSync(
      command,
      ["-NoProfile", "-NonInteractive", "-File", executableHarnessPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /last-exit-restored/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PowerShell cleanup attempts every target after an earlier failure", async () => {
  const command =
    process.platform === "win32"
      ? "powershell.exe"
      : (
          spawnSync(
            "/bin/sh",
            ["-c", "command -v pwsh || command -v powershell.exe"],
            { encoding: "utf8" },
          ).stdout.trim()
        );
  if (command.length === 0) return;

  const installer = await readFile(path.join(root, "install.ps1"), "utf8");
  const functionStart = installer.indexOf("function Invoke-InstallerCleanup");
  const functionEnd = installer.indexOf("\ntry {\n  $NativeArchitecture");
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);
  const cleanupFunction = installer.slice(functionStart, functionEnd);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-ps-cleanup-"));
  try {
    const stagedBinary = path.join(temporary, "staged-binary");
    const stagedReceipt = path.join(temporary, "staged-receipt");
    const installLock = path.join(temporary, "install-lock");
    const pathLock = path.join(temporary, "path-lock");
    const installerTemp = path.join(temporary, "installer-temp");
    await writeFile(stagedBinary, "binary");
    await writeFile(stagedReceipt, "receipt");
    await Promise.all([
      mkdir(installLock),
      mkdir(pathLock),
      mkdir(installerTemp),
    ]);

    let executableTemporary = temporary;
    if (
      process.platform === "linux" &&
      command.toLowerCase().endsWith(".exe")
    ) {
      const converted = spawnSync("wslpath", ["-w", temporary], {
        encoding: "utf8",
      });
      if (converted.status !== 0) return;
      executableTemporary = converted.stdout.trim();
    }
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const windowsPath = (name: string) =>
      process.platform === "linux" && command.toLowerCase().endsWith(".exe")
        ? `${executableTemporary}\\${name}`
        : path.join(temporary, name);
    const harnessPath = path.join(temporary, "cleanup.ps1");
    const executableHarnessPath = windowsPath("cleanup.ps1");
    await writeFile(
      harnessPath,
      [
        '$ErrorActionPreference = "Stop"',
        cleanupFunction,
        "$script:CleanupAttempts = @()",
        `$script:FailPath = ${quote(windowsPath("staged-binary"))}`,
        "function Remove-Item {",
        "  [CmdletBinding()]",
        "  param(",
        "    [Parameter(Mandatory = $true)] [string] $LiteralPath,",
        "    [switch] $Force,",
        "    [switch] $Recurse",
        "  )",
        "  $script:CleanupAttempts += $LiteralPath",
        '  if ($LiteralPath -ceq $script:FailPath) { throw "injected first cleanup failure" }',
        "  Microsoft.PowerShell.Management\\Remove-Item @PSBoundParameters",
        "}",
        `$Failures = @(Invoke-InstallerCleanup ${quote(windowsPath("staged-binary"))} ${quote(windowsPath("staged-receipt"))} $null $true ${quote(windowsPath("install-lock"))} $null $true ${quote(windowsPath("path-lock"))} $false ${quote(windowsPath("installer-temp"))})`,
        'if ($script:CleanupAttempts.Count -ne 5) { throw "not every cleanup target was attempted" }',
        'if ($Failures.Count -ne 1 -or $Failures[0] -cnotmatch "could not remove staged binary: injected first cleanup failure") { throw "cleanup failures were not aggregated accurately" }',
        "$NoopFailures = @(Invoke-InstallerCleanup $null $null $null $false $null $null $false $null $false $null)",
        'if ($NoopFailures.Count -ne 0) { throw "empty optional cleanup paths produced a failure" }',
        'if ($script:CleanupAttempts.Count -ne 5) { throw "empty optional cleanup paths reached Remove-Item" }',
        'if (-not (Test-Path -LiteralPath $script:FailPath)) { throw "failed cleanup target unexpectedly disappeared" }',
        `foreach ($Removed in @(${[
          "staged-receipt",
          "install-lock",
          "path-lock",
          "installer-temp",
        ]
          .map((name) => quote(windowsPath(name)))
          .join(",")})) { if (Test-Path -LiteralPath $Removed) { throw "later cleanup target was skipped: $Removed" } }`,
        "",
      ].join("\n"),
    );
    const result = spawnSync(
      command,
      ["-NoProfile", "-NonInteractive", "-File", executableHarnessPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PowerShell download progress retains bar, size, speed, ETA, and bounded completion", async () => {
  const command =
    process.platform === "win32"
      ? "powershell.exe"
      : (
          spawnSync(
            "/bin/sh",
            ["-c", "command -v pwsh || command -v powershell.exe"],
            { encoding: "utf8" },
          ).stdout.trim()
        );
  if (command.length === 0) return;

  const installer = await readFile(path.join(root, "install.ps1"), "utf8");
  const functionStart = installer.indexOf("function Format-DownloadProgress");
  const functionEnd = installer.indexOf("\nfunction Read-Properties");
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);
  const formatter = installer.slice(functionStart, functionEnd);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-ps-progress-"));
  try {
    const harnessPath = path.join(temporary, "progress.ps1");
    let executableHarnessPath = harnessPath;
    if (
      process.platform === "linux" &&
      command.toLowerCase().endsWith(".exe")
    ) {
      const converted = spawnSync("wslpath", ["-w", harnessPath], {
        encoding: "utf8",
      });
      if (converted.status !== 0) return;
      executableHarnessPath = converted.stdout.trim();
    }
    await writeFile(
      harnessPath,
      [
        '$ErrorActionPreference = "Stop"',
        formatter,
        "$Known = Format-DownloadProgress 50MB 100MB 10",
        'if ($Known -cnotmatch "\\[############------------\\]") { throw "known-length bar changed" }',
        'if ($Known -cnotmatch " 50%") { throw "known-length percent changed" }',
        'if ($Known -cnotmatch "50/100 MB") { throw "known-length size changed" }',
        'if ($Known -cnotmatch "5 MB/s") { throw "known-length speed changed" }',
        'if ($Known -cnotmatch "ETA 00:10") { throw "known-length ETA changed" }',
        "$Complete = Format-DownloadProgress 120MB 100MB 10",
        'if ($Complete -cnotmatch "\\[########################\\] 100%") { throw "completion was not clamped" }',
        'if ($Complete -cnotmatch "ETA 00:00") { throw "completion ETA changed" }',
        "$Unknown = Format-DownloadProgress 50MB -1 10",
        'if ($Unknown -cnotmatch "50 MB  5 MB/s") { throw "unknown-length size or speed changed" }',
        'if ($Unknown -match "%|ETA") { throw "unknown length invented percent or ETA" }',
        "$DecimalTotal = [long] (106.1 * 1MB)",
        "$Early = Format-DownloadProgress 1MB $DecimalTotal 1",
        "$Middle = Format-DownloadProgress 50MB $DecimalTotal 50",
        "$DecimalComplete = Format-DownloadProgress $DecimalTotal $DecimalTotal 106.1",
        'if ($Early -cnotmatch "1/106\\.1 MB" -or $Middle -cnotmatch "50/106\\.1 MB" -or $DecimalComplete -cnotmatch "106\\.1/106\\.1 MB") { throw "decimal-size rendering changed" }',
        'if ($Early.IndexOf("/") -ne $Middle.IndexOf("/") -or $Middle.IndexOf("/") -ne $DecimalComplete.IndexOf("/")) { throw "current-size width did not reserve the total width" }',
        'if ($Early.IndexOf(" MB/s") -ne $Middle.IndexOf(" MB/s") -or $Middle.IndexOf(" MB/s") -ne $DecimalComplete.IndexOf(" MB/s")) { throw "downstream progress columns shifted" }',
        'if ($Early.Length -ne $Middle.Length -or $Middle.Length -ne $DecimalComplete.Length) { throw "fixed-width progress lines changed length" }',
        "$OriginalCulture = [Threading.Thread]::CurrentThread.CurrentCulture",
        "try {",
        '  [Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo("de-DE")',
        "  $Invariant = Format-DownloadProgress 1.5MB 10.5MB 1.5",
        '  if ($Invariant -cnotmatch "1\\.5/10\\.5 MB") { throw "progress numbers followed the host locale" }',
        "} finally {",
        "  [Threading.Thread]::CurrentThread.CurrentCulture = $OriginalCulture",
        "}",
        "",
      ].join("\n"),
    );
    const result = spawnSync(
      command,
      ["-NoProfile", "-NonInteractive", "-File", executableHarnessPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PowerShell receiptless recognition accepts only published legacy digests", async () => {
  const command =
    process.platform === "win32"
      ? "powershell.exe"
      : (
          spawnSync(
            "/bin/sh",
            ["-c", "command -v pwsh || command -v powershell.exe"],
            { encoding: "utf8" },
          ).stdout.trim()
        );
  if (command.length === 0) return;

  const installer = await readFile(path.join(root, "install.ps1"), "utf8");
  const functionStart = installer.indexOf(
    "function Get-VerifiedLegacyReleaseDigest",
  );
  const functionEnd = installer.indexOf(
    "\nfunction Get-VerifiedLegacyRelease(",
  );
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);
  const verifier = installer.slice(functionStart, functionEnd);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-ps-legacy-"));
  try {
    const harnessPath = path.join(temporary, "legacy.ps1");
    let executableHarnessPath = harnessPath;
    if (
      process.platform === "linux" &&
      command.toLowerCase().endsWith(".exe")
    ) {
      const converted = spawnSync("wslpath", ["-w", harnessPath], {
        encoding: "utf8",
      });
      if (converted.status !== 0) return;
      executableHarnessPath = converted.stdout.trim();
    }
    await writeFile(
      harnessPath,
      [
        '$ErrorActionPreference = "Stop"',
        verifier,
        '$Release = Get-VerifiedLegacyReleaseDigest "4e905d9dd43d801ed3662ad4c1a7d774175207d92a1fd761d3b283af291c29de"',
        'if ($Release -cne "v0.3.2") { throw "official v0.3.2 digest was not recognized" }',
        '$SharedRelease = Get-VerifiedLegacyReleaseDigest "da20ac9ec3accb3aed715a064dcd6c250721b1afa2882465d5edef680a813b3d"',
        'if ($SharedRelease -cne "v0.1.0-rc1 or v0.1.0") { throw "shared v0.1.0 release digest was not recognized accurately" }',
        '$Foreign = Get-VerifiedLegacyReleaseDigest "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
        'if ($null -ne $Foreign) { throw "foreign receiptless digest was accepted" }',
        "",
      ].join("\n"),
    );
    const result = spawnSync(
      command,
      ["-NoProfile", "-NonInteractive", "-File", executableHarnessPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PowerShell retires an active exact-path runtime, publishes safely, and makes old-state rollback idempotent", { timeout: 30_000 }, async () => {
  const command =
    process.platform === "win32"
      ? "powershell.exe"
      : (
          spawnSync(
            "/bin/sh",
            ["-c", "command -v pwsh || command -v powershell.exe"],
            { encoding: "utf8" },
          ).stdout.trim()
        );
  if (command.length === 0) return;

  const installer = await readFile(path.join(root, "install.ps1"), "utf8");
  const fileFunctionStart = installer.indexOf("function Get-Sha256");
  const fileFunctionEnd = installer.indexOf(
    "\nfunction Get-VerifiedLegacyReleaseDigest",
  );
  const processFunctionStart = installer.indexOf(
    "function Get-CanonicalRuntimeProcesses",
  );
  const processFunctionEnd = installer.indexOf("\nfunction Assert-NotReparse");
  assert.notEqual(fileFunctionStart, -1);
  assert.notEqual(fileFunctionEnd, -1);
  assert.notEqual(processFunctionStart, -1);
  assert.notEqual(processFunctionEnd, -1);
  const fileFunctions = installer.slice(fileFunctionStart, fileFunctionEnd);
  const processFunctions = installer.slice(
    processFunctionStart,
    processFunctionEnd,
  );
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-ps-daemon-"));
  try {
    const harnessPath = path.join(temporary, "daemon.ps1");
    let executableHarnessPath = harnessPath;
    if (
      process.platform === "linux" &&
      command.toLowerCase().endsWith(".exe")
    ) {
      const converted = spawnSync("wslpath", ["-w", harnessPath], {
        encoding: "utf8",
      });
      if (converted.status !== 0) return;
      executableHarnessPath = converted.stdout.trim();
    }
    await writeFile(
      harnessPath,
      [
        '$ErrorActionPreference = "Stop"',
        fileFunctions,
        processFunctions,
        '$Root = Join-Path $env:TEMP ("sana-installer-native-" + [Guid]::NewGuid().ToString("N"))',
        '$Install = Join-Path $Root "installed"',
        '$Other = Join-Path $Root "other"',
        '[IO.Directory]::CreateDirectory($Install) | Out-Null',
        '[IO.Directory]::CreateDirectory($Other) | Out-Null',
        '$Target = Join-Path $Install "sana-mcp.exe"',
        '$OtherTarget = Join-Path $Other "sana-mcp.exe"',
        '$Previous = Join-Path $Root "previous-sana-mcp.exe"',
        '$Stage = Join-Path $Install ".sana-mcp-stage.exe"',
        '$TargetProcess = $null',
        '$OtherProcess = $null',
        '$PublishedProcess = $null',
        '$RetiredProcess = $null',
        "try {",
        '  Copy-Item -LiteralPath (Join-Path $PSHOME "powershell.exe") -Destination $Target',
        '  Copy-Item -LiteralPath $Target -Destination $OtherTarget',
        '  Copy-Item -LiteralPath $Target -Destination $Previous',
        '  $OldHash = Get-Sha256 $Target',
        '  Copy-Item -LiteralPath (Join-Path $env:SystemRoot "System32\\cmd.exe") -Destination $Stage',
        '  $NewHash = Get-Sha256 $Stage',
        "  $TargetProcess = Start-Process -FilePath $Target -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 30') -WindowStyle Hidden -PassThru",
        "  $OtherProcess = Start-Process -FilePath $OtherTarget -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 30') -WindowStyle Hidden -PassThru",
        '  $Deadline = [DateTime]::UtcNow.AddSeconds(5)',
        '  while (@(Get-CanonicalRuntimeProcesses $Target).Count -eq 0) {',
        '    if ([DateTime]::UtcNow -ge $Deadline) { throw "target process was not observable" }',
        '    Start-Sleep -Milliseconds 50',
        "  }",
        "  Stop-CanonicalRuntimeProcesses $Target",
        '  if (-not $TargetProcess.WaitForExit(3000)) { throw "exact-path process survived" }',
        '  if ($OtherProcess.HasExited) { throw "same-name other-path process was terminated" }',
        '  $Retired = $null',
        '  Publish-InstallerFile $Stage $Target $NewHash $OldHash ([ref] $Retired)',
        '  if ((Get-Sha256 $Target) -cne $NewHash) { throw "replacement was not published" }',
        "  $PublishedProcess = Start-Process -FilePath $Target -ArgumentList @('/c','ping -n 30 127.0.0.1 > nul') -WindowStyle Hidden -PassThru",
        "  $RetiredProcess = Start-Process -FilePath $Retired -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 30') -WindowStyle Hidden -PassThru",
        '  Stop-CanonicalRuntimeProcesses $Target',
        '  Stop-CanonicalRuntimeProcesses $Retired',
        '  if (-not $PublishedProcess.WaitForExit(3000) -or -not $RetiredProcess.WaitForExit(3000)) { throw "publication cleanup did not quiesce both paths" }',
        '  Remove-Item -LiteralPath $Retired -Force',
        '  Restore-InstallerFileState $Target $Previous $OldHash $NewHash "installed binary"',
        '  if ((Get-Sha256 $Target) -cne $OldHash) { throw "old runtime was not restored" }',
        '  $Before = (Get-Item -LiteralPath $Target).LastWriteTimeUtc.Ticks',
        '  Restore-InstallerFileState $Target $Previous $OldHash $NewHash "installed binary"',
        '  $After = (Get-Item -LiteralPath $Target).LastWriteTimeUtc.Ticks',
        '  if ($After -ne $Before) { throw "already-old rollback was not a no-op" }',
        "} finally {",
        '  foreach ($ProcessToClean in @($TargetProcess, $OtherProcess, $PublishedProcess, $RetiredProcess)) {',
        '    if ($null -eq $ProcessToClean) { continue }',
        '    try { if (-not $ProcessToClean.HasExited) { $ProcessToClean.Kill() }; $ProcessToClean.WaitForExit(3000) | Out-Null } catch { }',
        "  }",
        '  if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue }',
        "}",
        "",
      ].join("\n"),
    );
    const result = spawnSync(
      command,
      ["-NoProfile", "-NonInteractive", "-File", executableHarnessPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Windows compatible-update E2E strips destructive authority from the installer child", () => {
  assert.deepEqual(compatibleUpdateInstallerEnvironmentLines.slice(0, 2), [
    '  [void]$InstallerInfo.EnvironmentVariables.Remove("SANA_MCP_REPLACE_INCOMPATIBLE")',
    '  [void]$InstallerInfo.EnvironmentVariables.Remove("SANA_MCP_INCOMPATIBLE_RESET")',
  ]);
  assert.equal(compatibleUpdateInstallerEnvironmentLines.length, 3);
  assert.doesNotMatch(
    compatibleUpdateInstallerEnvironmentLines[2],
    /SANA_MCP_(?:REPLACE_INCOMPATIBLE|INCOMPATIBLE_RESET)/u,
  );
});

test(`Windows full installer replaces an active receipt-backed ${predecessorTag} mcp runtime`, { timeout: 180_000 }, async () => {
  const configuredCurrentBinary =
    process.env.SANA_MCP_TEST_CURRENT_WINDOWS_BINARY;
  const sourceCommit = process.env.SANA_MCP_TEST_SOURCE_COMMIT;
  if (!configuredCurrentBinary || !sourceCommit) return;
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);

  const powershell =
    process.platform === "win32"
      ? "powershell.exe"
      : (
          spawnSync(
            "/bin/sh",
            ["-c", "command -v powershell.exe"],
            { encoding: "utf8" },
          ).stdout.trim()
        );
  assert.notEqual(powershell, "");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-windows-e2e-"));
  const fixture = path.join(temporary, "fixture");
  await mkdir(fixture);
  const download = async (name: string): Promise<string> => {
    const response = await fetch(
      `https://github.com/Etals-AiApp/sana-ai-mcp/releases/download/${predecessorTag}/${name}`,
    );
    assert.equal(
      response.ok,
      true,
      `could not download official ${predecessorTag} ${name}`,
    );
    const destination = path.join(fixture, name);
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
    return destination;
  };
  const oldManifestPath = await download("manifest.json");
  const oldManifestChecksumPath = await download("manifest.json.sha256");
  const oldBinaryPath = await download("sana-mcp-windows-x64.exe");
  const oldBinaryChecksumPath = await download(
    "sana-mcp-windows-x64.exe.sha256",
  );
  const oldManifestBytes = await readFile(oldManifestPath);
  const oldManifestHash = sha256(oldManifestBytes);
  assert.equal(
    (await readFile(oldManifestChecksumPath, "utf8")).trim(),
    `${oldManifestHash}  manifest.json`,
  );
  const oldManifest = JSON.parse(oldManifestBytes.toString("utf8")) as {
    packageVersion: string;
    sourceCommit: string;
    installerProtocol: number;
    lifecycleProtocol: number;
    inspectProtocol: number;
    stateCompatibility: number;
    semanticCapability: string;
    assets: Array<{
      target: string;
      assetName: string;
      checksumFileName: string;
      sha256: string;
    }>;
  };
  assert.equal(oldManifest.packageVersion, predecessorVersion);
  assert.equal(oldManifest.installerProtocol, 1);
  assert.equal(oldManifest.lifecycleProtocol, 1);
  assert.equal(oldManifest.inspectProtocol, 1);
  assert.equal(oldManifest.stateCompatibility, 1);
  const oldAsset = oldManifest.assets.find(
    (asset) => asset.target === "bun-windows-x64",
  );
  assert.ok(oldAsset);
  const oldBinaryHash = sha256(await readFile(oldBinaryPath));
  assert.equal(oldBinaryHash, oldAsset.sha256);
  assert.equal(
    (await readFile(oldBinaryChecksumPath, "utf8")).trim(),
    `${oldBinaryHash}  sana-mcp-windows-x64.exe`,
  );
  await writeFile(
    path.join(fixture, predecessorWindowsFixture),
    await readFile(oldBinaryPath),
  );

  let currentBinaryPath = path.resolve(configuredCurrentBinary);
  if (process.platform === "linux") {
    const converted = spawnSync("wslpath", ["-u", configuredCurrentBinary], {
      encoding: "utf8",
    });
    if (converted.status === 0) currentBinaryPath = converted.stdout.trim();
  }
  const currentInspect = spawnSync(
    currentBinaryPath,
    ["__inspect", "--format", "json"],
    { encoding: "utf8" },
  );
  assert.equal(currentInspect.status, 0, currentInspect.stderr);
  const currentIdentity = JSON.parse(currentInspect.stdout) as {
    version: string;
    target: string;
    installerProtocol: number;
    lifecycleProtocol: number;
    inspectProtocol: number;
    stateCompatibility: number;
    semanticCapability: string;
  };
  assert.equal(currentIdentity.version, currentVersion);
  assert.equal(currentIdentity.target, "bun-windows-x64");
  assert.equal(currentIdentity.installerProtocol, 1);
  assert.equal(currentIdentity.lifecycleProtocol, 1);
  assert.equal(currentIdentity.inspectProtocol, 1);
  assert.equal(currentIdentity.stateCompatibility, 1);
  const currentBinaryHash = sha256(await readFile(currentBinaryPath));
  await writeFile(
    path.join(fixture, "sana-mcp-windows-x64.exe"),
    await readFile(currentBinaryPath),
  );
  await writeFile(
    path.join(fixture, "sana-mcp-windows-x64.exe.sha256"),
    `${currentBinaryHash}  sana-mcp-windows-x64.exe\n`,
  );
  const currentManifest = {
    manifestVersion: 1,
    packageVersion: currentIdentity.version,
    releaseTag: `v${currentIdentity.version}`,
    sourceCommit,
    installerProtocol: currentIdentity.installerProtocol,
    lifecycleProtocol: currentIdentity.lifecycleProtocol,
    inspectProtocol: currentIdentity.inspectProtocol,
    stateCompatibility: currentIdentity.stateCompatibility,
    semanticCapability: currentIdentity.semanticCapability,
    assets: [
      {
        target: currentIdentity.target,
        assetName: "sana-mcp-windows-x64.exe",
        checksumFileName: "sana-mcp-windows-x64.exe.sha256",
        sha256: currentBinaryHash,
      },
    ],
  };
  const currentManifestText = `${JSON.stringify(currentManifest, null, 2)}\n`;
  const currentManifestHash = sha256(currentManifestText);
  await writeFile(path.join(fixture, "manifest.json"), currentManifestText);
  await writeFile(
    path.join(fixture, "manifest.json.sha256"),
    `${currentManifestHash}  manifest.json\n`,
  );
  const metadataName = "manifest-bun-windows-x64.properties";
  const installer = await readFile(path.join(root, "install.ps1"), "utf8");
  const metadata = [
    "format=sana-mcp-release-v1",
    "manifestVersion=1",
    `manifestSha256=${currentManifestHash}`,
    `packageVersion=${currentIdentity.version}`,
    `releaseTag=v${currentIdentity.version}`,
    `sourceCommit=${sourceCommit}`,
    `installerProtocol=${currentIdentity.installerProtocol}`,
    `lifecycleProtocol=${currentIdentity.lifecycleProtocol}`,
    `inspectProtocol=${currentIdentity.inspectProtocol}`,
    `stateCompatibility=${currentIdentity.stateCompatibility}`,
    `semanticCapability=${currentIdentity.semanticCapability}`,
    "installerAssetName=install.ps1",
    `installerSha256=${sha256(installer)}`,
    `target=${currentIdentity.target}`,
    "assetName=sana-mcp-windows-x64.exe",
    "checksumFileName=sana-mcp-windows-x64.exe.sha256",
    `sha256=${currentBinaryHash}`,
    "",
  ].join("\n");
  await writeFile(path.join(fixture, metadataName), metadata);
  await writeFile(
    path.join(fixture, `${metadataName}.sha256`),
    `${sha256(metadata)}  ${metadataName}\n`,
  );
  const oldReceipt = [
    "format=sana-mcp-install-v2",
    `version=${oldManifest.packageVersion}`,
    "target=bun-windows-x64",
    `sourceCommit=${oldManifest.sourceCommit}`,
    `binarySha256=${oldBinaryHash}`,
    "pathManaged=false",
    `installerProtocol=${oldManifest.installerProtocol}`,
    `lifecycleProtocol=${oldManifest.lifecycleProtocol}`,
    `inspectProtocol=${oldManifest.inspectProtocol}`,
    `stateCompatibility=${oldManifest.stateCompatibility}`,
    "",
  ].join("\n");
  await writeFile(path.join(fixture, "old-receipt"), oldReceipt);

  const downloaderStart = installer.indexOf("function Download-Https(");
  const downloaderEnd = installer.indexOf(
    "\nfunction Format-DownloadProgress",
    downloaderStart,
  );
  assert.ok(downloaderStart >= 0 && downloaderEnd > downloaderStart);
  const fixtureDownloader = [
    "function Download-Https(",
    "  [string] $Source,",
    "  [string] $Destination,",
    "  [switch] $ShowProgress",
    ") {",
    "  $Name = [IO.Path]::GetFileName(([Uri] $Source).AbsolutePath)",
    "  $FixtureFile = Join-Path $env:SANA_MCP_TEST_RELEASE_DIR $Name",
    "  if (-not (Test-Path -LiteralPath $FixtureFile -PathType Leaf)) {",
    '    throw "The isolated release fixture is missing $Name."',
    "  }",
    "  Copy-Item -LiteralPath $FixtureFile -Destination $Destination",
    "}",
    "",
  ].join("\n");
  const patchedInstaller =
    installer.slice(0, downloaderStart) +
    fixtureDownloader +
    installer.slice(downloaderEnd);
  const patchedInstallerPath = path.join(fixture, "install-e2e.ps1");
  await writeFile(patchedInstallerPath, patchedInstaller);

  const windowsPath = (file: string): string => {
    if (process.platform === "win32") return file;
    const converted = spawnSync("wslpath", ["-w", file], { encoding: "utf8" });
    assert.equal(converted.status, 0, converted.stderr);
    return converted.stdout.trim();
  };
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const harnessPath = path.join(temporary, "e2e.ps1");
  await writeFile(
    harnessPath,
    [
      '$ErrorActionPreference = "Stop"',
      `$FixtureSource = ${quote(windowsPath(fixture))}`,
      '$KnownLocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)',
      'if ([string]::IsNullOrWhiteSpace($KnownLocalAppData)) { throw "Windows did not provide a canonical E2E root" }',
      '$WindowsPowerShellModulePath = [Environment]::GetEnvironmentVariable("PSModulePath", [EnvironmentVariableTarget]::Machine)',
      'if ([string]::IsNullOrWhiteSpace($WindowsPowerShellModulePath)) { throw "Windows did not provide a machine-scoped PSModulePath" }',
      '$env:PSModulePath = $WindowsPowerShellModulePath',
      '$Root = Join-Path $KnownLocalAppData ("sana-mcp-e2e-" + [Guid]::NewGuid().ToString("N"))',
      '$Release = Join-Path $Root "release"',
      '$Install = Join-Path $Root "install"',
      '$Other = Join-Path $Root "other"',
      '$Profile = Join-Path $Root "profile"',
      '$LocalAppData = Join-Path $Profile "AppData\\Local"',
      '$RoamingAppData = Join-Path $Profile "AppData\\Roaming"',
      '$Data = Join-Path $Root "data"',
      '$Transcripts = Join-Path $Root "transcripts"',
      '$DataSentinel = Join-Path $Data "compatible-auth-sentinel.bin"',
      '$TranscriptSentinel = Join-Path $Transcripts "compatible-transcript-sentinel.txt"',
      '$DataSentinelBytes = [byte[]](0,1,2,127,128,254,255)',
      '$TranscriptSentinelText = "compatible transcript sentinel`r`nsecond line"',
      '$Utf8NoBom = [Text.UTF8Encoding]::new($false)',
      '$ExpectedDataSentinelBytes = [Convert]::ToBase64String($DataSentinelBytes)',
      '$ExpectedTranscriptSentinelBytes = [Convert]::ToBase64String($Utf8NoBom.GetBytes($TranscriptSentinelText))',
      '$OriginalUserPath = [Environment]::GetEnvironmentVariable("Path", "User")',
      '$SerializationLock = Join-Path $KnownLocalAppData ".sana-mcp-installer-path.lock"',
      'if (Test-Path -LiteralPath $SerializationLock) { throw "real known-folder serialization lock was present before isolated test: $SerializationLock" }',
      '$IsolatedProcessPath = "$env:SystemRoot\\System32;$env:SystemRoot;$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0"',
      '$InstalledBinary = Join-Path $Install "sana-mcp.exe"',
      '$OtherBinary = Join-Path $Other "sana-mcp.exe"',
      '$OldProcess = $null',
      '$OtherProcess = $null',
      '$InstallerProcess = $null',
      '$PrimaryError = $null',
      "function Start-IsolatedMcp([string] $Executable, [string] $ProcessData) {",
      "  $Info = [Diagnostics.ProcessStartInfo]::new()",
      "  $Info.FileName = $Executable",
      '  $Info.Arguments = "mcp"',
      "  $Info.UseShellExecute = $false",
      "  $Info.CreateNoWindow = $true",
      "  $Info.RedirectStandardInput = $true",
      "  $Info.RedirectStandardOutput = $true",
      "  $Info.RedirectStandardError = $true",
      '  $Info.EnvironmentVariables["USERPROFILE"] = $Profile',
      '  $Info.EnvironmentVariables["HOME"] = $Profile',
      '  $Info.EnvironmentVariables["LOCALAPPDATA"] = $LocalAppData',
      '  $Info.EnvironmentVariables["APPDATA"] = $RoamingAppData',
      '  $Info.EnvironmentVariables["SANA_DATA_DIR"] = $ProcessData',
      '  $Info.EnvironmentVariables["SANA_TRANSCRIPTS_DIR"] = $Transcripts',
      '  $Info.EnvironmentVariables["PATH"] = $IsolatedProcessPath',
      '  $Info.EnvironmentVariables["PATHEXT"] = ".COM;.EXE;.BAT;.CMD"',
      "  return [Diagnostics.Process]::Start($Info)",
      "}",
      "try {",
      '  foreach ($Directory in @($Release,$Install,$Other,$Profile,$LocalAppData,$RoamingAppData,$Data,$Transcripts)) { [IO.Directory]::CreateDirectory($Directory) | Out-Null }',
      '  [IO.File]::WriteAllBytes($DataSentinel, $DataSentinelBytes)',
      '  [IO.File]::WriteAllText($TranscriptSentinel, $TranscriptSentinelText, $Utf8NoBom)',
      '  [IO.Directory]::CreateDirectory((Join-Path $Profile ".codex")) | Out-Null',
      '  Copy-Item -Path (Join-Path $FixtureSource "*") -Destination $Release -Force',
      `  Copy-Item -LiteralPath (Join-Path $FixtureSource "${predecessorWindowsFixture}") -Destination $InstalledBinary`,
      '  Copy-Item -LiteralPath $InstalledBinary -Destination $OtherBinary',
      '  Copy-Item -LiteralPath (Join-Path $FixtureSource "old-receipt") -Destination (Join-Path $Install ".sana-mcp-install-v1")',
      '  $OldProcess = Start-IsolatedMcp $InstalledBinary $Data',
      '  $OtherData = Join-Path $Root "other-data"',
      '  [IO.Directory]::CreateDirectory($OtherData) | Out-Null',
      '  $OtherProcess = Start-IsolatedMcp $OtherBinary $OtherData',
      '  Start-Sleep -Milliseconds 500',
      '  if ($OldProcess.HasExited -or $OtherProcess.HasExited) { throw "fixture MCP process exited before installation" }',
      '  $InstallerInfo = [Diagnostics.ProcessStartInfo]::new()',
      '  $InstallerInfo.FileName = (Join-Path $PSHOME "powershell.exe")',
      '  $InstallerInfo.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"" + (Join-Path $Release "install-e2e.ps1") + "`""',
      '  $InstallerInfo.UseShellExecute = $false',
      '  $InstallerInfo.CreateNoWindow = $true',
      '  $InstallerInfo.RedirectStandardOutput = $true',
      '  $InstallerInfo.RedirectStandardError = $true',
      ...compatibleUpdateInstallerEnvironmentLines,
      '  $InstallerProcess = [Diagnostics.Process]::Start($InstallerInfo)',
      '  $Stdout = $InstallerProcess.StandardOutput.ReadToEnd()',
      '  $Stderr = $InstallerProcess.StandardError.ReadToEnd()',
      '  if (-not $InstallerProcess.WaitForExit(60000)) { $InstallerProcess.Kill(); throw "installer timed out" }',
      '  if ($InstallerProcess.ExitCode -ne 0) { throw "installer failed: $Stdout`n$Stderr" }',
      '  if (-not $OldProcess.WaitForExit(5000)) { throw "active installed MCP process survived replacement" }',
      '  if ($OtherProcess.HasExited) { throw "same-name other-path process was terminated" }',
      '  if ($Stdout -cnotmatch "Installed .*sana-mcp.exe" -or $Stdout -cnotmatch "Registering sana-mcp with 1 detected client") { throw "successful install/configurer handoff was not reported: $Stdout" }',
      '  if ($Stderr -match "could not start|exited with code") { throw "configurer launch warning was emitted: $Stderr" }',
      `  if ((Get-FileHash -LiteralPath $InstalledBinary -Algorithm SHA256).Hash.ToLowerInvariant() -cne "${currentBinaryHash}") { throw "final binary digest mismatch" }`,
      '  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($DataSentinel)) -cne $ExpectedDataSentinelBytes) { throw "compatible update mutated the data sentinel" }',
      '  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($TranscriptSentinel)) -cne $ExpectedTranscriptSentinelBytes -or [IO.File]::ReadAllText($TranscriptSentinel, $Utf8NoBom) -cne $TranscriptSentinelText) { throw "compatible update mutated the transcript sentinel" }',
      '  $Receipt = @{}; foreach ($Line in [IO.File]::ReadAllLines((Join-Path $Install ".sana-mcp-install-v1"))) { if ($Line) { $Index=$Line.IndexOf("="); $Receipt[$Line.Substring(0,$Index)]=$Line.Substring($Index+1) } }',
      `  if ($Receipt.Count -ne 10 -or $Receipt["format"] -cne "sana-mcp-install-v2" -or $Receipt["version"] -cne "${currentVersion}" -or $Receipt["target"] -cne "bun-windows-x64" -or $Receipt["sourceCommit"] -cne "${sourceCommit}" -or $Receipt["binarySha256"] -cne "${currentBinaryHash}" -or $Receipt["pathManaged"] -cne "false" -or $Receipt["installerProtocol"] -cne "${currentIdentity.installerProtocol}" -or $Receipt["lifecycleProtocol"] -cne "${currentIdentity.lifecycleProtocol}" -or $Receipt["inspectProtocol"] -cne "${currentIdentity.inspectProtocol}" -or $Receipt["stateCompatibility"] -cne "${currentIdentity.stateCompatibility}") { throw "final receipt tuple mismatch" }`,
      '  $Unexpected = @(Get-ChildItem -LiteralPath $Install -Force | Where-Object { $_.Name -notin @("sana-mcp.exe", ".sana-mcp-install-v1") })',
      '  if ($Unexpected.Count -ne 0) { throw "installer artifacts remained: $($Unexpected.Name -join \', \')" }',
      '  if ([Environment]::GetEnvironmentVariable("Path", "User") -cne $OriginalUserPath) { throw "installer changed the real User PATH" }',
      '  if (Test-Path -LiteralPath $SerializationLock) { throw "installer left the real known-folder serialization lock: $SerializationLock" }',
      "} catch {",
      '  $PrimaryError = $_.Exception',
      "} finally {",
      '  $CleanupFailures = @()',
      '  foreach ($ProcessToClean in @($OldProcess,$OtherProcess,$InstallerProcess)) {',
      '    if ($null -eq $ProcessToClean) { continue }',
      '    try {',
      '      if (-not $ProcessToClean.HasExited) { $ProcessToClean.Kill() }',
      '      if (-not $ProcessToClean.WaitForExit(3000)) { throw "PID $($ProcessToClean.Id) did not exit within cleanup deadline" }',
      '    } catch { $CleanupFailures += $_.Exception.Message }',
      "  }",
      '  try { if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }; if (Test-Path -LiteralPath $Root) { throw "isolated root still exists" } } catch { $CleanupFailures += "could not remove isolated root $Root`: $($_.Exception.Message)" }',
      '  if (Test-Path -LiteralPath $SerializationLock) { $CleanupFailures += "real serialization lock remained at $SerializationLock" }',
      "}",
      'if ($null -ne $PrimaryError) { if ($CleanupFailures.Count -gt 0) { throw "$($PrimaryError.Message); cleanup failed: $($CleanupFailures -join \'; \')" }; throw $PrimaryError }',
      'if ($CleanupFailures.Count -gt 0) { throw "cleanup failed: $($CleanupFailures -join \'; \')" }',
      "",
    ].join("\n"),
  );
  try {
    const result = spawnSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-File", windowsPath(harnessPath)],
      { encoding: "utf8", timeout: 120_000 },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Windows confirms incompatible replacement before download and resets state transactionally", async () => {
  const installer = await readFile(path.join(root, "install.ps1"), "utf8");
  const cli = await readFile(path.join(root, "src/cli.ts"), "utf8");
  assert.match(installer, /^# Install[\s\S]*\n& \{\n/u);
  assert.doesNotMatch(installer, /\$script:/u);
  const acquireSharedLock = installer.indexOf(
    '$Directory = Join-Path $Root ".sana-mcp-installer-path.lock"',
  );
  const snapshotPath = installer.indexOf(
    '$OldUserPath = [Environment]::GetEnvironmentVariable("Path", "User")',
  );
  const publishPath = installer.indexOf(
    '[Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")',
  );
  const runtimeStateTouched = installer.indexOf(
    "$RuntimeStateTouched = $true",
    publishPath,
  );
  const runtimeHealth = installer.indexOf(
    'Invoke-Lifecycle $Destination "health"',
    runtimeStateTouched,
  );
  assert.ok(acquireSharedLock >= 0);
  assert.ok(snapshotPath > acquireSharedLock);
  assert.ok(publishPath > snapshotPath);
  assert.ok(runtimeStateTouched > publishPath);
  assert.ok(runtimeHealth > runtimeStateTouched);
  assert.doesNotMatch(installer, /__configure-transaction/u);
  assert.doesNotMatch(installer, /ConfigTransaction|ConfigJournal/u);
  assert.match(
    installer,
    /if \(\$PathBeforePublication -cne \$OldUserPath\)/,
  );
  assert.match(
    installer,
    /if \(\$CurrentUserPath -cne \$WrittenUserPath\)/,
  );
  assert.match(
    installer,
    /if \(\$FilesRestored -and \$OldPresent -and \$OldWasRunning\) \{\s+try \{\s+if \(\$null -eq \$Destination -or\s+-not \(Test-Path/u,
  );
  const receiptMove = installer.indexOf(
    "Publish-InstallerFile `\n    $StagedReceipt `\n    $ReceiptPath",
  );
  const incompatibleConfirmation = installer.indexOf(
    "Confirm-IncompatibleReplacement $LegacyRelease",
  );
  const temporaryCreation = installer.indexOf(
    '$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("sana-mcp-" +',
  );
  const resetPrepare = installer.indexOf(
    "__reset-incompatible-state prepare",
  );
  assert.ok(receiptMove >= 0);
  assert.ok(incompatibleConfirmation >= 0);
  assert.ok(incompatibleConfirmation < temporaryCreation);
  assert.ok(resetPrepare > receiptMove);
  assert.doesNotMatch(
    installer,
    /Existing Sana authentication could not be validated/u,
  );
  const committedReset = installer.indexOf(
    '$ResetCommit["state"] -cne "committed"',
  );
  const incompatibleCommitted = installer.indexOf(
    "$Committed = $true",
    committedReset,
  );
  const incompatibleTransactionClosed = installer.indexOf(
    "$TransactionActive = $false",
    incompatibleCommitted,
  );
  const cleanupCall = installer.lastIndexOf("Invoke-InstallerCleanup");
  const cleanupPromotion = installer.indexOf(
    "if ($CleanupErrors.Count -gt 0)",
    cleanupCall,
  );
  const failureProof = installer.indexOf(
    "if ($null -ne $InstallFailure)",
    cleanupPromotion,
  );
  const updateBranch = installer.indexOf(
    'if ($env:SANA_MCP_UPDATE -eq "1") {',
    failureProof,
  );
  const yesBranch = installer.indexOf(
    '} elseif ($env:SANA_MCP_YES -eq "1") {',
    updateBranch,
  );
  const postCommitSetup = installer.indexOf(
    "Invoke-PostInstallConfigurer $Destination",
    yesBranch,
  );
  assert.ok(committedReset >= 0);
  assert.ok(incompatibleCommitted > committedReset);
  assert.ok(incompatibleTransactionClosed > incompatibleCommitted);
  assert.ok(cleanupCall > incompatibleTransactionClosed);
  assert.ok(cleanupPromotion > cleanupCall);
  assert.ok(failureProof > cleanupPromotion);
  assert.ok(updateBranch > failureProof);
  assert.ok(yesBranch > updateBranch);
  assert.ok(postCommitSetup > yesBranch);
  assert.ok(resetPrepare < cleanupCall);
  assert.doesNotMatch(
    installer.slice(updateBranch, yesBranch),
    /Invoke-PostInstallConfigurer/u,
  );
  assert.match(
    installer,
    /if \(\$env:SANA_MCP_UPDATE -eq "1"\) \{\s+if \(\$IncompatibleStateReset\) \{[\s\S]*?Run this command to configure clients and sign in:[\s\S]*?\}\s+\} elseif \(\$env:SANA_MCP_YES -eq "1"\) \{[\s\S]*?Invoke-PostInstallConfigurer \$Destination -Yes[\s\S]*?\} else \{[\s\S]*?Invoke-PostInstallConfigurer \$Destination/u,
  );
  assert.equal(
    installer.match(/Invoke-PostInstallConfigurer \$Destination/g)?.length,
    2,
  );
  assert.doesNotMatch(installer, /InteractiveSetup|no interactive terminal/u);
  assert.match(
    installer,
    /Start-Process\s+`\s+-FilePath \$Executable\s+`\s+-ArgumentList \$Arguments\s+`\s+-NoNewWindow\s+`\s+-Wait\s+`\s+-PassThru/u,
  );
  assert.match(
    installer,
    /state = "exited"\s+exitCode = \$Configurer\.ExitCode[\s\S]*?state = "launch-failed"\s+message = \$_\.Exception\.Message/u,
  );
  assert.match(
    installer,
    /client registration exited with code \$\(\$SetupOutcome\.exitCode\)[\s\S]*?client registration could not start: \$\(\$SetupOutcome\.message\)[\s\S]*?setup exited with code \$\(\$SetupOutcome\.exitCode\)[\s\S]*?setup could not start: \$\(\$SetupOutcome\.message\)/u,
  );
  assert.doesNotMatch(installer, /& \$Destination install/u);
  assert.match(
    installer,
    /__reset-incompatible-state rollback[\s\S]*?incompatible local-state rollback was incomplete/u,
  );
  assert.match(
    installer,
    /if \(\$OldPresent -and -not \$LegacyInstall\)[\s\S]*?else \{\s+\$NewPathManaged = \$MatchingEntries\.Count -eq 0/u,
  );
  assert.match(
    installer,
    /Restore-InstallerFileState\s+`\s+\$ReceiptPath\s+`\s+\$OldReceiptBackup\s+`\s+\$OldReceiptDigest/u,
  );
  assert.match(
    installer,
    /if \(\$LegacyInstall\) \{\s+Start-LegacyDaemon \$Destination/u,
  );
  assert.match(
    installer,
    /function Get-ValidatedRecoveryReplacementReceiptHash[\s\S]*?\$ReplacementReceipt\["version"\][\s\S]*?\$Inventory\["replacementVersion"\][\s\S]*?\$ReplacementReceipt\["target"\][\s\S]*?\$Inventory\["replacementTarget"\][\s\S]*?\$ReplacementReceipt\["stateCompatibility"\][\s\S]*?\$Inventory\["replacementStateCompatibility"\]/u,
  );
  assert.match(
    installer,
    /replacementSourceCommit=\$\(\$Release\["sourceCommit"\]\)[\s\S]*?replacementInstallerProtocol=\$\(\$Release\["installerProtocol"\]\)[\s\S]*?replacementLifecycleProtocol=\$\(\$Release\["lifecycleProtocol"\]\)[\s\S]*?replacementInspectProtocol=\$\(\$Release\["inspectProtocol"\]\)/u,
  );
  assert.match(
    installer,
    /Publish-InstallerFile\s+`\s+\$StagedReceipt[\s\S]*?replacementReceiptSha256=\$NewReceiptDigest[\s\S]*?\[IO\.File\]::Replace\([\s\S]*?__reset-incompatible-state prepare/u,
  );
  assert.match(
    installer,
    /\$NeedsCommit[\s\S]*?\$Inventory\.ContainsKey\("replacementReceiptSha256"\)[\s\S]*?\$RecoveryReplacementReceiptHash -cne\s+\$Inventory\["replacementReceiptSha256"\]/u,
  );
  assert.match(
    installer,
    /function Get-ValidatedRecoveryReplacementReceiptHash[\s\S]*?\["sourceCommit"\][\s\S]*?\["replacementSourceCommit"\][\s\S]*?\["installerProtocol"\][\s\S]*?\["replacementInstallerProtocol"\][\s\S]*?\["lifecycleProtocol"\][\s\S]*?\["replacementLifecycleProtocol"\][\s\S]*?\["inspectProtocol"\][\s\S]*?\["replacementInspectProtocol"\]/u,
  );
  assert.match(
    installer,
    /function ConvertTo-RecoveryPathValue[\s\S]*?ToBase64String[\s\S]*?function ConvertFrom-RecoveryPathValue[\s\S]*?FromBase64String/u,
  );
  assert.match(
    installer,
    /\$OldUserPath = \[Environment\]::GetEnvironmentVariable\("Path", "User"\)[\s\S]*?\$ExpectedCurrentUserPath =[\s\S]*?replacementPathManaged=\$\(\$NewPathManaged[\s\S]*?previousUserPath=\$\(ConvertTo-RecoveryPathValue \$OldUserPath\)[\s\S]*?publishedUserPath=\$\(ConvertTo-RecoveryPathValue \$ExpectedCurrentUserPath\)[\s\S]*?\$TransactionActive = \$true/u,
  );
  assert.match(
    installer,
    /\$NeedsCommit[\s\S]*?GetEnvironmentVariable\("Path", "User"\) -cne\s+\$RecoveryPublishedUserPath[\s\S]*?committed incompatible replacement User PATH changed/u,
  );
  assert.match(
    installer,
    /if \(\$NeedsReset\) \{[\s\S]*?\$RecoveryCurrentUserPath[\s\S]*?replacementPathManaged"\] -ceq "true"[\s\S]*?\$RecoveryPreviousUserPath[\s\S]*?\$RecoveryPublishedUserPath[\s\S]*?SetEnvironmentVariable\([\s\S]*?"Path"[\s\S]*?\$RecoveryPreviousUserPath[\s\S]*?"User"[\s\S]*?User PATH changed concurrently/u,
  );
  assert.match(
    installer,
    /\$ReplacementReceipt\["pathManaged"\] -cne\s+\$Inventory\["replacementPathManaged"\]/u,
  );
  assert.match(
    installer,
    /function Get-RetiredInstallerFileName[\s\S]*?-retired-[\s\S]*?function Remove-OrphanRetiredInstallerFiles[\s\S]*?\[a-f0-9\]\{32\}[\s\S]*?\$Candidates\.Count -gt 64/u,
  );
  assert.match(
    installer,
    /Remove-OrphanRetiredInstallerFiles[\s\S]*?Assert-NotReparse \$Candidate\.FullName[\s\S]*?-PathType Leaf[\s\S]*?\$Inventory\["previousBinarySha256"\][\s\S]*?\$Inventory\["replacementBinarySha256"\][\s\S]*?Stop-CanonicalRuntimeProcesses \$Candidate\.FullName/u,
  );
  assert.match(
    installer,
    /Stop-CanonicalRuntimeProcesses \$Candidate\.FullName[\s\S]*?Assert-NotReparse \$Candidate\.FullName "Retired installer artifact"[\s\S]*?-PathType Leaf[\s\S]*?\(Get-Sha256 \$Candidate\.FullName\) -cne \$Digest[\s\S]*?Remove-Item -LiteralPath \$Candidate\.FullName/u,
  );
  assert.match(
    installer,
    /\$AllowedReceiptDigests[\s\S]*?\$Inventory\["previousReceiptSha256"\][\s\S]*?\$AuthorizedReplacementReceiptSha256[\s\S]*?unexpected or unprovable digest/u,
  );
  assert.match(
    installer,
    /Remove-OrphanRetiredInstallerFiles\s+`\s+\$Executable[\s\S]*?Remove-ResolvedIncompatibleRecovery \$RecoveryDirectory/u,
  );
  assert.match(
    installer,
    /function Get-CanonicalRuntimeProcesses[\s\S]*?\$ImageName = \[IO\.Path\]::GetFileName\(\$Resolved\)[\s\S]*?\^\[A-Za-z0-9\._-\]\+\$[\s\S]*?Get-CimInstance Win32_Process -Filter "Name = '\$ImageName'"/u,
  );
  assert.match(
    installer,
    /\$Committed = \$true\s+\$TransactionActive = \$false[\s\S]*?Remove-Item -LiteralPath \$RetiredBinary[\s\S]*?Remove-Item -LiteralPath \$RetiredReceipt[\s\S]*?\$RetiredBinaryRemains =[\s\S]*?\$RetiredReceiptRemains =[\s\S]*?if \(-not \$RetiredBinaryRemains -and\s+-not \$RetiredReceiptRemains\) \{[\s\S]*?Remove-ResolvedIncompatibleRecovery \$IncompatibleResetJournal/u,
  );
  assert.match(
    installer,
    /\} else \{[\s\S]*?deferred retired runtime cleanup remains at \$RetiredBinary[\s\S]*?deferred retired receipt cleanup remains at \$RetiredReceipt[\s\S]*?deferred recovery path: \$IncompatibleResetJournal/u,
  );
  assert.match(
    installer,
    /if \(\$null -ne \$RetiredBinary\) \{\s+try \{\s+Stop-CanonicalRuntimeProcesses \$RetiredBinary\s+Assert-NotReparse \$RetiredBinary "Retired runtime"[\s\S]*?\(Get-Sha256 \$RetiredBinary\) -cne \$OldBinaryDigest[\s\S]*?Remove-Item -LiteralPath \$RetiredBinary/u,
  );
  assert.match(
    installer,
    /if \(\$null -ne \$RetiredReceipt\) \{\s+try \{\s+Assert-NotReparse \$RetiredReceipt "Retired receipt"[\s\S]*?\(Get-Sha256 \$RetiredReceipt\) -cne \$OldReceiptDigest[\s\S]*?Remove-Item -LiteralPath \$RetiredReceipt/u,
  );
  assert.match(
    installer,
    /expectedSha256 = \$OldBinaryDigest[\s\S]*?expectedSha256 = \$OldReceiptDigest[\s\S]*?if \(\$RetiredArtifact\.safe\) \{[\s\S]*?Stop-CanonicalRuntimeProcesses \$RetiredArtifact\.path[\s\S]*?Assert-NotReparse[\s\S]*?\(Get-Sha256 \$RetiredArtifact\.path\) -cne\s+\$RetiredArtifact\.expectedSha256[\s\S]*?Remove-Item -LiteralPath \$RetiredArtifact\.path/u,
  );
  assert.match(
    installer,
    /function Restore-InstallerFileState[\s\S]*?Publish-InstallerFile[\s\S]*?Stop-CanonicalRuntimeProcesses \$Retired[\s\S]*?Assert-NotReparse \$Retired "Retired \$Label"[\s\S]*?\(Get-Sha256 \$Retired\) -cne \$CurrentSha256[\s\S]*?Remove-Item -LiteralPath \$Retired/u,
  );
  assert.match(
    installer,
    /Get-RetiredInstallerFileName\s+`\s+\$Destination[\s\S]*?Move-Item -LiteralPath \$Destination -Destination \$Retired[\s\S]*?Stop-CanonicalRuntimeProcesses \$Retired[\s\S]*?Assert-NotReparse \$Retired "Retired \$Label"[\s\S]*?\(Get-Sha256 \$Retired\) -cne \$ReplacementSha256[\s\S]*?Remove-Item -LiteralPath \$Retired/u,
  );
  assert.doesNotMatch(
    installer,
    /GetFileName\(\$Destination\) \+ "-remove-"/u,
  );
  assert.match(
    installer,
    /if \(\$RetiredArtifact\.safe\) \{[\s\S]*?Remove-Item[\s\S]*?\} else \{[\s\S]*?retained authoritative retired file at/u,
  );
  assert.match(
    cli,
    /let stoppedObservations = 0;[\s\S]*?while \(Date\.now\(\) < deadline\)[\s\S]*?stoppedObservations >= 3[\s\S]*?requestDaemonStop\(stoppedPid\)[\s\S]*?while \(pidAlive\(stoppedPid\)\)/u,
  );
});

test("advertised install commands stay concise and match installer headers", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const posixInstaller = await readFile(path.join(root, "install.sh"), "utf8");
  const windowsInstaller = await readFile(path.join(root, "install.ps1"), "utf8");

  const posixCommand =
    "sh -c 't=$(mktemp) && curl -fsSL \"$1\" -o \"$t\" && sh \"$t\"; s=$?; [ -z \"${t:-}\" ] || rm -f \"$t\"; exit \"$s\"' sh https://github.com/Etals-AiApp/sana-ai-mcp/releases/latest/download/install.sh";
  const windowsCommand =
    "irm https://github.com/Etals-AiApp/sana-ai-mcp/releases/latest/download/install.ps1 | iex";

  assert.ok(readme.split("\n").includes(posixCommand));
  assert.ok(readme.split("\n").includes(windowsCommand));
  assert.ok(posixInstaller.split("\n").includes(`#   ${posixCommand}`));
  assert.ok(windowsInstaller.split("\n").includes(`#   ${windowsCommand}`));
  assert.ok(posixCommand.length < 220);
  assert.ok(windowsCommand.length < 140);
});

test("advertised POSIX install command fails when curl fails", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "sana-bootstrap-failure-"),
  );
  const commands = path.join(temporary, "bin");
  await mkdir(commands);
  await writeFile(
    path.join(commands, "curl"),
    "#!/bin/sh\nexit 22\n",
  );
  await chmod(path.join(commands, "curl"), 0o755);
  try {
    const command =
      "sh -c 't=$(mktemp) && curl -fsSL \"$1\" -o \"$t\" && sh \"$t\"; s=$?; [ -z \"${t:-}\" ] || rm -f \"$t\"; exit \"$s\"' sh https://github.com/Etals-AiApp/sana-ai-mcp/releases/latest/download/install.sh";
    const result = spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${commands}:${process.env.PATH ?? ""}`,
      },
    });
    assert.notEqual(result.status, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PowerShell deferred-install command quotes the executable and invokes it", async () => {
  const powershell =
    process.platform === "win32"
      ? "powershell.exe"
      : spawnSync(
          "/bin/sh",
          ["-c", "command -v pwsh || command -v powershell.exe"],
          { encoding: "utf8" },
        ).stdout.trim();
  if (!powershell) return;

  const installer = await readFile(path.join(root, "install.ps1"), "utf8");
  const start = installer.indexOf("function Format-ExecutableCommand");
  const end = installer.indexOf("\nfunction Open-HttpsResponse", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const formatter = installer.slice(start, end);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-ps-command-"));
  try {
    const target = path.join(temporary, "sana helper's target.ps1");
    await writeFile(target, 'Write-Output ($args -join ",")\n');
    let executableTarget = target;
    if (
      process.platform === "linux" &&
      powershell.toLowerCase().endsWith(".exe")
    ) {
      executableTarget = spawnSync("wslpath", ["-w", target], {
        encoding: "utf8",
      }).stdout.trim();
    }
    const harness = path.join(temporary, "command-test.ps1");
    await writeFile(
      harness,
      [
        '$ErrorActionPreference = "Stop"',
        formatter,
        `$Command = Format-InstallCommand '${executableTarget.replaceAll("'", "''")}'`,
        "$Observed = Invoke-Expression $Command",
        'if ($Observed -cne "install") { throw "formatted command did not invoke the target with install" }',
        `$YesCommand = Format-InstallCommand '${executableTarget.replaceAll("'", "''")}' -Yes`,
        'if ($YesCommand -cnotmatch " install --yes$") { throw "unattended retry command omitted --yes" }',
        '$script:ConfigurerExitCode = 0',
        '$script:ConfigurerThrows = $false',
        "function Start-Process {",
        "  param(",
        "    [string] $FilePath,",
        "    [object[]] $ArgumentList,",
        "    [switch] $NoNewWindow,",
        "    [switch] $Wait,",
        "    [switch] $PassThru",
        "  )",
        `  if ($FilePath -cne '${executableTarget.replaceAll("'", "''")}') { throw "configurer used the wrong executable" }`,
        '  if (-not $NoNewWindow -or -not $Wait -or -not $PassThru) { throw "configurer did not inherit and synchronously hold the console" }',
        '  if ($script:ConfigurerThrows) { throw "simulated process launch failure" }',
        '  $script:ConfigurerArguments = @($ArgumentList)',
        "  return [pscustomobject]@{ ExitCode = $script:ConfigurerExitCode }",
        "}",
        `$PipelineResult = @("irm-body" | ForEach-Object { Invoke-PostInstallConfigurer '${executableTarget.replaceAll("'", "''")}' })`,
        'if ($PipelineResult.Count -ne 1 -or $PipelineResult[0].state -cne "success" -or (($PipelineResult[0].PSObject.Properties.Name -join ",") -cne "state")) { throw "pipeline-shaped success outcome was contaminated" }',
        'if ($script:ConfigurerArguments.Count -ne 1 -or $script:ConfigurerArguments[0] -cne "install") { throw "interactive configurer arguments changed" }',
        `$YesResult = Invoke-PostInstallConfigurer '${executableTarget.replaceAll("'", "''")}' -Yes`,
        'if ($YesResult.state -cne "success" -or $script:ConfigurerArguments.Count -ne 2 -or $script:ConfigurerArguments[1] -cne "--yes") { throw "unattended configurer arguments changed" }',
        "$script:ConfigurerExitCode = 9",
        `$FailedResult = Invoke-PostInstallConfigurer '${executableTarget.replaceAll("'", "''")}'`,
        'if ($FailedResult.state -cne "exited" -or $FailedResult.exitCode -ne 9 -or $FailedResult.PSObject.Properties.Name -ccontains "message") { throw "nonzero configurer exit lost its exact structured outcome" }',
        "$script:ConfigurerThrows = $true",
        `$ThrownResult = @(Invoke-PostInstallConfigurer '${executableTarget.replaceAll("'", "''")}')`,
        'if ($ThrownResult.Count -ne 1 -or $ThrownResult[0].state -cne "launch-failed" -or $ThrownResult[0].message -cne "simulated process launch failure" -or $ThrownResult[0].PSObject.Properties.Name -ccontains "exitCode") { throw "process launch exception lost its exact structured outcome" }',
        'Write-Output "command-format-ok"',
        "",
      ].join("\n"),
    );
    let executableHarness = harness;
    if (
      process.platform === "linux" &&
      powershell.toLowerCase().endsWith(".exe")
    ) {
      executableHarness = spawnSync("wslpath", ["-w", harness], {
        encoding: "utf8",
      }).stdout.trim();
    }
    const result = spawnSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-File", executableHarness],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /command-format-ok/u);

    const nativeWindowsHost =
      process.platform === "win32" || powershell.toLowerCase().endsWith(".exe");
    if (!nativeWindowsHost) {
      const actualTarget = path.join(temporary, "actual-sana-configurer");
      const observed = path.join(temporary, "actual-arguments.txt");
      await writeFile(
        actualTarget,
        [
          "#!/bin/sh",
          'printf "%s\\n" "$*" > "$SANA_MCP_CONFIGURER_OBSERVED"',
          'exit "$SANA_MCP_CONFIGURER_EXIT"',
          "",
        ].join("\n"),
      );
      await chmod(actualTarget, 0o755);
      const actualHarness = path.join(temporary, "actual-process.ps1");
      await writeFile(
        actualHarness,
        [
          '$ErrorActionPreference = "Stop"',
          formatter,
          `$Result = @("irm-body" | ForEach-Object { Invoke-PostInstallConfigurer '${actualTarget.replaceAll("'", "''")}' -Yes })`,
          'if ($Result.Count -ne 1 -or $Result[0].state -cne "success" -or (($Result[0].PSObject.Properties.Name -join ",") -cne "state")) { throw "actual pipeline launch failed or emitted process metadata" }',
          "",
        ].join("\n"),
      );
      const actualResult = spawnSync(
        powershell,
        ["-NoProfile", "-NonInteractive", "-File", actualHarness],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            SANA_MCP_CONFIGURER_OBSERVED: observed,
            SANA_MCP_CONFIGURER_EXIT: "0",
          },
        },
      );
      assert.equal(actualResult.status, 0, actualResult.stderr);
      assert.equal((await readFile(observed, "utf8")).trim(), "install --yes");
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX upgrades journal binary, PATH, receipt, and daemon state", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-upgrade-test-"));
  try {
    const commands = path.join(temporary, "commands");
    const home = path.join(temporary, "home");
    const installDirectory = path.join(temporary, "managed-bin");
    const stateFile = path.join(temporary, "daemon-state");
    const lifecycleLog = path.join(temporary, "lifecycle.log");
    const profile = path.join(home, ".bashrc");
    await mkdir(home);
    await writeFile(profile, "# existing profile\n");
    await writeFile(stateFile, "stopped\n");

    const run = (
      fixture: string,
      version: string,
      configExit: string,
    ) =>
      spawnSync("/bin/sh", [path.join(root, "install.sh")], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${commands}:/usr/bin:/bin`,
          HOME: home,
          SHELL: "/bin/bash",
          FIXTURE_ROOT: fixture,
          FAKE_CONFIG_EXIT: configExit,
          FAKE_LIFECYCLE_STATE_FILE: stateFile,
          FAKE_LIFECYCLE_LOG_FILE: lifecycleLog,
          SANA_MCP_INSTALL_DIR: installDirectory,
          SANA_MCP_VERSION: `v${version}`,
          SANA_MCP_YES: "1",
        },
      });

    const firstFixture = await createOfflineRelease(temporary, "0.3.2");
    const first = run(firstFixture, "0.3.2", "0");
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Added .* to PATH/);
    const oldBinary = await readFile(
      path.join(installDirectory, "sana-mcp"),
      "utf8",
    );
    const oldReceipt = await readFile(
      path.join(installDirectory, ".sana-mcp-install-v1"),
      "utf8",
    );
    const oldProfile = await readFile(profile, "utf8");
    assert.equal(
      oldProfile.match(/# >>> sana-mcp installer >>>/g)?.length,
      1,
    );
    assert.ok(
      oldProfile.includes(
        `export PATH='${installDirectory}':"$PATH"\n`,
      ),
    );
    assert.match(oldReceipt, /(?:^|\n)pathProfile=bashrc\n/);

    await writeFile(stateFile, "running\n");
    const secondFixture = await createOfflineRelease(temporary, "0.3.3");
    const upgrade = run(secondFixture, "0.3.3", "23");
    assert.equal(upgrade.status, 0, upgrade.stderr);
    assert.match(
      upgrade.stdout,
      /Existing client configuration was left unchanged\./,
    );
    assert.notEqual(
      await readFile(path.join(installDirectory, "sana-mcp"), "utf8"),
      oldBinary,
    );
    assert.match(
      await readFile(
        path.join(installDirectory, ".sana-mcp-install-v1"),
        "utf8",
      ),
      /(?:^|\n)version=0\.3\.3\n/,
    );
    assert.equal(await readFile(profile, "utf8"), oldProfile);
    assert.equal((await readFile(stateFile, "utf8")).trim(), "running");

    assert.match(upgrade.stdout, /Verified .* is already on PATH/);
    assert.equal(
      (
        await readFile(profile, "utf8")
      ).match(/# >>> sana-mcp installer >>>/g)?.length,
      1,
    );
    assert.equal((await readFile(stateFile, "utf8")).trim(), "running");
    assert.match(await readFile(lifecycleLog, "utf8"), /stop:stopped/);
    assert.match(await readFile(lifecycleLog, "utf8"), /start:running/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX installer refuses a foreign destination without a receipt", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-foreign-test-"));
  try {
    const fixture = await createOfflineRelease(temporary);
    const home = path.join(temporary, "home");
    const installDirectory = path.join(temporary, "managed-bin");
    await mkdir(home);
    await mkdir(installDirectory);
    await writeFile(path.join(installDirectory, "sana-mcp"), "foreign\n");
    const result = spawnSync("/bin/sh", [path.join(root, "install.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(temporary, "commands")}:/usr/bin:/bin`,
        HOME: home,
        FIXTURE_ROOT: fixture,
        SANA_MCP_INSTALL_DIR: installDirectory,
        SANA_MCP_VERSION: "v0.3.2",
        SANA_MCP_YES: "1",
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no supported installer receipt/);
    assert.equal(
      await readFile(path.join(installDirectory, "sana-mcp"), "utf8"),
      "foreign\n",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX latest resolution verifies its projection before trusting the tag", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-latest-test-"));
  try {
    const fixture = await createOfflineRelease(temporary);
    const metadata = path.join(
      fixture,
      "manifest-bun-linux-x64.properties",
    );
    await writeFile(
      metadata,
      `${await readFile(metadata, "utf8")}unknownKey=tampered\n`,
    );
    const home = path.join(temporary, "home");
    await mkdir(home);
    const result = spawnSync("/bin/sh", [path.join(root, "install.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(temporary, "commands")}:/usr/bin:/bin`,
        HOME: home,
        FIXTURE_ROOT: fixture,
        SANA_MCP_INSTALL_DIR: path.join(temporary, "managed-bin"),
        SANA_MCP_YES: "1",
        SANA_MCP_VERSION: "",
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /latest release metadata checksum mismatch/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX accepts a healthy fresh-login daemon and preserves stopped upgrade intent", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-login-daemon-"));
  try {
    const home = path.join(temporary, "home");
    const installDirectory = path.join(temporary, "managed-bin");
    const stateFile = path.join(temporary, "daemon-state");
    const bashrc = path.join(home, ".bashrc");
    const profile = path.join(home, ".profile");
    await mkdir(home);
    await writeFile(profile, "# profile\n");
    await writeFile(stateFile, "stopped\n");
    const run = (fixture: string, version: string) =>
      spawnSync("/bin/sh", [path.join(root, "install.sh")], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${path.join(temporary, "commands")}:/usr/bin:/bin`,
          HOME: home,
          SHELL: "/bin/bash",
          FIXTURE_ROOT: fixture,
          FAKE_CONFIG_EXIT: "0",
          FAKE_CONFIG_START_DAEMON: "1",
          FAKE_LIFECYCLE_STATE_FILE: stateFile,
          SANA_MCP_INSTALL_DIR: installDirectory,
          SANA_MCP_VERSION: `v${version}`,
          SANA_MCP_YES: "1",
        },
      });

    const first = run(
      await createOfflineRelease(temporary, "0.3.2"),
      "0.3.2",
    );
    assert.equal(first.status, 0, first.stderr);
    assert.equal((await readFile(stateFile, "utf8")).trim(), "running");
    assert.match(
      await readFile(
        path.join(installDirectory, ".sana-mcp-install-v1"),
        "utf8",
      ),
      /(?:^|\n)pathProfile=bashrc\n/,
    );
    assert.ok(
      (
        await readFile(bashrc, "utf8")
      ).includes(`export PATH='${installDirectory}':"$PATH"\n`),
    );
    assert.equal(await readFile(profile, "utf8"), "# profile\n");

    await writeFile(stateFile, "stopped\n");
    const upgrade = run(
      await createOfflineRelease(temporary, "0.3.3"),
      "0.3.3",
    );
    assert.equal(upgrade.status, 0, upgrade.stderr);
    assert.equal((await readFile(stateFile, "utf8")).trim(), "stopped");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX retains the published runtime and PATH after a live-state failure", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-path-rollback-"));
  try {
    const fixture = await createOfflineRelease(temporary);
    const home = path.join(temporary, "home");
    const profile = path.join(home, ".bashrc");
    const installDirectory = path.join(temporary, "managed-bin");
    const configured = path.join(temporary, "configured");
    await mkdir(home);
    const original = "# exact preimage without final newline";
    await writeFile(profile, original);
    const result = spawnSync("/bin/sh", [path.join(root, "install.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(temporary, "commands")}:/usr/bin:/bin`,
        HOME: home,
        SHELL: "/bin/bash",
        FIXTURE_ROOT: fixture,
        FAKE_CONFIG_EXIT: "0",
        FAKE_CONFIGURED_FILE: configured,
        FAKE_POST_CONFIG_HEALTH_EXIT: "77",
        SANA_MCP_INSTALL_DIR: installDirectory,
        SANA_MCP_VERSION: "v0.3.2",
        SANA_MCP_YES: "1",
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /new runtime health check failed/);
    assert.match(await readFile(profile, "utf8"), /sana-mcp installer/);
    await access(path.join(installDirectory, "sana-mcp"));
    await access(path.join(installDirectory, ".sana-mcp-install-v1"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX serializes PATH publication across different install destinations", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-path-lock-"));
  try {
    const fixture = await createOfflineRelease(temporary);
    const home = path.join(temporary, "home");
    const profile = path.join(home, ".bashrc");
    const releaseConfigurers = path.join(temporary, "release-configurers");
    await mkdir(home);
    await writeFile(profile, "# shared profile\n");

    const launch = (name: string) => {
      const ready = path.join(temporary, `${name}.ready`);
      const installDirectory = path.join(temporary, name);
      const child = spawn("/bin/sh", [path.join(root, "install.sh")], {
        env: {
          ...process.env,
          PATH: `${path.join(temporary, "commands")}:/usr/bin:/bin`,
          HOME: home,
          SHELL: "/bin/bash",
          FIXTURE_ROOT: fixture,
          FAKE_CONFIG_EXIT: "0",
          FAKE_CONFIG_READY_FILE: ready,
          FAKE_CONFIG_WAIT_FILE: releaseConfigurers,
          SANA_MCP_INSTALL_DIR: installDirectory,
          SANA_MCP_VERSION: "v0.3.2",
          SANA_MCP_YES: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      return { child, ready, installDirectory, stderr: () => stderr };
    };

    const first = launch("first-bin");
    await waitForFile(first.ready);
    await writeFile(
      profile,
      `${await readFile(profile, "utf8")}# concurrent external edit\n`,
    );
    const second = launch("second-bin");
    const [secondCode] = await once(second.child, "close") as [number];
    assert.equal(secondCode, 1);
    assert.match(second.stderr(), /changing user state|stale lock/);
    await assert.rejects(
      readFile(path.join(second.installDirectory, "sana-mcp")),
    );

    const third = launch("third-bin");
    const [thirdCode] = await once(third.child, "close") as [number];
    assert.equal(thirdCode, 1);
    assert.match(third.stderr(), /changing user state|stale lock/);
    await assert.rejects(
      readFile(path.join(third.installDirectory, "sana-mcp")),
    );

    await writeFile(releaseConfigurers, "continue\n");
    const [firstCode] = await once(first.child, "close") as [number];
    assert.equal(firstCode, 0, first.stderr());

    const profileBody = await readFile(profile, "utf8");
    assert.match(profileBody, /# concurrent external edit\n/);
    assert.equal(
      profileBody.match(/# >>> sana-mcp installer >>>/g)?.length,
      1,
    );
    assert.ok(
      profileBody.includes(
        `export PATH='${first.installDirectory}':"$PATH"\n`,
      ),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX losing install-lock contenders never remove the winner's lock", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-install-lock-"));
  try {
    const fixture = await createOfflineRelease(temporary);
    const home = path.join(temporary, "home");
    const installDirectory = path.join(temporary, "managed-bin");
    const configReady = path.join(temporary, "config-ready");
    const releaseConfig = path.join(temporary, "release-config");
    await mkdir(home);
    const environment = {
      ...process.env,
      PATH: `${path.join(temporary, "commands")}:/usr/bin:/bin`,
      HOME: home,
      FIXTURE_ROOT: fixture,
      FAKE_CONFIG_READY_FILE: configReady,
      FAKE_CONFIG_WAIT_FILE: releaseConfig,
      SANA_MCP_INSTALL_DIR: installDirectory,
      SANA_MCP_VERSION: "v0.3.2",
      SANA_MCP_YES: "1",
    };
    const first = spawn("/bin/sh", [path.join(root, "install.sh")], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let firstStderr = "";
    first.stderr.setEncoding("utf8");
    first.stderr.on("data", (chunk: string) => {
      firstStderr += chunk;
    });
    await waitForFile(configReady);

    for (let contender = 0; contender < 2; contender++) {
      const result = spawnSync("/bin/sh", [path.join(root, "install.sh")], {
        encoding: "utf8",
        env: environment,
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /another sana-mcp installation is active/);
    }

    await writeFile(releaseConfig, "continue\n");
    const [firstCode] = await once(first, "close") as [number];
    assert.equal(firstCode, 0, firstStderr);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX lost lock ownership blocks commit and leaves the winner's directory untouched", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-lock-loss-"));
  try {
    const fixture = await createOfflineRelease(temporary);
    const home = path.join(temporary, "home");
    const installDirectory = path.join(temporary, "managed-bin");
    const configReady = path.join(temporary, "config-ready");
    const releaseConfig = path.join(temporary, "release-config");
    await mkdir(home);
    const child = spawn("/bin/sh", [path.join(root, "install.sh")], {
      env: {
        ...process.env,
        PATH: `${path.join(temporary, "commands")}:/usr/bin:/bin`,
        HOME: home,
        FIXTURE_ROOT: fixture,
        FAKE_CONFIG_READY_FILE: configReady,
        FAKE_CONFIG_WAIT_FILE: releaseConfig,
        SANA_MCP_INSTALL_DIR: installDirectory,
        SANA_MCP_VERSION: "v0.3.2",
        SANA_MCP_YES: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await waitForFile(configReady);
    const pathLock = path.join(home, ".sana-mcp-installer-path.lock");
    const entries = await readdir(pathLock);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^owner\./);
    await rm(path.join(pathLock, entries[0]));
    await writeFile(releaseConfig, "continue\n");
    const [code] = await once(child, "close") as [number];
    assert.equal(code, 1);
    assert.match(stderr, /installer lock ownership was lost/);
    assert.match(stderr, /no further persistent rollback changes were attempted/);
    await access(path.join(installDirectory, "sana-mcp"));
    await access(path.join(installDirectory, ".sana-mcp-install-v1"));
    assert.deepEqual(await readdir(pathLock), []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX lock-token change during rollback stops every later cleanup mutation", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-rollback-lock-loss-"));
  try {
    const home = path.join(temporary, "home");
    const profile = path.join(home, ".bashrc");
    const installDirectory = path.join(temporary, "managed-bin");
    const stateFile = path.join(temporary, "daemon-state");
    const lifecycleLog = path.join(temporary, "lifecycle.log");
    const configured = path.join(temporary, "configured");
    await mkdir(home);
    await writeFile(profile, "# profile\n");
    await writeFile(stateFile, "stopped\n");

    const firstFixture = await createOfflineRelease(temporary, "0.3.2");
    const first = spawnSync("/bin/sh", [path.join(root, "install.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(temporary, "commands")}:/usr/bin:/bin`,
        HOME: home,
        SHELL: "/bin/bash",
        FIXTURE_ROOT: firstFixture,
        FAKE_CONFIGURED_FILE: configured,
        FAKE_CONFIG_START_DAEMON: "1",
        FAKE_LIFECYCLE_STATE_FILE: stateFile,
        FAKE_LIFECYCLE_LOG_FILE: lifecycleLog,
        SANA_MCP_INSTALL_DIR: installDirectory,
        SANA_MCP_VERSION: "v0.3.2",
        SANA_MCP_YES: "1",
      },
    });
    assert.equal(first.status, 0, first.stderr);
    assert.equal((await readFile(stateFile, "utf8")).trim(), "running");

    const secondFixture = await createOfflineRelease(temporary, "0.3.3");
    const startReady = path.join(temporary, "start-ready");
    const releaseStart = path.join(temporary, "release-start");
    await writeFile(lifecycleLog, "");
    const child = spawn("/bin/sh", [path.join(root, "install.sh")], {
      env: {
        ...process.env,
        PATH: `${path.join(temporary, "commands")}:/usr/bin:/bin`,
        HOME: home,
        SHELL: "/bin/bash",
        FIXTURE_ROOT: secondFixture,
        FAKE_CONFIGURED_FILE: configured,
        FAKE_POST_CONFIG_START_EXIT: "77",
        FAKE_START_READY_FILE: startReady,
        FAKE_START_WAIT_FILE: releaseStart,
        FAKE_LIFECYCLE_STATE_FILE: stateFile,
        FAKE_LIFECYCLE_LOG_FILE: lifecycleLog,
        SANA_MCP_INSTALL_DIR: installDirectory,
        SANA_MCP_VERSION: "v0.3.3",
        SANA_MCP_YES: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const closePromise = once(child, "close") as Promise<[number]>;
    await Promise.race([
      waitForFile(startReady),
      closePromise.then(([code]) => {
        throw new Error(
          `installer exited before lifecycle checkpoint (${code}): ${stderr}`,
        );
      }),
    ]);
    const pathLock = path.join(home, ".sana-mcp-installer-path.lock");
    const installLock = path.join(
      installDirectory,
      ".sana-mcp-install-lock",
    );
    const entries = await readdir(pathLock);
    assert.equal(entries.length, 1);
    await writeFile(path.join(pathLock, entries[0]), "changed-owner-token\n");
    await writeFile(releaseStart, "continue\n");
    const [code] = await closePromise;
    assert.equal(code, 1);
    assert.match(stderr, /installer lock ownership was lost/);
    assert.match(stderr, /no further persistent rollback changes were attempted/);
    assert.match(await readFile(lifecycleLog, "utf8"), /start-attempt:stopped\n/);
    assert.equal((await readFile(stateFile, "utf8")).trim(), "stopped");
    assert.match(
      await readFile(
        path.join(installDirectory, ".sana-mcp-install-v1"),
        "utf8",
      ),
      /(?:^|\n)version=0\.3\.3\n/,
    );
    assert.equal(
      await readFile(path.join(pathLock, entries[0]), "utf8"),
      "changed-owner-token\n",
    );
    const installLockEntries = await readdir(installLock);
    assert.equal(installLockEntries.length, 1);
    assert.equal(
      (await readFile(path.join(installLock, installLockEntries[0]), "utf8")).trim(),
      installLockEntries[0],
    );
    const recoveryInventoryMatch = stderr.match(
      /previous runtime backup and recovery inventory: ([^\n]+)/,
    );
    assert.ok(recoveryInventoryMatch);
    const recoveryInventory = recoveryInventoryMatch[1];
    await access(path.join(recoveryInventory, "old-binary"));
    await access(path.join(recoveryInventory, "old-receipt"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX lock loss during final rollback sync retains tail cleanup state", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-final-sync-lock-loss-"));
  try {
    const fixture = await createOfflineRelease(temporary);
    const commands = path.join(temporary, "commands");
    const home = path.join(temporary, "home");
    const profile = path.join(home, ".bashrc");
    const installDirectory = path.join(temporary, "managed-bin");
    const syncCount = path.join(temporary, "sync-count");
    const finalSyncReady = path.join(temporary, "final-sync-ready");
    const releaseFinalSync = path.join(temporary, "release-final-sync");
    await mkdir(home);
    await writeFile(profile, "# original profile\n");
    await writeFile(
      path.join(commands, "mktemp"),
      [
        "#!/bin/sh",
        'case "$*" in',
        '  *".sana-mcp-receipt."*) exit 73 ;;',
        "esac",
        'exec /usr/bin/mktemp "$@"',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(commands, "rm"),
      [
        "#!/bin/sh",
        'for candidate in "$@"; do',
        '  if [ -n "${FAKE_RM_FAIL_PATH:-}" ] && [ "$candidate" = "$FAKE_RM_FAIL_PATH" ]; then exit 73; fi',
        "done",
        'exec /usr/bin/rm "$@"',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(commands, "sync"),
      [
        "#!/bin/sh",
        "count=0",
        'if [ -f "$FAKE_SYNC_COUNT_FILE" ]; then count=$(cat "$FAKE_SYNC_COUNT_FILE"); fi',
        "count=$((count + 1))",
        'printf "%s\\n" "$count" > "$FAKE_SYNC_COUNT_FILE"',
        'if [ "$count" -eq 4 ]; then',
        '  : > "$FAKE_FINAL_SYNC_READY_FILE"',
        '  while [ ! -f "$FAKE_FINAL_SYNC_WAIT_FILE" ]; do sleep 0.02; done',
        "fi",
        'exec /usr/bin/sync "$@"',
        "",
      ].join("\n"),
    );
    await Promise.all(
      ["mktemp", "rm", "sync"].map((command) =>
        chmod(path.join(commands, command), 0o755),
      ),
    );

    const child = spawn("/bin/sh", [path.join(root, "install.sh")], {
      env: {
        ...process.env,
        PATH: `${commands}:/usr/bin:/bin`,
        HOME: home,
        SHELL: "/bin/bash",
        FIXTURE_ROOT: fixture,
        FAKE_RM_FAIL_PATH: path.join(installDirectory, "sana-mcp"),
        FAKE_SYNC_COUNT_FILE: syncCount,
        FAKE_FINAL_SYNC_READY_FILE: finalSyncReady,
        FAKE_FINAL_SYNC_WAIT_FILE: releaseFinalSync,
        SANA_MCP_INSTALL_DIR: installDirectory,
        SANA_MCP_VERSION: "v0.3.2",
        SANA_MCP_YES: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const closePromise = once(child, "close") as Promise<[number]>;
    await Promise.race([
      waitForFile(finalSyncReady),
      closePromise.then(([code]) => {
        throw new Error(
          `installer exited before final rollback sync (${code}): ${stderr}`,
        );
      }),
    ]);

    const pathLock = path.join(home, ".sana-mcp-installer-path.lock");
    const pathLockEntries = await readdir(pathLock);
    assert.equal(pathLockEntries.length, 1);
    await writeFile(
      path.join(pathLock, pathLockEntries[0]),
      "changed-during-final-sync\n",
    );
    await writeFile(releaseFinalSync, "continue\n");

    const [code] = await closePromise;
    assert.equal(code, 1);
    assert.equal((await readFile(syncCount, "utf8")).trim(), "4");
    assert.match(stderr, /installer lock ownership was lost/);
    assert.match(stderr, /no further persistent rollback changes were attempted/);
    assert.equal(await readFile(profile, "utf8"), "# original profile\n");
    await access(path.join(installDirectory, "sana-mcp"));
    await assert.rejects(
      access(path.join(installDirectory, ".sana-mcp-install-v1")),
    );
    assert.equal(
      await readFile(path.join(pathLock, pathLockEntries[0]), "utf8"),
      "changed-during-final-sync\n",
    );
    const installLock = path.join(
      installDirectory,
      ".sana-mcp-install-lock",
    );
    const installLockEntries = await readdir(installLock);
    assert.equal(installLockEntries.length, 1);
    assert.equal(
      (await readFile(path.join(installLock, installLockEntries[0]), "utf8")).trim(),
      installLockEntries[0],
    );
    const recoveryInventoryMatch = stderr.match(
      /previous runtime backup and recovery inventory: ([^\n]+)/,
    );
    assert.ok(recoveryInventoryMatch);
    const recoveryInventory = recoveryInventoryMatch[1];
    await access(path.join(recoveryInventory, "binary"));
    await access(path.join(recoveryInventory, "new-receipt"));
    await access(path.join(recoveryInventory, "old-path-file"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX lock loss during completed-journal removal gates final cleanup", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-journal-lock-loss-"));
  try {
    const fixture = await createOfflineRelease(temporary);
    const commands = path.join(temporary, "commands");
    const home = path.join(temporary, "home");
    const installDirectory = path.join(temporary, "managed-bin");
    const journal = path.join(
      installDirectory,
      ".sana-mcp-config-transaction",
      "client-config-transaction.json",
    );
    const removalReady = path.join(temporary, "journal-removal-ready");
    const releaseRemoval = path.join(temporary, "release-journal-removal");
    const removalLog = path.join(temporary, "rm.log");
    await mkdir(home);
    await writeFile(
      path.join(commands, "rm"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$FAKE_RM_LOG_FILE"',
        'for candidate in "$@"; do',
        '  if [ "$candidate" = "$FAKE_RM_WAIT_PATH" ]; then',
        '    : > "$FAKE_RM_READY_FILE"',
        '    while [ ! -f "$FAKE_RM_RELEASE_FILE" ]; do sleep 0.02; done',
        "  fi",
        "done",
        'exec /usr/bin/rm "$@"',
        "",
      ].join("\n"),
    );
    await chmod(path.join(commands, "rm"), 0o755);

    const child = spawn("/bin/sh", [path.join(root, "install.sh")], {
      env: {
        ...process.env,
        PATH: `${commands}:/usr/bin:/bin`,
        HOME: home,
        TMPDIR: temporary,
        FIXTURE_ROOT: fixture,
        FAKE_RM_LOG_FILE: removalLog,
        FAKE_RM_WAIT_PATH: journal,
        FAKE_RM_READY_FILE: removalReady,
        FAKE_RM_RELEASE_FILE: releaseRemoval,
        SANA_MCP_INSTALL_DIR: installDirectory,
        SANA_MCP_VERSION: "v0.3.2",
        SANA_MCP_YES: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const closePromise = once(child, "close") as Promise<[number]>;
    await Promise.race([
      waitForFile(removalReady),
      closePromise.then(([code]) => {
        throw new Error(
          `installer exited before completed-journal removal (${code}): ${stderr}`,
        );
      }),
    ]);

    const removalLogAtLoss = await readFile(removalLog, "utf8");
    const pathLock = path.join(home, ".sana-mcp-installer-path.lock");
    const pathLockEntries = await readdir(pathLock);
    assert.equal(pathLockEntries.length, 1);
    await writeFile(
      path.join(pathLock, pathLockEntries[0]),
      "changed-during-journal-removal\n",
    );
    await writeFile(releaseRemoval, "continue\n");

    const [code] = await closePromise;
    assert.equal(code, 1);
    assert.match(stderr, /installer lock ownership was lost/);
    assert.match(stderr, /lost before final lock release/);
    assert.equal(await readFile(removalLog, "utf8"), removalLogAtLoss);
    await access(path.join(installDirectory, "sana-mcp"));
    await access(path.join(installDirectory, ".sana-mcp-install-v1"));
    await assert.rejects(access(journal));
    assert.equal(
      await readFile(path.join(pathLock, pathLockEntries[0]), "utf8"),
      "changed-during-journal-removal\n",
    );
    const installLock = path.join(
      installDirectory,
      ".sana-mcp-install-lock",
    );
    const installLockEntries = await readdir(installLock);
    assert.equal(installLockEntries.length, 1);
    assert.equal(
      (await readFile(path.join(installLock, installLockEntries[0]), "utf8")).trim(),
      installLockEntries[0],
    );
    const temporaryEntries = await readdir(temporary);
    const recoveryInventories = temporaryEntries.filter((entry) =>
      entry.startsWith("sana-mcp."),
    );
    assert.equal(recoveryInventories.length, 1);
    const recoveryInventory = path.join(temporary, recoveryInventories[0]);
    await access(path.join(recoveryInventory, "binary"));
    await access(path.join(recoveryInventory, "config-apply.json"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX revalidates only the exact managed block immediately before receipt commit", async () => {
  if (process.platform !== "linux") return;
  for (const tamperManagedBlock of [false, true]) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-path-cas-"));
    try {
      const fixture = await createOfflineRelease(temporary);
      const home = path.join(temporary, "home");
      const profile = path.join(home, ".bashrc");
      const installDirectory = path.join(temporary, "managed-bin");
      const configured = path.join(temporary, "configured");
      const healthReady = path.join(temporary, "health-ready");
      const releaseHealth = path.join(temporary, "release-health");
      await mkdir(home);
      await writeFile(profile, "# original\n");
      const child = spawn("/bin/sh", [path.join(root, "install.sh")], {
        env: {
          ...process.env,
          PATH: `${path.join(temporary, "commands")}:/usr/bin:/bin`,
          HOME: home,
          TMPDIR: temporary,
          SHELL: "/bin/bash",
          FIXTURE_ROOT: fixture,
          FAKE_CONFIG_EXIT: "0",
          FAKE_CONFIGURED_FILE: configured,
          FAKE_HEALTH_READY_FILE: healthReady,
          FAKE_HEALTH_WAIT_FILE: releaseHealth,
          SANA_MCP_INSTALL_DIR: installDirectory,
          SANA_MCP_VERSION: "v0.3.2",
          SANA_MCP_YES: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      await waitForFile(healthReady);
      const published = await readFile(profile, "utf8");
      await writeFile(
        profile,
        tamperManagedBlock
          ? published.replace(':"$PATH"', ':"$PATH_TAMPERED"')
          : `${published}# unrelated concurrent edit\n`,
      );
      await writeFile(releaseHealth, "continue\n");
      const [code] = await once(child, "close") as [number];
      if (tamperManagedBlock) {
        assert.equal(code, 1);
        assert.match(stderr, /PATH block changed before receipt commit/);
        assert.match(stderr, /retained the replacement runtime/);
        await access(
          path.join(installDirectory, ".sana-mcp-install-v1"),
        );
      } else {
        assert.equal(code, 0, stderr);
        assert.match(await readFile(profile, "utf8"), /unrelated concurrent edit/);
        assert.match(
          await readFile(
            path.join(installDirectory, ".sana-mcp-install-v1"),
            "utf8",
          ),
          /(?:^|\n)pathProfile=bashrc\n/,
        );
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});

test("POSIX non-interactive install keeps the verified runtime and defers client configuration", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-nontty-install-"));
  try {
    const fixture = await createOfflineRelease(temporary);
    const home = path.join(temporary, "home");
    const installDirectory = path.join(temporary, "managed bin");
    const configReady = path.join(temporary, "config-ready");
    const recoveryArgs = path.join(temporary, "recovery-args");
    await mkdir(home);
    const result = spawnSync(
      "/usr/bin/setsid",
      ["/bin/sh", path.join(root, "install.sh")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${path.join(temporary, "commands")}:/usr/bin:/bin`,
          HOME: home,
          FIXTURE_ROOT: fixture,
          FAKE_CONFIG_READY_FILE: configReady,
          SANA_MCP_INSTALL_DIR: installDirectory,
          SANA_MCP_VERSION: "v0.3.2",
          SANA_MCP_YES: "",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /configuration was skipped/);
    const command = result.stdout.match(/^Run this command: (.+)$/mu)?.[1];
    assert.ok(command);
    const recovery = spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        SANA_DATA_DIR: path.join(temporary, "recovery-data"),
        FAKE_INSTALL_ARGS_FILE: recoveryArgs,
      },
    });
    assert.equal(recovery.status, 23, recovery.stderr);
    assert.equal(recovery.stderr, "");
    assert.equal(await readFile(recoveryArgs, "utf8"), "install\n");
    await access(path.join(installDirectory, "sana-mcp"));
    await access(path.join(installDirectory, ".sana-mcp-install-v1"));
    await assert.rejects(access(configReady));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX retains the replacement runtime and journal when apply is incomplete", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-apply-incomplete-"));
  try {
    const fixture = await createOfflineRelease(temporary);
    const home = path.join(temporary, "home");
    const installDirectory = path.join(temporary, "managed-bin");
    await mkdir(home);
    const result = spawnSync("/bin/sh", [path.join(root, "install.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(temporary, "commands")}:/usr/bin:/bin`,
        HOME: home,
        FIXTURE_ROOT: fixture,
        FAKE_CONFIG_OUTCOME: "rollback-incomplete",
        FAKE_CONFIG_EXIT: "2",
        FAKE_CONFIG_CREATE_JOURNAL: "1",
        FAKE_CONFIG_AUTHENTICATION: "unconfirmed",
        FAKE_CONFIG_DISPOSITION: "configuration-unavailable",
        SANA_MCP_INSTALL_DIR: installDirectory,
        SANA_MCP_VERSION: "v0.3.2",
        SANA_MCP_YES: "1",
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /could not be confirmed/);
    assert.match(result.stderr, /replacement runtime and recovery journal were retained/);
    await access(path.join(installDirectory, "sana-mcp"));
    await access(
      path.join(
        installDirectory,
        ".sana-mcp-config-transaction",
        "client-config-transaction.json",
      ),
    );
    await access(path.join(installDirectory, ".sana-mcp-install-v1"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX rolls client configuration back but retains a live-state-touched runtime", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-config-rollback-"));
  try {
    const fixture = await createOfflineRelease(temporary);
    const home = path.join(temporary, "home");
    const installDirectory = path.join(temporary, "managed-bin");
    const configured = path.join(temporary, "configured");
    const transactionLog = path.join(temporary, "transactions");
    await mkdir(home);
    const result = spawnSync("/bin/sh", [path.join(root, "install.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(temporary, "commands")}:/usr/bin:/bin`,
        HOME: home,
        FIXTURE_ROOT: fixture,
        FAKE_CONFIGURED_FILE: configured,
        FAKE_POST_CONFIG_HEALTH_EXIT: "77",
        FAKE_TRANSACTION_LOG_FILE: transactionLog,
        SANA_MCP_INSTALL_DIR: installDirectory,
        SANA_MCP_VERSION: "v0.3.2",
        SANA_MCP_YES: "1",
      },
    });
    assert.equal(result.status, 1);
    assert.deepEqual(
      (await readFile(transactionLog, "utf8")).trim().split("\n"),
      ["apply", "rollback"],
    );
    await access(path.join(installDirectory, "sana-mcp"));
    await access(path.join(installDirectory, ".sana-mcp-install-v1"));
    await assert.rejects(
      access(path.join(installDirectory, ".sana-mcp-config-transaction")),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX keeps the replacement runtime, PATH, and recovery journal when rollback fails", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-rollback-fails-"));
  try {
    const fixture = await createOfflineRelease(temporary);
    const home = path.join(temporary, "home");
    const profile = path.join(home, ".bashrc");
    const installDirectory = path.join(temporary, "managed-bin");
    const configured = path.join(temporary, "configured");
    await mkdir(home);
    await writeFile(profile, "# profile\n");
    const result = spawnSync("/bin/sh", [path.join(root, "install.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(temporary, "commands")}:/usr/bin:/bin`,
        HOME: home,
        SHELL: "/bin/bash",
        FIXTURE_ROOT: fixture,
        FAKE_CONFIGURED_FILE: configured,
        FAKE_POST_CONFIG_HEALTH_EXIT: "77",
        FAKE_ROLLBACK_OUTCOME: "conflict",
        FAKE_ROLLBACK_EXIT: "2",
        SANA_MCP_INSTALL_DIR: installDirectory,
        SANA_MCP_VERSION: "v0.3.2",
        SANA_MCP_YES: "1",
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /configuration rollback was incomplete/);
    assert.match(result.stderr, /retained the replacement runtime/);
    await access(path.join(installDirectory, "sana-mcp"));
    await access(
      path.join(
        installDirectory,
        ".sana-mcp-config-transaction",
        "client-config-transaction.json",
      ),
    );
    assert.match(await readFile(profile, "utf8"), /sana-mcp installer/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX retains transactional configuration while Windows defers public setup until commit", async () => {
  const posix = await readFile(path.join(root, "install.sh"), "utf8");
  const windows = await readFile(path.join(root, "install.ps1"), "utf8");
  assert.match(
    posix,
    /command -v apk[\s\S]*apk info --exists libstdc\+\+[\s\S]*apk info --exists libgcc[\s\S]*apk add --no-cache libstdc\+\+ libgcc/,
  );
  assert.match(
    posix,
    /__configure-transaction apply[\s\S]*--server-command "\$dest" \\\n    < \/dev\/tty > "\$tmp_dir\/config-apply\.json"/,
  );
  assert.doesNotMatch(
    posix,
    /--server-command "\$dest" \\\n    --yes \\\n    < \/dev\/tty/,
  );
  assert.doesNotMatch(windows, /__configure-transaction/u);
  assert.doesNotMatch(windows, /Read-ConfigTransactionResult/u);
  assert.match(
    windows,
    /\$RuntimeStateTouched = \$true[\s\S]*?Invoke-Lifecycle \$Destination "health"/u,
  );
});

test("POSIX installer checks Alpine runtime packages before release downloads", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "sana-musl-prerequisite-"),
  );
  try {
    const commands = path.join(temporary, "commands");
    const home = path.join(temporary, "home");
    const log = path.join(temporary, "calls.log");
    await mkdir(commands);
    await mkdir(home);
    await writeFile(
      path.join(commands, "uname"),
      "#!/bin/sh\ncase \"$1\" in -s) echo Linux ;; -m) echo x86_64 ;; *) exit 64 ;; esac\n",
    );
    await writeFile(path.join(commands, "getconf"), "#!/bin/sh\nexit 1\n");
    await writeFile(
      path.join(commands, "ldd"),
      "#!/bin/sh\necho 'musl libc (test fixture)'\n",
    );
    await writeFile(
      path.join(commands, "apk"),
      [
        "#!/bin/sh",
        'printf "apk:%s\\n" "$3" >> "$FAKE_CALL_LOG"',
        '[ "$1" = info ] && [ "$2" = --exists ] || exit 64',
        '[ "${FAKE_MISSING_PACKAGE:-}" != "$3" ]',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(commands, "curl"),
      '#!/bin/sh\nprintf "curl\\n" >> "$FAKE_CALL_LOG"\nexit 22\n',
    );
    for (const command of ["uname", "getconf", "ldd", "apk", "curl"]) {
      await chmod(path.join(commands, command), 0o755);
    }

    const run = (missingPackage?: string) =>
      spawnSync("/bin/sh", [path.join(root, "install.sh")], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${commands}:/usr/bin:/bin`,
          HOME: home,
          FAKE_CALL_LOG: log,
          SANA_MCP_VERSION: "v0.4.0",
          ...(missingPackage === undefined
            ? {}
            : { FAKE_MISSING_PACKAGE: missingPackage }),
        },
      });

    for (const missingPackage of ["libstdc++", "libgcc"]) {
      await writeFile(log, "");
      const missing = run(missingPackage);
      assert.notEqual(missing.status, 0);
      assert.match(
        missing.stderr,
        /apk add --no-cache libstdc\+\+ libgcc/,
      );
      assert.doesNotMatch(await readFile(log, "utf8"), /curl/);
    }

    await writeFile(log, "");
    const present = run();
    assert.notEqual(present.status, 0);
    assert.match(present.stderr, /could not download release metadata/);
    assert.deepEqual(
      (await readFile(log, "utf8")).trim().split("\n"),
      ["apk:libstdc++", "apk:libgcc", "curl"],
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX defers only the canonical interaction-unavailable response from an interactive attempt", async () => {
  if (process.platform !== "linux") return;
  for (const terminalEnv of [
    { CI: "1", TERM: "xterm-256color" },
    { CI: "", TERM: "dumb" },
  ]) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-interaction-defer-"));
    try {
      const fixture = await createOfflineRelease(temporary);
      const home = path.join(temporary, "home");
      const installDirectory = path.join(temporary, "managed-bin");
      await mkdir(home);
      const result = spawnSync(
        "/usr/bin/script",
        [
          "-qec",
          `/bin/sh '${path.join(root, "install.sh")}'`,
          "/dev/null",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            ...terminalEnv,
            PATH: `${path.join(temporary, "commands")}:/usr/bin:/bin`,
            HOME: home,
            FIXTURE_ROOT: fixture,
            FAKE_CONFIG_OUTCOME: "interaction-unavailable",
            FAKE_CONFIG_EXIT: "1",
            FAKE_CONFIG_AUTHENTICATION: "not-attempted",
            SANA_MCP_INSTALL_DIR: installDirectory,
            SANA_MCP_VERSION: "v0.3.2",
            SANA_MCP_YES: "",
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /configuration was deferred/);
      assert.match(
        result.stdout,
        /Run this command: '.*managed-bin\/sana-mcp' install/u,
      );
      await access(path.join(installDirectory, "sana-mcp"));
      await access(path.join(installDirectory, ".sana-mcp-install-v1"));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});

test("POSIX rejects contradictory transaction counts before claiming authentication", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-config-contradiction-"));
  try {
    const fixture = await createOfflineRelease(temporary);
    const home = path.join(temporary, "home");
    const installDirectory = path.join(temporary, "managed-bin");
    await mkdir(home);
    const result = spawnSync("/bin/sh", [path.join(root, "install.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(temporary, "commands")}:/usr/bin:/bin`,
        HOME: home,
        FIXTURE_ROOT: fixture,
        FAKE_CONFIG_OUTCOME: "no-mutation",
        FAKE_CONFIG_APPLIED_COUNT: "1",
        FAKE_CONFIG_AUTHENTICATION: "ready",
        SANA_MCP_INSTALL_DIR: installDirectory,
        SANA_MCP_VERSION: "v0.3.2",
        SANA_MCP_YES: "1",
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid transaction response/);
    assert.doesNotMatch(result.stdout, /authentication was confirmed/);
    await access(path.join(installDirectory, "sana-mcp"));
    await access(path.join(installDirectory, ".sana-mcp-install-v1"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX rejects ready authentication on a failed transaction before presentation", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-ready-failure-"));
  try {
    const fixture = await createOfflineRelease(temporary);
    const home = path.join(temporary, "home");
    const installDirectory = path.join(temporary, "managed-bin");
    await mkdir(home);
    const result = spawnSync("/bin/sh", [path.join(root, "install.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(temporary, "commands")}:/usr/bin:/bin`,
        HOME: home,
        FIXTURE_ROOT: fixture,
        FAKE_CONFIG_OUTCOME: "configuration-unavailable",
        FAKE_CONFIG_EXIT: "1",
        FAKE_CONFIG_AUTHENTICATION: "ready",
        SANA_MCP_INSTALL_DIR: installDirectory,
        SANA_MCP_VERSION: "v0.3.2",
        SANA_MCP_YES: "1",
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid transaction response/);
    assert.doesNotMatch(result.stdout, /authentication was confirmed/);
    assert.match(result.stderr, /retained the replacement runtime/);
    await access(path.join(installDirectory, "sana-mcp"));
    await access(path.join(installDirectory, ".sana-mcp-install-v1"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("POSIX pre-live publication failure restores files without starting the replacement runtime", async () => {
  if (process.platform !== "linux") return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-prelive-failure-"));
  try {
    const fixture = await createOfflineRelease(temporary);
    const home = path.join(temporary, "home");
    const profile = path.join(home, ".bashrc");
    const installDirectory = path.join(temporary, "managed-bin");
    const configReady = path.join(temporary, "config-ready");
    const lifecycleLog = path.join(temporary, "lifecycle.log");
    await mkdir(home);
    await writeFile(profile, "# >>> sana-mcp installer >>>\n");
    const result = spawnSync("/bin/sh", [path.join(root, "install.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(temporary, "commands")}:/usr/bin:/bin`,
        HOME: home,
        SHELL: "/bin/bash",
        FIXTURE_ROOT: fixture,
        FAKE_CONFIG_READY_FILE: configReady,
        FAKE_LIFECYCLE_LOG_FILE: lifecycleLog,
        SANA_MCP_INSTALL_DIR: installDirectory,
        SANA_MCP_VERSION: "v0.3.2",
        SANA_MCP_YES: "1",
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PATH block .* malformed/);
    await assert.rejects(access(configReady));
    await assert.rejects(access(lifecycleLog));
    await assert.rejects(access(path.join(installDirectory, "sana-mcp")));
    await assert.rejects(
      access(path.join(installDirectory, ".sana-mcp-install-v1")),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PowerShell install-directory validation rejects separators, controls, and noncanonical paths", async () => {
  const command =
    process.platform === "win32"
      ? "powershell.exe"
      : (
          spawnSync(
            "/bin/sh",
            ["-c", "command -v pwsh || command -v powershell.exe"],
            { encoding: "utf8" },
          ).stdout.trim()
        );
  if (command.length === 0) return;
  const installer = await readFile(path.join(root, "install.ps1"), "utf8");
  const functionStart = installer.indexOf("function Resolve-InstallDirectory");
  const functionEnd = installer.indexOf("\nfunction Normalize-PathEntry");
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);
  const validator = installer.slice(functionStart, functionEnd);
  const script = [
    '$ErrorActionPreference = "Stop"',
    validator,
    '$Base = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) "sana-installer-path-test"))',
    '$Resolved = Resolve-InstallDirectory $Base ([IO.Path]::GetTempPath())',
    'if ($Resolved -cne $Base) { throw "canonical path changed" }',
    '$Default = Resolve-InstallDirectory $null $Base',
    'if ($Default -cne (Join-Path $Base "sana-mcp")) { throw "default path changed" }',
    '$Invalid = @(" ", "$Base;extra", "$Base`nextra", ($Base + [char]0 + "extra"), [IO.Path]::Combine($Base, "..", "other"))',
    "foreach ($Candidate in $Invalid) {",
    "  $Rejected = $false",
    "  try { Resolve-InstallDirectory $Candidate ([IO.Path]::GetTempPath()) } catch { $Rejected = $true }",
    '  if (-not $Rejected) { throw "invalid install directory was accepted" }',
    "}",
    "",
  ].join("\n");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-ps-install-path-"));
  try {
    const scriptPath = path.join(temporary, "install-path.ps1");
    await writeFile(scriptPath, script);
    let executableScriptPath = scriptPath;
    if (
      process.platform === "linux" &&
      command.toLowerCase().endsWith(".exe")
    ) {
      const converted = spawnSync("wslpath", ["-w", scriptPath], {
        encoding: "utf8",
      });
      if (converted.status !== 0) return;
      executableScriptPath = converted.stdout.trim();
    }
    const result = spawnSync(
      command,
      ["-NoProfile", "-NonInteractive", "-File", executableScriptPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

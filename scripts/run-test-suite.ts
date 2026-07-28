import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const fileTimeoutSeconds =
  process.env.SANA_MCP_TEST_CURRENT_WINDOWS_BINARY === undefined ? 120 : 300;
const glob = new Bun.Glob("tests/**/*.test.ts");
const files: string[] = [];

for await (const file of glob.scan({ cwd: root, onlyFiles: true })) {
  files.push(file);
}
files.sort();
if (files.length === 0) throw new Error("No test files were discovered");

async function runFile(file: string): Promise<number> {
  const testCommand = [
    process.execPath,
    "test",
    file,
    "--parallel=1",
    "--timeout",
    "20000",
  ];
  let command = testCommand;
  let supervisedByTimeout = false;
  if (process.platform === "linux") {
    const timeoutExecutable = Bun.which("timeout");
    if (timeoutExecutable === null) {
      throw new Error("timeout is required to supervise the test suite");
    }
    command = [
      timeoutExecutable,
      "-s",
      "KILL",
      "-k",
      "1s",
      `${fileTimeoutSeconds}s`,
      ...testCommand,
    ];
    supervisedByTimeout = true;
  }

  const child = Bun.spawn(command, {
    cwd: root,
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  let timedOut = false;
  const timer = supervisedByTimeout
    ? undefined
    : setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, fileTimeoutSeconds * 1_000);
  const exitCode = await child.exited;
  if (timer !== undefined) clearTimeout(timer);
  if (timedOut) {
    console.error(`${file} exceeded ${fileTimeoutSeconds}s`);
  }
  return timedOut ? 1 : exitCode;
}

for (const file of files) {
  console.log(`\n==> ${file}`);
  const exitCode = await runFile(file);
  if (exitCode !== 0) process.exit(exitCode || 1);
}

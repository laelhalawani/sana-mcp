import {
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  readSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

interface FakeReleaseState {
  exists: boolean;
  draft: boolean;
  tag: string;
  title: string;
  prerelease: boolean;
  tagExists?: boolean;
  tagCreated?: boolean;
  tagSha?: string | null;
  tagKind?: string;
  tagObjectSha?: string;
  tagVisibilityMisses?: number;
  releaseVisibilityMisses?: number;
  tagLookups?: number;
  releaseLookups?: number;
  sleepCalls?: string[];
}

const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 16_384;
const MAX_ENVIRONMENT_BYTES = 16_384;
const MAX_STATE_BYTES = 1_048_576;
const environmentNames = [
  "FAKE_GITHUB_ROOT",
  "FAKE_RELEASE_STATE",
  "FAKE_RELEASE_ASSETS",
  "FAKE_RELEASE_SCENARIO",
  "GITHUB_REPOSITORY",
  "RELEASE_TAG",
  "PWD",
  "SOURCE_SHA",
  "FAKE_TAG_CREATE_FAIL",
  "FAKE_TAG_RACE_SHA",
  "FAKE_CREATED_TAG_SHA",
  "FAKE_CREATED_TAG_KIND",
  "FAKE_TAG_VISIBILITY_MISSES",
  "FAKE_TAG_LOOKUP_ERROR",
  "FAKE_POST_CREATE_TAG_LOOKUP_ERROR",
  "FAKE_TAG_OBJECT_LOOKUP_ERROR",
  "FAKE_RELEASE_LOOKUP_FAILURE_AT",
  "FAKE_RELEASE_MALFORMED_AT",
  "FAKE_RELEASE_DUPLICATE_AT",
  "FAKE_RELEASE_VISIBILITY_MISSES",
  "FAKE_MOVE_TAG_ON_DOWNLOAD_SHA",
  "FAKE_MOVE_TAG_ON_UPLOAD_SHA",
  "FAKE_MOVE_TAG_ON_EDIT_SHA",
] as const;

class SimulatorFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let root = "";
let scenario = "unlabelled";

function fail(status: number, message: string): never {
  throw new SimulatorFailure(status, message);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validateScalar(name: string, value: string): void {
  if (/[\r\n]/u.test(value)) fail(70, `${name} contains a line break`);
  if (byteLength(value) > MAX_ENVIRONMENT_BYTES) {
    fail(70, `${name} exceeds ${MAX_ENVIRONMENT_BYTES} bytes`);
  }
}

function withinRoot(candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function validateRoot(requested: string): string {
  validateScalar("FAKE_GITHUB_ROOT", requested);
  if (!path.isAbsolute(requested) || path.normalize(requested) !== requested) {
    fail(70, "simulator root is not canonical and absolute");
  }
  const observed = lstatSync(requested);
  if (
    observed.isSymbolicLink() ||
    !observed.isDirectory() ||
    observed.uid !== process.getuid() ||
    (observed.mode & 0o777) !== 0o700
  ) {
    fail(70, "simulator root must be an owned ordinary mode-0700 directory");
  }
  const canonical = realpathSync(requested);
  if (canonical !== requested) fail(70, "simulator root is not authoritative");
  return canonical;
}

function validateExisting(
  requested: string,
  kind: "file" | "directory",
): string {
  validateScalar(`${kind} path`, requested);
  if (!path.isAbsolute(requested) || path.normalize(requested) !== requested) {
    fail(70, `${kind} path is not canonical and absolute`);
  }
  if (!withinRoot(requested)) fail(70, `${kind} path escapes the simulator root`);
  const relative = path.relative(root, requested);
  let cursor = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let observed: ReturnType<typeof lstatSync>;
    try {
      observed = lstatSync(cursor);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        fail(70, `${kind} path has a missing component`);
      }
      throw error;
    }
    if (observed.isSymbolicLink()) {
      fail(70, `${kind} path contains a symbolic link or reparse point`);
    }
  }
  const canonical = realpathSync(requested);
  if (canonical !== requested || !withinRoot(canonical)) {
    fail(70, `${kind} path does not resolve canonically within the simulator root`);
  }
  const observed = lstatSync(canonical);
  if (
    observed.isSymbolicLink() ||
    (kind === "file" ? !observed.isFile() : !observed.isDirectory())
  ) {
    fail(70, `${kind} path has the wrong filesystem type`);
  }
  return canonical;
}

function validateLeaf(parent: string, leaf: string, allowMissing: boolean): string {
  validateScalar("simulator file name", leaf);
  if (
    leaf === "" ||
    leaf !== path.basename(leaf) ||
    leaf === "." ||
    leaf === ".."
  ) {
    fail(70, "simulator file name is invalid");
  }
  const canonicalParent = validateExisting(parent, "directory");
  const candidate = path.join(canonicalParent, leaf);
  if (!withinRoot(candidate)) fail(70, "simulator file target escapes the simulator root");
  if (allowMissing) {
    try {
      lstatSync(candidate);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return candidate;
      }
      throw error;
    }
  }
  try {
    return validateExisting(candidate, "file");
  } catch (error) {
    if (
      allowMissing &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return candidate;
    }
    throw error;
  }
}

function makeExclusiveTemporary(parent: string, label: string): {
  path: string;
  descriptor: number;
} {
  for (let index = 0; index < 32; index += 1) {
    const leaf = `.${label}.${process.pid}.${index}.tmp`;
    const candidate = validateLeaf(parent, leaf, true);
    try {
      const descriptor = openSync(
        candidate,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      fchmodSync(descriptor, 0o600);
      return { path: candidate, descriptor };
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        continue;
      }
      throw error;
    }
  }
  fail(70, "could not allocate an exclusive simulator temporary file");
}

function atomicBytes(destination: string, bytes: Uint8Array): void {
  const parent = validateExisting(path.dirname(destination), "directory");
  const leaf = path.basename(destination);
  const expectedDestination = validateLeaf(parent, leaf, true);
  const temporary = makeExclusiveTemporary(parent, leaf);
  let temporaryExists = true;
  try {
    writeFileSync(temporary.descriptor, bytes);
    closeSync(temporary.descriptor);
    validateExisting(parent, "directory");
    validateLeaf(parent, leaf, true);
    renameSync(temporary.path, expectedDestination);
    temporaryExists = false;
  } finally {
    try {
      closeSync(temporary.descriptor);
    } catch {
      // The descriptor was already closed after a successful durable write.
    }
    if (temporaryExists) {
      try {
        unlinkSync(temporary.path);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw error;
        }
      }
    }
  }
}

function readState(stateFile: string): FakeReleaseState {
  const authoritative = validateExisting(stateFile, "file");
  const observed = statSync(authoritative);
  if (observed.size > MAX_STATE_BYTES) {
    fail(70, `release state exceeds ${MAX_STATE_BYTES} bytes`);
  }
  const bytes = readFileSync(authoritative);
  if (bytes.includes(0)) fail(70, "release state contains a NUL byte");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(70, "release state is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(70, "release state must be an object");
  }
  const state = parsed as Partial<FakeReleaseState>;
  if (
    typeof state.exists !== "boolean" ||
    typeof state.draft !== "boolean" ||
    typeof state.tag !== "string" ||
    typeof state.title !== "string" ||
    typeof state.prerelease !== "boolean" ||
    typeof state.tagExists !== "boolean"
  ) {
    fail(70, "release state is missing required typed fields");
  }
  for (const [name, value] of [
    ["tagCreated", state.tagCreated],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      fail(70, `release state ${name} is invalid`);
    }
  }
  for (const [name, value] of [
    ["tagSha", state.tagSha],
    ["tagKind", state.tagKind],
    ["tagObjectSha", state.tagObjectSha],
  ] as const) {
    if (
      value !== undefined &&
      value !== null &&
      typeof value !== "string"
    ) {
      fail(70, `release state ${name} is invalid`);
    }
  }
  for (const [name, value] of [
    ["tagVisibilityMisses", state.tagVisibilityMisses],
    ["releaseVisibilityMisses", state.releaseVisibilityMisses],
    ["tagLookups", state.tagLookups],
    ["releaseLookups", state.releaseLookups],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < 0)
    ) {
      fail(70, `release state ${name} is invalid`);
    }
  }
  if (
    state.sleepCalls !== undefined &&
    (!Array.isArray(state.sleepCalls) ||
      state.sleepCalls.some((entry) => typeof entry !== "string"))
  ) {
    fail(70, "release state sleepCalls is invalid");
  }
  return state as FakeReleaseState;
}

function saveState(stateFile: string, state: FakeReleaseState): void {
  const authoritative = validateExisting(stateFile, "file");
  const encoded = Buffer.from(JSON.stringify(state));
  if (encoded.byteLength > MAX_STATE_BYTES) {
    fail(70, `release state exceeds ${MAX_STATE_BYTES} bytes`);
  }
  atomicBytes(authoritative, encoded);
}

function copyAtomically(source: string, destination: string): void {
  const authoritativeSource = validateExisting(source, "file");
  const parent = validateExisting(path.dirname(destination), "directory");
  const leaf = path.basename(destination);
  const expectedDestination = validateLeaf(parent, leaf, true);
  const temporary = makeExclusiveTemporary(parent, leaf);
  let temporaryExists = true;
  const sourceDescriptor = openSync(
    authoritativeSource,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const count = readSync(sourceDescriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      let offset = 0;
      while (offset < count) {
        offset += writeSync(
          temporary.descriptor,
          buffer,
          offset,
          count - offset,
        );
      }
    }
    closeSync(sourceDescriptor);
    closeSync(temporary.descriptor);
    validateExisting(authoritativeSource, "file");
    validateExisting(parent, "directory");
    validateLeaf(parent, leaf, true);
    renameSync(temporary.path, expectedDestination);
    temporaryExists = false;
  } finally {
    for (const descriptor of [sourceDescriptor, temporary.descriptor]) {
      try {
        closeSync(descriptor);
      } catch {
        // The descriptor was already closed on the successful path.
      }
    }
    if (temporaryExists) {
      try {
        unlinkSync(temporary.path);
      } catch {
        // Preserve the primary copy or validation failure.
      }
    }
  }
}

function environmentCount(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail(70, `${name} must be a non-negative integer`);
  }
  return parsed;
}

function validateEnvironmentSemantics(): void {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(
      process.env.GITHUB_REPOSITORY ?? "",
    )
  ) {
    fail(70, "GITHUB_REPOSITORY must be an exact owner/repository name");
  }
  if (!/^[a-f0-9]{40}$/u.test(process.env.SOURCE_SHA ?? "")) {
    fail(70, "SOURCE_SHA must be a lowercase full commit SHA");
  }
  if (!/^v[0-9A-Za-z.+-]+$/u.test(process.env.RELEASE_TAG ?? "")) {
    fail(70, "RELEASE_TAG must be an exact v-prefixed release tag");
  }
  for (const name of [
    "FAKE_TAG_CREATE_FAIL",
    "FAKE_TAG_LOOKUP_ERROR",
    "FAKE_POST_CREATE_TAG_LOOKUP_ERROR",
    "FAKE_TAG_OBJECT_LOOKUP_ERROR",
  ]) {
    const value = process.env[name];
    if (value !== undefined && value !== "" && value !== "1") {
      fail(70, `${name} must be absent or exactly 1`);
    }
  }
  for (const name of [
    "FAKE_TAG_VISIBILITY_MISSES",
    "FAKE_RELEASE_LOOKUP_FAILURE_AT",
    "FAKE_RELEASE_MALFORMED_AT",
    "FAKE_RELEASE_DUPLICATE_AT",
    "FAKE_RELEASE_VISIBILITY_MISSES",
  ]) {
    environmentCount(name);
  }
  for (const name of [
    "FAKE_TAG_RACE_SHA",
    "FAKE_MOVE_TAG_ON_DOWNLOAD_SHA",
    "FAKE_MOVE_TAG_ON_UPLOAD_SHA",
    "FAKE_MOVE_TAG_ON_EDIT_SHA",
  ]) {
    const value = process.env[name];
    if (
      value !== undefined &&
      value !== "" &&
      !/^[a-f0-9]{40}$/u.test(value)
    ) {
      fail(70, `${name} must be a lowercase full commit SHA`);
    }
  }
  for (const name of ["FAKE_CREATED_TAG_SHA", "FAKE_CREATED_TAG_KIND"]) {
    if (process.env[name] === "") {
      fail(70, `${name} must be absent or nonempty`);
    }
  }
}

function requireExactArgs(
  actual: readonly string[],
  expected: readonly string[],
  description: string,
): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    fail(64, `${description} arguments are invalid: ${JSON.stringify(actual)}`);
  }
}

function run(tool: string, args: readonly string[]): string {
  const stateFile = validateExisting(process.env.FAKE_RELEASE_STATE ?? "", "file");
  const workingDirectory = validateExisting(process.env.PWD ?? "", "directory");
  const assets = (): string =>
    validateExisting(process.env.FAKE_RELEASE_ASSETS ?? "", "directory");
  const load = (): FakeReleaseState => readState(stateFile);
  const save = (state: FakeReleaseState): void => saveState(stateFile, state);

  if (tool === "sleep") {
    const state = load();
    state.sleepCalls = [...(state.sleepCalls ?? []), ...args];
    save(state);
    return "";
  }
  if (tool !== "gh") fail(64, `unexpected tool ${JSON.stringify(tool)}`);
  const repository = process.env.GITHUB_REPOSITORY!;

  if (args[0] === "api" && args.includes("--method")) {
    requireExactArgs(
      args.slice(0, 4),
      ["api", "--method", "POST", `repos/${repository}/git/refs`],
      "tag creation",
    );
    if (
      args.length !== 8 ||
      args[4] !== "-f" ||
      args[5] !== `ref=refs/tags/${process.env.RELEASE_TAG ?? ""}` ||
      args[6] !== "-f" ||
      args[7] !== `sha=${process.env.SOURCE_SHA}`
    ) {
      fail(64, `tag creation arguments are invalid: ${JSON.stringify(args)}`);
    }
    const state = load();
    if (process.env.FAKE_TAG_CREATE_FAIL === "1") {
      fail(1, "synthetic tag creation failure");
    }
    const requestedSha = args[7]!.slice("sha=".length);
    const raceSha = process.env.FAKE_TAG_RACE_SHA;
    state.tagExists = true;
    state.tagCreated = true;
    state.tagSha =
      raceSha || process.env.FAKE_CREATED_TAG_SHA || requestedSha;
    state.tagKind = process.env.FAKE_CREATED_TAG_KIND || "commit";
    state.tagVisibilityMisses =
      environmentCount("FAKE_TAG_VISIBILITY_MISSES") ?? 0;
    save(state);
    if (raceSha) fail(1, "synthetic concurrent tag creation");
    return "{}";
  }

  if (args[0] === "api" && args[1]?.includes("/git/ref/tags/")) {
    const tag = process.env.RELEASE_TAG ?? "";
    requireExactArgs(
      args,
      [
        "api",
        `repos/${repository}/git/ref/tags/${tag}`,
        "--jq",
        '.object.type + " " + .object.sha',
      ],
      "tag lookup",
    );
    if (process.env.FAKE_TAG_LOOKUP_ERROR === "1") {
      fail(1, "synthetic tag lookup failure");
    }
    const state = load();
    state.tagLookups = (state.tagLookups ?? 0) + 1;
    save(state);
    if (
      state.tagCreated &&
      process.env.FAKE_POST_CREATE_TAG_LOOKUP_ERROR === "1"
    ) {
      fail(1, "synthetic post-create tag lookup failure");
    }
    if ((state.tagVisibilityMisses ?? 0) > 0) {
      state.tagVisibilityMisses = (state.tagVisibilityMisses ?? 0) - 1;
      save(state);
      fail(1, "HTTP 404: Not Found");
    }
    if (state.tagExists === false) fail(1, "HTTP 404: Not Found");
    if (state.tagExists !== true) {
      fail(70, "release state does not declare tag existence");
    }
    if (typeof state.tagKind !== "string" || typeof state.tagSha !== "string") {
      fail(70, "release state does not declare the tag target");
    }
    if (state.tagKind === "tag") {
      if (typeof state.tagObjectSha !== "string") {
        fail(70, "release state does not declare the annotated-tag object");
      }
      return `tag ${state.tagObjectSha}\n`;
    }
    return `${state.tagKind} ${state.tagSha}\n`;
  }

  if (args[0] === "api" && args[1]?.includes("/git/tags/")) {
    const state = load();
    requireExactArgs(
      args,
      [
        "api",
        `repos/${repository}/git/tags/${state.tagObjectSha ?? ""}`,
        "--jq",
        '.object.type + " " + .object.sha',
      ],
      "annotated-tag lookup",
    );
    if (process.env.FAKE_TAG_OBJECT_LOOKUP_ERROR === "1") {
      fail(1, "HTTP 404: Not Found");
    }
    if (
      state.tagKind !== "tag" ||
      !args[1].endsWith(`/${state.tagObjectSha}`)
    ) {
      fail(66, `unexpected annotated-tag lookup ${JSON.stringify(args[1])}`);
    }
    if (typeof state.tagSha !== "string") {
      fail(70, "release state does not declare the annotated-tag target");
    }
    return `commit ${state.tagSha}\n`;
  }

  if (args[0] === "api" && args[1]?.includes("/commits/")) {
    fail(67, "commit lookup must not be used as a tag lookup");
  }

  if (args[0] === "api" && args.includes("--paginate")) {
    requireExactArgs(
      args,
      [
        "api",
        "--paginate",
        `repos/${repository}/releases?per_page=100`,
        "--slurp",
      ],
      "release lookup",
    );
    const authoritativeAssets = assets();
    const assetNames = readdirSync(authoritativeAssets);
    for (const name of assetNames) {
      validateLeaf(authoritativeAssets, name, false);
    }
    const state = load();
    state.releaseLookups = (state.releaseLookups ?? 0) + 1;
    save(state);
    if (
      environmentCount("FAKE_RELEASE_LOOKUP_FAILURE_AT") ===
      state.releaseLookups
    ) {
      fail(1, "synthetic release lookup failure");
    }
    if (
      environmentCount("FAKE_RELEASE_MALFORMED_AT") === state.releaseLookups
    ) {
      return "[";
    }
    const releases = state.exists
      ? [
          {
            tag_name: state.tag,
            target_commitish: "main",
            draft: state.draft,
            name: state.title,
            prerelease: state.prerelease,
            assets: assetNames.map((name) => ({ name })),
          },
        ]
      : [];
    if (
      environmentCount("FAKE_RELEASE_DUPLICATE_AT") === state.releaseLookups &&
      releases.length === 1
    ) {
      releases.push({ ...releases[0]! });
    }
    if ((state.releaseVisibilityMisses ?? 0) > 0) {
      state.releaseVisibilityMisses =
        (state.releaseVisibilityMisses ?? 0) - 1;
      save(state);
      return JSON.stringify([[], []]);
    }
    return JSON.stringify([[], releases]);
  }

  if (args[0] === "api") {
    fail(68, `unexpected API invocation ${JSON.stringify(args)}`);
  }
  if (args[0] !== "release") {
    fail(64, `unexpected gh invocation ${JSON.stringify(args)}`);
  }

  if (args[1] === "download") {
    const patternIndex = args.indexOf("--pattern");
    const directoryIndex = args.indexOf("--dir");
    const pattern = args[patternIndex + 1];
    const directory = args[directoryIndex + 1];
    if (
      patternIndex < 0 ||
      directoryIndex < 0 ||
      pattern === undefined ||
      directory === undefined
    ) {
      fail(64, `malformed release download ${JSON.stringify(args)}`);
    }
    requireExactArgs(
      args,
      [
        "release",
        "download",
        process.env.RELEASE_TAG ?? "",
        "--pattern",
        pattern,
        "--dir",
        directory,
      ],
      "release download",
    );
    const source = validateLeaf(assets(), pattern, false);
    const destinationDirectory = validateExisting(
      path.resolve(workingDirectory, directory),
      "directory",
    );
    const destination = validateLeaf(destinationDirectory, pattern, true);
    copyAtomically(source, destination);
    if (process.env.FAKE_MOVE_TAG_ON_DOWNLOAD_SHA) {
      const state = load();
      state.tagSha = process.env.FAKE_MOVE_TAG_ON_DOWNLOAD_SHA;
      save(state);
    }
    return "";
  }

  if (args[1] === "upload") {
    if (
      args.length < 4 ||
      args[2] !== (process.env.RELEASE_TAG ?? "") ||
      args.slice(3).some((argument) => argument.startsWith("-"))
    ) {
      fail(64, `release upload arguments are invalid: ${JSON.stringify(args)}`);
    }
    const transfers = args.slice(3).map((file) => {
      const source = validateExisting(
        path.isAbsolute(file) ? file : path.resolve(workingDirectory, file),
        "file",
      );
      const destination = validateLeaf(assets(), path.basename(file), true);
      return { source, destination };
    });
    for (const { source, destination } of transfers) {
      copyAtomically(source, destination);
    }
    if (process.env.FAKE_MOVE_TAG_ON_UPLOAD_SHA) {
      const state = load();
      state.tagSha = process.env.FAKE_MOVE_TAG_ON_UPLOAD_SHA;
      save(state);
    }
    return "";
  }

  if (args[1] === "edit") {
    requireExactArgs(
      args,
      [
        "release",
        "edit",
        process.env.RELEASE_TAG ?? "",
        "--draft=false",
      ],
      "release edit",
    );
    const state = load();
    state.draft = false;
    if (process.env.FAKE_MOVE_TAG_ON_EDIT_SHA) {
      state.tagSha = process.env.FAKE_MOVE_TAG_ON_EDIT_SHA;
    }
    save(state);
    return "";
  }

  if (args[1] === "create") {
    const state = load();
    const titleIndex = args.indexOf("--title");
    const title = args[titleIndex + 1];
    const expected = [
      "release",
      "create",
      process.env.RELEASE_TAG ?? "",
      "--verify-tag",
      "--draft",
      "--target",
      process.env.SOURCE_SHA ?? "",
      "--title",
      process.env.RELEASE_TAG ?? "",
    ];
    if (args.at(-1) === "--prerelease") expected.push("--prerelease");
    requireExactArgs(args, expected, "release creation");
    if (state.tagExists === false || titleIndex < 0 || title === undefined) {
      fail(65, `release creation state is invalid: ${JSON.stringify(args)}`);
    }
    state.exists = true;
    state.draft = true;
    state.tag = args[2];
    state.title = title;
    state.prerelease = args.includes("--prerelease");
    state.releaseVisibilityMisses =
      environmentCount("FAKE_RELEASE_VISIBILITY_MISSES") ?? 0;
    save(state);
    return "";
  }

  fail(64, `unexpected release invocation ${JSON.stringify(args)}`);
}

try {
  if (process.argv[2] !== "invoke") fail(64, "expected invoke");
  const tool = process.argv[3];
  if (tool !== "gh" && tool !== "sleep") fail(64, "invalid tool");
  const requestedScenario = process.env.FAKE_RELEASE_SCENARIO ?? "unlabelled";
  validateScalar("FAKE_RELEASE_SCENARIO", requestedScenario);
  scenario = requestedScenario;
  const separator = process.argv.indexOf("--", 4);
  if (separator < 0) fail(64, "missing argument separator");
  const args = process.argv.slice(separator + 1);
  if (args.length > MAX_ARGUMENTS) {
    fail(64, `argument count exceeds ${MAX_ARGUMENTS}`);
  }
  for (const [index, argument] of args.entries()) {
    // POSIX argv/environment strings cannot carry NUL bytes. Line breaks and
    // authoritative byte limits are still validated explicitly here.
    if (/[\r\n]/u.test(argument)) {
      fail(64, `argument ${index} contains a line break`);
    }
    if (byteLength(argument) > MAX_ARGUMENT_BYTES) {
      fail(64, `argument ${index} exceeds ${MAX_ARGUMENT_BYTES} bytes`);
    }
  }
  for (const name of environmentNames) {
    validateScalar(name, process.env[name] ?? "");
  }
  root = validateRoot(process.env.FAKE_GITHUB_ROOT ?? "");
  validateExisting(process.env.FAKE_RELEASE_STATE ?? "", "file");
  validateExisting(process.env.FAKE_RELEASE_ASSETS ?? "", "directory");
  validateExisting(process.env.PWD ?? "", "directory");
  validateEnvironmentSemantics();
  if (
    tool === "gh" &&
    (args[0] === "__probe" || args[0] === "__probe-raw")
  ) {
    const status = Number(args[1]);
    if (
      !Number.isSafeInteger(status) ||
      status < 0 ||
      status > 125 ||
      args[2] === undefined ||
      args[3] === undefined
    ) {
      fail(64, "invalid direct probe arguments");
    }
    if (args[0] === "__probe") {
      process.stdout.write(`${JSON.stringify(args.slice(4))}\n${args[2]}\n`);
      process.stderr.write(`${args[3]}\n`);
    } else {
      process.stdout.write(args[2]);
      process.stderr.write(args[3]);
    }
    process.exit(status);
  }
  const output = run(tool, args);
  process.stdout.write(output);
} catch (error) {
  const status = error instanceof SimulatorFailure ? error.status : 70;
  const message =
    error instanceof Error ? error.message : "unknown simulator failure";
  process.stderr.write(`fake-github[${scenario}]: ${message}\n`);
  process.exit(status);
}

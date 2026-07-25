---
status: active
scope: repository-wide remediation and UX delivery
last_verified: 2026-07-25
authority: supersedes conflicting pre-implementation design notes
---

# Repository remediation and delivery plan

This is the reviewed implementation program for the pre-1.0 redesign. It is
governed by `AGENTS.md`.

## Frozen product and engineering decisions

### Compatibility

- Before `1.0.0`, internal APIs, human CLI navigation, cache schemas, receipts,
  and implementation details may break.
- The protected compatibility surface is the agent/LLM contract: MCP tool name,
  tool aliases, argument meanings, Markdown/free-text structure, optional YAML
  frontmatter, table columns, IDs, and navigation hints.
- Correctness fixes may intentionally change invalid-argument, expired-session,
  degraded-search, stalled-daemon, and error wording. Every intentional change is
  recorded in the contract-change ledger; all unaffected fixtures remain frozen.

### Distribution

- End users install standalone Bun executables from GitHub Releases.
- The repository is a private Bun source project, not a Node-compatible npm CLI.
- Release binaries provide keyword/phrase search. Semantic search is source-only
  for this release because the transformer runtime and native sqlite-vec extension
  are not currently delivered for every binary target. Standalone binaries report
  that capability truthfully and continue with keyword search.
- Supported release assets are limited to targets that receive actual native or
  faithful-emulation execution in CI. File-header/architecture inspection alone
  does not qualify. The intended matrix is glibc and musl
  Linux x64/arm64, macOS x64/arm64, and Windows x64; unsupported targets are
  removed from the claim rather than published untested.
- WSL uses the Linux binary and configures clients installed inside WSL. Windows
  GUI clients are configured by running the PowerShell installer on Windows; no
  path or client state is guessed across the WSL boundary.
- The authoritative dependency lock is Bun's text lockfile, `bun.lock`.
- Release publication is automatic from `main` when the exact
  `v<package.json version>` tag does not yet exist. Matching `v*` tag pushes and
  manual dispatches are also supported. Every path binds the package version,
  release tag, source commit, binaries, attestations, manifest, installers, and
  checksums to one exact release tuple.

### Installer/version coupling

- `install.sh`, `install.ps1`, `manifest.json`, binaries, and checksums are release
  assets from the same exact tag.
- The one-line command downloads the installer asset from `releases/latest`; a
  pinned install downloads the installer from that exact tag.
- A versioned manifest freezes asset names, target, SHA-256 filename, binary
  version, installer protocol, lifecycle protocol, and semantic capability.
- The downloaded binary exposes a machine-readable internal inspect command for
  embedded version, target, and protocol. Installer handoff variables are
  untrusted display input and never mutation authority.
- Every redirect remains HTTPS, bounded, and policy-validated.

### Pre-1.0 state transition

- A serialized startup gate is shared by CLI, MCP, daemon, store-open, manual
  binary use, and installer lifecycle. No new entrypoint can open the legacy
  singleton database.
- Upgrading is a controlled removal of the old runtime followed by clean
  installation. Rebuildable transcript, FTS, vector, generated state, and caches
  are not schema-migrated.
- Legacy authentication is preserved only when its canonical origin is explicit
  and proven, legacy cookies can be bound host-only to that origin, `user.me`
  returns an immutable user ID and an authoritative workspace ID, and the new
  profile/resync path validates. `lastUsedWorkspaceId`, email, default origin, or
  another account's workspace are never substitutes.
- Pending-login state is never migrated.
- The closed legacy DB, WAL, and SHM are atomically quarantined under a secure
  transaction journal. They are never exposed through the new profile and remain
  available for rollback until the new account-scoped profile completes a
  cursor-valid full listing plus successful reconciliation/re-fetch of every
  remotely available transcript, meeting-details, and participants artifact, and
  the rollback window closes. Artifacts that cannot be proven rebuildable keep the
  quarantine until explicit cleanup.
- If provenance, auth, resync, ownership, or rollback cannot be proven, the
  transition stops safely and requires login/manual action.

### Human command grammar

- `sana-mcp` on an interactive terminal opens the meeting app.
- Bare non-TTY invocation prints a short usage hint and never prompts.
- `sana-mcp config` and `sana-mcp configure` open client configuration.
- `sana-mcp disconnect` removes only proven sana-mcp client registrations.
- `sana-mcp uninstall` stops the daemon, disconnects proven-owned registrations,
  removes the proven installer-owned binary/PATH/receipt, and preserves auth/data.
- `sana-mcp uninstall --purge-data` additionally removes local auth/cache only
  after explicit confirmation. `--yes` alone never purges data.
- Internal `inspect`, lifecycle, startup-gate, and daemon-control commands are
  machine-oriented, versioned, and not presented as public scripting contracts.
- Command actions return structured outcomes to one top-level error/exit boundary;
  they do not call `process.exit()` internally.

## Prep gate

### Completed

- Repository analysis and three-way planning fan-out.
- Two independent adversarial plan reviews.
- Root `AGENTS.md` with the required workflow, pre-1.0 policy, review evidence,
  and no-hardcoded-fallback rule.
- Local Git remote changed to token-free HTTPS without printing the credential.

### Required before development

#### P-CONTRACT: freeze LLM and process boundaries

Owned files:

- `tests/contracts/agent-output.test.ts`
- `tests/contracts/mcp-stdio.test.ts`
- `tests/fixtures/contracts/agent-output-shapes.json`
- `tests/fixtures/contracts/block-network.ts`
- `tests/fixtures/contracts/daemon-spawn-attempt.ts`
- `tests/fixtures/contracts/dispatch-call.ts`
- `tests/fixtures/contracts/documented-semantics.json`
- `tests/fixtures/contracts/guard-probe.ts`
- `tests/fixtures/contracts/help-list.txt`
- `tests/fixtures/contracts/help-logged-out.txt`
- `tests/fixtures/contracts/help.txt`
- `tests/fixtures/contracts/mcp-tool.json`
- `tests/fixtures/contracts/preload-descendant-probe.ts`
- `tests/fixtures/contracts/representative-outputs.json`
- `tests/fixtures/contracts/seed-store.ts`
- `tests/fixtures/contracts/set-sync-progress.ts`
- `tests/fixtures/contracts/tool-docs.json`
- `docs/dev/contract-change-ledger.md`

One narrow source amendment was authorized after
`p_doc_status_dev/p_contract_fresh_review_2` found an opaque example identifier:
in `src/tools/help.ts`, P-CONTRACT changed only the four `read`, `summary`,
`participants`, and `recording` example IDs to the explicit `<meeting-id>`
placeholder. This wording-only security/contract correction is recorded in the
contract-change ledger and was included in every later whole-scope review through
the clean `p_contract_zero_review_2` review. It does not give P-CONTRACT general
ownership of `src/tools/help.ts`.

Capture sanitized deterministic fixtures for:

- `meeting_transcripts` schema/description;
- tools and legacy aliases `list_meetings` and `read_transcript`;
- arguments and meanings;
- help text;
- Markdown headings/tables/columns and navigation hints;
- optional YAML-frontmatter convention;
- one-shot CLI equality with dispatcher output;
- JSON-RPC stdout purity and absence of ANSI/UI/log output.

List approved behavior corrections separately. No unauthorized fixture diff passes.

#### P-DOC-STATUS: prevent stale design guidance

Owned files:

- `docs/dev/README.md`
- frontmatter/status only in `docs/dev/analysis-app-shell.md`
- frontmatter/status only in `docs/dev/binary-packaging.md`
- frontmatter/status only in `docs/dev/bun-port.md`
- frontmatter/status only in `docs/dev/cli-app-architecture.md`
- frontmatter/status only in `docs/dev/cli-feature-screens.md`
- frontmatter/status only in `docs/dev/cli-presentation-layer.md`
- frontmatter/status only in `docs/dev/cli-specs.md`
- frontmatter/status only in `docs/dev/codebase-notes.md`
- frontmatter/status only in `docs/dev/go-embeddings.md`
- frontmatter/status only in `docs/dev/go-port.md`
- frontmatter/status only in `docs/dev/installer-flow-polish.md`
- frontmatter/status only in `docs/dev/rust-embeddings.md`
- frontmatter/status only in `docs/dev/rust-port.md`
- frontmatter/status only in `docs/dev/tui-library-research.md`
- frontmatter/status only in `docs/dev/tui-rendering.md`

Mark this plan authoritative. Mark conflicting checksum-unverified, singleton
store, historical port, and unfinished UI recommendations as superseded or
historical before implementation agents use them.

#### P-SECURITY: credential gate

- Local remote sanitization is complete.
- This scope owns no repository files and made no repository changes. Its
  read-only targets were `.git/config`, `.gitignore`, all tracked and untracked
  worktree paths, all 34 commits across all refs,
  `scripts/bootstrap-session.mjs`, `scripts/paginate.mjs`,
  `scripts/validate.mjs`, `scripts/investigate.mjs`, `scripts/record.mjs`,
  `scratchpad-test/**`, and path/name/permission metadata under ignored
  `data/**`. It did not inspect live-data file contents.
- Scan results and the intended contract-fixture implications are recorded
  without displaying discovered secrets.
- External GitHub PAT revocation/rotation must ultimately be confirmed through
  GitHub. Local URL cleanup is not revocation, but that external confirmation does
  not block autonomous local development; it remains an explicit completion gate.

## Stage A: UX-first and secure foundations

This stage starts with the requested UX work while limiting it to presentation and
stable ports until the secure runtime spine exists.

### Parallel A wave

#### A-UI: terminal rendering and typed UI ports

Owned files:

- `src/app/ui.ts`
- new `src/app/ports.ts`
- new `src/app/render.ts`
- `tests/app/ui.*`
- `tests/app/ports.*`

Deliver:

- one TTY/color/Unicode policy;
- `NO_COLOR`, `TERM=dumb`, CI, redirected streams, resize, Windows console, and
  WSL-safe rendering;
- soft clear-to-end without alternate screen or scrollback destruction;
- wrap-aware redraw and cursor/raw-mode restoration on success, cancellation,
  exception, SIGINT, and SIGTERM;
- terminal sanitization for ANSI/control/bidi content from titles, transcripts,
  API errors, subprocess errors, and environment display fields;
- width-aware truncation, wrapping, tables, rules, panels, settled/live rows;
- stable typed ports for session, status, list, search, read, summary,
  participants, recording, auth, client configuration, and daemon state;
- explicit loading/ok/empty/unavailable/invalid/error/cancelled unions.

Screens depend only on these ports, never on dispatcher strings or raw store/client
objects.

#### A-CLIENT-CONFIG: safe client configuration core

Owned files:

- `src/install/clients.ts`
- `src/install/detect.ts`
- `src/install/server-target.ts`
- `src/install/status.ts`
- `src/install/writers.ts`
- new `src/install/apply.ts`
- `src/install/install.ts` only for extraction
- `tests/install/clients.*`
- `tests/install/detect.*`
- `tests/install/status.*`
- `tests/install/writers.*`
- `tests/install/apply.*`

Deliver:

- tri-state detection/registration: present, absent, unavailable;
- proof of full managed target ownership before replacement/removal;
- collision handling that never adopts or overwrites a same-name foreign entry;
- safe symlink/reparse handling, preserved owner/mode/comments/newlines, atomic
  same-directory write, `fsync`, and best-effort exact reread immediately before
  rename to detect observed concurrent edits;
- atomic JSON/JSONC/TOML/YAML operations;
- validated names and proven Windows `.exe`/`.cmd`/`.ps1` argv strategy without
  user-controlled shell injection;
- command timeouts and verified postconditions;
- deterministic presentation-free change planning/application.

Freeze `ClientChange`, `ApplyResult`, and ownership APIs before configurer work.

#### A-SECURE-RUNTIME: secure files, environment, and build identity

Owned files:

- `src/config.ts`
- new `src/runtime/env.ts`
- new `src/runtime/secure-files.ts`
- new `src/runtime/build-info.ts`
- `tsconfig.json`
- `package.json` and `bun.lock` for this coordinated dependency/build-marker
  change only
- `src/core/login.ts`, `src/sync/daemon.ts`, and `src/semantic/semantic.ts` only
  for replacing their existing direct numeric `process.env` parsing with imports
  from the authoritative validated runtime environment module; no surrounding
  behavior or API changes
- `src/sana/client.ts` only for adopting secure atomic session load/save and
  permission handling; `src/store/db.ts` only for securing the current database
  parent and DB/WAL/SHM modes; `src/sync/spawn.ts` and `src/sync/lock.ts` only for
  secure `0600` daemon log/lock creation. These are narrow current-consumer
  integrations, not the later session, profile, schema, or daemon redesigns.
- `src/core/search.ts` and `src/core/status.ts` only as needed to consume the
  typed build-capability state so a keyword-only standalone build cannot enter
  semantic/embedding paths and an explicit semantic request is reported as
  unsupported/degraded rather than silently ignored. LLM output structure stays
  unchanged; the complete search/status redesign remains in later scopes.
- `src/tools/dispatch.ts` only for the corresponding additive Markdown status
  sentence that semantic search is unavailable while keyword search remains
  available. This is an intentional truthful wording correction; its exact
  output must be recorded in the contract-change ledger and frozen fixtures
  before Stage A closes.
- `tests/runtime/env.*`
- `tests/runtime/secure-files.*`
- `tests/runtime/build-info.*`

Deliver:

- strict absent/default versus explicit-invalid environment parsing;
- no direct `process.env` numeric parsing outside this module;
- secure `0700` directories and `0600` sensitive files on Unix, truthful
  verified per-user DACLs for default and custom Windows data roots, permission
  repair, and symlink/reparse rejection;
- same-directory atomic JSON, `fsync`, and corrupt-file quarantine;
- authoritative compile-time standalone/target/version/protocol identity; remove
  basename/path heuristics;
- early direct `zod` declaration and frozen Bun lock.

Product defaults are intentional primary configuration. Explicit invalid values
return named errors and never fall back. If the required Windows DACL cannot be
applied and verified, return a typed security/manual-action state before writing
authentication or transcript data.

#### A-RELEASE-CONTRACT: machine-readable distribution contract

Owned files:

- new `src/install/manifest.ts`
- new `release/manifest.schema.json`
- `tests/install/manifest.*`
- `tests/fixtures/manifest/**`

Deliver:

- one versioned JSON manifest schema and strict parser;
- exact target-to-asset and target-to-checksum filename mapping;
- required package version, release tag, target, libc where applicable, SHA-256,
  installer protocol, lifecycle protocol, binary inspect protocol, and semantic
  capability fields;
- unknown-version/unknown-field policy and sanitized fixtures;
- no derived or fallback asset names when a required field is missing.

Freeze this machine contract before installer transport or release generation.

### Stage A review

Each scope repeats dev/review/fix/fresh-review until clean. Then a fresh
cross-cutting reviewer traces sanitized human rendering, client ownership,
concurrent config changes, secure files, and build identity. Repeat until clean.

### Stage A simplification before cross-cutting review

The first Stage A implementation over-applied same-user adversarial defenses to a
local, non-elevated application. This section is the authoritative correction to
the implementation details above. It does not change the frozen product
decisions, protected LLM contracts, strict error behavior, private-data
permissions, ownership checks, or atomic-publication requirements.

The realistic boundary is:

- protect authentication and local data from other local accounts;
- reject final-path symlinks/reparse points at mutation boundaries;
- do not overwrite foreign client registrations and reject concurrent user edits
  observed before publication;
- make writes atomic and report uncertain durability or cleanup truthfully;
- keep release downloads, manifests, checksums, origins, and authentication
  security-sensitive;
- do not attempt to defend against an attacker who can already execute arbitrary
  code as the current user, replace the process environment, or race every
  current-user filesystem operation.

Simple safeguards that serve the first five points remain. Process
authentication, same-user race laboratories, long-lived helper processes, and
native filesystem emulation introduced solely for the last point are removed.
No simplification path may invent fallback state or turn an error into apparent
success.

#### S1: private runtime storage

This scope owns exactly:

- `src/runtime/secure-files.ts`
- new `src/runtime/private-json.ts`
- new `src/runtime/windows-acl.ts`
- delete `src/runtime/unix-at.ts`
- delete `src/runtime/windows-process-handle.ts`
- `src/config.ts`
- `src/sana/client.ts`
- `src/store/db.ts`
- `src/sync/lock.ts`
- `src/sync/spawn.ts`
- `src/sync/daemon.ts` only for the daemon-finalization handoff described below,
  after S-DATE has completed and released the file
- `tests/runtime/secure-files.test.ts`
- `tests/runtime/secure-session.test.ts`
- `tests/runtime/secure-store.test.ts`
- new `tests/runtime/private-json.test.ts` if JSON responsibilities are moved out
  of the existing secure-files suite
- new `tests/runtime/windows-acl.test.ts` for adapter-level tests that do not fit
  the existing cross-platform suite
- `tests/sync/daemon.test.ts` only for daemon-finalization coverage, after S-DATE
  has completed and released the file

The implementation keeps:

- Unix data directories at `0700` and sensitive files, including auth, config,
  logs, locks, the database, and present SQLite sidecars, at `0600`;
- one bounded, short-lived Windows ACL setup/verification for each newly
  encountered private data root, or when its versioned ACL-setup receipt is
  absent/invalid, with a restrictive DACL that excludes other local accounts;
- final-target and final-parent symlink/reparse rejection immediately before a
  sensitive open or publish;
- bounded, schema-validated JSON reads;
- same-directory temporary writes, a held file descriptor through flush, atomic
  replacement, and directory flush where the platform supports it;
- typed corrupt/too-large/unsafe-path/manual-action results, bounded preservation
  of corrupt JSON, exact temporary cleanup reporting, and no empty authenticated
  session synthesized from corruption;
- normal SQLite concurrency and SQLite's ownership of WAL/SHM creation and
  removal.

The implementation removes:

- PowerShell directory leases, DB/WAL/SHM replacement-lock helpers, process-token
  handshakes, verified process handles, and helper parent-death protocols;
- probe files, coordination artifacts, pre-created or held-open WAL/SHM files,
  and same-user substitution-race hooks;
- `/proc/self/fd` and `/dev/fd` database routing;
- native libc/kernel filesystem wrappers and Bun FFI from private-file paths.

`SanaStore` opens the real secured database pathname and lets SQLite manage its
sidecars. Existing sidecars have their modes repaired when present, but are not
pre-created or kept open. A small platform-neutral storage layer owns path
checking, permission repair, ordinary descriptor use, flush, atomic sibling
rename, and cleanup. `private-json.ts` owns JSON validation and serialization.
`windows-acl.ts` is the only Windows ACL adapter. It takes a required
authoritative `SystemRoot` input, validates that it is a local absolute
non-reparse directory, resolves the exact regular system ACL executable beneath
its canonical `System32`, and fails closed if that identity cannot be established.
It does not import `src/install/detect.ts`, inspect executable DACL provenance,
search `PATH`, embed a persistent PowerShell/C# service, or perform per-file
helper authentication.

On Windows, the adapter performs at most one short bounded setup/repair invocation
for each private-root setup batch, and only when that root was newly created or
its atomic `.sana-acl-setup-v1.json` receipt is absent, malformed, has the wrong
version/root, or describes an incomplete setup. One invocation batches that root
and every known existing sensitive child, resets unwanted inherited/explicit
grants, establishes inheritance for future children, and verifies the resulting
root and child ACLs. Setup state is per canonical root: encountering two
independent roots without valid receipts requires one bounded invocation for each;
a process-global "already set up" flag must not skip the second root.

After the root setup succeeds, the adapter bootstraps the receipt through a
low-level non-reentrant path: create a unique sibling with exclusive ordinary
filesystem calls, write and flush the exact version/root/setup record, atomically
publish it, read it back, and validate its final non-reparse path and contents.
This bootstrap must not call `writeJsonAtomic`, `ensureSecureDirectory`,
`ensureSecureDirectories`, or another path that can recursively invoke ACL
setup. The receipt inherits from the already secured root and is not considered
valid until its publication/readback verification succeeds under that ACL.
It is product setup evidence that avoids repeated subprocesses, not a claim that
same-user ACL changes are cryptographically prevented. Later opens of that root
with a valid receipt start no ACL subprocess during ordinary
config/session/store use.

Existing production imports keep the public surface they use:
`SecurePathError`, `SecurePathManualActionError`, `CorruptJsonFileError`,
`JsonFileTooLargeError`, `SecureFileOptions`, `ensureSecureDirectory`,
`ensureSecureDirectories`, `repairSensitiveFilePermissions`,
`repairSensitiveFilesPermissions`, `openSensitiveFile`, `readJsonFile`, and
`writeJsonAtomic`. They may be re-exported from the slimmer
`secure-files.ts`. `ensureDataDir`, `loadConfig`, `saveConfig`, `SanaClient`,
`SanaStore`, `acquireDaemonLock`, `releaseDaemonLock`, `pidAlive`,
`isDaemonAlive`, and `ensureDaemonRunning` retain their current caller-visible
signatures and typed behavior as far as truthful error propagation allows.
`SecureFileOptions.directoryHooks`, `SecureFileOptions.windowsHelperHooks`,
`SensitiveOpenHooks`, `ReadJsonOptions.hooks`, and the `SanaStore`
`beforeDatabaseOpen` constructor hook are intentionally deleted before `1.0.0`.
Descriptor/native exports and types, including `BoundSensitiveFile`,
`bindSensitiveFile`, `bindSensitiveFiles`, the `unix-at.ts` exports, the
`VerifiedWindowsProcessHandle` API, Windows process-handle exports, and all
adversarial race hooks are deleted after production imports are removed.

Daemon-lock cleanup must also stop masking local I/O failures.
`acquireDaemonLock` may treat `EEXIST` as an observed competing owner and may
return `false`; stale-lock unlink may ignore only a proven `ENOENT` race.
`releaseDaemonLock` may take no action when the exact current lock is proven to
belong to another PID and may ignore a proven `ENOENT`. Other lock reads, parses,
permission errors, and unlink failures are surfaced to the caller rather than
silently swallowed. The public return signatures stay `boolean` and `void`; error
states that cannot be represented truthfully are thrown with path-safe actionable
context and are handled at the existing top-level boundary.

S-DATE owns `src/sync/daemon.ts` first and changes only the missing meeting
timestamp behavior. Once S-DATE's development/review loop is clean, it releases
`src/sync/daemon.ts` and `tests/sync/daemon.test.ts` to S1 for one explicitly
authorized finalization amendment. S1 also owns the narrow corresponding
`src/store/db.ts` addition
`clearDaemonIdentityIfOwned(expectedPid): "cleared" | "not-owner"` (or an
equivalent typed name), implemented as one conditional store update whose
predicate is `daemon_pid === expectedPid`.

After a daemon lock has been acquired, daemon finalization first conditionally
clears only this process's daemon PID/heartbeat while it still owns the lock,
then releases the lock, then closes the store. Each action is attempted
independently in that order, so a failure cannot skip any later action. This order
prevents a successor that acquires the released lock from having its newly written
identity cleared by its predecessor. All cleanup failures, together with any
primary daemon failure, are preserved in one observable aggregate at the
top-level boundary. A conditional `not-owner` result is observable diagnostic
state and never triggers an unconditional clear.

Every branch that throws or returns before acquiring the lock still attempts to
close its store. A close failure is surfaced, and when there is also a primary
pre-lock failure both are preserved in the aggregate; those branches never
release a foreign lock or clear another daemon's state. No S1 agent edits the
daemon files until S-DATE releases them, and S-DATE does not edit them again
afterward.

Acceptance and platform evidence:

- routine config/session/store open and close starts no helper process and leaves
  no probe, lease, replacement-lock, or coordination artifact;
- Windows performs one short batched ACL operation per root needing
  establishment/repair and successfully publishes its versioned receipt without
  re-entering setup; subsequent opens of each valid-receipt root start no ACL
  subprocess, while two independent uninitialized roots are both secured;
- Linux and macOS use ordinary paths, `lstat`/`O_NOFOLLOW` where available,
  restrictive modes, and normal SQLite open/close/WAL behavior;
- Windows uses ordinary secured paths, final-boundary reparse checks, restrictive
  root/file ACLs, and normal SQLite open/close/WAL behavior;
- corrupt JSON is preserved at a bounded, deterministic location or returned
  untouched with a typed preservation error; repeated reads cannot create
  unbounded copies;
- permission, reparse, flush, rename, parse, validation, and cleanup failures
  remain observable and never become a successful empty/default state;
- lock tests prove only `ENOENT` and a proven foreign owner are non-errors, while
  read, parse, permission, and unlink failures remain observable;
- daemon finalization tests inject failure separately into conditional sync-state
  clearing, lock release, and store close, and prove that every later
  cleanup is still attempted; a successor-race test proves a predecessor cannot
  clear the successor's PID/heartbeat after releasing its lock; combined
  primary/cleanup failures remain individually visible in the aggregate; and
  both pre-lock return and pre-lock throw paths attempt close, surface its failure,
  and never touch foreign state;
- tests use isolated temporary roots and assert no helper/probe artifacts. Stage A
  requires Linux plus available native Windows evidence and a platform-aware code
  review. Native macOS and the complete release matrix are deferred to
  D-CI-RELEASE and remain release blockers, not Stage A implementation blockers.

This is an internal pre-`1.0.0` simplification, not a live-data migration. It does
not delete, quarantine, or rewrite the live database, auth, or transcript cache.
The database pathname and JSON schemas remain unchanged. Obsolete implementation
coordination files are not found by broad scans or deleted by ordinary runtime
code; only the later serialized upgrade coordinator may remove an exact,
proven-owned artifact. If an old artifact makes ownership ambiguous, return
manual action. An existing Windows private root without a valid ACL receipt gets
one bounded setup/repair on its next open; this records setup state but does not
rewrite auth or database contents. Rollback of this source change requires no data
conversion.

#### S2: client configuration writer

This scope owns exactly:

- `src/install/writers.ts`
- new `src/install/config-formats.ts`
- new `src/install/atomic-config.ts`
- new `src/install/legacy-config-artifacts.ts`
- `src/install/detect.ts`
- `src/install/clients.ts`
- `src/install/status.ts`
- `src/install/apply.ts`
- `src/install/install.ts`
- `tests/install/writers.test.ts`
- new `tests/install/config-formats.test.ts` if format coverage is moved out of
  the existing writers suite
- new `tests/install/atomic-config.test.ts` for publication/observation behavior
- new `tests/install/legacy-config-artifacts.test.ts`
- `tests/install/detect.test.ts`
- `tests/install/clients.test.ts`
- `tests/install/status.test.ts`
- `tests/install/apply.test.ts`

The implementation keeps:

- present/absent/unavailable detection and dual-file ambiguity detection;
- exact full-entry ownership, foreign same-name collision refusal, and no
  adoption or removal of a foreign entry;
- duplicate-key rejection and JSON, JSONC, TOML, and YAML-list support;
- comments, unrelated entries, formatting, and newline conventions where the
  current format implementation supports preservation;
- fully read-only dry-run planning;
- final-target/final-parent link rejection at the operation boundary;
- best-effort observed-conflict detection through an exact raw-content reread
  immediately before publication;
- unique same-directory temporary creation, file flush, intended/preserved Unix
  mode, atomic replacement, directory flush where supported, and typed durability;
- post-write parse and semantic ownership verification;
- the `applied`, `planned`, `noop`, `collision`, `conflict`, `unavailable`,
  `ambiguous`, and `failed` result meanings used by the human configurer.

The implementation removes:

- transaction journals, recovery APIs, PID/start/executable transaction locks,
  backup/link publication, and no-replace native rename protocols;
- `renameat2`, `renameatx_np`, libproc, libc scanning, Bun FFI, Windows process
  handles, and embedded PowerShell/C# commit helpers;
- ACL rewriting or restrictive-DACL enforcement on another application's config
  file;
- command-backed registration transports, which no current `CLIENTS` entry uses,
  and the executor that always refuses to launch;
- trusted-system-executable verification needed only by those removed transports;
- global production hooks for adversarial same-user race injection.

Path-only executable presence detection may remain where it contributes evidence
that an installed client exists. It must inspect paths without starting a
process, checking executable DACL provenance, or becoming a mutation transport.

The conventional publication algorithm is:

1. Parse and plan from an exact byte snapshot.
2. Render and validate the complete candidate before touching the target.
3. Create a unique same-directory temporary, write, flush, and set the intended
   mode.
4. Immediately before rename, reread the target and return `conflict` if its
   existence or exact bytes differ from the planned snapshot.
5. Atomically rename the temporary over the target.
6. Reparse the published file and verify the requested ownership state.
7. If post-publication verification fails, do not roll back, unlink, or otherwise
   mutate the path, including when the target was originally absent. Return a
   typed `ambiguous`/manual-action result containing the exact observed state and
   state plainly that publication occurred but ownership could not be proven.
8. Flush the directory where supported and report `durability: "uncertain"` with
   its warning when it is not.

There is an unavoidable interval between the final reread and atomic rename in
which another same-user process can publish an edit that this process then
replaces. The API is explicitly a proportionate best-effort observed-conflict
model, not compare-and-swap and not a guarantee that no concurrent edit can ever
be overwritten. UI text says what was observed: `conflict` means a pre-publication
change was detected; `ambiguous` means sana-mcp published a candidate but could
not verify the final registration and the user must inspect the named config.
Neither state claims that the original was restored or that the config is
unchanged.

`config-formats.ts` owns parse/render/duplicate-key and preservation mechanics.
`atomic-config.ts` owns snapshot comparison, temporary lifecycle, publication,
post-publication observation, durability, and cleanup.
`legacy-config-artifacts.ts` performs a small read-only deterministic check for
the exact former `.<target>.sana-mcp.journal.json`,
`.<target>.sana-mcp.lock`,
`.<target>.sana-mcp-<24-hex-nonce>.bak`/`.tmp`,
`.<target>.sana-mcp.lock.publish-<24-hex-nonce>-<24-hex>.tmp`, and
`.<target>.sana-mcp.lock.stale-<24-hex>` artifact forms in the target directory.
It also recognizes the former Unix cleanup-capture suffix
`.remove-<48-lowercase-hex>` appended to each of those five pattern classes
(lock, journal, transaction `.bak`/`.tmp`, lock-publish temporary, and stale
lock): the exact anchored construction is
`${baseArtifact}.remove-[a-f0-9]{48}`. Thus each concrete declared base basename,
including both transaction alternatives, is blocked in its exact cleanup-capture
form.

Every basename expression is fully anchored to the exact target leaf and accepts
lowercase hexadecimal at exactly the declared lengths; it does not broaden into a
generic prefix/suffix match or match another target in the same directory.
Planning and applying both return typed manual action when any exists, even if
the config target itself is absent. Tests cover every base and
`.remove-<48hex>` form, truncated/overlong/uppercase/non-hex near misses, two
unrelated target names in the same directory, and the missing-target case. The
blocker never recovers, renames, unlinks, glob-deletes, or broadly cleans
artifacts; the later serialized upgrade coordinator owns proven cleanup.
`writers.ts` is a thin
ownership/plan/apply facade and must not embed shell scripts, native bindings, or
platform process management.

The caller-visible API remains centered on `FileConfigKind`, `ConfigOwnership`,
`FileChangePlan`, `FileApplyResult`, `PlanFileChangeOptions`,
`isOwnedConfigEntry`, `inspectConfigOwnership`, `planFileChange`,
`applyFileChange`, `RegistrationStatus`, `registrationStatus`,
`DesiredRegistration`, `ClientChange`, `ApplyResult`, `ApplyOptions`,
`validateServerName`, `planClientChange`, and `applyClientChange`.
`ClientChange` remains a typed planning result but its unreachable
`transport: "command"` branch is intentionally removed before `1.0.0`.
`ClientDef.install` becomes file-only. Command invocation/result types,
command-mutation functions, transaction recovery/lock functions, native
inspection functions, hardening helpers, and race-hook exports are deleted after
all imports and tests are migrated. Human and agent-facing result wording is
unchanged unless separately approved in the contract-change ledger.

Acceptance and platform evidence:

- inspecting all clients and opening the configurator starts no subprocess,
  including PowerShell, on Windows;
- a crash before atomic rename leaves the original config at its pathname and
  byte-for-byte intact;
- a successful write leaves no journal, lock, backup, probe, or temporary;
- a byte/existence change observed by the final pre-rename reread is reported as
  conflict and remains untouched; tests also document rather than conceal the
  unavoidable final rename window;
- failed post-publication verification leaves the observed path untouched,
  returns `ambiguous`/manual action, and never reports restoration;
- exact legacy artifacts block plan/apply read-only, including the case where the
  target is missing; journal, lock, backup/temp, lock-publish-temp, and stale-lock
  forms plus each exact Unix `.remove-<48hex>` cleanup-capture form are all
  covered and are never recovered or deleted by this scope;
- comments, newlines, foreign keys, and foreign entries remain preserved
  according to the format contract;
- Unix mode preservation is verified on Linux and reviewed for macOS; Windows
  publication and reparse behavior are verified on available native Windows.
  Native macOS execution remains a D-CI-RELEASE release gate;
- inspection, planning, dry-run, register, disconnect, collision, conflict,
  failed verification, ambiguous final state, legacy blocker, and cleanup paths
  have isolated tests.

This internal pre-`1.0.0` representation change requires no config migration:
the on-disk MCP entries and full-entry ownership rule remain the same. Runtime
code does not auto-delete old writer journals or backups. The later upgrade
coordinator may remove only an exact, proven-owned obsolete artifact; otherwise
mutation stops with manual action. A failed post-publication verification leaves
the exact observed state in place for manual inspection; it does not attempt
rollback.

#### S3: canonical release and build target contract

This scope owns exactly:

- new `src/release/contract.ts`
- `src/runtime/build-info.ts`
- `src/install/manifest.ts`
- `release/manifest.schema.json`
- `tests/runtime/build-info.test.ts`
- `tests/install/manifest.test.ts`
- `tests/fixtures/manifest/valid-all-targets.json`
- `tests/fixtures/manifest/invalid-unknown-field.json`
- additional manifest fixtures created by this scope
- `tests/contracts/mcp-stdio.test.ts` only for the narrow canonical
  target-helper/compiled-identifier allowlist update required by this contract
- `tests/contracts/agent-output.test.ts` only for the same narrow canonical
  target-helper/compiled-identifier allowlist update

`src/release/contract.ts` is the single TypeScript authority for the manifest
version, installer/lifecycle/inspect protocol versions, standalone semantic
capability, release targets, target/libc relationships, and their narrow types.
Build identity and manifest parsing import it. The JSON Schema necessarily
duplicates serializable constants; a parity test proves it has the exact same
target and protocol set.

The canonical target vocabulary is the existing release-manifest/Bun vocabulary:

- `bun-linux-x64`
- `bun-linux-x64-musl`
- `bun-linux-arm64`
- `bun-linux-arm64-musl`
- `bun-darwin-x64`
- `bun-darwin-arm64`
- `bun-windows-x64`

The manifest `libc` field remains the explicit glibc/musl discriminator.
`BuildInfo.target`, standalone marker parsing, compile-target parsing, manifest
assets, and binary inspection all use the validated release-target type rather
than widening to `string`. There is no target conversion or guessed suffix in a
fallback path.

Existing imports of `SUPPORTED_COMPILE_TARGETS`,
`RELEASE_MANIFEST_VERSION`, `SUPPORTED_RELEASE_PROTOCOLS`,
`STANDALONE_SEMANTIC_CAPABILITY`, `RELEASE_TARGETS`, and their public target
types continue through explicit re-exports where needed. `BuildInfo`,
`BuildMarkers`, `BuildIdentityError`, `resolveBuildInfo`, `BUILD_INFO`,
`isStandaloneBuild`, `BuildCommandError`, `parseCompileTarget`,
`createStandaloneBuildConfig`, `ReleaseManifest`, `ReleaseManifestError`,
`parseReleaseManifest`, `parseReleaseManifestJson`, and
`resolveManifestAsset` keep their caller-visible meanings. Tightening
`BuildInfo.target` and `parseCompileTarget` to the canonical type is an intended
pre-`1.0.0` correctness change.

The two contract test files are an intentional sequential ownership handoff:
S3 may change only target-helper imports and the explicit compiled-identifier
allowlist needed to use the canonical target contract. It may not change
dispatcher behavior, expected output bytes, frozen fixtures, environment
containment, or LLM-facing assertions. S3 releases both files after its clean
review; S4 then owns their broader harness-only simplification.

Stage A individual acceptance:

- canonical target/protocol/semantic constants have one TypeScript source and
  both strict parser and build-marker configuration consume it;
- glibc/musl combinations are accepted and rejected identically by the strict
  parser and schema;
- schema parity tests fail on a missing, extra, or mismatched target/protocol;
- missing, partial, unsupported, or mismatched build markers remain typed errors;
- the available local Linux compile/inspect/smoke path and available native
  Windows compile/inspect/smoke path prove that the embedded target exactly
  equals the selected canonical target;
- code review traces every declared target/libc branch without claiming that
  review or file-header inspection proves executable platform support.

S3 does not expand into release workflow implementation. Marker-aware CI matrix
generation, native or faithful-emulation execution for every claimed asset,
native macOS execution, manifest generation, checksums, asset completeness, and
the exact publication tuple are owned by D-CI-RELEASE. Stage A may become
implementation-clean after its available Linux/Windows evidence and clean
reviews, but no release is eligible until D-CI-RELEASE proves the complete matrix.

This is an intentional pre-`1.0.0` target-name correction. No installed state is
migrated. Release manifests and binaries are regenerated together from the exact
tag; a stale manifest/binary pair is rejected rather than translated. Rollback
uses the previous complete release tuple, never a mixture of old and new assets.

#### S-DATE: adjacent daemon timestamp invariant correction

This narrow correctness scope owns exactly:

- `src/sync/daemon.ts`
- new `tests/sync/daemon.test.ts` if no daemon test file exists when the scope
  starts

The embedding call currently substitutes `Date.now()` when a meeting that is
being embedded has no authoritative `created_at_ms`. That violates the
no-hardcoded-fallback rule by inventing source identity. Replace it with an
explicit invariant/error path that records the meeting failure with actionable
context and does not mark that meeting embedded. A missing timestamp must not
abort unrelated meetings or silently disable semantic search.

This correction does not redesign daemon authority, synchronization, retries, or
artifact state; those remain in B-DAEMON-CONTROL and C-DAEMON-SYNC. It preserves
the existing embedding and store APIs. Tests prove that a missing timestamp
records a failure, does not call `embedMeeting`, does not call `markEmbedded`, and
allows later valid meetings in the cycle to proceed. There is no persistent-state
migration or rollback action.

#### S4: proportionate contract harness

S4 starts only after S1, S2, S3, and S-DATE are individually clean so that it
tests the settled runtime. It owns exactly:

- `tests/contracts/agent-output.test.ts`
- `tests/contracts/mcp-stdio.test.ts`
- `tests/fixtures/contracts/block-network.ts`
- `tests/fixtures/contracts/dispatch-call.ts`
- `tests/fixtures/contracts/guard-probe.ts`
- `tests/fixtures/contracts/seed-store.ts`
- `tests/fixtures/contracts/semantic-client.ts`
- `tests/fixtures/contracts/semantic-runtime-failure.ts`
- `tests/fixtures/contracts/semantic-spawn.ts`
- `tests/fixtures/contracts/semantic-store.ts`
- `tests/fixtures/contracts/set-sync-progress.ts`
- delete `tests/fixtures/contracts/preload-descendant-probe.ts`
- delete `tests/fixtures/contracts/daemon-spawn-attempt.ts`
- `docs/dev/contract-change-ledger.md` only for an implementation note describing
  the proportionate isolated test environment; protected output baselines and
  approved behavior-change entries remain unchanged
- the contract runner fixtures only; frozen output fixture bytes remain
  read-only unless an independently approved contract-ledger entry requires a
  change

The harness keeps:

- isolated HOME, data, temporary, and client-config paths;
- an explicit block on repository live `data/`;
- blocked `fetch`, the network path actually used by production, and real daemon
  spawn from contract-test execution;
- JSON-RPC stdout purity and absence of UI, ANSI, or log contamination;
- exact representative dispatcher/CLI/MCP parity;
- every frozen tool, alias, argument, Markdown/free-text, optional-frontmatter,
  table, ID, navigation, and semantic-degradation contract.

The harness removes:

- preload digest authentication and copied-preload whitespace protocols;
- malicious same-user preload replacement and descendant-escape scenarios;
- exhaustive interception of unrelated filesystem, DNS, socket, TLS, UDP, HTTP/2,
  worker, and subprocess APIs;
- production-daemon escape fixtures that belong in dedicated daemon tests;
- one isolated child launch per dispatcher output when one isolated child can
  execute a deterministic batch.

The remaining live-data guard should wrap the small set of filesystem entrypoints
actually exercised by production contract paths, canonicalize the forbidden root,
and fail loudly. The network guard should block `fetch`, which is the current Sana
transport, plus only the direct network primitive actually exercised by those
paths. The spawn guard should reject the actual daemon launch path. It is a test
containment boundary, not a sandbox against arbitrary same-user code.

Acceptance criteria:

- all existing frozen output fixture bytes remain unchanged;
- the harness still fails a direct or symlink-aliased access to repository live
  `data/`, a real Sana `fetch`, and a real daemon launch;
- all state is created under isolated temporary roots and cleaned exactly;
- representative dispatcher outputs are obtained in a bounded number of child
  processes without changing their environment or bytes;
- the tests read as output-contract verification, and contain no cryptographic
  preload protocol or adversarial process tree;
- contract tests pass on Linux and available native Windows using
  platform-appropriate path comparison; macOS implementation is code-reviewed
  here and native execution is deferred to D-CI-RELEASE as a release gate.

S4 changes no production or persistent state, so it has no migration or runtime
rollback. If simplification weakens one of the retained containment assertions,
the change is rejected rather than compensated with a hardcoded path or success.
Its contract-ledger edit describes test-environment implementation only and must
not reclassify, rewrite, add, or remove a protected output baseline or approved
contract change.

#### Simplification sequencing, review, and completion gate

1. Freeze the exact ownership above. S1's storage/lock files, S2, S3, and S-DATE
   may develop in parallel except that S3 has the explicitly narrow ownership of
   the two contract test files. S-DATE alone edits `src/sync/daemon.ts` and
   `tests/sync/daemon.test.ts` until its timestamp-only scope is clean; it then
   releases those files for S1's finalization amendment. No other overlapping
   edits are allowed.
2. Within each scope, use a development agent, a separate full-scope logic/API
   reviewer, correction agents for every finding, and a fresh reviewer after
   every correction round until one returns zero findings. Reviewers assess
   correctness, error paths, cleanup, portability, and maintainability against
   the realistic boundary; they do not reintroduce defenses against arbitrary
   same-user code execution.
3. Run S4 only after those four scopes are clean and S3 has released its two
   contract test files. S4 then owns those test files for broader harness changes.
   Give it the same development/review/fresh-review loop.
4. Run one fresh adversarial-but-proportionate Stage A cross-cutting reviewer
   through runtime startup/store open, session/config JSON, client
   inspect/plan/apply, build/manifest identity, semantic timestamp failure, and
   CLI/MCP contract execution on POSIX, Windows, and WSL.
5. Split non-overlapping cross-cutting findings among development agents, then
   run a fresh complete cross-review. Repeat until it returns zero findings.

Clean and maintainable means:

- no production PowerShell/C# helper protocol, long-lived helper, native FFI,
  process-handle authentication, descriptor-namespace database path, or
  same-user race hook remains in S1/S2;
- normal store open, client inspection, and contract execution do not create
  avoidable subprocesses or persistent coordination artifacts;
- storage, JSON, config formats, atomic publication, Windows ACL, ownership, and
  release identity each have one cohesive module and one authority;
- facade modules preserve the documented production APIs without retaining dead
  compatibility shims;
- comments explain product invariants and platform limitations, not historical
  defensive machinery;
- the package type-checks, targeted suites pass in isolated roots, native Windows
  and Linux evidence covers the available local platform paths, and the available
  Bun standalone compile/smoke checks pass;
- no protected LLM fixture changes without a reviewed contract-ledger entry;
- no live `data/` access, migration, quarantine, cleanup, or deletion occurs
  during development or tests.

Only after this simplification and its clean cross-cutting review does Stage A
close and Stage B begin. Native macOS and the full supported-target matrix remain
explicitly unproven at that point: Stage B may proceed, but release eligibility
remains blocked until D-CI-RELEASE supplies that evidence.

## Post-Stage-A execution baseline

Stage A is CLEAN under its recorded individual, cross-cutting, and final whole
reviews. Later work must consume, not rebuild, its terminal/UI ports, strict
argument preflight, endpoint schemas, session/cache generation fencing, daemon
lease/readiness, secure local artifacts, transactional client configuration,
one-line installer transport, release identity, and protected contract fixtures.

The authoritative read-only audits were performed by
`/root/stage_a_cross_data_args_dev` for Stage B,
`/root/s2_client_writer_zero_review` for Stage C, and
`/root/stage_a_cross_daemon_dev` for Stage D. Planning/status consolidation is
owned by `/root/stage_a_config_batch_dev/stage_a_config_batch_review_13`.
These are prep identities, not development or clean-review outcomes. The
consolidated plan must receive the required two independent plan reviews before
any Stage B development begins.

The read-only gap audits classify the remaining program as follows:

| Stage | Scope | Status after Stage A |
|---|---|---|
| B | B-HTTP | PARTIAL |
| B | B-DAEMON-CONTROL | PARTIAL |
| B | B-SESSION | PARTIAL |
| B | B-STARTUP-PROFILE | MISSING as an integrated capability; reusable primitives exist |
| B | B-STORE | PARTIAL |
| B | B-CORE | PARTIAL |
| C | C-DAEMON-SYNC | PARTIAL |
| C | C-SEARCH | PARTIAL |
| C | C-APP-SCREENS | MISSING as product UX; UI/port foundations exist |
| C | C-CONFIGURER-LIFECYCLE | PARTIAL, with substantial clean work pulled forward |
| C | C-CLI-MCP | PARTIAL |
| C | C-INSTALLER-TRANSPORT | PARTIAL only at the future lifecycle-protocol boundary; transport mechanics are clean |
| D | D-PACKAGE-BUILD | PARTIAL |
| D | D-DEVTOOLS-TEST-GAPS | PARTIAL |
| D | D-CI-RELEASE | PARTIAL, with substantial clean release work pulled forward |
| D | D-DOCS | PARTIAL |
| D | D-VERSION-PROJECTION | MISSING; newly separated atomic projection scope |
| D | D-HYGIENE | PARTIAL |

No PARTIAL label reopens a clean Stage A implementation without a concrete
remaining acceptance gap.

## Stage B: security and data correctness spine

Stage B freezes the identity, process, profile, storage, and structured adapter
APIs consumed by Stage C. Its exact execution sequence is:

```text
branch A: B-HTTP-COOKIES -> B-HTTP-CLIENT -> B-SESSION
branch B: B-DAEMON-CONTROL
join branch A + branch B
  -> B-STARTUP-FOUNDATION
  -> B-STORE
  -> B-CORE
  -> B-STARTUP-INTEGRATION
  -> fresh Stage B adversarial review
```

Every scope has its own development/fresh-review loop before its successors
start. A file is reserved in full to its active owner even when the intended
amendment is narrow.

### B-HTTP-COOKIES

Status: PARTIAL. Preserve the clean exact-origin/loopback and endpoint behavior;
replace the flat single-domain cookie representation.

Exclusive files:

- `src/sana/cookies.ts`
- `src/sana/types.ts`
- authoritative URL/origin cookie ingest, request-header selection,
  serialization, and legacy-import portions of existing `src/sana/client.ts`;
  reserve the whole file while this scope is active
- new `tests/sana/cookies.test.ts`
- corresponding cookie integration portions of existing
  `tests/sana/client.test.ts`; reserve the whole file while this scope is active

Acceptance:

- URL-aware Domain, Path, Secure, expiry, Max-Age, deletion, and creation-order
  semantics;
- legacy flat-cookie import only with validated authoritative origin;
- bounded serialization and selection with no invented origin or successful
  empty state.

After this scope's fresh review is clean, it explicitly releases
`src/sana/client.ts` and `tests/sana/client.test.ts` in full to
B-HTTP-CLIENT. The two scopes never run concurrently or share file ownership.

### B-DAEMON-CONTROL

Status: PARTIAL. Preserve the clean SQLite lease, heartbeat, owner-conditional
stale recovery, spawn readiness, losing-child reap, and cleanup behavior.

Exclusive files:

- `src/sync/lock.ts`
- `src/sync/spawn.ts`
- `src/sync/daemon.ts`
- new `src/sync/control.ts`
- daemon-lifecycle-only amendment in `src/cli.ts`; reserve the entire file while
  this scope is active
- existing `tests/sync/daemon.test.ts`
- new `tests/sync/lock.test.ts`
- new `tests/sync/spawn.test.ts`
- new `tests/sync/control.test.ts`
- new `tests/tools/cli-lifecycle.test.ts`

Acceptance:

- atomic spawn reservation and protocol-versioned instance record;
- PID and a per-start instance ID distinguish the active daemon record;
- typed live/stalled/dead states and owner-checked cleanup;
- instance-specific cooperative stop/wait/restart through the shared local
  control state, with daemon-side acknowledgement before it terminates itself;
- no direct signal is sent from a persisted PID; an unresponsive daemon returns
  typed manual action;
- no PID-only signal and no invented executable, path, start time, or identity;
- frozen start/health/control API for startup, installer lifecycle, and daemon
  sync.

The final Stage A review's PID-reuse question is an explicit input here. Under
the proportional local-process model, cooperative self-stop avoids signaling a
PID-reuse successor without adding hostile same-user process machinery.

### B-HTTP-CLIENT

Status: PARTIAL. Depends on B-HTTP-COOKIES.

Exclusive files:

- `src/sana/client.ts`
- existing `tests/sana/client.test.ts`

This scope begins only after B-HTTP-COOKIES releases both files and consumes the
reviewed cookie schema/call-site contract without reopening cookie semantics.

Acceptance:

- retain exact schema validation, valid-empty versus malformed distinction,
  cursor non-progress detection, HTTPS/exact-loopback policy, and reviewed
  redirect method behavior;
- configurable validated timeout, caller abort propagation, and bounded success
  and error response bodies;
- typed/redacted network, timeout, HTTP, Retry-After, tRPC, protocol, payload,
  redirect, origin, and retry-exhaustion errors;
- explicit trusted-origin/TLS/downgrade policy and credential stripping on any
  allowed cross-origin transition;
- bounded automatic retry only for idempotent reads.

### B-SESSION

Status: PARTIAL. Depends on B-HTTP-CLIENT. It may run while
B-DAEMON-CONTROL finishes only while their reserved files remain disjoint.

Exclusive files:

- new `src/sana/session.ts`
- `src/sana/client.ts`
- `src/sana/auth.ts`
- `src/sana/session-publication.ts`
- `src/core/login.ts`
- new `tests/sana/session.test.ts`
- `tests/sana/client.test.ts`
- `tests/sana/auth.test.ts`
- `tests/sana/auth-request.test.ts`
- `tests/sana/session-publication.test.ts`
- `tests/runtime/secure-session.test.ts`

Acceptance:

- separate versioned active and expiring/challenge-bound pending-login stores;
- canonical origin provenance, immutable user/workspace profile identity, and
  scope hash;
- serialized session revision and cookie CAS including deletions;
- request-code isolation with no prior-workspace or `lastUsedWorkspaceId`
  inheritance;
- atomic switch/sign-out, old-store retarget/closure signal, and late-writer
  rejection;
- legacy session parse and Sana revalidation or typed fresh-login state.

### B-STARTUP-FOUNDATION

Status: MISSING as an integrated capability. Depends on reviewed-clean
B-DAEMON-CONTROL and B-SESSION.

Exclusive files:

- new `src/runtime/startup.ts`
- new `src/runtime/profile-transition.ts`
- new `src/runtime/transition-handoff.ts`
- new `src/install/upgrade.ts`
- new `src/store/profile.ts`
- new `src/store/schema.ts`
- `src/store/db.ts`
- `src/daemon-main.ts`
- new `tests/runtime/startup.test.ts`
- new `tests/runtime/profile-transition.test.ts`
- new `tests/runtime/transition-handoff.test.ts`
- `tests/runtime/home-store.test.ts`
- `tests/fixtures/runtime/home-store-probe.ts`
- new `tests/install/upgrade.test.ts`
- new `tests/store/profile.test.ts`
- new `tests/store/schema.test.ts`
- `tests/runtime/secure-store.test.ts`

Acceptance:

- one serialized, idempotent, typed startup-gate API and a profile-bound DB
  capability, ready for later entrypoint integration;
- current clean schema with `PRAGMA foreign_keys=ON`;
- exact startup/profile journal and bounded quarantine/rollback for session,
  profile identity, DB/WAL/SHM, generated state, and cache only;
- daemon verified stopped through B-DAEMON-CONTROL before DB/WAL/SHM mutation;
- auth preservation only after authoritative parse, migration without invented
  values, and Sana revalidation;
- old cache is quarantined and retained; this scope never deletes it and cannot
  claim reconciliation complete;
- freeze a two-phase transition API and issue one transaction/profile/session
  reconciliation token after quarantine and auth validation; ordinary CLI,
  MCP, configurer, direct-store, and user daemon routes remain
  `transition-required`;
- leave reconciliation-proof validation, token consumption, and ready
  publication to the consecutive integration scope after B-STORE freezes the
  proof schema;
- typed ready, needs-login, transition-required, manual-action, rollback, and
  persistence-unknown outcomes.

### B-STORE

Status: PARTIAL. Depends on B-STARTUP-FOUNDATION.

Exclusive files:

- `src/store/db.ts`
- `src/store/schema.ts`
- `src/sana/transcript.ts`
- new `tests/store/db.test.ts`
- `tests/sana/transcript.test.ts`
- `tests/runtime/secure-store.test.ts`

Acceptance:

- independent durable transcript, meeting-details, participants, and embedding
  state/retry/revision/fingerprint;
- change-classifying meeting upsert, refresh/full-scan/tombstone state, and
  independent partial metadata preservation;
- transactional transcript/FTS replacement and embedding invalidation; corrupt
  indexing is explicit and never swallowed as success;
- strict finite/safe pagination before offset and deterministic
  `created_at_ms, id` ordering;
- generation-aware exact readiness/completion;
- freeze every profile, sync, artifact, phrase-search, and staged vector
  generation port required by Stage C;
- freeze a measured sync-rate/ETA observation port. If authoritative
  observations are unavailable, its only valid result is typed unavailable;
- freeze the complete-listing and transcript/details/participants reconciliation
  proof schema consumed by the startup transition. Stage C must not edit
  `src/store/db.ts`.

### B-CORE

Status: PARTIAL. Depends on B-STORE.

Exclusive files:

- `src/core/args.ts`
- `src/core/status.ts`
- `src/core/meetings.ts`
- new `src/app/adapters.ts`
- ETA/status-rendering-only amendment in `src/tools/dispatch.ts`; reserve the
  entire file while this scope is active
- `tests/core/args.test.ts`
- `tests/core/status-auth.test.ts`
- `tests/core/meetings.test.ts`
- new `tests/app/adapters.test.ts`
- `tests/tools/dispatch-args.test.ts`
- `tests/tools/dispatch-auth.test.ts`
- `tests/tools/cli-output.test.ts`
- `tests/contracts/agent-output.test.ts`
- `tests/contracts/mcp-stdio.test.ts`
- `tests/fixtures/contracts/representative-outputs.json`
- `tests/fixtures/contracts/documented-semantics.json`
- `docs/dev/contract-change-ledger.md`

Acceptance:

- preserve the clean strict absent-only default and explicit-invalid argument
  behavior;
- profile-aware session/status/meeting/auth adapters implement frozen AppPorts;
- remove every invented half-second-per-item helper and dispatch call; ETA is
  derived only from the frozen B-STORE measured-rate port or is explicitly
  unavailable;
- preserve typed corrupt/empty/unavailable/error states;
- honor cancellation and invalidate subscriptions/results on account transition;
- record and review every necessary protected-output byte change in the contract
  ledger, with direct CLI/MCP fixture parity preserved.

### B-STARTUP-INTEGRATION

Status: MISSING. Runs last after reviewed-clean B-STORE and B-CORE and only after
every prior owner releases the shared files.

Exclusive files:

- handoff ownership of `src/runtime/startup.ts`,
  `src/runtime/profile-transition.ts`, and their exact tests from
  B-STARTUP-FOUNDATION;
- handoff ownership of `tests/runtime/home-store.test.ts` and
  `tests/fixtures/runtime/home-store-probe.ts` from B-STARTUP-FOUNDATION;
- `src/cli.ts`
- `src/mcp.ts`
- `src/tools/dispatch.ts`
- `src/install/install.ts`
- `src/sana/auth.ts`
- `src/sync/spawn.ts`
- `src/sync/daemon.ts`
- `src/daemon-main.ts`
- `install.sh`
- `install.ps1`
- `tests/install/installers.test.ts`
- `tests/tools/cli-configurer-exit.test.ts`
- `tests/tools/dispatch-args.test.ts`
- `tests/tools/dispatch-auth.test.ts`
- `tests/sync/daemon.test.ts`
- new `tests/runtime/startup-entrypoints.test.ts`
- new `tests/fixtures/startup/entrypoint-probe.ts`
- new `tests/fixtures/startup/pre-gate-mutation-guard.ts`

The startup entrypoint matrix must explicitly exercise CLI, MCP, source/direct
dispatch, daemon, direct store-open, configurer, and installer modes through the
two named fixtures.

Acceptance:

- every production entrypoint crosses the same gate before session/profile/store
  mutation; the matrix proves both gate invocation and zero pre-gate mutation;
- shell installers remain thin consumers of the three transaction authorities
  defined below;
- final frozen B store/core/profile/control APIs are used without compatibility
  shims;
- production remains `transition-required` and retains quarantine until a
  valid reconciliation proof is supplied; no B production path invents or
  self-certifies that proof;
- implement the B-STORE reconciliation-proof validator only after consuming its
  frozen schema, then re-enter the serialized gate, match and consume the exact
  transaction/profile/session token once, and publish ready state;
- the startup entrypoint matrix proves only the reconciliation route can submit
  proof while every ordinary route remains blocked;
- failure rolls back exact owned state and restores the old daemon/runtime when
  safe;
- existing one-line UX, config transaction, lifecycle protocol v1, and protected
  LLM bytes remain exact.

### Stage B migration, data, contract, and review gates

Three distinct transaction authorities remain explicit:

1. The shell distribution transaction owns executable replacement, managed PATH,
   receipt, prior-runtime inventory, and old-runtime restart. It never edits auth,
   cache, or client configuration directly.
2. The client-config transaction in `src/install/config-transaction.ts` owns only
   proven sana-mcp client registrations and their rollback journal.
3. The startup/profile transition in `src/runtime/profile-transition.ts` owns
   auth validation, profile publication, DB/cache quarantine, and the resync
   gate. Its distinct name must not be shortened to the ambiguous “installer
   transaction.”

`src/runtime/transition-handoff.ts` freezes a versioned handoff containing one
transaction ID, authority-specific journal references, prepared/
committed/rolled-back states, and exact commit order. Distribution prepares the
new runtime, client configuration records its owned result, and startup/profile
publishes or rolls back its profile state before distribution can commit and
discard rollback material. A failure in one authority never grants another
authority permission to claim or mutate its state.

B-STORE defines the authoritative complete-listing and per-artifact
reconciliation proof port; B-STARTUP-INTEGRATION then owns its validator and
single-use finalization path. No B production provider may self-certify it.
C-DAEMON-SYNC implements the production reconciler. Until that exact proof is
returned, startup remains `transition-required`, keeps the quarantine and
prior-runtime recovery inventory, and does not describe auth/cache transition as
complete. C-INSTALLER-TRANSPORT-CLOSURE must verify the complete three-authority
handoff and commit/rollback path.

Pre-1.0 transition is controlled old-runtime uninstall plus clean new-runtime
install, not an old-cache compatibility layer. Keep the prior runtime, journal,
and quarantine until complete health/profile/artifact reconciliation. Never
purge an unproven artifact or call copied auth preserved before Sana
revalidation. Every test uses isolated temporary HOME/data/config/PATH/session/
profile roots, fake network, injected clocks/process probes, and synthetic
DB/WAL/SHM; no development command touches live `data/`.

Protected MCP tool names, aliases, argument meanings, Markdown free text,
optional YAML frontmatter, and CLI/MCP byte parity remain frozen. Machine
lifecycle protocol v1 is also frozen throughout Stages B and C; no scope may
improvise an extension or partial bump.

If a protocol change becomes unavoidable, development stops for a reviewed plan
amendment that assigns one consecutive scope exact ownership of:

- `src/release/contract.ts`
- `src/runtime/build-info.ts`
- `tests/runtime/build-info.test.ts`
- `tests/runtime/home-store.test.ts`
- `src/install/manifest.ts`
- `release/manifest.schema.json`
- `tests/fixtures/manifest/valid-all-targets.json`
- `tests/fixtures/manifest/invalid-unknown-field.json`
- `src/cli.ts`
- future `src/sync/control.ts`
- `src/sync/daemon.ts`
- `install.sh`
- `install.ps1`
- `tests/install/manifest.test.ts`
- `tests/install/installers.test.ts`
- `tests/tools/cli-configurer-exit.test.ts`
- future `tests/sync/control.test.ts`
- future `tests/tools/cli-lifecycle.test.ts`
- `tests/sync/daemon.test.ts`
- `scripts/release.ts`
- `tests/release/release.test.ts`
- `.github/workflows/release.yml`
- `docs/dev/contract-change-ledger.md`

That amendment must version and review the canonical constant, inspect output,
manifest parser/schema/fixtures, CLI adapter, both installers, release assembler/
tests/workflow, daemon control, startup/home-store consumers, and documentation
atomically before any code edit. At amendment time a fresh exhaustive repository
search must inventory every current and planned protocol producer, parser,
fixture, test, installer, manifest, release, workflow, and documentation
consumer. Any consumer missing from this planning inventory must be added to the
reviewed amendment before edits; the list above is a minimum, not authority for
an ad hoc partial bump.

After every scope is individually clean, a fresh adversarial reviewer traces
redirect/cookie boundaries, valid empty versus malformed payloads, pending login
with another active account, late writes/account switch, every startup entrypoint,
interrupted quarantine/rollback, permissions/disk-full/read-only failures, and
account-A/account-B isolation. Corrections repeat through fresh reviewers until
zero findings.

## Stage C: runtime behavior and complete human UX

Stage C starts only after B-DAEMON-CONTROL, B-SESSION,
B-STARTUP-INTEGRATION, B-STORE, and B-CORE are individually and
cross-cutting reviewed clean and their public APIs are frozen.

Pulled-forward clean work includes the terminal renderer/AppPorts, strict search
preflight, keyword whole-word behavior, semantic degradation, daemon lease and
generation fences, structured configurer/config transaction, CLI/MCP framing,
and release installer transport. These are foundations, not evidence that the
missing screens, profile lifecycle, exact hybrid search, or sync lifecycle are
complete.

The sequence is:

```text
frozen Stage B
  -> parallel:
       C-DAEMON-SYNC
       C-SEARCH
       C-APP-STATUS-LOGIN
       C-APP-LIST-SEARCH-ACTIONS
       C-APP-DETAILS-PLATFORM
  -> C-SEARCH-CONTRACT
  -> C-CONFIGURER-LIFECYCLE
  -> C-CLI-MCP
  -> C-INSTALLER-TRANSPORT-CLOSURE
  -> fresh Stage C adversarial review
```

### Parallel C wave

#### C-DAEMON-SYNC

Status: PARTIAL.

Exclusive files:

- `src/sync/daemon.ts`
- `src/daemon-main.ts`, only after B explicitly releases it
- `tests/sync/daemon.test.ts`
- new `tests/sync/daemon-sync.test.ts`

It must consume, not edit, B control, client, profile, and store internals.

Acceptance:

- independent heartbeat during slow network/model work;
- AbortSignal propagation through in-flight work and bounded resource cleanup;
- secure bounded rotating logs;
- recent-horizon incremental refresh plus periodic complete cursor-valid scans;
- refresh processing/revised meetings, not only missing artifacts or new IDs;
- independent transcript/details/participants state and Retry-After-aware bounded
  backoff;
- truthful capped-work/incomplete state and embedding-independent canonical/
  keyword catch-up;
- tombstone/deletion only after absence from two complete authoritative scans;
  partial/error scans never prove absence;
- implement the frozen B reconciliation port using a complete remote listing and
  exact transcript/details/participants artifact proof; never attest a partial,
  capped, cancelled, or failed scan;
- run reconciliation only with the single-use B capability bound to the exact
  transition/profile/session tuple, submit the proof through the gate finalize
  call, and never expose that capability to ordinary daemon/user routes;
- validate exact profile/session/cache/generation authority after every await and
  before every persistent write;
- remove the duplicate unreachable throw without widening the scope.

#### C-SEARCH

Status: PARTIAL.

Exclusive files:

- `src/core/search.ts`
- `src/semantic/semantic.ts`
- `tests/runtime/semantic-capability.test.ts`
- new `tests/core/search.test.ts`
- new `tests/semantic/semantic.test.ts`

It must use frozen B-STORE staging/query APIs and must not edit `src/store/db.ts`.

Acceptance:

- deterministic plain whole-word AND and quoted-phrase grammar;
- globally correct total/page/sort over the full keyword/hybrid universe;
- typed truthful incomplete state if resource bounds prevent exactness;
- semantic fingerprint includes exact model revision/artifact, dimension,
  quantization, normalization, and transcript revision/generation;
- staged vector generation with atomic validated active-generation publication;
  queries never observe a partial rebuild;
- no alternate model, dimension, cursor, count, or successful-result fallback;
- semantic unavailability preserves exact keyword semantics and adds observable
  typed degradation;
- profile/cache/generation authority is rechecked after asynchronous boundaries.

Phrase support is additive through the existing search arguments. Existing
unquoted meanings and protected output remain frozen. C-SEARCH implements and
reviews the parser/search capability behind an internal structured option; it
closes without enabling or claiming new public argument semantics. The
following C-SEARCH-CONTRACT scope owns public activation and protected contract
approval. A mismatch returns to C-SEARCH for correction.

#### C-APP-STATUS-LOGIN

Status: MISSING as product UX; Stage A AppPorts/UI are complete.

Exclusive files:

- new `src/app/screens/status.ts`
- new `src/app/screens/login.ts`
- new `tests/app/screens/status.test.ts`
- new `tests/app/screens/login.test.ts`

Acceptance: use only frozen AppPorts/UI; represent loading, unavailable, corrupt,
and auth states truthfully; cancel and discard stale results on profile
transition; never access stores, clients, or LLM prose directly.

#### C-APP-LIST-SEARCH-ACTIONS

Status: MISSING.

Exclusive files:

- new `src/app/screens/list.ts`
- new `src/app/screens/search.ts`
- new `src/app/screens/actions.ts`
- new `src/app/prompts/meeting-list.ts`
- new `tests/app/screens/list.test.ts`
- new `tests/app/screens/search.test.ts`
- new `tests/app/screens/actions.test.ts`
- new `tests/app/prompts/meeting-list.test.ts`

Acceptance: persistent deterministic navigation and selection, exact
phrase/paging state, typed empty/error/degraded results, cancellation/profile
invalidation, and AppPorts/UI-only access.

#### C-APP-DETAILS-PLATFORM

Status: MISSING.

Exclusive files:

- new `src/app/screens/read.ts`
- new `src/app/screens/summary.ts`
- new `src/app/screens/participants.ts`
- new `src/app/screens/recording.ts`
- new `src/app/prompts/transcript-pager.ts`
- new `src/app/platform.ts`
- new `tests/app/screens/read.test.ts`
- new `tests/app/screens/summary.test.ts`
- new `tests/app/screens/participants.test.ts`
- new `tests/app/screens/recording.test.ts`
- new `tests/app/prompts/transcript-pager.test.ts`
- new `tests/app/platform.test.ts`

Acceptance:

- fixed-height transcript paging/find/go-to/reload;
- typed missing/corrupt/unavailable states and sanitized rendering;
- signed recording URLs are HTTPS-validated and never logged or persisted;
- injected argument-array browser opening and platform-aware clipboard behavior
  report unsupported/open/copy failure across Windows, WSL, macOS, and Linux;
- cancellation/profile transition fences every result and platform effect.

The three app scopes must not edit `ports.ts`, `ui.ts`, `render.ts`,
`adapters.ts`, core, or store files. If they genuinely require a shared screen
model, create and review one small single-owner model scope before launching
them rather than overlap files.

#### C-SEARCH-CONTRACT

Status: MISSING. Runs after the parallel C implementations are individually
clean and before C-CONFIGURER-LIFECYCLE. It does not block C-SEARCH's internal
implementation review.

Exclusive files:

- `src/tools/dispatch.ts`, search activation/presentation only; reserve the
  complete file during this scope
- `src/tools/help.ts`
- `tests/tools/dispatch-args.test.ts`
- `tests/contracts/agent-output.test.ts`
- `tests/contracts/mcp-stdio.test.ts`
- `tests/fixtures/contracts/documented-semantics.json`
- `tests/fixtures/contracts/representative-outputs.json`
- `tests/fixtures/contracts/tool-docs.json`
- `docs/dev/contract-change-ledger.md`

Acceptance:

- deliberately approve or reject the quoted-phrase argument meaning and every
  protected help/output byte;
- enable the already-reviewed structured C-SEARCH capability only after
  direct CLI/MCP fixture parity is clean;
- preserve all unquoted meanings and return implementation mismatches to
  C-SEARCH rather than patching core search under this ownership;
- release every shared file to C-CLI-MCP after a fresh clean review.

### Sequential C integration

#### C-CONFIGURER-LIFECYCLE

Status: PARTIAL with substantial Stage A work preserved. Depends on the complete
parallel C wave.

Exclusive files:

- new `src/install/app-prompt.ts`
- `src/install/presentation.ts`
- new `src/install/lifecycle.ts`
- `src/install/install.ts`
- delete `src/install/wizard-prompt.ts`
- new `tests/install/app-prompt.test.ts`
- new `tests/install/lifecycle.test.ts`
- new `tests/install/install-flow.test.ts`
- `tests/install/configurer-flow.test.ts`
- `tests/install/install.test.ts`
- `tests/install/presentation.test.ts`
- delete `tests/install/wizard-prompt.test.ts`

Acceptance:

- preserve current structured config transaction, dry-run/planned,
  cancellation, ownership, and exit contracts;
- one coherent welcome/select/apply/login/success region plus settled unattended
  and non-TTY behavior;
- profile-aware auth without claiming copied auth preserved before revalidation;
- proven-owned disconnect and full uninstall, with runtime/registration removal
  separate from explicit confirmed purge;
- no implicit live-data deletion and `--yes` alone never purges;
- verified Windows deferred self-removal when required;
- purpose-written human strings over structured results, never `sana()` or LLM
  coaching prose.

#### C-CLI-MCP

Status: PARTIAL. Depends on every parallel scope and
C-CONFIGURER-LIFECYCLE.

Exclusive files:

- new `src/app/app.ts`
- new `src/app/hint.ts`
- `src/cli.ts`
- `src/mcp.ts`
- `src/tools/dispatch.ts`
- `src/tools/help.ts`
- `tests/tools/cli-output.test.ts`
- `tests/tools/cli-configurer-exit.test.ts`
- `tests/tools/dispatch-args.test.ts`
- `tests/tools/dispatch-auth.test.ts`
- new `tests/cli/app-routing.test.ts`
- new `tests/cli/command-grammar.test.ts`
- new `tests/cli/profile-routing.test.ts`
- `tests/contracts/agent-output.test.ts`
- `tests/contracts/mcp-stdio.test.ts`
- the entire reserved `tests/fixtures/contracts/` subtree, whose planning
  inventory is `agent-output-shapes.json`, `auth-cache-probe.ts`,
  `auth-client.ts`, `auth-model.ts`, `auth-publication-probe.ts`,
  `auth-session.ts`, `auth-spawn.ts`, `auth-store.ts`,
  `auth-transitions.json`, `block-network.ts`, `build-entrypoint.ts`,
  `dispatch-call.ts`, `documented-semantics.json`, `guard-probe.ts`,
  `help-list.txt`, `help-logged-out.txt`, `help.txt`, `mcp-tool.json`,
  `representative-outputs.json`, `seed-store.ts`, `semantic-client.ts`,
  `semantic-degradation.json`, `semantic-runtime-failure.ts`,
  `semantic-spawn.ts`, `semantic-store.ts`, `set-sync-progress.ts`, and
  `tool-docs.json`
- `docs/dev/contract-change-ledger.md`

No other active scope may touch that reserved fixture subtree. A new fixture
requires a reviewed plan amendment before edits.

Acceptance:

- bare interactive invocation opens the app; bare non-TTY prints the short hint;
- explicit config/configure, disconnect, uninstall, and purge grammar;
- every profile-bound route crosses the frozen startup gate;
- profile-aware dispatch preserves complete pure preflight before I/O;
- help and unknown-tool routes are static/store-free before client/store
  construction;
- preserve MCP stdout purity, one-shot parity, drain-safe exit, sanitizer,
  explicit exit mapping, and hidden installer/control protocols;
- any additive truthful profile/degradation notice receives contract-ledger
  approval before protected fixture changes.

#### C-INSTALLER-TRANSPORT-CLOSURE

Status: PARTIAL only for final B/C protocol conformance. Depends on C-CLI-MCP.

Exclusive files:

- `install.sh`
- `install.ps1`
- `tests/install/installers.test.ts`

Start with a conformance/evidence pass. A production no-op is correct if the
frozen lifecycle protocol v1 remains compatible. A discovered incompatibility
stops work for the plan amendment defined in Stage B; this scope cannot make a
partial protocol change. Preserve all clean Stage A transport invariants:
exact tag/manifest/binary/checksum identity, HTTPS and size bounds, ownership/
path/link checks, unique local temps, smoke before replacement, serialized
lock/journal/rollback, old-runtime retention/restart, PATH receipts, checked
failures, and truthful noninteractive deferral. Use B's verified instance/
manual-action protocol and profile coordinator; never fall back to a bare PID or
invented path/version/auth value. Verify the versioned transaction ID, three
authority-specific journals, commit order, rollback, transition-required state,
and later reconciliation-proof completion end to end. Native release proof
remains Stage D.

### Stage C review

Review every scope to zero findings, then assign a fresh adversarial reviewer to
trace install/upgrade through startup/profile, daemon sync/search, human app,
CLI/MCP, profile switch/logout, disconnect/uninstall/purge, cancellation,
rollback, WSL/platform effects, and protected LLM output. Corrections and fresh
reviews repeat until clean.

## Stage D: build, test gaps, release, docs, and hygiene

Stage D begins after Stages B and C are frozen. Its repository sequence is:

```text
D-DEVTOOLS-CLEANUP
  -> D-PACKAGE-BUILD
  -> D-CI-RELEASE
  -> D-DOCS-FINAL
  -> D-VERSION-PROJECTION
  -> D-HYGIENE-GATE
  -> fresh Stage D adversarial review
```

Do not rebuild pulled-forward clean work: the canonical seven-target release/
manifest/build identity, strict schema and checksum/name coupling, exact
tag/commit/draft safeguards, native workflow job shapes, installer tests,
contract isolation guards, development-document status/index, or README's
source-versus-standalone semantic distinction. Stage A's code review proves
those implementations; it does not supply native publication evidence.

### D-DEVTOOLS-CLEANUP

Status: PARTIAL. Run first.

Exclusive files:

- `scripts/bootstrap-session.mjs`
- `scripts/investigate.mjs`
- `scripts/paginate.mjs`
- `scripts/record.mjs`
- `scripts/validate.mjs`
- the entire reserved `scratchpad-test/` subtree, whose planning inventory is
  `cancel.ts`, `feed.sh`, `keylog.ts`, `pty_resize.py`, `pty_run.py`,
  `resize.ts`, `tall.ts`, and `wrap.ts`
- new `tests/devtools/isolation.test.ts`

Prefer removing obsolete research probes and scratchpads over maintaining
credential-bearing browser capture machinery. Do not edit `scripts/release.ts`.
No other active scope may touch the reserved subtree. Adding a file to it or any
scope list requires a reviewed plan amendment before edits.

Acceptance:

- no hardcoded workspace/account IDs;
- no guessed cursor/offset/data fallback or masked empty success;
- no tool reads or writes repository/live `data/`;
- no silent auth URL/body/HAR/trace/download capture;
- useful retained probes have declared requirements, typed failures, isolated
  roots, and blocked external network;
- package-level tests gain an enforceable isolation boundary without breaking
  intentional loopback tests.

### D-PACKAGE-BUILD

Status: PARTIAL. Depends on D-DEVTOOLS-CLEANUP.

Exclusive files:

- `package.json`
- `bun.lock`
- verify `package-lock.json` remains absent and prevent its regeneration
- `.gitignore`
- new `scripts/clean.mjs`
- new `tests/build/clean-build.test.ts`
- new `tests/build/package-contract.test.ts`
- new `tests/build/standalone-build.test.ts`

Acceptance:

- private Bun-only metadata, no Node `bin`, explicit package manager/version;
- remove unused `adm-zip`, `@types/adm-zip`, `tsx`, and, after obsolete probes
  are removed, `playwright`; regenerate a coherent frozen lock;
- `clean`, clean `build`, `test`, `check`, and explicit standalone-build
  commands;
- a seeded stale `dist/` sentinel and obsolete source maps cannot survive build;
- explicit tested source-map policy;
- `npm pack` refuses safely or uses a strict tested allowlist excluding runtime
  data, builds, scratch/captures, internal ledgers, and unsafe tools;
- package/build inventory tests and deterministic repeat build;
- package version remains unchanged here; D-VERSION-PROJECTION owns the atomic
  bump after CI and documentation implementations stabilize.

### D-CI-RELEASE

Status: PARTIAL, with substantial clean work pulled forward. Depends on stable
D-PACKAGE-BUILD commands.

Exclusive files:

- new `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `scripts/release.ts`
- `release/manifest.schema.json`
- `release/semver-corpus.json`
- `tests/release/release.test.ts`
- `tests/runtime/build-info.test.ts`
- `tests/install/manifest.test.ts`
- `tests/fixtures/manifest/valid-all-targets.json`
- `tests/fixtures/manifest/invalid-unknown-field.json`

Acceptance:

- frozen install, package/version/lock checks, typecheck, full isolated tests,
  POSIX/PowerShell parsing, clean build, package inventory/refusal, and host
  standalone inspect/help smoke;
- generate or exhaustively verify workflow targets and exact expected asset
  inventory from the canonical release contract; remove hardcoded inventory
  counts;
- full-SHA-pinned actions and least privilege remain;
- define jobs that execute assets in their declared native or faithful
  environments, including native macOS x64/arm64 and Windows x64;
- manifest, checksums, properties, embedded inspect identity, tag, and commit
  remain one exact tuple;
- define and locally validate the native/faithful execution jobs for every
  canonical target, without claiming that a native run occurred during this
  implementation scope;
- encode automatic publication for a package-version bump on `main`, matching
  `v*` tag pushes, and explicit manual retries, with exact remote-asset
  revalidation and local workflow/contract tests proving each path;
- resolve the package-matching tag and exact triggering SHA before any build;
  an existing package tag makes an unchanged `main` push a no-op, while a
  missing tag is created at the reviewed SHA only after every build succeeds;
- every native/build/publish job checks out the expected full SHA; publication
  creates or verifies the exact tag at that SHA before any release mutation and
  rechecks it before the final state transition;
- after changing the release from draft to published, the same workflow run
  re-fetches it, requires `draft=false`, and byte-verifies the complete remote
  asset tuple again before reporting success.

Actual automatic authorization, seven-target native execution, publication,
and remote revalidation are final-candidate evidence. They occur from the
version-bumped candidate on `main` or its exact matching tag after
D-DOCS-FINAL and D-VERSION-PROJECTION have finished.

### D-DOCS-FINAL

Status: PARTIAL. Run after B/C lifecycle and D package/release contracts are
stable.

Exclusive files:

- `README.md`
- `docs/dev/README.md`
- `docs/dev/analysis-app-shell.md`
- `docs/dev/binary-packaging.md`
- `docs/dev/bun-port.md`
- `docs/dev/cli-app-architecture.md`
- `docs/dev/cli-feature-screens.md`
- `docs/dev/cli-presentation-layer.md`
- `docs/dev/cli-specs.md`
- `docs/dev/codebase-notes.md`
- `docs/dev/configurer-transaction-handoff.md`
- `docs/dev/go-embeddings.md`
- `docs/dev/go-port.md`
- `docs/dev/installer-flow-polish.md`
- `docs/dev/rust-embeddings.md`
- `docs/dev/rust-port.md`
- `docs/dev/tui-library-research.md`
- `docs/dev/tui-rendering.md`

The root ledger registrar retains `docs/dev/review-ledger.md`,
`docs/dev/remediation-plan.md`, and `docs/dev/contract-change-ledger.md` unless
an explicit sequential handoff says otherwise.

Acceptance:

- every command and claim executes against current code;
- final account/profile/reset/auth/lifecycle/uninstall/purge grammar;
- exact WSL boundary: WSL-local clients use the Linux installer; Windows GUI
  clients require the Windows installer;
- explicit semantic/model download/network/cache and standalone behavior;
- checksum evidence that is missing, malformed, filename-mismatched, or
  digest-mismatched aborts before replacement;
- document implemented `SANA_TRANSCRIPTS_DIR`, `SANA_COUNT_WAIT_MS`,
  `SANA_MAX_NEW_TRANSCRIPTS`, and `SANA_EMBED_MIN_WORDS`;
- balanced Markdown fences, no generated conversation tags, and truthful
  historical/research status;
- version examples derive from or are checked against package/release identity.

### D-VERSION-PROJECTION

Status: IMPLEMENTED. The projection is enforced by
`tests/release/version-projection.test.ts` and is included in the release
validation gate.

Exclusive files:

- `package.json`
- `bun.lock`
- `install.sh`
- `install.ps1`
- `README.md`
- `.github/workflows/release.yml`
- `src/release/contract.ts`
- `src/runtime/build-info.ts`
- `src/install/manifest.ts`
- `release/manifest.schema.json`
- `scripts/release.ts`
- `tests/install/manifest.test.ts`
- `tests/install/installers.test.ts`
- `tests/runtime/build-info.test.ts`
- `tests/release/release.test.ts`
- `tests/fixtures/manifest/valid-all-targets.json`
- `tests/fixtures/manifest/invalid-unknown-field.json`
- new `tests/release/version-projection.test.ts`

Acceptance:

- bump the canonical package/release version to `0.4.0` in one reviewed scope
  after every prior owner releases these files;
- exhaustively inventory and update actual package, installer, README, workflow,
  manifest, build-inspect, release-assembler, fixture, and test projections;
- classify intentional `0.3.2`/`0.3.3` upgrade scenarios in installer tests as
  historical test data rather than blindly rewriting them;
- preserve historical examples in `docs/dev/cli-specs.md`,
  `docs/dev/installer-flow-polish.md`, and `docs/dev/tui-rendering.md` unless
  D-DOCS-FINAL has explicitly reclassified one as current authority;
- return the complete repository to green with exact package/tag/manifest/
  inspect/checksum agreement before hygiene begins.

The listed files are sequentially re-owned only for this projection. Any newly
discovered projection requires a reviewed plan amendment before it is edited.

### D-HYGIENE-GATE

Status: PARTIAL verification gate after all development/docs. It owns no
production files. Route remaining ignore findings to D-PACKAGE-BUILD and
devtool findings to D-DEVTOOLS-CLEANUP.

Acceptance:

- high-confidence secret scans cover tracked files, final worktree, fixtures,
  history, and all refs without printing secret material;
- runtime data, browser profiles, HAR/trace/inspect output, models, logs, release
  assets, standalone binaries, stale builds, scratch, and `.env.*` are absent
  from `git ls-files` and ignored where appropriate;
- the intended candidate inventory is explicit and local frozen install,
  `bun run check`, seeded-clean deterministic build, package refusal/allowlist,
  and host standalone compile/inspect/help smoke leave no unowned artifact;
- live `data/` remains untouched;
- PAT and native release-run evidence is reported truthfully.

This local gate establishes candidate readiness, not clean-clone or native
evidence. A `git archive HEAD` or modified worktree never substitutes for the
post-review evidence seal below.

### External blockers

These block final release/completion claims, not autonomous local development:

- GitHub PAT revocation/rotation remains externally unconfirmed;
- native macOS x64/arm64 and the complete approved seven-target workflow require
  GitHub-hosted/native execution.

### Stage D review

After every scope is individually clean, a fresh adversarial reviewer traces
candidate-ready inventory -> frozen install/check commands -> clean build ->
release matrix/manifest/checksum/attestation logic -> exact-SHA authorization -> installer
selection -> docs/hygiene. Corrections and fresh reviews repeat until zero
findings. Actual clean-clone/native publication evidence follows the final local
reviews under the evidence seal.

## Final repository-wide review

After all stages are clean, assign one fresh adversarial reviewer to trace:

```text
clean source
  -> one-line new install / manual binary start / source start / MCP start
  -> startup gate and pre-1.0 transition
  -> auth/profile isolation
  -> daemon sync/refresh/retry
  -> keyword/phrase/source-semantic search
  -> MCP and one-shot output contracts
  -> human app/configurer
  -> update/rollback/disconnect/uninstall/purge
  -> build/manifest/release/docs
```

Send every finding to scoped development, then use a fresh whole-repository
reviewer. Repeat until zero findings.

## Repository-wide no-masked-error audit

Before completion, review every `catch`, `??`, `||`, default switch, coercion,
empty-array/null construction, and environment read.

Specifically eliminate:

- invalid arguments silently becoming defaults;
- corrupt transcript/metadata/participant data becoming empty success;
- invented topic/title/time/count/ETA/model/dimension/workspace/version/target;
- error-as-absent client detection;
- API missing data coerced to empty;
- standalone runtime heuristics;
- hardcoded developer workspace IDs and guessed pagination.

Intentional documented primary defaults apply only when input is absent. Explicit
invalid or unavailable values produce typed errors/unavailable states or stop
safely before mutation.

## Evidence seal

Evidence is sealed only after every substantive local code/documentation scope,
stage-cross-cutting review, final repository review, and no-masked-error review
is clean:

```text
all substantive local reviews clean
  -> registrar records exact local review outcomes
  -> create candidate commit
  -> fresh non-mutating candidate-content audit of that exact SHA
  -> fresh clone of that exact SHA
  -> frozen install/check/clean-build/package/standalone evidence
  -> merge the version-bumped candidate to main or push its exact matching tag
  -> workflow resolves or creates the release tag at that exact candidate SHA
  -> CI plus native seven-target build/smoke/attestation on that exact tag/SHA
  -> publish and remotely revalidate the immutable asset tuple
  -> retain immutable external run/publication/attestation evidence
```

The candidate-content audit is the bounded terminal review of the registrar
change and exact committed tree. Its result is retained as immutable external
evidence keyed to the candidate SHA; it does not mutate the repository and
therefore does not create another registrar/review cycle. If it finds anything,
the candidate is discarded, the normal correction/review/registrar loop runs,
and a new candidate is cut. No repository mutation follows a clean terminal
candidate audit.

The clean-clone gate must run `bun install --frozen-lockfile`, `bun run check`,
a seeded-stale and deterministic-repeat build, package refusal/allowlist checks,
and host standalone compile/inspect/help smoke, ending with a clean checkout.
Native evidence records the exact workflow run, tag, full candidate SHA,
publication result, and attestations for all seven targets.

Any source, build, installer, workflow, manifest, test, or authoritative
documentation change after the candidate is cut invalidates that candidate.
Cut a new candidate and, under the version/tag policy, a new exact tag/version,
then repeat the clone, automatic authorization, CI/native, publication, and remote
checks. External run URLs and attestations cannot be embedded in the commit
they attest and are therefore retained as immutable external completion
evidence. An optional later ledger-only evidence reference commit must identify
itself as post-candidate, must not be called the release tag commit, and cannot
substitute for evidence on the tagged candidate. The release tag and attested
candidate are always the same SHA.

## Completion gate

Completion requires:

- zero unresolved individual-scope findings;
- zero unresolved stage cross-cutting findings;
- a fresh zero-finding final repository review;
- complete review ledger;
- typecheck/tests/parsers/linters/builds/supported smokes passing;
- intentional worktree inventory;
- no secret/runtime/generated artifact included;
- PAT revocation and exact native evidence confirmed for final release, or each
  unconfirmed item explicitly
  reported as an external blocker to local-only completion;
- zero unauthorized LLM contract diff;
- zero known audit, plan-review, code-review, or no-fallback finding.

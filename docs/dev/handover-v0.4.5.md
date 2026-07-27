# v0.4.5 Windows installer handover

Last updated: 2026-07-26 (Europe/Berlin)

## Objective

Ship a verified Windows installer fix for the v0.4.4 compatible-reinstall
failure:

```text
Cannot create a file when that file already exists.
sana-mcp rollback was incomplete
```

The release is not complete until the direct PowerShell installer succeeds over
an existing receipt-backed installation while `sana-mcp.exe mcp` is active,
then launches the public configurer without opening separate test windows.

## Proven root cause

- The retained user failure state still contained the intact v0.4.3 binary and
  receipt.
- PID 14136 was running the exact installed
  `C:\Users\dana\AppData\Local\sana-mcp\sana-mcp.exe mcp`.
- The installer stopped only the daemon. The active MCP stdio process kept the
  executable mapped on Windows.
- `Move-Item -Force` then failed while publishing over the existing executable.
- Rollback incorrectly tried to overwrite the unchanged, still-locked old
  executable, producing the second error.
- The old lifecycle protocol could also report stopped after clearing its
  database lease but before the daemon OS process had exited.

## Implemented v0.4.5 scope

The v0.4.5 scope changes:

- `install.ps1`
  - verifies installer ownership, receipt, digest, target, and embedded identity
    before process control;
  - cooperatively stops the daemon, then terminates only processes whose
    canonical executable path, PID, and creation time revalidate against the
    proven installed runtime;
  - waits for three stable clear observations before publication;
  - replaces `Move-Item -Force` overwrite assumptions with same-directory
    retire/publish operations and digest verification;
  - reconciles binary and receipt rollback independently;
  - treats an already-restored old digest as a no-op;
  - refuses to overwrite unexpected bytes;
  - applies the same logic to interrupted incompatible recovery;
  - preserves unresolved retired authoritative files and reports their paths.
- `src/cli.ts`
  - `__lifecycle stop` waits for each captured daemon PID to exit and repeats
    for successor daemon identities until the stopped state remains stable.
- `tests/install/installers.test.ts`
  - native Windows fixture processes use hidden windows and bounded cleanup;
  - helper-level process retirement/publication/rollback coverage is present;
  - a full isolated `install.ps1` reinstall regression is the Windows release
    gate.
- `.github/workflows/release.yml`
  - the Windows release build must run the full isolated reinstall regression.
- Version and documentation projections are set to `0.4.5`.

## Review state

First independent code review found three issues, all corrected:

1. successor daemon identity could make lifecycle stop fail;
2. interrupted-recovery commit did not validate the full receipt tuple;
3. unresolved rollback cleanup could delete a retired authoritative copy.

A fresh review found no additional production-logic issue, but rejected the
helper-only Windows regression as insufficiently end to end. It also identified
visible fixture windows; those launches now use `-WindowStyle Hidden`.

## Validation already completed

- Native hidden Windows helper regression passed.
- Installer tests passed before the final end-to-end gate addition.
- Full Bun suite passed before the correction round.
- Typecheck passed after the correction round.
- PowerShell AST parsing, `sh -n install.sh`, and `git diff --check` passed
  during development.

Do not rerun broad suites repeatedly. Run the final end-to-end Windows test once,
then one final typecheck/AST/diff check.

## Latest validation

The hidden full native Windows regression passed once:

```text
1 pass
40 filtered out
0 fail
```

It used the checksum-verified official `v0.4.4` Windows runtime and receipt,
held a real `mcp` process open, installed the native Windows `v0.4.5` build,
configured one isolated client through the public configurer, preserved a
same-name process at another path, and left no installer artifacts.

After that run, recovery authority was strengthened to journal and require the
exact replacement-receipt digest before committed incompatible recovery can
delete its journal. Recovery also journals exact previous/published User PATH
state and `pathManaged`; rollback restores only the exact installer-authored
mutation, while commit requires the current PATH and receipt ownership to match
the journal. After a hard interruption, recovery also removes only exact
installer-pattern retired siblings whose digests match the journaled previous
or replacement artifacts. The recovery journal is deleted last, only after
those retired siblings are absent; deferred cleanup retains and reports the
journal for the next run. Typecheck, PowerShell AST parsing, shell syntax, and
diff validation passed after those final production corrections. Retired-file
cleanup also revalidates the exact leaf, reparse state, and authorized digest
immediately before deletion, both in interrupted recovery and normal
post-commit/finally cleanup. Rollback uses the same standard retired naming and
revalidation, so a failed cleanup remains discoverable by recovery.

The first GitHub release run built every platform but correctly stopped before
publication when the Windows release gate supplied `$env:TEMP` as an installer
destination and the installer rejected that non-canonical runner path. The gate
now derives its isolated root from the authoritative Windows
`LocalApplicationData` known folder. Every mutation under that real root is
inside the test harness's guaranteed `try/finally`; a fresh independent review
returned zero findings. This test-only correction passed typecheck and diff
validation.

The next Windows gate reached the installer but inherited pwsh 7's
`PSModulePath` in its nested Windows PowerShell 5.1 process, so the native
`Get-FileHash` command could not autoload. The isolated harness now reads the
authoritative machine-scoped module path, fails explicitly if it is unavailable,
sets it for the harness process, and passes it to the nested installer. A native
non-interactive probe resolved `Get-FileHash`; typecheck and diff validation
passed, and a fresh independent reviewer returned zero findings.

The corrected Windows gate then passed in GitHub Actions. The first publication
attempt successfully created the exact `v0.4.5` tag but observed a transient
404 while immediately reading it back, so it stopped before creating a release.
The idempotent rerun resolved the same immutable tag, rebuilt all targets,
passed the Windows gate again, and published
<https://github.com/laelhalawani/sana-mcp/releases/tag/v0.4.5>. The published
`install.ps1` SHA-256 is
`e64ce62eeccbd1fd6acd068f3732f9f04bbbd2a680ae6a3f02512b926a1ee670`,
exactly matching the tagged source.

The post-publication workflow correction keeps ordinary tag verification
fail-fast and retries only the read immediately following a successful tag
creation. It makes at most ten probes one second apart, retries only a 404, and
still fails immediately on API errors, malformed or non-commit objects, and SHA
mismatches. Behavioral fake-API coverage checks transient and persistent 404s,
the hard-error paths, sleep counts, lookup counts, and absence of release
mutation.

## Completion state

- `v0.4.5` is published from
  `032a470ca8a185ccf5b0597591042c9c969b97b5`.
- The bounded post-create tag-visibility correction is pushed as
  `bfbfbb697c6f4b55e64dec52d9f451987c18453c`.
- Its automatic main-push workflow completed successfully after authorizing the
  existing version and skipping every build and publication job.
- The repository worktree was clean after the push.
- A final local check found zero isolated `sana-mcp-e2e-*` roots, zero test Sana
  processes, and removed the coordinator's stale GitHub Actions watcher.
- No live user Sana runtime or data was terminated, migrated, or modified by
  final validation.

The production Windows command is:

```powershell
irm https://github.com/laelhalawani/sana-mcp/releases/latest/download/install.ps1 | iex
```

## Safety constraints

- Never terminate by process name alone.
- Never touch the live repository `data/` tree or the user's real client
  configuration during tests.
- Do not kill unrelated system processes or same-name executables at other
  paths.
- Do not run visible fixture processes.
- Do not publish if the full Windows reinstall path has not passed.

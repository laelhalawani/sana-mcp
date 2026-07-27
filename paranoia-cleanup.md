# Paranoia cleanup

Goal: strip over-engineered security from this personal, local-first MCP server.
Work happens on `cleanup/paranoia-teardown` and is **not merged until each slice
passes `bun run check` and the release workflow is verified on the branch**.

## Principles (from the user)

- Remove over-engineering that adds complexity/friction without proportional
  benefit for a single-user, local MCP server.
- **Keep genuinely useful parts** that improve stability or compatibility, and
  **do not sacrifice features** (install, update, daemon, configurer, search).
- Obsolete but **non-harmful** security logic may be **kept** when removing it
  is riskier than it is worth.

## Confirmed dead at runtime (safe to remove)

Grep across `src/` (excluding `src/sync/control.ts`) shows these are referenced
nowhere after the daemon-startup rip-out that shipped in v0.4.6:

`claimDaemonStartup`, `observeDaemonStartup`, `observeDaemonStartupReadOnly`,
`clearDaemonStartup`, `bindDaemonStartupChild`, `retireStartupAuthority`,
`DAEMON_STARTUP_TOKEN_ENV`, `DaemonStartupClaim`, `DaemonStartupObservation`,
`prepareQuarantineAclForRecovery`, `recoverQuarantinedStartup` — and their
internal helpers (candidate/quarantine/startup-ACL-receipt machinery in
`src/sync/control.ts`). Only `tests/sync/control.test.ts` exercises them.

Kept (still used by spawn/daemon/lifecycle): `observeDaemonControl`,
`observeDaemonControlReadOnly`, `publishDaemonControl`, `clearDaemonControl`,
`clearDeadLegacyDaemonControl`, `requestDaemonStop`, `daemonStopRequested`,
`refreshDaemonControl`, and the control-file publication helpers.

## Slice plan

1. **Release descriptor attestation** — `release.yml` smoke runs each binary
   through a descriptor-bound execution proof (`/proc/self/fd`, `/dev/fd`,
   Windows file lease) and `scripts/release.ts` attests/authorities/verifies it.
   Pure supply-chain theater for a personal server, and the thing that kept
   breaking the build. Plan: simplify the smoke to a plain `--version` /
   `__inspect` / sha256 check; keep the manifest + sha256 sidecars (the
   installer uses those); drop `attest`/`assemble`/`authority` from
   `scripts/release.ts` and the matching tests in `tests/release/`.
2. **Dead daemon-startup machinery** — remove the unused candidate/quarantine/
   startup-ACL-receipt code from `src/sync/control.ts` and drop
   `tests/sync/control.test.ts` (or trim to the control-file functions only).
3. **Installer transaction overhead** — assess `install.sh`/`install.ps1`
   locks/journals/receipts. Keep atomic install + `sana-mcp update`; lighten or
   keep depending on coupling/risk.
4. **Runtime ACL receipts** (`src/runtime/windows-acl.ts`) — assess. These give
   real per-user protection on shared Windows hosts; for a single-user machine
   they are paranoid but non-harmful. Lean keep unless removal is clean.

## Progress

- [x] Slice 1: release descriptor attestation — removed the descriptor-bound
      execution circus (`exec 9<` / `/proc/self/fd/9`, macOS `/dev/fd/9` + perl
      seek + path-swap proof + `EXEC_COPY`, Windows `[IO.File]::Open` lease +
      crypto re-hash) from all three smoke jobs. Each smoke now does a plain
      `--version` / `--help` / `__inspect` run, a sha256, and the existing
      `attest` (sha256+inspect tuple). Kept: the manifest + sha256 sidecars the
      installer uses, and the reasonable inspect-tuple identity check. Not yet
      touched: the publish job's descriptor-bound upload (works today; later).
      Verified: YAML parses, `tests/release/release.test.ts` green, typecheck
      clean. Full CI smoke verification pending before merge.
- [x] Slice 2: dead daemon-startup machinery — DONE. Removed ~1914 lines from
      `src/sync/control.ts` (3114→~1200) and trimmed `tests/sync/control.test.ts`
      (1881→~598; 20 startup tests dropped, 15 control tests kept). Kept
      functions intact; dev agent implemented, review agent found no blockers
      (one dangling `import type` fixed), typecheck clean, `tests/sync/` 31 pass.
- [x] Slice 3: installer transaction overhead — DONE (targeted). An analysis
      agent read both installers + their tests end-to-end: the complexity is
      almost entirely FEATURES (atomic publication, receipt-bound update,
      configurer-rollback journal, incompatible-replacement recovery, checksum
      + __inspect identity). The only zero-cascade theater was ~7 lines: the
      redundant manifest/binary "cross-binding" checks in `install.sh` (the
      manifest and binary are already checksum-verified independently) and a
      redundant staged-binary re-hash in `install.ps1` (re-hashed again one
      statement later by `Publish-InstallerFile`). Removed those; kept
      everything that serves a feature. Verified: installers + version-projection
      tests green (43 pass), `install.ps1` parses clean. Everything else
      (lock-token ceremony, PATH-block sha, `Assert-NotReparse`, retired-artifact
      re-hash, etc.) is locked in by co-designed tests AND serves atomicity/
      upgrade-safety — left intact per "do not sacrifice features."
- [x] Slice 4: runtime ACL receipts — KEEP. After Slice 2 only the single
      data-dir receipt remains (per-subdir startup receipts are gone); it is
      non-breaking and gives real per-user protection on Windows. Genuinely
      useful, kept per the principles.

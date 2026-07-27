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
- [ ] Slice 2: dead daemon-startup machinery — **assessment: keep (for now).**
      The startup functions are confirmed unused at runtime, but they are
      interleaved in `src/sync/control.ts` with the *active* control-file
      functions (publish/observe/clear/stop) that the daemon depends on, and
      `tests/sync/control.test.ts` exercises both. Surgical removal is real
      surgery for cosmetic gain (the code is dead, not harmful). Per the cleanup
      principles ("keep obsolete non-harmful logic when removal is riskier than
      it is worth"), defer unless we want to invest in a careful extraction.
- [ ] Slice 3: installer transaction overhead — `install.sh`/`install.ps1`
      locks/journals/receipts are *active* and coupled to `sana-mcp update`
      (receipts) and the configurer rollback (journals). Lightening them risks
      install/update stability ("do not sacrifice features"). Needs a careful,
      dedicated pass — not rushed.
- [ ] Slice 4: runtime ACL receipts (`windows-acl.ts`) — provides real per-user
      protection on shared Windows hosts; non-harmful on a single-user machine.
      **Lean keep** per the principles.

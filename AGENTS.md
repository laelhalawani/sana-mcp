# Repository agent workflow

These instructions apply to every task in this repository.

## Required delivery framework

For every repository change, use this three-stage workflow. Split even a narrow
change into independent analysis/development/review responsibilities; do not let
the implementing agent approve its own work.

### 1. Prep

1. Analyze the affected logic, user experience, installation, build, deployment,
   documentation, tests, workflows, and data paths.
2. Fan planning out to separate agents with concrete, non-overlapping areas.
3. Gather the planning results into one dependency-aware implementation plan.
4. Send that consolidated plan to two independent review agents for
   cross-verification.
5. Resolve every plan-review finding and finalize file ownership, sequencing,
   acceptance criteria, compatibility constraints, and migration strategy before
   development begins.

### 2. Development loop

1. Split the finalized plan into manageable development scopes.
2. Run non-overlapping, non-dependent scopes in parallel. Run dependent or
   overlapping scopes consecutively.
3. After a development agent finishes, assign a different, read-only review agent
   to compare the implementation against the complete scope.
4. The review must focus on logic, API correctness, state transitions, error
   paths, security, portability, resource cleanup, compatibility, and code smells.
   Tests may support validation, but passing tests are not a substitute for code
   review.
5. Send every finding back to a development agent for correction.
6. After corrections, assign a fresh read-only review agent that has neither
   implemented nor reviewed any earlier round of that scope to review the entire
   scope again.
7. Repeat development plus fresh review until the reviewer reports no findings.

### 3. Cross-cutting development loop

1. After all scopes in a stage are individually clean, assign one fresh,
   adversarial review agent to trace the complete stage across scope boundaries.
2. The review must follow real end-to-end paths and look for integration gaps,
   mismatched assumptions, races, stale state, incompatible formats, unsafe
   migrations, and incomplete failure handling.
3. Split cross-cutting findings among development agents when they do not overlap;
   otherwise fix them consecutively.
4. Assign a fresh adversarial reviewer after every correction round. A fresh
   reviewer has neither implemented nor reviewed an earlier round of that
   cross-cutting scope.
5. Repeat until the cross-cutting reviewer reports no findings.

Do not declare a stage complete while any individual or cross-cutting review
finding remains unresolved.

## Scope and compatibility rules

- Preserve the existing agent/LLM-facing output contracts unless a task
  explicitly changes them. This includes tool names, argument meanings, Markdown
  free text, and optional YAML frontmatter.
- Until the project reaches `1.0.0`, do not add complexity solely to preserve
  compatibility for internal APIs, local cache schemas, installer receipts,
  human CLI navigation, or other pre-release implementation details. Prefer the
  cleanest correct design and document the breaking change.
- Human CLI and installer presentation must use structured core APIs. Do not
  reuse LLM-coaching strings in human-facing screens.
- Give concurrent agents exclusive file ownership. Agents must not edit files
  owned by another active scope.
- Preserve unrelated worktree changes and generated/runtime data.
- Tests and development validation must use isolated temporary data, HOME, PATH,
  client configs, clocks, process probes, and network fakes. They must never read,
  write, migrate, or delete the live `data/` tree.
- Treat installers, upgrades, migrations, authentication, local transcript
  storage, daemon control, and release publication as security-sensitive paths.

## Pre-1.0 upgrade and migration policy

Before `1.0.0`, upgrades should behave as a controlled uninstall of the previous
runtime followed by a clean installation of the new runtime.

- Stop the previous daemon and replace only proven installer-owned binaries,
  registrations, receipts, and PATH entries through verified, bounded operations.
  Prefer exact in-place replacement to removal/recreation.
- Recreate rebuildable local databases, full-text indexes, embeddings, generated
  configuration, and caches when their schema or ownership model changes. Do not
  build elaborate compatibility layers for pre-release cache formats.
- Preserve authentication only when the existing session can be parsed, migrated
  without invented values, and revalidated against Sana. If that cannot be proven,
  require a fresh login.
- Never describe an unvalidated copied session as preserved authentication.
- Keep the previous working runtime and a journaled inventory available for
  rollback until the complete post-install transaction has succeeded: download,
  checksum, smoke check, daemon transition, replacement, receipt/PATH/config
  changes, authentication validation, new-profile initialization, health check,
  and required daemon restart.
- Never implicitly purge non-rebuildable user-owned data. Current Sana meeting
  databases are treated as rebuildable local caches only after the active account
  and remote resync path have been verified.
- Only the reviewed, serialized pre-1.0 upgrade coordinator may quarantine or
  delete a rebuildable live cache. Ordinary agents, tests, and ad hoc scripts must
  preserve runtime data.

## Review evidence

Maintain an auditable review ledger for each scope and cross-cutting stage. Record:

- scope and exact owned files;
- development agent;
- review agent for each round;
- every finding and its resolution;
- correction agent/round;
- the fresh reviewer that returned zero findings.

## No hardcoded fallback values

Never hardcode a value in a fallback or recovery path when doing so could hide an
error, invent state, route data incorrectly, or make a failed operation appear
successful.

In particular, fallback paths must not invent or substitute:

- account, user, workspace, meeting, asset, or tenant identifiers;
- versions, release tags, architectures, platforms, or asset names;
- origins, API endpoints, redirect targets, paths, or executable locations;
- model identifiers, embedding dimensions, cursors, timestamps, counts, or
  pagination state;
- authentication/session values, checksums, configuration entries, or empty
  successful API results.

When a required value is missing or invalid, do one of the following:

1. derive it from an authoritative source and validate it;
2. return a typed unavailable/error state with actionable context; or
3. stop safely without mutating persistent state.

Fallbacks must be observable and must not downgrade integrity checks, privacy
boundaries, authentication, or error reporting. A documented product default is
allowed only when it is the intentional primary behavior, not an error-recovery
substitute.

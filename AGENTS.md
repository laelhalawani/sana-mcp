# Repository agent workflow

These instructions apply to every task in this repository.

## `.env` is immutable without explicit user approval

Never delete the `.env` file, and never delete, overwrite, blank, or otherwise
remove any value from it, unless the user explicitly requests that specific
change in the current task. Reading `.env` to use a value (for example, to run a
push with a token from the URL) is allowed; mutating or removing its contents is
not. If a task seems to require changing `.env`, stop and ask the user first and
do not act until they confirm. There is no fallback or "cleanup" path that
justifies touching `.env` without this confirmation.

## Required delivery workflow

1. Read the affected code and understand the behavior before editing.
2. Make the smallest correct change that satisfies the request.
3. Run the relevant tests, type checks, builds, and end-to-end checks.
4. Have a separate read-only agent review the finished implementation for code
   correctness. The review should look for concrete logic errors, broken API or
   state transitions, missed error handling, regressions, and missing tests.
5. Fix valid review findings and re-run the affected checks. Request another
   review only when the correction is substantial enough to need one.

Do not require planning fan-out, multiple plan reviewers, adversarial review
rounds, fresh-review chains, or process evidence for routine work. Add extra
review only when the user asks for it or a specific high-risk change clearly
needs it.

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

## Pre-1.0 upgrade and replacement policy

Before `1.0.0`, every release declares an explicit positive state-compatibility
epoch in the release manifest, standalone binary, and installer receipt.

- A receipt-backed installation with the same epoch is a compatible update. Stop
  its verified daemon, replace only proven installer-owned runtime artifacts, and
  preserve its local authentication and meeting/cache state without inspecting,
  parsing, or revalidating authentication. The update must not require Sana to be
  reachable.
- A recognized official pre-receipt installation, or a receipt-backed installation
  with a different epoch, is incompatible. Before any mutation, tell the user that
  it cannot be updated in place, that replacement requires meetings to be
  resynced and a new login, and ask for explicit confirmation. Declining is a
  successful no-op.
- A platform may offer that consent only after its destructive replacement
  coordinator has been implemented and reviewed end to end. Until then it must
  refuse an epoch-changing update before confirmation or persistent mutation;
  currently the automatic incompatible replacement coordinator is Windows-only.
- After confirmation, perform a controlled destructive replacement: stop the
  proven old daemon, replace only proven installer-owned runtime artifacts, and
  reset the canonical default local state. Do not migrate, copy, or revalidate
  authentication from the incompatible installation.
- Never overwrite an unrecognized receiptless executable. Never automatically
  reset an overridden data or transcript directory; stop with actionable manual
  guidance instead.
- Journal and quarantine the incompatible state until binary replacement, receipt
  and PATH publication, smoke/health checks, and required daemon transition have
  succeeded. Roll back on failure; delete the quarantine only after commit.
- Recreate rebuildable local databases, full-text indexes, embeddings, generated
  state, and caches after a confirmed incompatible replacement. Do not build
  elaborate compatibility layers for pre-release formats.
- `sana-mcp update` must prove the installed standalone runtime and adjacent
  receipt before network access, resolve an exact release tuple, and hand off to
  that release's checksum-verified installer. A current version is a no-op and an
  installed version newer than the latest release is never downgraded.
- Only the reviewed, serialized pre-1.0 replacement coordinator may quarantine or
  delete the canonical rebuildable live state. Ordinary agents, tests, and ad hoc
  scripts must preserve runtime data.

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

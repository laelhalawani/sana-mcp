---
status: active
scope: protected agent/LLM-facing contract
baseline_date: 2026-07-24
---

# Agent contract change ledger

This ledger governs the protected `meeting_transcripts` contract. Before
`1.0.0`, internal APIs and human-facing CLI navigation may change, but an
agent-facing change must be deliberate, fixture-backed, reviewed, and recorded
here.

## Baseline

The baseline is captured by:

- `tests/fixtures/contracts/tool-docs.json`: public tool names, descriptions,
  argument meanings, sanitized examples, and ordering;
- `tests/fixtures/contracts/mcp-tool.json`: MCP registration metadata and JSON
  input schema;
- `tests/fixtures/contracts/help.txt` and `help-logged-out.txt`: exact help
  documents;
- `tests/fixtures/contracts/agent-output-shapes.json`: legacy alias names and
  the Markdown/free-text envelope;
- `tests/fixtures/contracts/representative-outputs.json`: behaviorally captured
  Markdown headings, tables, columns, navigation hints, and safe error output;
- `tests/fixtures/contracts/auth-transitions.json`: exact agent-facing login,
  authentication-transition, cache-block, and sync-unavailable output;
- `tests/contracts/agent-output.test.ts` and `mcp-stdio.test.ts`: fixture
  enforcement, stdio JSON-RPC purity, alias equivalence, and exact direct
  dispatcher/MCP equality. The human CLI is intentionally rendered from
  structured core results and is not an agent-output consumer.

Source help examples use the unmistakable `<meeting-id>` placeholder. This
keeps the baseline deterministic and secret-free without retaining an opaque
identifier of unproven provenance.

Agent responses remain Markdown or free text. YAML frontmatter is optional: an
output may omit it, as all baseline fixtures currently do, or use a `---`
delimited YAML document followed by Markdown/free text. This convention does not
authorize changing a tool's names, argument meanings, table columns, IDs, or
navigation hints.

Legacy tool aliases are `list_meetings` → `list` and `read_transcript` → `read`.
Accepted argument aliases are `login.code` → `login.confirmation_code` and
`id` → `meeting_id`.

## Approved changes

### 2026-07-25 — separate human one-shot CLI presentation from agent output

- Affected surface: human `sana-mcp <command>` output only.
- Old behavior: the human CLI printed the protected agent renderer verbatim,
  including `meeting_transcripts(...)` coaching and MCP-oriented help.
- New behavior: the human CLI calls structured core operations and renders
  CLI syntax and plain terminal text. The MCP server and direct `sana()`
  dispatcher remain byte-for-byte governed by the existing fixtures.
- Reason: human terminal commands and agent tool responses have different
  navigation and coaching needs; sharing presentation strings made the CLI
  confusing and violated the repository's explicit presentation boundary.
- Approval: required by the repository scope rule and identified by the fresh
  UX review. Protected agent output is unchanged.

### 2026-07-25 — distinguish remote sign-in outcomes from local transition failures

- Affected surface: `login`, authentication-aware `help`, `status`, and every
  cache-backed data tool; `auth-transitions.json` and the `loginCodeError`
  member of `representative-outputs.json`.
- Old request behavior: request and publication failures were rendered from
  whichever untyped exception escaped. An accepted remote request followed by
  failed local publication or cleanup could be presented as an ordinary
  request failure, and callers could not reliably tell whether Sana had sent a
  code.
- New request behavior: `REQUEST_CODE_PREFLIGHT_FAILED` says no request was sent.
  `REQUEST_CODE_REMOTE_FAILED` distinguishes a definite rejection
  (`remoteAccepted: false`) from a timeout, 5xx response, invalid response, or
  other outcome where acceptance is unknown (`remoteAccepted: "unknown"`). If
  Sana accepted the request but local store construction, session publication,
  or cleanup failed, `REQUEST_CODE_LOCAL_TRANSITION_FAILED` says that a code
  was emailed and the local transition did not complete. Only the fully
  accepted transition returns the existing next-step instructions. Separate
  deterministic store, publication, and cleanup failure cases freeze the same
  deliberate local-incomplete rendering.
- Old verification behavior: failures generally used `Sign-in failed:` plus
  the lowest-level error. The representative missing-pending-request case
  exposed a storage detail and duplicated punctuation before retry coaching.
  Local publication, confirmation, cleanup, and daemon failures could be
  confused with a rejected code.
- New verification behavior: `VERIFY_CODE_PREFLIGHT_FAILED` says no code was
  submitted when there is no matching challenge, the code/input is invalid
  locally, or local authentication storage cannot be opened. The representative
  missing-pending-challenge fixture now freezes that stable preflight output.
  `VERIFY_CODE_REMOTE_FAILED` distinguishes a definite rejection from an
  unknown timeout/5xx/invalid-response outcome without telling an agent to
  blindly retry an uncertain code. A remotely accepted code followed by local
  publication/confirmation failure uses
  `VERIFY_CODE_LOCAL_TRANSITION_FAILED`, says the local authentication
  transition did not complete, and keeps meeting tools blocked. Busy and stale
  session writers retain their typed publication outcome instead of being
  mislabeled as remote rejection. Missing authoritative user/workspace identity
  is a local transition failure, never a partial-success identity. A store
  cleanup failure is appended to the primary verification result rather than
  replacing or hiding that result.
- Old post-login behavior: daemon launch and initial catch-up failure could
  escape the successful sign-in path or leave the caller without a durable,
  agent-visible distinction between authentication and transcript-sync
  availability.
- New post-login behavior: successful authentication with unavailable sync
  starts with `Logged in as ...`, explicitly says
  `Sign-in succeeded, but transcript sync is unavailable`, and says the cache
  remains blocked. The partial result is `LOGIN_SYNC_UNAVAILABLE`; if recording
  that durable status also fails, a separate
  `SYNC_STATUS_PERSISTENCE_FAILED` line makes the uncertainty observable.
  `status` renders a persisted sync issue as
  `Transcript sync is unavailable (<code>/<cause>): <message>`. A later
  ordinary daemon launch failure is recorded and rendered as
  `SYNC_DAEMON_UNAVAILABLE/<authoritative cause>`; if that record fails, status
  renders an ephemeral `SYNC_STATUS_PERSISTENCE_FAILED` issue rather than
  pretending persistence succeeded. When an older durable issue also exists,
  it is retained on a separate `Previous persisted sync issue
  (<code>/<cause>): <message>.` line rather than replacing the current failure.
- Missing authoritative identity: the contract harness does not invent or
  freeze an impossible successful identity. Missing user/workspace identity
  is present in the target session version before publication, is recorded as
  null in the owned transition and durable generation, and then remains a typed
  local transition failure with meeting tools blocked. It is not simulated by
  rewriting only the returned confirmation. Its nested storage cause is not
  currently a separate agent-facing string.
- Configured-origin transition: an origin-bound session mismatch is not reused.
  A request that can preserve the confirmed baseline explains that it is
  starting a fresh session; inability to preserve that baseline is an explicit
  local failure whose exact output is fixture-backed. A legacy session
  containing only a partial identity is
  explicitly reset before fresh sign-in and gets its own notice; it is not
  described as preserved authentication. No origin or identity fallback is
  invented.
- Accepted publication state: the isolated contract boundary advances a real
  modeled session and store from generation 2 to generation 3 after seeding an
  older authentication issue and sync issue. Before session persistence it
  asserts the complete owned transition: blocking/pending state, catch-up
  generation, owner PID, operation token, generation, kind, and nullable target
  user/workspace. It then asserts session save, durable confirmation,
  current-generation failure reset, and exact-generation sync-status clear or
  record. The post-verification snapshot proves that clearing an earlier issue
  retains the login block and catch-up generation. The ready-state probe
  separately models the daemon completing the confirmed generation-3 catch-up
  cycle before the cache is released; the partial result stays blocked at
  catch-up generation 3 with the exact durable issue code, cause, and message.
  Every post-confirmation transition and authentication-issue field is asserted
  cleared.
- Help and data gating: a durable authentication issue is prepended to help and
  prevents all data-tool reads. Status snapshot drift is explicit as
  `AUTH_STATUS_SNAPSHOT_CHANGED`; a refresh that attempts to change identity is
  explicit as `AUTH_REFRESH_IDENTITY_MISMATCH`. Cache-backed operations are
  guarded before, during, and after execution; a detected race renders
  `CACHE_OPERATION_CHANGED` coaching before returning any stale output. Exact
  fixtures mutate only production-shaped cache user/workspace identity fields
  before capture, before a synchronous fence, after a synchronous operation,
  after a keyword result is formed but before its caller resumes, and after the
  recording network await. No fixture-only cache generation exists. Each
  failure comes from comparing the captured authentication guard to the mutated
  shared cache identity, never from a scenario-forced exception. The search
  probe freezes read, real microtask yield, tuple mutation, then guard rejection
  in order; the recording probe similarly freezes fetch completion, mutation,
  and rejection.
- Blocking sync status: the old status fixture exposed `1/4` transcript
  progress, an ETA, and the previous full-sync timestamp while the active cache
  was blocked. The new fixture says the meeting list is being built and omits
  cache-derived counts and timestamps until the confirmed identity's catch-up
  releases the cache. The existing `Meeting tools are unavailable until it
  completes.` coaching is unchanged.
- Reason: agent callers must distinguish a rejected remote action from a
  remotely accepted action whose local durable state is incomplete.
  Authentication success must not imply sync or cache availability, and no
  fallback may invent identity.
- Approval: Approved without further byte changes by the clean
  protected-contract review and the final whole-Stage-A review.
  The auth fixture remains intentionally isolated so later approved wording
  changes can affect only this entry and that focused fixture.
- Reverified unchanged: the public tool name and all tool aliases; `email`,
  `workspace_id`, `confirmation_code`, and `code` meanings; every non-auth
  heading, Markdown table schema and column; meeting IDs and pagination/read
  navigation; and Markdown/free-text with optional YAML frontmatter.
  `tool-docs.json`, `mcp-tool.json`, help registry text, documented semantics,
  and semantic-degradation output remain byte-for-byte unchanged. Direct
  dispatcher and MCP equality is frozen for the partial sync-unavailable
  result; the human CLI has separate structured-output coverage.

### 2026-07-24 — sanitize example meeting identifiers

- Affected surface: detailed help examples for `read`, `summary`,
  `participants`, and `recording`; `tool-docs.json`.
- Old behavior: examples contained the same opaque 16-character identifier of
  unproven provenance.
- New behavior: examples use the explicit `<meeting-id>` placeholder.
- Reason: a help example must not preserve a possibly real meeting identifier.
- Approval: P-CONTRACT correction round, explicitly authorized as a
  wording-only contract/security correction.
- Reverified unchanged: tool names, aliases, argument meanings, headings,
  tables, columns, output formats, and navigation hints.

### 2026-07-24 — expose semantic capability and runtime degradation

- Affected surface: `status` and `search`;
  `tests/fixtures/contracts/semantic-degradation.json`.
- Old `status` behavior: when semantic search was explicitly requested from a
  keyword-only standalone build, status omitted any semantic line and appeared
  the same as an intentional keyword-only configuration.
- New `status` behavior: after the existing status lines, it appends
  `Semantic search: unavailable (This standalone build supports keyword search only; semantic search is available from source builds.) Keyword search remains available.`
- Old standalone `search` behavior: an explicit semantic request silently
  returned the ordinary keyword output, including populated, zero-match, and
  empty-page results.
- New standalone `search` behavior: it still returns the authoritative keyword
  result and adds
  `Semantic search degraded (SEMANTIC_CAPABILITY_UNAVAILABLE): This standalone build supports keyword search only; semantic search is available from source builds. Showing keyword results.`
  The notice follows the result summary for populated results and follows the
  empty-result sentence for zero-match or empty-page results.
- Old source-build runtime-unavailable behavior: a
  `SemanticUnavailableError` discarded already available keyword results and
  returned the terminal message
  `Semantic search is enabled but unavailable: <message> Set SANA_SEMANTIC=0 to use keyword search.`
- New source-build runtime-unavailable behavior: search returns the
  authoritative keyword result and adds
  `Semantic search degraded (SEMANTIC_RUNTIME_UNAVAILABLE): <message> Showing keyword results.`
- Old unexpected semantic-error behavior: search silently returned keyword
  results, making the semantic failure invisible.
- New unexpected semantic-error behavior: search returns the keyword result and
  adds `Semantic search degraded (SEMANTIC_RUNTIME_ERROR): <message> Showing keyword results.`
  For a non-Error thrown value, where no authoritative message exists, the
  observable detail is the typed cause `UNKNOWN_THROWN_VALUE` rather than an
  invented message.
- Old typed API after the initial correction: `SearchResult` still retained the
  obsolete `kind: "semantic-unavailable"` variant, and the dispatcher retained
  its old terminal response branch even though production search no longer
  returned that state.
- New typed API: runtime semantic failures can only return `kind: "ok"` with an
  authoritative keyword result and typed degradation. The obsolete result
  variant, unused semantic import, and terminal dispatcher branch are removed,
  so exhaustive type checking prevents that discarded-output behavior from
  being reintroduced accidentally. This cleanup does not change the approved
  rendered behavior.
- Reason: a requested capability must never appear active when it is absent or
  fail silently. Keyword results are independently authoritative and remain
  useful, so preserving them with a typed, observable degradation is more
  accurate than discarding them or pretending hybrid search succeeded.
- Approval: A-SECURE-RUNTIME contract closeout.
- Reverified unchanged: tool names and aliases; argument names, aliases, and
  meanings; Markdown/free-text with optional YAML frontmatter; search summary
  wording, Markdown heading/table schema and columns, meeting identifiers,
  pagination guidance, and read-around navigation. Exact fixtures cover
  populated, zero-match, and empty-page placement for capability-unavailable,
  runtime-unavailable, ordinary runtime-error, and unknown-thrown-value
  degradation. With semantic search disabled, every prior status and search
  fixture remains byte-for-byte unchanged.

## 2026-07-25: remove invented sync time estimates

- Affected tools: `login`, `status`, `read`, and the common blocked-state text
  used by meeting tools.
- Old behavior: progress text converted the remaining item count into minutes
  using a fixed assumption of 0.5 seconds per transcript. The runtime did not
  measure or persist a download rate, so the displayed ETA had no authoritative
  source.
- New behavior: progress text reports only authoritative completed, total, or
  remaining item counts. A transcript that is still downloading directs the
  caller to `status` for current progress. A read requested while the meeting
  list is still being built now says
  `Still syncing the meeting list. Check meeting_transcripts("status") for current progress.`
  instead of promising a retry “in a few seconds.” The structured status field
  `etaMinutes` remains present but is `null` until an authoritative estimator
  exists.
- Reason: the constant could make a stalled or slow sync look healthy and
  violated the repository rule against hardcoded recovery/fallback values that
  invent state. Omitting the estimate is accurate and observable.
- Approval: repository no-hardcoded-fallback correction, implemented by the
  root development scope.
- Reverified unchanged: tool names and aliases; argument names, aliases, and
  meanings; Markdown/free-text and optional YAML-frontmatter conventions;
  meeting identifiers, list/search table columns, pagination, and read-range
  navigation.

## Review rule

An intentional correctness change must add a dated entry containing:

1. the affected tool and fixture;
2. the old and new observable behavior;
3. why the old behavior was incorrect or unsafe;
4. the approving review scope;
5. any unchanged aliases, arguments, headings, table columns, and navigation
   hints that were reverified.

Do not update a fixture merely to make a failing test pass. Unauthorized fixture
diffs are contract regressions.

## Test environment

The stdio and parity checks require Bun because the source runtime imports
`bun:sqlite`; Node-only execution is not a supported substitute. Every dynamic
check creates an isolated temporary root and passes an allowlisted environment
whose home, platform config, temporary, transcript, and data paths all remain
inside that root. Each child is launched explicitly with a small preload that
guards the path-bearing Node filesystem entry points used by secure storage,
daemon locks and logs, plus native Bun SQLite. It rejects access resolving to
the repository's live `data/` path and resolves the nearest existing ancestor
before comparison. POSIX runs and Windows runs from a local drive verify this
with a temporary symlink or junction alias. A Windows process executing the
repository through a WSL UNC share cannot create that junction, so that
environment verifies direct live-data blocking while the alias case is covered
by the other supported environments. The preload also blocks the global
`fetch` used by `SanaClient` and the Node child-process spawn used by the daemon
launcher.

A focused guard probe invokes `SanaClient.requestSignInCode()` and the real
asynchronous `ensureDaemonRunning()` path to verify those boundaries before
network or process creation. The harness intentionally does not intercept
unrelated DNS, socket, server, WebSocket, or process APIs that the exercised
application paths do not use. Tests disable semantic model loading, use a fixed
test clock, seed only synthetic local rows, remove all temporary state, and
never read, write, migrate, or delete the repository's live `data/` tree.

Contract bundles are built in isolated child processes with a 30-second inner
deadline. On timeout the harness kills and reaps the builder before the helper
rejects; the outer watchdog budgets that complete deadline plus cleanup and a
separate margin. A focused timeout probe freezes this cancellation path, so an
in-process build cannot outlive test cleanup.

The behavioral baseline covers deterministic status; list query, ready,
downloading and failed filters, ISO/epoch date bounds, pagination, and oldest
sort; read full/range/no-selection/timestamp behavior; search best/oldest sorts,
pagination/navigation, and ISO/epoch date bounds; summary; participants;
recording failure/missing-ID handling; tool aliases; meeting-ID argument
aliasing for read, summary, participants, and recording; missing required read
and search arguments; missing login email and missing summary/participants
meeting IDs; login code aliases; top-level and exact detailed help; ready and
sync-in-progress status; JSON argument routing; and exact direct
dispatcher/MCP parity for representative safe calls, with separate human CLI
coverage. A successful recording
response is intentionally not captured because it requires remote
authentication and a signed URL. Login request and verification rendering are
captured through bundled production dispatcher and MCP
entrypoints whose Sana, store, daemon, and session-publication boundaries are
replaced with deterministic contract fixtures. Those fixtures model explicit
accepted, rejected, publication-failed, cleanup-failed, incomplete, busy,
stale, and sync-unavailable results; they never contact Sana, claim a live
remote response, or mutate a runtime store.

Every owned contract test, fixture, this ledger, and the explicitly authorized
help source is scanned for UUIDs, long mixed alphanumeric or URL-safe encoded
tokens, and literal values assigned to `meeting_id`, `external_id`, or `id`.
Only named synthetic values and explicit placeholders are accepted.

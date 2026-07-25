---
status: active
scope: implementation and review evidence
last_verified: 2026-07-25
---

# Review ledger

This ledger records the required development and adversarial review loops from
`AGENTS.md`. A scope is not complete until its latest fresh review reports zero
findings.

## Prep

### Exact scope inventory

#### P-CONTRACT

Development agents: `p_contract_dev` for the initial implementation and
corrections through the state reviewed by `p_contract_resume_review`;
`p_contract_fix_resume` for that review's fixes and every later correction
through the clean state.

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

Authorized source amendment: after
`p_doc_status_dev/p_contract_fresh_review_2` found the remaining opaque source
example ID, `p_contract_dev` changed only the four example identifiers for
`read`, `summary`, `participants`, and `recording` in `src/tools/help.ts` to
`<meeting-id>`. The contract-change ledger records why this wording-only
security/contract correction was approved. All later P-CONTRACT reviewers
reviewed the amended source as part of the complete scope, ending with the clean
`p_contract_zero_review_2` review. This exception did not grant general ownership
of `src/tools/help.ts`.

#### P-DOC-STATUS

Development agent: `p_doc_status_dev`.

Owned files:

- all content in `docs/dev/README.md`;
- frontmatter/status only in `docs/dev/analysis-app-shell.md`;
- frontmatter/status only in `docs/dev/binary-packaging.md`;
- frontmatter/status only in `docs/dev/bun-port.md`;
- frontmatter/status only in `docs/dev/cli-app-architecture.md`;
- frontmatter/status only in `docs/dev/cli-feature-screens.md`;
- frontmatter/status only in `docs/dev/cli-presentation-layer.md`;
- frontmatter/status only in `docs/dev/cli-specs.md`;
- frontmatter/status only in `docs/dev/codebase-notes.md`;
- frontmatter/status only in `docs/dev/go-embeddings.md`;
- frontmatter/status only in `docs/dev/go-port.md`;
- frontmatter/status only in `docs/dev/installer-flow-polish.md`;
- frontmatter/status only in `docs/dev/rust-embeddings.md`;
- frontmatter/status only in `docs/dev/rust-port.md`;
- frontmatter/status only in `docs/dev/tui-library-research.md`;
- frontmatter/status only in `docs/dev/tui-rendering.md`.

#### P-SECURITY

Audit agent: `prep_runtime_plan`. This was a read-only scope with no owned files
and no repository mutations.

Read-only targets:

- `.git/config` and `.gitignore`;
- all tracked and untracked worktree paths;
- all 34 commits across all refs;
- `scripts/bootstrap-session.mjs`, `scripts/paginate.mjs`,
  `scripts/validate.mjs`, `scripts/investigate.mjs`, and
  `scripts/record.mjs`;
- `scratchpad-test/**`;
- path, name, and permission metadata under ignored `data/**`, without reading
  live-data file contents.

### Development and review lineage

Agent IDs containing `/` below are canonical child-task paths, not a list of
multiple reviewers. Each row records the reviewer finding, its correction, and
the next review gate; the last row for each development scope identifies the
fresh reviewer that returned zero findings.

| Scope | Development / consolidation | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|---|
| Initial repository analysis | `/root` with `runtime_logic`, `build_deploy`, `docs_workflows` | n/a | Runtime, privacy, installer, package, release, docs, and test audit produced | Converted to remediation program | complete |
| Initial remediation plan | `/root` with `prep_ux_plan`, `prep_runtime_plan`, `prep_release_plan` | `plan_review_a` | 27 initial gaps, then 6 remaining gaps | Plan fully rewritten and corrected twice; `AGENTS.md` strengthened; remote sanitized | `plan_review_a` round 2: APPROVED |
| Initial remediation plan | `/root` with `prep_ux_plan`, `prep_runtime_plan`, `prep_release_plan` | `plan_review_b` | 22 initial gaps, then 4 remaining gaps | Frozen product/distribution/upgrade decisions; daemon/manifest/store/reviewer order corrected | `plan_review_b` round 2: APPROVED |
| P-SECURITY redacted audit | `prep_runtime_plan` (read-only) | n/a | No tracked/history credential match; unsafe live-data scripts, permissive live-file modes, `.env.*`/scratchpad ignore gaps, and an opaque fixture ID were identified | Runtime, devtools, hygiene, and contract owners retain the findings; fixture ID was made synthetic; external PAT revocation remains the completion gate | audit complete; no repository files changed |
| P-DOC-STATUS | `p_doc_status_dev` | `prep_runtime_plan` | Active contract ledger omitted from index | Added the protected contract ledger to active controls | correction required another review |
| P-DOC-STATUS, corrected round | `p_doc_status_dev` | `p_contract_dev` | Accepted installer-polish note still endorsed checksum-unverified success | Marked the document superseded in frontmatter and the index without changing its body | correction required fresh review |
| P-DOC-STATUS, final round | `p_doc_status_dev` | `prep_runtime_plan/p_doc_fresh_review` | none | n/a | CLEAN — zero findings |
| P-CONTRACT, initial round | `p_contract_dev` | `p_doc_status_dev` | Source-string rather than behavioral assertions; inherited host environment; incomplete stdout drain/framing; narrow parity; non-recursive fixture scan | Replaced with isolated synthetic-store behavior, allowlisted environment, close-drained JSON-RPC parsing, broader parity, and recursive scans | correction required fresh review |
| P-CONTRACT, correction round 1 | `p_contract_dev` | `prep_runtime_plan` | Time-dependent daemon suppression; missing read/search/status navigation fixtures; opaque example copied into tests | Added fixed-clock production liveness path, descendant preload proof, navigation/status fixtures, and structural normalization | correction required fresh review |
| P-CONTRACT, correction round 2 | `p_contract_dev` | `p_doc_status_dev/p_contract_fresh_review_2` | Incomplete argument semantics; source opaque ID remained; blank frames accepted; no direct-dispatch parity | Added discriminating argument cases, approved synthetic help placeholder, strict framing, and dispatcher/CLI/MCP parity | correction required fresh review |
| P-CONTRACT, correction round 3 | `p_contract_dev` | `prep_runtime_plan/p_contract_fresh_review` | Daemon blocker not exercised through production spawn; non-portable live-data sentinel | Added bounded production daemon-spawn containment and normalized path construction | correction required fresh review |
| P-CONTRACT, correction round 4 | `p_contract_dev` | `p_doc_status_dev/p_contract_fresh_review_3` | Environment-only live-data protection; partial network blocking; missing required/status/help/alias cases; narrow opaque-ID scan | Added fail-closed fs/Bun/sqlite and network preload guards, no-I/O probes, exact missing/status/help/alias fixtures, and broader identifier checks | correction required fresh review |
| P-CONTRACT, correction round 5 | `p_contract_dev` | `p_contract_resume_review` | DNS resolver/Bun UDP/EventSource gaps; symlink bypass; identifier scan still narrow; missing required branches; preload paths with spaces | `p_contract_fix_resume` added canonical alias guards, complete network guards/probes, generic ID scanning, missing cases, and integrity-checked no-space descendant preload | correction required fresh review |
| P-CONTRACT, correction round 6 | `p_contract_fix_resume` | `p_contract_final_review` | Remaining supported fs path APIs plus Node dgram/http2 were not guarded despite broad isolation claim | Added/probed glob/statfs/lutimes/promises-watch and dgram/http2 families; narrowed ledger wording to verified families; retained mode-0600 file-backed MCP stdin | correction required fresh review |
| P-CONTRACT, correction round 7 | `p_contract_fix_resume` | `p_contract_zero_review` | Glob arrays/options.cwd and Bun global/module DNS could bypass guards | Guarded/probed glob scalar/array/cwd across callback/sync/promises and Bun DNS lookup/prefetch; 19 tests and typecheck pass | correction required fresh review |
| P-CONTRACT, correction round 8 | `p_contract_fix_resume` | `p_contract_zero_review_2` | none | n/a | CLEAN — zero findings |
| Prep cross-cutting round 1 | n/a | `prep_cross_review` | Process/listener containment and child identity were incomplete; exact ownership/reviewer evidence was missing | `prep_cross_harness_fix` hardened and probed the preload boundary; `prep_cross_evidence_fix` added exact inventories and the approved help exception lineage | correction required fresh review |
| Prep cross-cutting round 2 | `prep_cross_harness_fix`, `prep_cross_evidence_fix` | `prep_cross_zero_review` | Node spawn allowed `shell: true` or an explicit shell on an otherwise allowlisted command | `prep_cross_harness_fix` rejects both forms before process creation and added no-I/O probes | correction required fresh review |
| Prep cross-cutting round 3 | `prep_cross_harness_fix` | `prep_cross_zero_review_2` | none | n/a | CLEAN — zero findings |

## Stage A

### A-UI ownership

- `src/app/ui.ts`
- `src/app/ports.ts`
- `src/app/render.ts`
- `tests/app/ui.test.ts`
- `tests/app/ports.test.ts`

| Scope | Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|---|
| A-UI initial | `a_ui_dev` | `a_ui_review` | Untrusted SGR crossed boundary; resize used stale rows; split policy; listener/cleanup leaks; flag/keycap widths; unavailable client context | Added trusted rendering provenance, safe region resize, unified policy, retryable resource ownership, grapheme fixes, discriminated client availability | correction required fresh review |
| A-UI correction 1 | `a_ui_dev` | `a_ui_fresh_review` | Trust was global not policy-bound; resize replayed stale layout; unavailable reasons remained strings; process hooks persisted; masked wrap fallback | Bound styles to owner/current policy, model-driven resize, closed reason/action unions, reference-counted hooks, nonempty wrap invariant | correction required fresh review |
| A-UI correction 2 | `a_ui_dev` | `a_ui_fresh_review_2` | none | n/a | CLEAN — zero findings; 18 tests pass |

### A-RELEASE-CONTRACT ownership

- `src/install/manifest.ts`
- `release/manifest.schema.json`
- `tests/install/manifest.test.ts`
- `tests/fixtures/manifest/valid-all-targets.json`
- `tests/fixtures/manifest/invalid-unknown-field.json`

| Scope | Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|---|
| A-RELEASE-CONTRACT initial | `a_release_contract_dev` | `a_release_contract_review` | Schema/parser divergence; unsupported protocols/capability; invalid target misreported; Win32 device names accepted | Differential schema/parser boundary, exact v1/keyword constants, runtime target validation, portable filename rejection | correction required fresh review |
| A-RELEASE-CONTRACT correction 1 | `a_release_contract_dev` | `a_release_contract_fresh_review` | Mutable exported target array; public types widened protocol/libc invariants | Runtime-frozen target tuple, protocol literals, target-discriminated asset/parser types | correction required fresh review |
| A-RELEASE-CONTRACT correction 2 | `a_release_contract_dev` | `a_release_contract_fresh_review_2` | none | n/a | CLEAN — zero findings; 14 tests and typecheck pass |

### A-CLIENT-CONFIG ownership and lineage

Development agent: `a_client_config_dev`.

Owned files:

- `src/install/clients.ts`
- `src/install/detect.ts`
- `src/install/server-target.ts`
- `src/install/status.ts`
- `src/install/writers.ts`
- `src/install/apply.ts`
- `src/install/install.ts`
- `tests/install/clients.test.ts`
- `tests/install/detect.test.ts`
- `tests/install/status.test.ts`
- `tests/install/writers.test.ts`
- `tests/install/apply.test.ts`

Each resolution below was applied to the historical implementation before the
next full-scope review. S2 later superseded its transaction/process/native
machinery, so the ledger records the demanded correction without implying that
the corrected machinery remains in the current design.

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `a_client_config_dev` | `a_client_config_review` | Duplicate JSON keys; TOML array boundary; rename/CAS symlink race; semantic postcondition/durability; empty args and dotted env; process-tree timeout/ambiguous result; tri-state boolean masking; relative environment roots; Windows reparse/DACL; prototype names; trailing newline | Added strict duplicate/argument/name handling, format-boundary preservation, canonical roots and tri-state results, link/Windows checks, bounded process ambiguity, and postcondition/durability verification | correction required fresh review |
| `a_client_config_dev` | `a_client_config_fresh_review` | Unix CAS gap; Windows DACL falsely reported applied; Windows identity/CAS gap; ambiguous command false success; PID-reuse/unawaited process cleanup; quoted TOML boundary/comments; unknown-field ownership; symlink/crash lock; dual OpenCode files; aliases/root-relative paths/untrusted executables | Added platform-specific identity/CAS and truthful results, awaited verified cleanup, preserved TOML/unknown ownership, hardened lock/link handling, represented dual-file ambiguity, and validated aliases, roots, and executables | correction required fresh review |
| `a_client_config_dev` | `a_client_config_fresh_review_2` | Arbitrary recovery artifacts; Windows recovery lacked a lock; Unix replace backup was unsafe; journal omitted metadata/existence; staged Windows DACL; process-tree completion; mutable `SystemRoot`/path; symlink parents | Restricted recovery inventory, serialized Windows recovery, corrected replace/journal metadata and staged ACLs, awaited process completion, anchored system paths, and rejected linked parents | correction required fresh review |
| `a_client_config_dev` | `a_client_config_fresh_review_3` | Circular PowerShell ACL trust; racy Windows parent handling; journal-before-lock/canonical-binding/PID-reuse defects; artifact DACL; hardcoded `libc.so.6`; false durability | Removed circular trust, bound parent/lock/journal identities in the required order, secured artifacts, resolved libc without a hardcoded soname fallback, and reported durability truthfully | correction required fresh review |
| `a_client_config_dev` | `a_client_config_fresh_review_4` | Windows target-handle/ACL mismatch could block valid work; deleted Unix staged file left its journal; stale-lock deletion race; partial-lock wedge; nested TOML subtree removal; Unix ancestor TOCTOU and dry-run mutation | Corrected handle/ACL decisions, paired staged/journal cleanup, stabilized lock takeover, removed complete TOML subtrees, bound Unix ancestors, and made dry-run read-only | correction required fresh review |
| `a_client_config_dev` | `a_client_config_fresh_review_5` | Windows final CAS race; Darwin unsupported path; loose libc discovery; pre-journal temporary leak; journal identity | Bound Windows final publication, added the Darwin path, made libc discovery exact, cleaned pre-journal temporaries, and verified journal identity | correction required fresh review |
| `a_client_config_dev` | `a_client_config_fresh_review_6` | Windows target/staged handle identity missing; Windows recovery journal-snapshot cleanup incomplete | Added held-handle identity checks for target/staged files and completed journal-snapshot cleanup | correction required fresh review |
| `a_client_config_dev` | `a_client_config_zero_review` | none | n/a | CLEAN — zero findings |

This clean result closed the original scope, but its transaction/process/native
machinery was later judged disproportionate for a local non-elevated
application. S2 below is the reviewed replacement and is the current approved
implementation.

### A-SECURE-RUNTIME ownership and lineage

Development agent: `a_secure_runtime_dev`, with the one explicitly recorded
Windows correction round performed by `a_client_config_dev`.

Primary owned files:

- `src/config.ts`
- `src/runtime/env.ts`
- `src/runtime/secure-files.ts`
- `src/runtime/build-info.ts`
- `src/runtime/unix-at.ts` (later deleted by S1)
- `src/runtime/windows-process-handle.ts` (later deleted by S1)
- `tsconfig.json`
- `package.json`
- `bun.lock`
- `tests/runtime/env.test.ts`
- `tests/runtime/secure-files.test.ts`
- `tests/runtime/build-info.test.ts`
- `tests/runtime/secure-session.test.ts`
- `tests/runtime/secure-store.test.ts`
- `tests/runtime/semantic-capability.test.ts`

Authorized narrow production amendments:

- numeric environment parsing only in `src/core/login.ts`,
  `src/sync/daemon.ts`, and `src/semantic/semantic.ts`;
- secure-file consumer integration only in `src/sana/client.ts`,
  `src/store/db.ts`, `src/sync/spawn.ts`, and `src/sync/lock.ts`;
- typed build-capability consumption only in `src/core/search.ts` and
  `src/core/status.ts`;
- the corresponding additive semantic-availability text only in
  `src/tools/dispatch.ts`.

Each historical correction below was applied before the next review. The
helper/FFI/private-storage parts were then superseded by S1, release identity by
S3, and the timestamp fallback by S-DATE; the surviving environment and
semantic surface has its own clean successor review below.

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `a_secure_runtime_dev` | `a_secure_runtime_review` | Exclusive cleanup could delete a competitor lock; unbounded/redundant PowerShell ACL work; broad data-root chmod; numeric timers lacked caps; standalone targets/capability were invented; compile usage mismatched | Corrected lock ownership, bounded ACL work and chmod scope, capped timers, and made build target/capability/compile identity authoritative for the next review | correction required fresh review |
| `a_secure_runtime_dev` | `a_secure_runtime_fresh_review_2` | Quarantine check/overwrite race; mkdir component race; database identity gap; global umask race; standalone semantic/status mismatch; list preflight mutated | Bound quarantine/directory/database operations, removed global umask mutation, aligned semantic/status capability, and made list preflight nonmutating | correction required fresh review |
| `a_secure_runtime_dev` | `a_secure_runtime_fresh_review_3` | WAL/SHM pre-open; Unix ancestor binding; Windows directory creation/ACL; bind creation replacement/leak; check-unlink could delete a competitor; JSON descriptor leak; semantic errors silently appeared hybrid and lacked contract evidence | Corrected sidecar/ancestor/Windows binding, competitor-safe cleanup and descriptor lifecycle, and made semantic degradation observable with contract closeout required | correction required fresh review |
| `a_secure_runtime_dev` | `a_secure_runtime_fresh_review_4` | Windows source-publication race; destructive database lock probe; database cleanup aggregation; JSON descriptor aggregation; batch binds mutated before complete binding; hardcoded unknown semantic message | Bound Windows publication, replaced destructive probing, aggregated database/JSON cleanup, completed binding before mutation, and used a typed unknown-cause result | correction required fresh review |
| `a_secure_runtime_dev` | `a_secure_runtime_fresh_review_5` | Windows ancestor/source identity; database batch did not bind actual mutation; descriptor-close errors swallowed; empty degradation dropped | Bound exact Windows and database mutation paths, surfaced close failures, and preserved degradation on empty results | correction required fresh review |
| `a_secure_runtime_dev` | `a_secure_runtime_fresh_review_6` | Continuous Windows source binding; JSON serialized before transaction; lock/spawn cleanup masking; standalone semantic dependencies not external | Kept source identity bound through publication, moved serialization inside the transaction boundary, aggregated lock/spawn cleanup, and externalized standalone semantic dependencies | correction required fresh review |
| `a_secure_runtime_dev` | `a_secure_runtime_fresh_review_7` | Helper release was nonretryable/leaked; Unix pathname fallback; Darwin `/dev/fd` child traversal | Made helper release bounded and observable, removed the Unix fallback, and handled Darwin traversal explicitly | correction required fresh review |
| `a_secure_runtime_dev` | `a_secure_runtime_fresh_review_8` | SQLite pseudo-path broke WAL/SHM placement; Windows helper termination/retry | Routed SQLite sidecars to the actual database directory and made Windows helper termination bounded/retryable | correction required fresh review |
| `a_secure_runtime_dev` | `a_secure_runtime_fresh_review_9` | Darwin child traversal was not preprobed; Windows handle-acquisition helper leaked; `CloseHandle` failure was swallowed | Added a pre-mutation Darwin probe, closed acquisition helpers, and surfaced handle-close failures | correction required fresh review |
| `a_secure_runtime_dev` | `a_secure_runtime_zero_review` | Helpers could outlive a parent crash | Added parent-death handling and crash-worker evidence | correction required fresh review |
| `a_secure_runtime_dev` | `a_secure_runtime_zero_review_2` | Bare PowerShell path; cooperative nonzero helper exit accepted; DACL rule/flags incomplete | `a_client_config_dev` anchored PowerShell identity, rejected nonzero exits, and completed DACL rule/flag verification | correction required fresh review |
| `a_secure_runtime_dev`, `a_client_config_dev` | `a_secure_runtime_zero_review_3` | Inherited environment/CWD injection; post-helper DACL replacement gap; forced termination accepted; unauthenticated PID-reuse kill | Isolated helper environment/CWD, reverified final DACL identity, rejected forced completion, and authenticated process identity before termination | correction required fresh review |
| `a_secure_runtime_dev`, `a_client_config_dev` | `a_secure_runtime_zero_review_4` | Disproportionate helper/process/FFI/probe architecture; Unix descriptor/macOS maintainability; missing timestamps used `Date.now()` | Replaced the architecture through reviewed S1/S3, and the timestamp fallback through S-DATE; surviving environment/semantic behavior was re-reviewed in A-SECURE-SURVIVING | superseded; no false clean verdict recorded |

### A-CONTRACT-CLOSEOUT ownership and lineage

Development agent: `a_contract_closeout_dev`.

Owned files:

- `docs/dev/contract-change-ledger.md`
- `tests/contracts/mcp-stdio.test.ts`
- `tests/contracts/agent-output.test.ts`
- `tests/fixtures/contracts/semantic-degradation.json`
- `tests/fixtures/contracts/semantic-client.ts`
- `tests/fixtures/contracts/semantic-store.ts`
- `tests/fixtures/contracts/semantic-spawn.ts`
- `tests/fixtures/contracts/semantic-runtime-failure.ts`

Its correction round was narrowly authorized to remove the unreachable
semantic-unavailable result/dispatcher branch and import in
`src/core/search.ts` and `src/tools/dispatch.ts`; it did not receive general
ownership of either source file. `tests/runtime/semantic-capability.test.ts`
remained A-SECURE-owned supporting evidence and was not edited by this scope.
Exact approved status/search text and unchanged LLM-facing structures are
recorded in `docs/dev/contract-change-ledger.md`.

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `a_contract_closeout_dev` | `a_contract_closeout_review` | Runtime degradation paths were not behaviorally exercised; build-target handling retained a musl fallback | Added runtime-path fixtures/assertions and removed fallback target invention | correction required fresh review |
| `a_contract_closeout_dev` | `a_contract_closeout_zero_review` | Empty runtime-result paths were incomplete; obsolete semantic-unavailable branch remained | Covered empty paths and made the authorized `search.ts`/`dispatch.ts` type cleanup | correction required fresh review |
| `a_contract_closeout_dev` | `a_contract_closeout_zero_review_2` | none | n/a | CLEAN — zero findings |

### A-CONTRACT-CROSS correction ownership and lineage

Development and correction agent:
`/root/stage_a_cross_contract_dev`.

Exact owned files:

- `tests/contracts/mcp-stdio.test.ts`
- `tests/fixtures/contracts/auth-client.ts`
- `tests/fixtures/contracts/auth-store.ts`
- `tests/fixtures/contracts/auth-session.ts`
- `tests/fixtures/contracts/auth-spawn.ts`
- `tests/fixtures/contracts/auth-model.ts`
- `tests/fixtures/contracts/auth-publication-probe.ts`
- `tests/fixtures/contracts/auth-cache-probe.ts`
- `tests/fixtures/contracts/build-entrypoint.ts`
- `tests/fixtures/contracts/auth-transitions.json`
- `tests/fixtures/contracts/seed-store.ts` only to remove the obsolete
  `cache_generation` seed field
- `docs/dev/contract-change-ledger.md`
- this lineage section and the Stage A cross-cutting status below in
  `docs/dev/review-ledger.md`

The scope did not own production files or any other protected fixture. The
whole-stage adversarial reviewer reported nine Stage A findings; this scope
owns only its contract/timeout finding 9. Every later row is a fresh,
read-only full-scope review after the preceding correction.

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `/root/stage_a_cross_contract_dev` | `/root/stage_a_cross_review` | Stage finding 9: outer contract watchdogs could expire before the complete serialized child-helper cleanup path | Derived each outer budget from exact process/MCP/build child counts, complete phase maxima, cleanup, and a separate margin | correction required fresh review |
| `/root/stage_a_cross_contract_dev` | `/root/stage_a_cross_contract_review_1` | Five findings: watchdog counts still lacked complete helper/build authority; accepted login did not prove durable publication; changed-after async cache guards were absent/no-op; failed origin-baseline recovery lacked an exact fixture; current-target selection invented Windows ARM64 | Added exact serialized budgets, stateful generation-advancing publication probes, changed-after outputs and async probes, exact origin recovery failure, and one canonical unsupported-target path | correction required fresh review |
| `/root/stage_a_cross_contract_dev` | `/root/stage_a_cross_contract_review_2` | Three findings: cache failures remained scenario-forced instead of tuple-driven; issue clearing incorrectly released the cache and invented `cache_generation`; the build allowance was not an enforced inner deadline | Replaced forced failures with shared-state mutation and guard comparison, separated issue clearing from modeled daemon catch-up completion, removed durable `cache_generation`, and isolated `Bun.build` in a deadline-bound kill/reap worker with an exact timeout test | correction required fresh review |
| `/root/stage_a_cross_contract_dev` | `/root/stage_a_cross_contract_review_3` | Five findings: an internal invented cache generation remained; keyword search mutation preceded a real async yield; publication evidence omitted seeded issues and full pending ownership/post-verify snapshots; missing identity was rewritten only on return; contract/cross review lineage was absent | Removed every cache-generation seed/model field; changed only production-shaped cache identity after an explicit microtask yield; added seeded initial, full pending owner, post-verify, and separate finish snapshots; made the target and durable publication identity genuinely null; added this exact lineage | correction required fresh review |
| `/root/stage_a_cross_contract_dev` | `/root/stage_a_cross_contract_review_4` | none | n/a | CLEAN — zero findings |

### Stage A proportionate-simplification plan

Read-only planning inputs: `stage_a_maintainability_audit` and
`a_secure_runtime_zero_review_4`. Consolidation agent:
`stage_a_simplification_consolidate`. Independent plan reviewers:
`stage_a_simplification_plan_review_a` and
`stage_a_simplification_plan_review_b`.

| Round | Review | Findings | Resolution / result |
|---|---|---|---|
| 1 | both independent reviewers | Impossible S2 compare-and-swap claim; ambiguous ACL child/receipt contract; unowned S3 release evidence and S4 ledger changes; unspecified hook/API deletion; incomplete legacy blocker and S3/S4 handoff; S1/S2 resolver dependency; platform-evidence gaps; masked lock errors | Consolidator rewrote ownership, algorithms, API removals, evidence boundaries, and lock/error behavior |
| 2 | reviewer A and reviewer B | A approved; B found daemon cleanup caller/order, nonrecursive per-root ACL receipt behavior, and omitted lock-publish/stale legacy forms | Added exact daemon handoff/order, per-root receipt lifecycle, and legacy-artifact forms |
| 3 | reviewer A and reviewer B | B approved; A found a successor-heartbeat clearing race and omitted `.remove-<48hex>` legacy captures | Added conditional owner clearing before lock release and exact cleanup-capture patterns |
| 4 | both independent reviewers | none | APPROVED — zero findings from both reviewers |

### S-DATE ownership and lineage

Development agent: `s_date_dev`.

Owned files:

- `src/sync/daemon.ts`
- `tests/sync/daemon.test.ts`

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `s_date_dev` | `s_date_review` | none | Replaced invented missing meeting timestamps with an observable per-meeting invariant failure; unrelated meetings continue | CLEAN — zero findings |

After this clean result, both files were released for S1's narrowly authorized
daemon-finalization handoff.

### S1 private-runtime-storage ownership and lineage

Development agent: `s1_private_storage_dev`.

Owned files:

- `src/runtime/secure-files.ts`
- `src/runtime/private-json.ts`
- `src/runtime/windows-acl.ts`
- deletion of `src/runtime/unix-at.ts`
- deletion of `src/runtime/windows-process-handle.ts`
- `src/config.ts`
- `src/sana/client.ts`
- `src/store/db.ts`
- `src/sync/lock.ts`
- `src/sync/spawn.ts`
- `tests/runtime/secure-files.test.ts`
- `tests/runtime/secure-session.test.ts`
- `tests/runtime/secure-store.test.ts`
- `tests/runtime/private-json.test.ts`
- `tests/runtime/windows-acl.test.ts`

Authorized amendments after S-DATE released its files:

- `src/sync/daemon.ts` and `tests/sync/daemon.test.ts` for ordered,
  owner-conditional daemon finalization;
- the narrow `src/store/db.ts` conditional daemon-identity clear used by that
  handoff;
- `src/sana/auth.ts`, `src/tools/dispatch.ts`,
  `tests/fixtures/contracts/semantic-spawn.ts`, and
  `tests/fixtures/contracts/daemon-spawn-attempt.ts` only after
  `s1_private_storage_zero_review` found that the now-async spawn boundary could
  falsely report completion or mask pre-spawn cleanup; the amendment covered the
  auth/dispatch/spawn boundaries and preserved truthful completion/error
  behavior.

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `s1_private_storage_dev` | `s1_private_storage_review` | Incorrect `pidAlive` error classification; broad `EEXIST` handling/leak; untyped ACL errors; primary failures masked by cleanup | Tightened classifications and ownership, closed resources, typed ACL failure, and aggregated primary/cleanup errors | correction required fresh review |
| `s1_private_storage_dev` | `s1_private_storage_zero_review` | Stale-lock race; async spawn could falsely succeed and mask pre-spawn cleanup; unbounded JSON; inactive mount-root guard; ACL path filtering | Added explicit recovery/async outcomes, bounded JSON, active root checks, and exact ACL targets; authorized async call-site amendments applied | correction required fresh review |
| `s1_private_storage_dev` | `s1_private_storage_zero_review_2` | Stale takeover TOCTOU and unstable release ownership | Added a serialized recovery gate and stable owner-checked release | correction required fresh review |
| `s1_private_storage_dev` | `s1_private_storage_zero_review_3` | No verdict: reviewer became unresponsive and was interrupted | No review evidence claimed; assigned a fresh reviewer | review discarded |
| `s1_private_storage_dev` | `s1_private_storage_zero_review_4` | Incomplete empty-main/recovery-gate initialization window | Added ready records and bounded retry around initialization | correction required fresh review |
| `s1_private_storage_dev` | `s1_private_storage_zero_review_5` | Final wait attempt was off by one | Corrected the bounded wait boundary | correction required fresh review |
| `s1_private_storage_dev` | `s1_private_storage_zero_review_6` | none | n/a | CLEAN — zero findings |

### S2 client-writer ownership and lineage

Development agent: `s2_client_writer_dev`.

Owned files:

- `src/install/writers.ts`
- `src/install/config-formats.ts`
- `src/install/atomic-config.ts`
- `src/install/legacy-config-artifacts.ts`
- `src/install/detect.ts`
- `src/install/clients.ts`
- `src/install/status.ts`
- `src/install/apply.ts`
- `src/install/install.ts`
- `tests/install/writers.test.ts`
- `tests/install/config-formats.test.ts`
- `tests/install/atomic-config.test.ts`
- `tests/install/legacy-config-artifacts.test.ts`
- `tests/install/detect.test.ts`
- `tests/install/clients.test.ts`
- `tests/install/status.test.ts`
- `tests/install/apply.test.ts`

Authorized amendments:

- `tests/install/install.test.ts` for caller-flow coverage identified during the
  S2 review loop; it was not part of the original exact plan inventory;
- `src/cli.ts` after `s2_client_writer_zero_review_2`, solely to make the
  top-level human CLI boundary render the typed incomplete-config result without
  a stack trace.

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `s2_client_writer_dev` | `s2_client_writer_review` | Dry-run could mutate login state; TOML footer/inline preservation defects; false `All set`; split validation authority; dead builder; missing legacy/atomic/reparse coverage | Made dry-run read-only, repaired preservation and truthful outcomes, centralized validation, removed dead code, and filled boundary coverage | correction required fresh review |
| `s2_client_writer_dev` | `s2_client_writer_zero_review` | Uninstall reported success for incomplete outcomes; inline TOML rewrote unrelated content | Propagated incomplete outcomes and changed inline TOML to target-span preservation | correction required fresh review |
| `s2_client_writer_dev` | `s2_client_writer_zero_review_2` | Temporary-name collision could delete a foreign file; typed CLI failure printed a stack | Made temporary ownership exact and added the authorized human CLI boundary | correction required fresh review |
| `s2_client_writer_dev` | `s2_client_writer_zero_review_3` | Incomplete wizard path still returned success; missing configuration paths were not covered | Unified incomplete exit behavior and added missing-path handling | correction required fresh review |
| `s2_client_writer_dev` | `s2_client_writer_zero_review_4` | Path provenance was optional; unavailable reasons exposed unsanitized paths | Required authoritative provenance and sanitized human-facing path reasons | correction required fresh review |
| `s2_client_writer_dev` | `s2_client_writer_zero_review_5` | `install.path` could throw an untyped error; uninstall name prompt was unsanitized | Added typed validation/error routing and sanitized the prompt | correction required fresh review |
| `s2_client_writer_dev` | `s2_client_writer_zero_review_6` | `runInstall` validated the server name after an earlier side effect | Moved validation before every mutation or prompt-dependent action | correction required fresh review |
| `s2_client_writer_dev` | `s2_client_writer_zero_review_7` | none | n/a | CLEAN — zero findings |

### S3 release/build-contract ownership and lineage

Development agent: `a_secure_runtime_zero_review_2` acting in a development
role for this non-overlapping simplification scope.

Owned files:

- `src/release/contract.ts`
- `src/runtime/build-info.ts`
- `src/install/manifest.ts`
- `release/manifest.schema.json`
- `tests/runtime/build-info.test.ts`
- `tests/install/manifest.test.ts`
- `tests/fixtures/manifest/valid-all-targets.json`
- `tests/fixtures/manifest/invalid-unknown-field.json`

Authorized narrow ownership amendments:

- `tests/contracts/mcp-stdio.test.ts`;
- `tests/contracts/agent-output.test.ts`.

Those amendments were limited to importing the canonical target helper and
updating the explicit compiled-identifier allowlist. S3 did not own output bytes,
frozen fixtures, dispatcher behavior, or containment, and released both files to
S4 after its clean result.

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `a_secure_runtime_zero_review_2` | `s3_release_contract_review` | Ajv was used as an undeclared direct test dependency; separate semver parsing was loose; non-Linux own-build identity accepted undefined libc | Removed the undeclared dependency path, centralized strict version parsing, and made target/libc identity exact | correction required fresh review |
| `a_secure_runtime_zero_review_2` | `s3_release_contract_zero_review` | none | n/a | CLEAN — zero findings |

### S4 proportionate-contract-harness ownership and lineage

Development agent: `s4_contract_harness_dev`.

Owned files:

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
- deletion of `tests/fixtures/contracts/preload-descendant-probe.ts`
- deletion of `tests/fixtures/contracts/daemon-spawn-attempt.ts`
- `docs/dev/contract-change-ledger.md` only for the proportionate isolated-test
  implementation note; protected output baselines and approved behavior entries
  remained unchanged.

Frozen output fixture bytes remained read-only. S4 received the two contract test
files only after S3's narrow target-helper amendments were clean and released.

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `s4_contract_harness_dev` | `s4_contract_harness_review` | MCP accepted invalid pipelining/exit/framing; mini-sandbox remained broad and lost properties; post-kill waits were unbounded; dispatcher calls were not batched and UNC evidence mismatched the platform claim | Enforced exact MCP lifecycle/framing, reduced guards while preserving properties, bounded termination waits, batched dispatcher execution, and aligned UNC evidence with the claim | correction required fresh review |
| `s4_contract_harness_dev` | `s4_contract_harness_zero_review` | Guard probe mutated state; initialization response shape was unchecked | Made the probe observational and asserted the complete initialization shape | correction required fresh review |
| `s4_contract_harness_dev` | `s4_contract_harness_zero_review_2` | Capabilities/server identity were not exact; an early second phase was accepted; premature-exit waits consumed the timeout | Froze exact identity/capabilities, enforced phase ordering, and made exit waits fail promptly within the bound | correction required fresh review |
| `s4_contract_harness_dev` | `s4_contract_harness_zero_review_3` | Extra initialization/serverInfo keys were accepted | Closed the initialization and server-info object shapes | correction required fresh review |
| `s4_contract_harness_dev` | `s4_contract_harness_zero_review_4` | none | n/a | CLEAN — zero findings |

### A-SECURE-SURVIVING ownership and lineage

Development agent: `a_secure_surviving_dev`.

Owned files:

- `src/runtime/env.ts`
- `src/core/login.ts` only for numeric-environment integration
- `src/semantic/semantic.ts`
- `src/core/status.ts`
- `package.json`
- `bun.lock`
- `tsconfig.json`
- `tests/runtime/env.test.ts`
- `tests/runtime/semantic-capability.test.ts`

The correction after `a_secure_surviving_zero_review_2` received narrow
ownership of `src/core/search.ts` only to propagate transcript-store corruption
as a truthful typed search degradation. This successor review maps the original
A-SECURE environment, login, semantic lifecycle/status, dependency, lockfile,
TypeScript, and focused-test surface to a clean maintained implementation; it
does not revive the S1-deleted helper/FFI architecture.

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `a_secure_surviving_dev` | `a_secure_surviving_review` | Embedding vector shape/dimension was not validated; lifecycle cached a rejected initialization, mishandled its timer, and exposed untyped dependencies | Validated vector structure/dimensions and made lifecycle retry, timer cleanup, and dependencies typed and explicit | correction required fresh review |
| `a_secure_surviving_dev` | `a_secure_surviving_zero_review` | Not every schema failure became a typed unavailable result | Mapped every validated schema-failure path to the typed unavailable boundary | correction required fresh review |
| `a_secure_surviving_dev` | `a_secure_surviving_zero_review_2` | A generic SQLite-lookalike error was misclassified; transcript corruption was swallowed | Narrowed SQLite classification and made the authorized `src/core/search.ts` propagation change | correction required fresh review |
| `a_secure_surviving_dev` | `a_secure_surviving_zero_review_3` | Error detail was trimmed instead of preserving the exact authoritative message | Preserved the exact message without invented or normalized fallback text | correction required fresh review |
| `a_secure_surviving_dev` | `a_secure_surviving_zero_review_4` | none | n/a | CLEAN — zero findings |

### A-CROSS-CONFIGURER current evidence

Development and correction agent for every round:
`/root/s2_client_writer_zero_review`.

The original agent reconstructed the following exact allocation from its own
patches and handoffs, not from the current diff. Numeric line ranges are not
retained and therefore are not claimed.

Owned production portions:

- `src/install/install.ts`: the prompt-driver and cancellation adapter
  (`InstallInteraction.promptDriver`,
  `ClientConfigurationCancellationStage`,
  `ClientConfigurationCancelledError`, `normalizePromptCancellation`, the
  production prompt wrappers and uninstall chooser, and the install/login/
  uninstall cancellation catches); the structured configurer-auth state,
  observation, operation-error, partial-result, stable-readiness, session
  inspection, login rendering, and request/verify adapter portions; and only
  the imports required by those portions;
- `src/install/presentation.ts`: `ConfigurerPromptContext`, retention of the
  injected terminal/output, and `promptContext`, `promptTheme`, and
  `checkboxTheme`;
- `src/install/wizard-prompt.ts`: the hidden-client empty-state wording and
  the visible `Not detected (manual opt-in)` divider only.

Owned test portions:

- `tests/install/configurer-flow.test.ts`: the full-result/auth-state fakes and
  session/sync helpers; the structured publication/request/verify, stable
  inspection/churn/identity/transition, malformed-state, authoritative
  guidance, injected prompt-runtime, and Ctrl+C cases; and the corresponding
  updates to failure/aggregate/cleanup and sync-unavailable assertions;
- `tests/install/presentation.test.ts`: the injected-stream/shared
  ASCII/no-color prompt-runtime test and its `PassThrough` import;
- `tests/install/wizard-prompt.test.ts`: only the hidden-client copy
  expectation;
- `tests/install/install.test.ts`: the `InstallInteraction` import,
  `captureInteraction`, and replacement of `console.log` interception with
  injected terminal/output capture in the four named foreign-cursor,
  incomplete-wizard, hostile-uninstall-name, and invalid-install-name cases.

Explicit exclusions and handoffs:

- the agent did not author the surrounding discovery/apply/remove planning,
  result-description, registration-collection, or original overall
  install/uninstall flow beyond the adapter/cancellation portions above;
- it did not author the pre-existing presentation sanitization core, the
  wizard reveal/select or Esc/q mechanics, or the remaining install tests;
- `/root/stage_a_cross_daemon_dev` owned the request/verify core error/result
  unions and publication/session/store/daemon behavior consumed by this
  adapter; the configurer agent did not own those core files;
- its config-batch API proposal was a handoff only and did not grant ownership
  of transaction/core files.

Final adapter validation retained by the original agent: 38/38 related tests
on Linux, 38/38 under native Windows, typecheck clean, and diff check clean.
Earlier checkpoints were 21/21, 30/30, and 35/35. Exact historical line
ranges, every intermediate reviewer identity, and authorship of neighboring
shared code are not provable and are not inferred here.

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `/root/s2_client_writer_zero_review` | `/root/stage_a_cross_configurer_review` | Owned uninstall entries disappeared when the executable was absent; foreign/unavailable absence could report false success; nested `AggregateError` causes were masked | Made owned registration removal independently discoverable, kept foreign/unavailable state explicit, and rendered every aggregate child cause | correction required fresh review |
| `/root/s2_client_writer_zero_review` | `/root/stage_a_cross_configurer_review_2` | Unavailable executable detection still hid an owned removal; sync-unavailable output omitted nested causes | Gave proven ownership precedence over unavailable detection and preserved nested sync failure detail | correction required fresh review |
| `/root/s2_client_writer_zero_review` | `/root/stage_a_cross_configurer_review_3` | Detected-present foreign/unavailable registrations were offered/actioned; `auth.close` was mislabeled as sign-in failure; hidden-versus-empty wizard messaging was false | Excluded non-owned/nonactionable targets, separated cleanup failure from sign-in, and distinguished hidden rows from an empty model | correction required fresh review |
| `/root/s2_client_writer_zero_review` | `/root/stage_a_cross_configurer_review_4` | The proposed undetected-actionable defect was rejected because explicit manual opt-in is the approved product contract; valid findings were prompt stream/theme bypass and untyped Ctrl+C | Preserved the approved explicit opt-in behavior, routed prompts through injected streams/theme, and normalized cancellation to a typed path | correction required fresh review |
| `/root/s2_client_writer_zero_review` | `/root/stage_a_cross_configurer_review_5` | Existing auth publication could be falsely called ready; request/verify copy was operation-blind; tests still assumed `console.log` after the presentation sink changed | Required authoritative publication readiness, made request/verify messages operation-specific, and updated tests to the structured presentation sink | correction required fresh review |
| `/root/s2_client_writer_zero_review` | `/root/stage_a_cross_configurer_review_6` | Session/store snapshot was unstable; invented `AUTH_TRANSITION_PENDING` and invalid pending state were accepted; request-code remote outcome was false; issue guidance was discarded | Added stable snapshot verification, rejected invented/invalid pending state, distinguished request remote outcomes, and retained authoritative guidance | correction required fresh review |
| `/root/s2_client_writer_zero_review` | `/root/stage_a_cross_configurer_review_7` | Full user/workspace identity tuple was omitted; verify remote/local phases were missing; cleanup-only request copy was false | Compared the complete identity tuple, separated verify remote acceptance from local transition, and corrected cleanup-only request wording | correction required fresh review |
| `/root/s2_client_writer_zero_review` | `/root/stage_a_cross_configurer_review_8` | none | n/a | CLEAN — zero findings for that state |
| `/root/s2_client_writer_zero_review` | historical review-trigger identity was not preserved and is not now provable; non-gating predecessor state | The auth result union still required its final transaction/configurer adapter integration after the prior clean state | Integrated the final typed auth union adapter; because code changed, review 8 was not reused | historical intermediate state; superseded by `/root/stage_a_cross_configurer_review_9` CLEAN |
| `/root/s2_client_writer_zero_review` | `/root/stage_a_cross_configurer_review_9` | none | n/a | CLEAN — zero findings; final current configurer state |

### A-CROSS-DAEMON-AUTH current evidence

Development and correction agent for every round:
`/root/stage_a_cross_daemon_dev`.

The original agent reconstructed the following allocation from its retained
implementation/handoff record. It describes owned portions through
`/root/stage_a_cross_daemon_review_10`, not current whole-file exclusivity.
Exact historical line ranges and pre-existing neighboring lines are not
provable and are not claimed.

Owned production portions:

- `src/sync/lock.ts`: daemon lease acquisition/renewal, PID/liveness and
  stale-live classification, and owner-loss/stale-owner errors;
- `src/sync/spawn.ts`: tuple/heartbeat readiness, concurrent-winner handling,
  bounded polling and cleanup, and losing-child terminate/escalate/reap paths;
- `src/sync/daemon.ts`: full auth-cycle identity, lease/heartbeat fencing,
  stale-cycle failure currency, and finalization;
- `src/store/db.ts`: daemon lease/recovery, auth publication source/target CAS
  and transitions, sync/cache guards, durable current-tuple sync failure,
  coherent status/count support, malformed tuple validation, and
  `needs_login` retirement;
- `src/sana/client.ts`: persisted session/version identity, publication
  save/rollback, partial-legacy and origin-reset handling, attempt cookies,
  exact-origin/loopback policy, bounded HTTP, strict responses, and redirect
  method/status/header/cookie semantics;
- `src/sana/session-publication.ts`: serialized publication coordination,
  source claim, target publication, confirmation/observation, tuple comparison,
  and stale/busy/recovery/rollback outcomes;
- `src/sana/auth.ts`: request/verify fencing, cookies, publication, truthful
  preflight/remote/local/confirmed-sync outcomes, cleanup, and durable
  sync-unavailable recording;
- `src/tools/dispatch.ts`: stable authorization refresh, cache-operation
  coupling and fences, stale CAS, status dispatch, and exact tuple-bound
  ephemeral persistence issues;
- `src/core/status.ts`: paired bounded status snapshots, auth/cache coherence,
  metric suppression, current/previous issue selection, and exact ephemeral
  binding;
- `src/core/search.ts`, `src/core/meetings.ts`, and
  `src/semantic/semantic.ts`: cache-operation change propagation and the named
  post-await/synchronous operation fences.

Owned test portions:

- `tests/sync/daemon.test.ts`, `tests/sana/auth.test.ts`,
  `tests/sana/auth-request.test.ts`,
  `tests/sana/session-publication.test.ts`, and `tests/sana/client.test.ts` for
  the corresponding lease/readiness, publication, fencing, cookie, response,
  origin, and redirect paths;
- `tests/runtime/secure-store.test.ts` and
  `tests/runtime/secure-session.test.ts` for tuple/CAS/cache guards, durable
  failure currency, session publication, partial legacy, and origin reset;
- `tests/runtime/semantic-capability.test.ts`,
  `tests/core/status-auth.test.ts`, and `tests/tools/dispatch-auth.test.ts` for
  semantic fences, paired status/coherence/issues, refreshed authorization,
  stale sync CAS, and ephemeral persistence classification/binding.

Explicit exclusions and handoffs:

- contract fixtures/schema adaptations were handed to
  `/root/stage_a_cross_contract_dev`; this agent did not own
  `tests/fixtures/contracts/**`;
- configurer and transaction consumers were handed to their owners; this agent
  did not own `src/install/**`, `src/cli.ts`, or `tests/install/**`;
- protected agent-facing output remained with the contract/configurer scopes;
- no ownership is claimed for plausible neighbors including
  `src/sana/cookies.ts`, `src/core/login.ts`, `src/daemon-main.ts`, or
  `tests/core/meetings.test.ts`.

Final validation retained by the original agent: 99/99 across its ten focused
test files on Linux and 99/99 through native Windows PowerShell/UNC execution;
typecheck and diff checks clean. Fresh
`/root/stage_a_cross_daemon_review_10` returned zero findings.

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `/root/stage_a_cross_daemon_dev` | `/root/stage_a_cross_daemon_review` | Live stale lease could be taken over; auth was saved before its gate and partial success was false; losing child was not reaped; dispatch read stale state | Bound lease ownership, ordered auth gating/publication, reaped the losing child, and refreshed dispatch state | correction required fresh review |
| `/root/stage_a_cross_daemon_dev` | `/root/stage_a_cross_daemon_review_2` | Concurrent login publication race; no forced-kill/final reap; lingering timer; contract evidence missing | Serialized publication, added bounded terminate/reap and timer cleanup, and supplied contract evidence | correction required fresh review |
| `/root/stage_a_cross_daemon_dev` | `/root/stage_a_cross_daemon_review_3` | Stale daemon/request-code session writers; confirmation failure produced partial/wedged state; PID+wall-clock identity; `lastUsedWorkspace` fallback; abandoned transition unobservable | Fenced writers and confirmation, replaced weak identity/fallback state, and made abandoned transition observable | correction required fresh review |
| `/root/stage_a_cross_daemon_dev` | `/root/stage_a_cross_daemon_review_4` | Live publication observer was not confirmed; invalid code borrowed an old cookie; TRPC/malformed responses became false empty success; account cache/generation writes were unfenced; dispatch auth was unstable; malformed SQLite tuple accepted; sync-unavailable/status was nondurable/repeated; HTTP lacked timeout | Added confirmed observation, attempt-bound cookies, strict response/error handling, generation fences, stable auth tuples, durable status, and bounded HTTP | correction required fresh review |
| `/root/stage_a_cross_daemon_dev` | `/root/stage_a_cross_daemon_review_5` | Full identity binding incomplete; refresh recovery stayed blocked; cookies were origin-unbound and redirects crossed origin; authorization bypassed cache operation; writes lacked generation coordination; status persistence failed; phase/rollback claims and contract copy were false | Bound complete identity/origin/redirect/cache/generation state, repaired recovery and persistence, and aligned phase, rollback, and contract wording | correction required fresh review |
| `/root/stage_a_cross_daemon_dev` | `/root/stage_a_cross_daemon_review_6` | Intent/cycle lacked token/source tuple; origin-reset client stayed stale; async guard committed before await; status was mixed/early; cleanup overrode outcome; Busy/Stale branches were unreachable; punctuation/rejections duplicated | Carried the full tuple, refreshed origin reset, fenced after await, delayed coherent status, preserved primary outcome through cleanup, made Busy/Stale reachable, and deduplicated presentation | correction required fresh review |
| `/root/stage_a_cross_daemon_dev` | `/root/stage_a_cross_daemon_review_7` | Stale confirmed login was called partial; `needs_login` was not retired; status/cache metrics mixed; ephemeral issue was masked; semantic post-await fence missing; partial legacy tuple dead-ended | Corrected stale/partial truth, retired login state, made metrics/issues coherent, added post-await semantic fencing, and gave legacy state a typed recovery path | correction required fresh review |
| `/root/stage_a_cross_daemon_dev` | `/root/stage_a_cross_daemon_review_8` | Stale daemon failure was labeled current; generationless pending legacy could not reset; loopback HTTP policy was inconsistent | Tuple-bound failure currency, allowed safe legacy reset, and unified loopback HTTP policy | correction required fresh review |
| `/root/stage_a_cross_daemon_dev` | `/root/stage_a_cross_daemon_review_9` | Redirect method/status semantics were incomplete; ephemeral failure was not tuple-bound | Enforced redirect method/status rules and bound ephemeral failure to the authoritative tuple | correction required fresh review |
| `/root/stage_a_cross_daemon_dev` | `/root/stage_a_cross_daemon_review_10` | none | n/a | CLEAN — zero findings |

### A-CONFIG-TRANSACTION-CROSS ownership and lineage

Development and correction agent:
`/root/stage_a_config_batch_dev`.

Exact owned files:

- `src/install/config-transaction.ts`
- `src/install/atomic-config.ts`
- `src/install/error-text.ts`
- `src/install/writers.ts`
- the installer-transaction/auth adapter in `src/install/install.ts`
- the hidden transaction adapter in `src/cli.ts`
- `tests/install/config-transaction.test.ts`
- `tests/install/config-transaction-flow.test.ts`
- `tests/install/atomic-config.test.ts`
- `tests/install/writers.test.ts`
- `docs/dev/configurer-transaction-handoff.md`

The retained record before review 7 proves the following corrected findings,
but does not preserve their exact individual reviewer IDs or round mapping.
They remain recorded as a consolidated pre-round lineage rather than being
attributed to invented agents:

- preflight was not fully side-effect-free and did not reject invalid receipt
  leaves before selection/no-mutation paths;
- submitted desired state and planned no-ops were not revalidated at every
  mutation/receipt boundary;
- journal parsing, target/image/digest invariants, durable publication,
  rollback terminal states, and persistence-unknown outcomes were incomplete;
- unattended status discovery, phase attribution, auth cleanup, batch
  cardinality/provenance, and missing-batch invariants were incomplete;
- Windows publication/removal retry revalidation and nested aggregate-error
  observability were incomplete.

The correction established side-effect-free preflight, complete desired-set
replanning, exact no-op revalidation, strict receipt parsing and semantic
invariants, durable/ambiguous/persistence-unknown journal outcomes, stable
compensation states, authoritative unattended status, explicit auth phases,
full batch provenance, bounded Windows retry with optimistic-image rechecks,
and bounded nested-error rendering. Exact reviewer identities for those earlier
historical corrections were not preserved and are not now provable. Those
predecessor states are non-gating; no invented identities are presented.

Every row below is an exact fresh read-only review after the preceding
correction. Later nominal-authority changes supersede the earlier
shape-matching implementations while preserving their required behavior.

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `/root/stage_a_config_batch_dev` | `/root/stage_a_config_batch_dev/stage_a_config_batch_review_7` | Confirmed/skipped `auth.close` cleanup failures were classified as presentation failures | Added a cleanup-specific result that preserves the authoritative config batch and retained/skipped auth without rollback | correction required fresh review |
| `/root/stage_a_config_batch_dev` | `/root/stage_a_config_batch_dev/stage_a_config_batch_review_8` | Recursive cancellation search accepted cancellation-shaped errors nested inside operation or cleanup causes | Restricted cancellation authority to the direct Sana prompt-cancellation/cleanup relationship and added applied/no-mutation negative cases | correction required fresh review |
| `/root/stage_a_config_batch_dev` | `/root/stage_a_config_batch_dev/stage_a_config_batch_review_9` | Recursive cleanup search and raw aggregate acceptance let open/request/verify/observer errors impersonate the real session-close failure | Removed recursive mining and raw-aggregate authority, provenance-wrapped session-open errors, and added cross-source applied/no-mutation cases | correction required fresh review |
| `/root/stage_a_config_batch_dev` | `/root/stage_a_config_batch_dev/stage_a_config_batch_review_10` | Failure rendering could replace the authoritative auth/cleanup envelope and change compensation/auth truth | Constructed authority before rendering and recorded rendering failure separately with primary and cleanup causes preserved | correction required fresh review |
| `/root/stage_a_config_batch_dev` | `/root/stage_a_config_batch_dev/stage_a_config_batch_review_11` | Four findings: falsy thrown values could become success; inner raw aggregates could mimic close authority; session-open rendering could replace open authority; cleanup results omitted primary flow detail and could falsely claim completion | Introduced a private nominal `MaybeLoginOutcomeError`, presence-based failure tracking and typed non-`Error` normalization; carried only the real close/open failures; guarded rendering; included primary, cleanup, and presentation detail without claiming partial completion | correction required fresh review |
| `/root/stage_a_config_batch_dev` | `/root/stage_a_config_batch_dev/stage_a_config_batch_review_12` | Publicly constructible cancellation and partial-authentication errors could still forge skipped/retained authority | Added a private prompt-cancellation signal and explicit private auth disposition set only by controlled skip/confirmation milestones; adapter classification stopped trusting public semantic error classes | correction required fresh review |
| `/root/stage_a_config_batch_dev` | `/root/stage_a_config_batch_dev/stage_a_config_batch_review_13` | Two findings: outer completion/cancellation failures still gained authority from public `phase.current`; atomic post-publication mode verification used host `process.platform` instead of injected operations | Added a private validated success-authority token and branded wrappers for outer completion/cancellation failures; removed phase authority fallback; made mode verification use `operations.platform` with fake Windows/POSIX cross-host cases | correction required fresh review |
| `/root/stage_a_config_batch_dev` | `/root/stage_a_config_batch_dev/stage_a_config_batch_review_14` | none; reviewer also assessed two intermittent native-Windows `journal-persistence-unknown` results and found them consistent with bounded external `EPERM`/`EBUSY` contention rather than a cleanup/concurrency/resource leak | The truthful uncertainty result was preserved; isolated and later full native-Windows runs were clean | CLEAN — zero findings |

Final validation recorded for the clean transaction state: Linux install suite
237/237; native Windows 230 passed with 7 expected POSIX-only skips after a
clean standalone rerun; TypeScript and diff checks clean. Two earlier Windows
full runs each returned a different truthful journal-persistence uncertainty;
they are evidence, not hidden or converted to success.

### A-CROSS-RELEASE-INTEGRATION evidence

Development and correction agent:
`/root/stage_a_cross_release_dev`.

Exact reviewed release-chain mutation inventory and ownership handoffs follow.
Shared entries identify only the authorized portions named here; they do not
claim whole-file current exclusivity after the scope released its files to the
then-future whole-Stage-A review. That historical handoff was superseded by the
later exact whole-stage CLEAN review
`/root/s2_client_writer_zero_review/stage_a_post_correction_adversarial`.

Release-integration-owned files and portions:

- `.github/workflows/release.yml`;
- `install.sh`;
- `install.ps1`;
- the one-line install, upgrade, distribution, and release documentation in
  `README.md`;
- the release/package declaration in `package.json`;
- deletion of the obsolete `package-lock.json`, leaving `bun.lock` as the
  authoritative lockfile;
- removal from `bun.lock` of the stale direct root dependency on
  `@inquirer/ansi`; its valid transitive entries remain. A-SECURE-SURVIVING
  retained ownership of unrelated dependency/lockfile state;
- `release/semver-corpus.json`;
- `scripts/release.ts`;
- `tests/install/installers.test.ts`;
- `tests/release/release.test.ts`.

The release/build contract files below originated in A-RELEASE-CONTRACT and
were then owned and cleaned by S3. Release integration received them after the
S3 clean handoff solely for the canonical target, tag, asset, protocol,
standalone-build, inspection, and publication-chain amendments reviewed here:

- `src/release/contract.ts`;
- `src/install/manifest.ts`;
- `release/manifest.schema.json`;
- `tests/install/manifest.test.ts`;
- `tests/fixtures/manifest/valid-all-targets.json`;
- `tests/fixtures/manifest/invalid-unknown-field.json`;
- the release identity, protocol markers, explicit compile-target path, and
  standalone inspection serialization in `src/runtime/build-info.ts`;
- the corresponding release/build protocol coverage in
  `tests/runtime/build-info.test.ts`.

That successor ownership did not reopen unrelated surviving runtime behavior or
the protected LLM-facing contract outputs. The complete current release chain,
including these predecessor files, was reviewed by the release-integration
reviewers below before its historical handoff to whole-Stage-A review. That
handoff was superseded by the later exact whole-stage CLEAN review
`/root/s2_client_writer_zero_review/stage_a_post_correction_adversarial`.

Two additional files were shared at narrower protocol boundaries:

- in `src/cli.ts`, this scope owned the standalone `__inspect` and
  `__lifecycle` release-protocol adapters only. S2 retained its human CLI error
  boundary, and A-CONFIG-TRANSACTION-CROSS retained the hidden
  `__configure-transaction` adapter;
- in `docs/dev/configurer-transaction-handoff.md`, this scope owned the
  release-installer sequencing/consumption statements only.
  A-CONFIG-TRANSACTION-CROSS retained the structured transaction, journal,
  rollback, authentication, and result-contract specification.

The config-transaction implementation remained owned by
A-CONFIG-TRANSACTION-CROSS. After that scope returned a clean transaction
contract, release integration consumed it only through the documented CLI
protocol in `install.sh`, `install.ps1`, the release-side handoff statements,
and installer tests. Earlier A-RELEASE-CONTRACT, S3, and config-transaction
clean reviews do not substitute for the integrated release gate recorded
below.

The corrected inventory above also records a documentation-evidence correction
that must not be confused with the clean code review below:

| Finding review | Findings | Subsequent correction | Fresh result |
|---|---|---|---|
| `/root/stage_a_release_ledger_review_3` | The exact release inventory omitted deletion of `package-lock.json`, the direct-root cleanup in `bun.lock`, the manifest source/tests/fixtures, build-info source/test, the CLI release-protocol portion, and the release statements in the configurer handoff | `/root/stage_a_release_ledger_fix_2` corrected this ledger only, preserving narrow shared-file boundaries and predecessor/successor handoffs; the inherited chronology was then corrected without changing code or ownership | `/root/stage_a_cross_posix_path_dev`: CLEAN — zero findings after the chronology correction |

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `/root/stage_a_cross_release_dev` | `/root/stage_a_cross_release_review_1` | Replacement was destructive/nontransactional; mutable tag/SHA TOCTOU; mutable actions/container dependencies; noncanonical assets; unchecked latest projection; unsafe/unreliable PATH; divergent SemVer; package/npm/docs contradiction | Made replacement transactional, pinned source/actions/container authority, canonicalized assets/latest projection, bounded PATH publication, unified SemVer, and aligned package/docs claims | correction required fresh review |
| `/root/stage_a_cross_release_dev` | `/root/stage_a_cross_release_review_2` | Configurer-started daemon broke rollback; POSIX PATH update was non-atomic; shared PATH state was stale/concurrent; draft publication was non-resumable; profile fallback was missing | Journaled daemon intent, made PATH publication atomic/serialized, added resumable draft state, and made profile selection explicit | correction required fresh review |
| `/root/stage_a_cross_release_dev` | `/root/stage_a_cross_release_review_3` | Configurer boundary was unjournaled and depended on the transaction scope; advertised `curl | sh` could falsely succeed; final POSIX PATH lacked compare-and-swap; release resume omitted title/prerelease metadata | Completed the independent release corrections for one-line failure propagation, final PATH revalidation, and resumable metadata; configurer transaction wiring was handed to the transaction scope | historical integration handoff; superseded by the recorded release reviews through `/root/stage_a_release_final_review_5` CLEAN |
| `/root/stage_a_cross_release_dev` | `/root/stage_a_cross_release_review_4` | TTY handling contradicted the documented deferral contract; rollback could restore the old binary after the replacement had touched live state; Windows accepted `;` in an install directory; transaction parsing lacked the complete semantic matrix; an already-present PATH entry was falsely reported as added | Made noninteractive deferral and interactive configuration explicit, retained the replacement runtime after live-state access, rejected noncanonical Windows paths including `;`, enforced the complete typed transaction matrix, and distinguished verified PATH state from a newly added entry | correction required fresh review |
| `/root/stage_a_cross_release_dev` | `/root/stage_a_cross_release_review_5` | POSIX lock ownership could race cleanup; a failed transaction response could claim authentication ready; a Linux-only release test was not gated | Bound cleanup to the exact lock token, rejected ready authentication for failed outcomes, and explicitly gated the platform-specific test | correction required fresh review |
| `/root/stage_a_cross_release_dev` | `/root/stage_a_cross_release_review_6` | Rollback reconciliation reused a stale `locks_owned` snapshot | Refreshed exact install/PATH lock ownership across rollback reconciliation and before dependent mutation | correction required fresh review |
| `/root/stage_a_cross_release_dev` | `/root/stage_a_cross_release_dev/monotonic_cleanup_review` | Retained summary: cleanup could continue tail mutations after ownership loss; ownership was not refreshed after the final managed-PATH hash check; the test did not prove that later mutations stopped | Made cleanup ownership loss monotonic, refreshed exact tokens at the publication/cleanup boundary, and added deterministic mutation-gating evidence | correction required fresh review |
| `/root/stage_a_cross_release_dev` | `/root/stage_a_cross_release_dev/monotonic_cleanup_rereview` | After retracting same-user hostile-mutation concerns as outside the proportional local-installer model, the reviewer retained one low finding: final PATH-sync cleanup refresh was conditional | Made the final cleanup-tail ownership refresh unconditional at the defined boundary | correction required fresh review |
| `/root/stage_a_cross_release_dev` | `/root/stage_a_cross_release_dev/cleanup_final_review` | One low code-smell finding: the old `locks_owned` variable was unused | Removed the dead snapshot variable | correction required fresh review |
| `/root/stage_a_cross_release_dev` | `/root/stage_a_cross_release_dev/release_regression_clean_review` | Tail ownership refresh/release helpers could report success after completed-journal ownership loss; PowerShell retained an unreachable duplicate rollback block | Made an acquired-but-unowned release fail, refreshed after completed-journal removal before final release, gated the remaining cleanup tail, added deterministic token-loss evidence, and removed the duplicate rollback block | correction required fresh review |
| `/root/stage_a_cross_release_dev` | `/root/stage_a_cross_release_dev/installer_release_last_review` | The outer PowerShell `exit 1` used by the advertised `irm ... \| iex` path could terminate the caller's host | Replaced it with a caller-catchable terminating `InvalidOperationException`, retained a nonzero direct `-File` exit, and preserved finalization | correction required fresh review |
| `/root/stage_a_cross_release_dev` | `/root/stage_a_release_final_review_2` | Two findings: IEX execution leaked error/progress preferences, functions, variables, and script state into the caller; sequential unguarded PowerShell cleanup could skip later targets and mask the primary failure | Wrapped installer execution in a child scope, removed the script-scope assignment, and added independent `Invoke-InstallerCleanup` attempts with aggregated cleanup context that preserves the primary failure | correction required fresh review |
| `/root/stage_a_cross_release_dev` | `/root/stage_a_release_final_review_3` | Three findings: caller `LASTEXITCODE` leaked; fallible rollback `Test-Path` observations could mask the primary failure; POSIX EXIT cleanup could short-circuit and replace the primary status | Snapshotted and restored the exact `LASTEXITCODE` value or absence, guarded and aggregated rollback observations, and made POSIX cleanup capture the original status, disable errexit, attempt every cleanup independently, report cleanup context, and retain recoverable state | correction required fresh review |
| `/root/stage_a_cross_release_dev` | `/root/stage_a_release_final_review_4` | Two findings: PowerShell 7 with `PSNativeCommandUseErrorActionPreference=true` could bypass typed apply/rollback exit handling; POSIX lock-token establishment failure could leave stale install/PATH locks | Locally disabled the native-command preference inside the isolated installer scope while preserving the caller value, and separated lock-directory, token, and acquired state so setup failures receive symmetric immediate and EXIT cleanup without premature ownership claims | correction required fresh review |
| `/root/stage_a_cross_release_dev` | `/root/stage_a_release_final_review_5` | none | n/a | CLEAN — zero findings; final current release/install integration |

Final current validation: `bun test tests/install/installers.test.ts
tests/release/release.test.ts` passes 37/37 on Linux and 36/37 with the one
intentional Linux-only publication-resume skip under native Windows Bun and
PowerShell 5.1. The final gate also retained successful PowerShell 5.1 parsing,
POSIX shell syntax, TypeScript, build, and diff checks from the correction
rounds.

Release/install integration and its corrected inventory are clean. The later
whole-review findings, correction loops, and final fresh-review gates are
recorded below.

### Whole-Stage-A adversarial review 2 correction lineage

`/root/stage_a_whole_cross_review_2` returned six findings. They were allocated
without broadening the named correction scopes:

| # | Severity and finding | Correction owner | Resolution |
|---|---|---|---|
| 1 | HIGH — an explicitly malformed `workspace_id` could still route through the saved workspace | `/root/stage_a_cross_data_args_dev` | Preserved supplied-value presence through the auth/client API and rejected malformed explicit routing instead of falling back |
| 2 | HIGH — corrupt transcript, notes, participants, and segment data could become successful empty/none results or invented `Topic`, `0:00`, and timestamp-zero values | `/root/stage_a_cross_data_args_dev` | Added missing-versus-empty artifact states and complete runtime schemas; corrupt or unavailable artifacts stay observable |
| 3 | MEDIUM — invalid pagination, date/status filters, timestamps, and line selections were coerced or dropped | `/root/stage_a_cross_data_args_dev` | Centralized pure pre-I/O argument validation for canonical tools and aliases and passed the canonical list maximum through storage |
| 4 | MEDIUM — the README Windows `irm ... \| iex` bootstrap was outside the bounded HTTPS, redirect, and timeout policy | `/root/stage_a_cross_windows_bootstrap_dev` | Bounded and validated the advertised PowerShell bootstrap body/redirect/download path, including PowerShell 5 behavior and encoding |
| 5 | LOW — the Bun Windows-ACL `{ skip }` form did not actually skip that test on WSL | `/root/stage_a_cross_windows_bootstrap_dev` | Changed the platform gate to effective `skipIf`, preserving an explicit intentional skip |
| 6 | LOW — the remediation plan still claimed a `bun-windows-arm64` target | `/root/stage_a_cross_windows_bootstrap_dev` | Corrected the plan to the authoritative seven-target release set and WSL behavior |

The data/argument correction was reviewed afresh after every round:

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `/root/stage_a_cross_data_args_dev` | `/root/stage_a_cross_data_args_review` | Explicit supplied `undefined` workspace still fell back; list limits above 1000 disagreed with the store clamp; missing failed artifacts rendered absence; summary fields were unvalidated; partial participants invented blank/`host:no`; validation ran after daemon/sync effects | Preserved argument presence, centralized the store maximum, separated missing/empty/corrupt artifacts, validated complete summary/participant shapes, and moved validation before I/O | correction required fresh review |
| `/root/stage_a_cross_data_args_dev` | `/root/stage_a_cross_data_args_review_2` | Preflight was incomplete for unknown/help requests, invalid email, missing query, and missing IDs | Added one pure registry covering every canonical tool and legacy alias before runtime work | correction required fresh review |
| `/root/stage_a_cross_data_args_dev` | `/root/stage_a_cross_data_args_review_3` | Malformed confirmation codes were accepted | Required an exact six-ASCII-digit string or integer in 100000..999999 before I/O | correction required fresh review |
| `/root/stage_a_cross_data_args_dev` | `/root/stage_a_cross_data_args_review_4` | Finite but non-renderable timestamps and whitespace-padded user/workspace IDs were accepted | Required renderable Date epochs and canonical identities before adoption | correction required fresh review |
| `/root/stage_a_cross_data_args_dev` | `/root/stage_a_cross_data_args_review_5` | `me` mutated cookies before rejecting a malformed response; persisted-session and participant identifier schemas disagreed | Restored the complete client state including cookies on failure and unified canonical identifier validation | correction required fresh review |
| `/root/stage_a_cross_data_args_dev` | `/root/stage_a_cross_data_args_review_6` | Store publication/session/cycle/confirmed-auth invariants accepted padded IDs | Reused one no-surrounding-space predicate while preserving documented paired nulls | correction required fresh review |
| `/root/stage_a_cross_data_args_dev` | `/root/stage_a_cross_data_args_review_7` | Durable generation-zero state allowed non-null identity | Required generation-zero token, user, and workspace to be null or surfaced `AUTH_STATE_MALFORMED` | correction required fresh review |
| `/root/stage_a_cross_data_args_dev` | `/root/stage_a_cross_data_args_review_8` | none | n/a | CLEAN — zero findings |

The original data/argument agent attributed these exact portions:

- `src/core/args.ts`: strict argument errors and pagination, limit, date,
  filter, status, read, identifier, and search parsing;
- `src/core/meetings.ts`: strict list input; explicit corrupt/unavailable
  transcript, summary, and participant states; scalar/participant validation;
  and removal of recording/data fallbacks;
- `src/sana/transcript.ts`: typed strict segment, word, and timestamp
  validation while preserving authoritative zero;
- `src/tools/dispatch.ts`: the pure centralized preflight registry/aliases and
  request snapshot, strict per-tool fields, missing/ambiguous input handling,
  six-digit canonical/legacy login codes, and the corresponding handler,
  artifact, and auth-status integration;
- `src/sana/client.ts`: supplied-versus-omitted workspace semantics, strict
  remote metadata/participant/identity/epoch schemas, and transactional
  `me()` rollback including cookies;
- only the request-code presence-preserving shim in `src/sana/auth.ts`;
- only the canonical list maximum and canonical identity/session/publication/
  cycle/confirmed-auth validators, including generation-zero prohibition, in
  `src/store/db.ts`;
- the corresponding exact coverage in `tests/core/args.test.ts`,
  `tests/core/meetings.test.ts`, `tests/sana/transcript.test.ts`,
  `tests/tools/dispatch-args.test.ts`, `tests/sana/client.test.ts`,
  `tests/sana/auth-request.test.ts`, `tests/runtime/secure-session.test.ts`,
  and `tests/runtime/secure-store.test.ts`;
- only the list-maximum mirrors in
  `tests/fixtures/contracts/auth-store.ts` and
  `tests/fixtures/contracts/semantic-store.ts`.

Historical line ranges, commit SHAs, pre-resume untracked-test provenance, and
unrelated co-located portions of dispatch/client/store are not provable and are
not attributed to this scope.

Final data/argument validation: full repository 500 passed, one intentional
skip, zero failed, and 1275 assertions; protected contract tests 28/28 with 528
assertions.

Bootstrap/hygiene ownership was limited to:

- `README.md`;
- only the bootstrap comments in `install.ps1`;
- only the bootstrap scenarios in `tests/install/installers.test.ts`;
- `tests/runtime/windows-acl.test.ts`;
- only the authoritative target rows in `docs/dev/remediation-plan.md`.

The bootstrap/hygiene correction chain was:

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `/root/stage_a_cross_windows_bootstrap_dev` | `/root/stage_a_cross_bootstrap_hygiene_review` | The advertised PowerShell bootstrap bounded connection/redirect handling but not the response body | Added an explicit bounded body-read path and failure propagation | correction required fresh review |
| `/root/stage_a_cross_windows_bootstrap_dev` | `/root/stage_a_cross_bootstrap_review_2` | PowerShell 5 could block during body cancellation and UTF-8 behavior was not covered | Made cancellation/cleanup bounded under PowerShell 5 and added exact UTF-8 coverage | correction required fresh review |
| `/root/stage_a_cross_windows_bootstrap_dev` | `/root/stage_a_cross_bootstrap_review_3` | none | n/a | CLEAN — zero findings |

Final bootstrap/hygiene validation: Linux installer plus ACL tests 261 passed
with one intentional skip; native Windows 255 passed with seven platform-only
skips; PowerShell 5 parsing, typecheck, and diff checks were clean. This chain
also contains the effective WSL `skipIf` correction and the seven-target plan
correction.

### Whole-Stage-A adversarial review 3 correction lineage

`/root/stage_a_whole_cross_review_3` retained two implementation findings plus
the evidence-allocation gate:

The POSIX correction owned only the shell/profile selection and current-shell
presentation portions of `install.sh` and the fresh/upgrade shell matrices in
`tests/install/installers.test.ts`. The authentication correction owned only
`inspectPersistedAuthIssue` and its invariant reuse in `src/store/db.ts`, the
auth-issue status logic in `src/core/status.ts`, the help/blocked presentation
in `src/tools/dispatch.ts`, the direct cases in
`tests/core/status-auth.test.ts` and `tests/tools/dispatch-auth.test.ts`, and
the required store-API doubles in
`tests/fixtures/contracts/auth-store.ts` and
`tests/fixtures/contracts/semantic-store.ts`.

| Severity and finding | Development | Resolution | Fresh review |
|---|---|---|---|
| MEDIUM — POSIX installation mapped every non-bash/zsh or missing `SHELL` to `.profile`, wrote/verified it, and falsely claimed PATH readiness for fish, Nushell, and unknown shells | `/root/stage_a_cross_posix_path_dev` | Restricted automatic startup-file mutation to supported bash/zsh profiles; unsupported/unset shells receive truthful manual guidance and no Added/Verified claim | `/root/stage_a_cross_posix_path_review` found one remaining upgrade issue |
| MEDIUM follow-up — upgrade presentation reused the receipt-owned old profile and falsely reported Verified when the current shell was unsupported or had changed | `/root/stage_a_cross_posix_path_dev` | Separated receipt-owned `path_profile` authority used for validation, rollback, locking, and the next receipt from current-shell presentation; changed/unsupported shells do not mutate or claim readiness | `/root/stage_a_cross_data_args_review_2`: CLEAN — zero findings |
| MEDIUM — corrupt persisted `auth_issue_code`/`auth_issue_message` parity was masked by invented dispatch/status prose, and help read the tuple without reconciliation | `/root/stage_a_config_batch_dev/stage_a_config_batch_review_13` | Added the authoritative `inspectPersistedAuthIssue`, reused it in the store invariant, reconciled help, and made status/blocked presentation surface exact typed `AUTH_STATE_MALFORMED`; healthy pairs remain exact | `/root/stage_a_cross_posix_path_dev`: CLEAN — zero findings |
| Evidence gate — exact configurer and daemon/auth owned portions, exclusions, and handoffs were not yet recorded | original agents `/root/s2_client_writer_zero_review` and `/root/stage_a_cross_daemon_dev`; ledger integration by `/root/stage_a_config_batch_dev/stage_a_config_batch_review_13` | Reconstructed the two allocations above from original patch/handoff records, explicitly leaving unprovable line ranges and neighboring authorship unclaimed; corrected the inherited chronology without changing code or authorship | `/root/stage_a_cross_posix_path_dev`: CLEAN — zero findings after the chronology correction |

POSIX PATH final validation: installer/release tests 40/40, POSIX shell syntax,
typecheck, and diff checks clean. Auth-issue development validation: focused
13/13 before contract-double integration, protected contracts 28/28 with 528
assertions, and full repository 505 passed with one expected skip and zero
failed; typecheck and diff checks clean. The fresh auth review additionally
reported 27/27 targeted tests.

### Final whole-Stage-A correction lineages

The fresh whole-stage reviewer
`/root/stage_a_cross_daemon_dev/stage_a_fresh_adversarial_final` traced the
complete current Stage A after the earlier lineage and ledger corrections. It
returned three implementation findings:

1. the human one-shot `list`, `read`, `summary`, `participants`, and `search`
   terminal path emitted untrusted remote/cache strings without terminal
   sanitization;
2. standalone storage and client-path discovery could still route through a
   relative or otherwise non-authoritative home/path source;
3. the POSIX installer selected `.profile` for bash even though the installed
   command must be available to ordinary interactive bash sessions.

The corrections retained the protected MCP/agent-facing Markdown and optional
YAML-frontmatter contracts. Human presentation consumed structured results;
no LLM-facing prose was parsed into CLI logic.

#### Human one-shot terminal-output correction

Development agent:
`/root/stage_a_config_batch_dev/stage_a_config_batch_review_13`.

Exact owned files for this correction:

- `src/cli.ts`, limited to the human one-shot output/error boundary;
- `src/app/render.ts`, limited to the exported multiline terminal sanitizer;
- `tests/fixtures/cli-output-dispatch.ts`;
- `tests/tools/cli-output.test.ts`;
- `tests/app/ui.test.ts`, limited to direct sanitizer newline/tab coverage.

The correction routed human one-shot stdout and unexpected stderr through the
shared multiline terminal sanitizer. CSI, OSC, other terminal control
sequences, C0 controls, and bidirectional controls are removed while ordinary
Markdown, tabs, CR normalization, newlines, and blank lines remain intact.
Hidden installer protocols, dispatcher results, MCP responses, and protected
agent output were not changed.

Fresh review `/root/stage_a_cross_daemon_dev` returned CLEAN — zero findings
for this scope. Development validation was 23/23 focused tests with 118
assertions, protected contracts 28/28 with 528 assertions, and the then-current
full repository 513 passed, one intentional skip, zero failed, with 1306
assertions; TypeScript and diff checks were clean.

#### Authoritative home and explicit-directory correction

Development and correction agent:
`/root/stage_a_cross_posix_path_dev`.

Exact consolidated owned files:

- `src/runtime/home.ts`;
- the explicit application-directory parser in `src/runtime/env.ts`;
- the lazy storage-path resolution in `src/config.ts`;
- the home/XDG/Windows root resolution in `src/install/detect.ts`;
- the client path consumers in `src/install/clients.ts`;
- `tests/runtime/home.test.ts`;
- `tests/runtime/home-store.test.ts`;
- `tests/fixtures/runtime/home-store-probe.ts`;
- the explicit-directory cases in `tests/runtime/env.test.ts`;
- the home/XDG/Windows-root cases in `tests/install/detect.test.ts`;
- the manual-client unavailable cases in `tests/install/clients.test.ts`.

Review and correction chronology:

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `/root/stage_a_cross_posix_path_dev` | `/root/stage_a_config_batch_dev/stage_a_config_batch_review_13` | Four findings: relative `SANA_DATA_DIR` could route persistent state through cwd; standalone home resolution threw during module evaluation before the CLI boundary; XDG/APPDATA/LOCALAPPDATA roots were absolute but not lexically canonical/root-safe; `HOMEDRIVE` and `HOMEPATH` were trusted after blind concatenation | Required canonical absolute explicit application roots, made storage resolution lazy, reused typed canonical directory results for client roots, and validated the two Windows home components before composition | correction required fresh review |
| `/root/stage_a_cross_posix_path_dev` | `/root/stage_a_cross_daemon_dev` | Windows path leaves still admitted Win32-forbidden/control characters, aliases, device names, or equivalent unsafe segments | Added platform-lexical Windows leaf validation and typed rejection before filesystem or client mutation | correction required fresh review |
| `/root/stage_a_cross_posix_path_dev` | `/root/stage_a_cross_data_args_dev` | UNC server/share authority grammar remained incomplete | Validated complete UNC server/share authority, forbidden aliases/characters, share length, and canonical descendants without inventing a local path | correction required fresh review |
| `/root/stage_a_cross_posix_path_dev` | `/root/s2_client_writer_zero_review` | none | n/a | CLEAN — zero findings |

The first read-only review ran the 19 focused home/detect/client tests and
TypeScript successfully. Later correction and whole-stage gates below include
the final source state; no earlier test pass substitutes for the final clean
review.

#### POSIX interactive-shell PATH correction

Development and correction agent:
`/root/stage_a_cross_posix_path_dev`.

Exact owned files remained:

- the profile selection, PATH publication, receipt-owned profile validation,
  and current-shell presentation portions of `install.sh`;
- the fresh/upgrade shell matrices in `tests/install/installers.test.ts`.

The correction changed current bash selection from `.profile` to `.bashrc`,
retained `.zshrc` for zsh, and preserved the earlier separation between a
receipt-owned historical profile and current-shell readiness. Unsupported or
unset shells receive manual guidance and no false Added/Verified claim.
Fresh review `/root/stage_a_cross_daemon_dev` returned CLEAN — zero findings.
Final POSIX validation remained 40/40 installer/release tests with shell
syntax, TypeScript, and diff checks clean.

### Post-final-review configurer and CLI correction lineage

The next independent whole reviewer,
`/root/s2_client_writer_zero_review/stage_a_final_adversarial_review`, returned
two medium findings:

1. human `install`, bare `sana-mcp`, and `uninstall` returned exit zero when an
   actionable operation required confirmation but no interactive terminal was
   available;
2. an injected `applyBatch` could still mutate during `--dry-run`.

#### Typed configurer outcomes and dry-run isolation

Development and correction agent:
`/root/s2_client_writer_zero_review`.

Exact owned files:

- the structured installer/uninstaller disposition, dry-run delegation, and
  related flow portions of `src/install/install.ts`;
- direct outcome coverage in `tests/install/install.test.ts`;
- direct dry-run delegation and configurer-flow coverage in
  `tests/install/configurer-flow.test.ts`.

The correction made uninstall return a typed `UninstallerFlowResult`, retained
typed `InstallerFlowResult`, represented `interaction-unavailable` explicitly,
prevented dry-run from invoking an injected mutating batch, and added the
truthful `planned` disposition to both installer and uninstaller results.

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `/root/s2_client_writer_zero_review` | `/root/stage_a_cross_daemon_dev` | Dry-run planning lacked a truthful `planned` disposition and planned presentation/reload behavior was incomplete | Added `planned` to both result unions and aligned planned presentation/reload behavior without performing mutation | correction required fresh review |
| `/root/s2_client_writer_zero_review` | `/root/stage_a_cross_data_args_dev` | none | n/a | CLEAN — zero findings |

#### Human CLI exit and drain corrections

Development and correction agent for every round:
`/root/stage_a_config_batch_dev/stage_a_config_batch_review_13`.

Exact owned files:

- `src/cli.ts`, limited to human install/uninstall/bare and one-shot exit/output
  boundaries;
- `tests/tools/cli-configurer-exit.test.ts`;
- `tests/fixtures/cli-configurer-backpressure.ts`;
- `tests/tools/cli-output.test.ts`;
- `tests/fixtures/cli-output-dispatch.ts`.

The first correction exhaustively mapped installer and uninstaller
dispositions: only `interaction-unavailable` is exit 1; configured, planned,
completed, no-client/no-registration, no-change/no-selection, and cancellation
outcomes are clean exit 0. It covered explicit install, explicit uninstall,
and bare `sana-mcp`, while preserving presentation and hidden protocol bytes.

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `/root/stage_a_config_batch_dev/stage_a_config_batch_review_13` | `/root/stage_a_cross_data_args_dev` | Immediate `process.exit` after install/uninstall/bare could truncate redirected or backpressured configurer output | Replaced immediate exits with exhaustive `process.exitCode` assignment; bare invocation explicitly returns and cannot fall through; added exact 4 MiB redirected-output drain evidence for all three paths | correction required fresh review |
| `/root/stage_a_config_batch_dev/stage_a_config_batch_review_13` | `/root/stage_a_cross_daemon_dev` | The default `[tool] [json]` success path and invalid-JSON path retained the same immediate-exit drain defect | Made one-shot success and invalid JSON drain-safe with explicit exit codes and return-before-dispatch on invalid JSON; added exact 4 MiB sanitized dispatcher-output evidence | correction required fresh review |
| `/root/stage_a_config_batch_dev/stage_a_config_batch_review_13` | `/root/s2_client_writer_zero_review` | none | n/a | CLEAN — zero findings |

Validation progressed with each complete correction state:

- initial exit mapping: 11/11 focused CLI tests; full repository 533 passed,
  one intentional skip, zero failed, 1462 assertions;
- configurer drain and planned mapping: 6/6 focused tests; full repository 535
  passed, one intentional skip, zero failed, 1478 assertions;
- final one-shot drain correction: 15/15 focused CLI tests; protected contracts
  28/28 with 528 assertions; full repository 537 passed, one intentional skip,
  zero failed, 1485 assertions.

TypeScript and diff checks were clean in every reported correction round. The
final drain evidence verifies exact byte count and content, not merely process
success. Hidden `__inspect` protocol stdout remained exact, and MCP/agent bytes
remained protected.

### Final Stage A whole-review gate

Fresh whole reviewer
`/root/s2_client_writer_zero_review/stage_a_post_correction_adversarial`
returned CLEAN — zero findings for the complete current Stage A.

That reviewer initially raised a PID-reuse concern in daemon control, then
retracted it as a Stage A finding after applying the repository's proportional
local-process model and existing authenticated daemon identity boundaries. It
is not recorded as an unresolved Stage A defect. The concern is retained as an
explicit input to `B-DAEMON-CONTROL`, where daemon supervision/control is the
owned scope and can decide whether stronger process-handle identity is
proportionate.

### Stage A cross-cutting status

The original Stage A cross-cutting review,
`/root/stage_a_cross_review`, returned nine findings. Whole reviews 2 and 3 and
their correction chains are recorded above. Current successor reviews are
clean for the configurer
(`/root/stage_a_cross_configurer_review_9`), daemon/auth
(`/root/stage_a_cross_daemon_review_10`), contract
(`/root/stage_a_cross_contract_review_4`), and config transaction
(`/root/stage_a_config_batch_dev/stage_a_config_batch_review_14`) scopes.
The original configurer and daemon/auth agents have now reconstructed their
exact owned portions, handoffs, exclusions, validations, and unprovable
historical ranges above. Release integration is clean under
`/root/stage_a_release_final_review_5`, and the corrected release inventory is
clean under `/root/stage_a_cross_posix_path_dev`. The later whole-stage
correction lineages are clean under their named fresh reviewers, and final
complete reviewer
`/root/s2_client_writer_zero_review/stage_a_post_correction_adversarial`
returned zero findings.

Stage A is CLEAN. Its code and review-evidence gates are complete. The explicit
daemon PID-reuse design question is a Stage B input, not an open Stage A
finding.

After the stale historical `pending` wording was corrected without changing code
or review outcomes, exact final ledger re-reviewer
`/root/stage_a_cross_daemon_dev` returned CLEAN — zero findings. This confirms
the evidence wording only; the final whole-code gate remains
`/root/s2_client_writer_zero_review/stage_a_post_correction_adversarial` CLEAN.

#### Original cross-review finding allocation

| # | Original `/root/stage_a_cross_review` finding | Assigned correction scope / agent | Resolution | Current review status |
|---|---|---|---|---|
| 1 | Release used raw build output without authoritative standalone markers | Release integration / `/root/stage_a_cross_release_dev` | Bound release assets and standalone capability to the reviewed canonical build/manifest contract instead of raw build presence | Clean current release integration review: `/root/stage_a_release_final_review_5` |
| 2 | Installers lacked complete checksum enforcement, swallowed configurer failure, and had incorrect PowerShell exit propagation | Release integration / `/root/stage_a_cross_release_dev` | Enforced checksum/failure propagation across the one-line installers and corrected PowerShell process and IEX-host exit behavior | Clean current release integration review: `/root/stage_a_release_final_review_5` |
| 3 | Release target, manifest, musl, and tag identities diverged | Release integration / `/root/stage_a_cross_release_dev` | Centralized canonical target/libc/tag/manifest identity and rejected divergent projections | Clean current release integration review: `/root/stage_a_release_final_review_5` |
| 4 | Daemon spawn reported ready at process creation rather than after an authoritative heartbeat | Daemon/auth cross scope / `/root/stage_a_cross_daemon_dev` | Required tuple-bound live publication/heartbeat confirmation before readiness | Clean current daemon/auth review: `/root/stage_a_cross_daemon_review_10` |
| 5 | Daemon lock/recovery could remain wedged after a crash | Daemon/auth cross scope / `/root/stage_a_cross_daemon_dev` | Added serialized, owner-checked stale recovery and observable abandoned-transition handling | Clean current daemon/auth review: `/root/stage_a_cross_daemon_review_10` |
| 6 | Human configurer reused `sana()` LLM coaching prose and regex parsing | Configurer cross scope / `/root/s2_client_writer_zero_review` | Routed human CLI behavior through structured core results and dedicated presentation instead of LLM prose parsing | Clean current configurer review: `/root/stage_a_cross_configurer_review_9` |
| 7 | Terminal rendering policy was disconnected from the configurer prompts/output | Configurer/UI scopes / `/root/s2_client_writer_zero_review` and `a_ui_dev` | Connected prompts and rendering to the shared injected terminal streams, theme, color, and interaction policy | Clean configurer review `/root/stage_a_cross_configurer_review_9`; A-UI clean review `a_ui_fresh_review_2` |
| 8 | Advertised explicit selection of an undetected client was impossible | Configurer cross scope / `/root/s2_client_writer_zero_review` | Implemented explicit manual opt-in for undetected-but-safely-configurable clients. Review 4 later proposed disabling that path; the proposal was explicitly rejected because manual opt-in is the approved product contract, while its valid prompt findings were corrected | Clean current configurer review: `/root/stage_a_cross_configurer_review_9`; finding resolved, not ignored |
| 9 | Windows contract outer watchdogs were shorter than the complete child plus cleanup path | Contract cross scope / `/root/stage_a_cross_contract_dev` | Derived outer budgets from exact serialized child/build/MCP phase and cleanup maxima with a separate margin | Clean current contract review: `/root/stage_a_cross_contract_review_4` |

## Stage B

Read-only gap audit `/root/stage_a_cross_data_args_dev` classified B-HTTP,
B-DAEMON-CONTROL, B-SESSION, B-STORE, and B-CORE as PARTIAL and
B-STARTUP-PROFILE as functionally MISSING with reusable Stage A primitives.
No Stage B development or review outcome is claimed.

`B-DAEMON-CONTROL` retains the reclassified daemon PID-reuse/process-identity
concern as an explicit design input under the proportional local-process model.

## Stage C

Read-only gap audit `/root/s2_client_writer_zero_review` classified
C-DAEMON-SYNC, C-SEARCH, C-CONFIGURER-LIFECYCLE, and C-CLI-MCP as PARTIAL;
C-APP-SCREENS as MISSING product UX over implemented UI/port foundations; and
C-INSTALLER-TRANSPORT as PARTIAL only at the future B lifecycle-protocol
boundary, with its transport mechanics already clean. No Stage C development or
review outcome is claimed.

## Stage D

Read-only gap audit `/root/stage_a_cross_daemon_dev` classified
D-PACKAGE-BUILD, D-DEVTOOLS-TEST-GAPS, D-CI-RELEASE, D-DOCS, and D-HYGIENE as
PARTIAL. It explicitly preserved the clean release contract/tooling and recorded
native execution, environment approval, PAT confirmation, and exact clean-clone
proof as later evidence gates. No Stage D development or review outcome is
claimed.

Planning/status consolidation across the three audits is owned by
`/root/stage_a_config_batch_dev/stage_a_config_batch_review_13` in
`docs/dev/remediation-plan.md` and this ledger only. It records no invented
reviewer, development, or clean result.

## Install and human CLI UX completion

Development owner: `/root`.

Exact scope:

- `README.md`, `install.sh`, `install.ps1`;
- `src/cli.ts`;
- `src/app/app.ts`, `src/app/commands.ts`, `src/app/prompts.ts`,
  `src/app/runtime.ts`;
- the ETA correction in `src/core/args.ts`, `src/core/meetings.ts`,
  `src/core/status.ts`, and `src/tools/dispatch.ts`;
- `tests/install/installers.test.ts`, `tests/tools/cli-output.test.ts`,
  `tests/tools/cli-configurer-exit.test.ts`, and
  `tests/fixtures/cli-output-dispatch.ts`;
- `docs/dev/contract-change-ledger.md`.

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `/root` | `/root/install_cli_ux_review_1` | Missing direct coverage for the `install`/`config`/`configure` aliases | Added exact alias routing coverage | correction required fresh review |
| `/root` | `/root/install_cli_ux_review_2` | Deferred installer recovery commands were not safely executable for paths containing spaces or apostrophes | Emitted absolute shell-correct commands and executed them in isolated tests | correction required fresh review |
| `/root` | `/root/install_cli_ux_review_3` | Human one-shot output still reused LLM coaching strings; the POSIX deferred-command test had a false oracle | Added the structured human command renderer, preserved direct dispatcher/MCP parity, and made the recovery test execute the installed command | correction required fresh review |
| `/root` | `/root/install_cli_ux_review_4` | Human cache-generation fencing, read options, JSON/code-alias validation, and POSIX bootstrap failure propagation were incomplete | Added sync/async cache guards, complete read semantics, object-only JSON and code alias handling, and failure-correct bootstrap execution | correction required fresh review |
| `/root` | `/root/install_cli_ux_review_5` | POSIX portability, origin-change login recovery, semantic preflight, artifact-state detail, operational exit codes, terminating Windows download, terminal-policy enforcement, and validation field context were incomplete | Replaced the bootstrap with POSIX `sh` temp-download execution; reused the reviewed fresh-login recovery; moved validation before runtime state; retained typed artifact code/action; made operational failures nonzero; added `-ErrorAction Stop`; enforced shared interactivity; retained argument fields | correction required fresh review |
| `/root` | `/root/install_cli_ux_review_6` | Remaining semantic preflight, interactive validation, async resource lifetime, and post-await cache-generation gaps | Moved validation before I/O, awaited owned resources, and fenced results after asynchronous work | correction required fresh review |
| `/root` | `/root/install_cli_ux_review_7` | Empty list/search pages concealed authoritative empty/degraded states; sync-unavailable login could report success; protected read guidance retained an invented short retry interval | Rendered truthful empty/degraded states, made incomplete login nonzero with persistence uncertainty, removed the duration claim, and added an exact protected fixture | correction required fresh review |
| `/root` | `/root/install_cli_ux_review_8` | README still promised that a small catch-up finishes in seconds | Removed the unsupported duration promise | correction required fresh review |
| `/root` | `/root/ux_copy_final_review` | none | n/a | CLEAN — zero findings |

### B-D consolidated plan review

Correction owner: `/root/stage_a_config_batch_dev/stage_a_config_batch_review_13`.
Both independent reviews were read-only and ran no tests.

| Reviewer | Finding | Resolution in corrected plan |
|---|---|---|
| `/root/stage_a_cross_data_args_dev` | B-DAEMON-CONTROL did not own the daemon-side participant required by its instance protocol | Added `src/sync/daemon.ts` and exact daemon tests; made authenticated cooperative self-stop primary, bounded direct signaling to cheap authoritative platform proof, and otherwise required typed manual action |
| `/root/stage_a_cross_data_args_dev` | Startup foundation/integration acceptance and ordering were impossible before final store proof APIs | Reordered foundation -> store -> core -> integration; limited foundation to gate/profile/quarantine APIs with no deletion; moved all-entrypoint/no-pre-gate and production wiring to final integration |
| `/root/stage_a_cross_data_args_dev` | Startup integration lacked exact tests for every claimed entrypoint | Added one exact matrix test and two exact fixtures covering CLI, MCP, source/direct dispatch, daemon, direct store-open, configurer, and installer with a pre-gate mutation guard |
| `/root/stage_a_cross_data_args_dev` | B-CORE could not remove invented ETA across unowned dispatch/protected output | Added the dispatch portion, exact protected tests/fixtures, and contract ledger; B-STORE now freezes measured-rate or typed-unavailable authority |
| `/root/stage_a_cross_data_args_dev` | D-PACKAGE could not atomically bump every version projection it did not own | Removed the bump and added sequential D-VERSION-PROJECTION after CI/docs implementation with exact projection ownership and historical-fixture classification |
| `/root/stage_a_cross_data_args_dev` | Several scopes used unauditable fixture/test/directory escape clauses | Enumerated planned files or reserved whole subtrees with an inventory snapshot, exclusive ownership, and reviewed-amendment requirement for additions |
| `/root/stage_a_cross_data_args_dev` | `tests/sana/client.test.ts` was incorrectly labeled new and `package-lock.json` deletion was stale | Marked the client test existing and made D-PACKAGE verify the Stage A deletion remains absent without reopening it |
| `/root/stage_a_cross_daemon_dev` | B startup integration preceded the store/core APIs it consumes | Moved integration after reviewed-clean B-STORE and B-CORE and made it the last Stage B development scope |
| `/root/stage_a_cross_daemon_dev` | One upgrade transaction conflated three authorities and required reconciliation before the C implementation existed | Defined distribution, client-config, and startup/profile authorities with a versioned transaction ID/handoff/commit boundary; B retains quarantine and C-DAEMON-SYNC implements the production reconciler |
| `/root/stage_a_cross_daemon_dev` | Lifecycle protocol changes lacked atomic ownership across canonical and release consumers | Froze lifecycle protocol v1 through B/C and required a reviewed plan amendment with every exact protocol/manifest/installer/release/workflow owner before any unavoidable change |
| `/root/stage_a_cross_daemon_dev` | The `0.4.0` bump conflicted with D-PACKAGE ownership | Resolved by the same atomic D-VERSION-PROJECTION scope, sequenced after CI/docs implementation and before hygiene/reviews |
| `/root/stage_a_cross_daemon_dev` | Final-commit, ledger, clean-clone, native, and approval evidence formed a closure cycle | Added an evidence seal: finish local reviews and registrar entries, create a candidate, run exact-SHA clone/CI/native/approval evidence, and require the release tag to point to that candidate; later external evidence references are explicitly post-candidate |

#### Fresh plan re-review round 1

Both fresh independent re-reviews were read-only and ran no tests. Neither was
clean.

| Fresh reviewer | Finding | Resolution in correction round 2 |
|---|---|---|
| `/root/s2_client_writer_zero_review` | The conditional lifecycle-protocol amendment omitted direct and planned consumers | Added build-info, CLI/configurer, home/store, future daemon-control, daemon, and their exact tests; retained protocol v1 and required a fresh exhaustive consumer inventory before any reviewed amendment |
| `/root/s2_client_writer_zero_review` | B-HTTP-COOKIES could not integrate URL-aware behavior without owning client call sites/tests | Added the exact cookie-related `src/sana/client.ts` and `tests/sana/client.test.ts` portions, reserved each whole file, and required an explicit clean handoff before B-HTTP-CLIENT |
| `/root/s2_client_writer_zero_review` | The Stage B DAG contradicted the stated parallel session/daemon execution | Rewrote it as branch A cookies -> HTTP client -> session in parallel with branch B daemon control, followed by one explicit join into startup foundation |
| `/root/stage_a_cross_posix_path_dev` | The current auth/login/status/cache output entry remained labeled pending despite exact clean Stage A approval lineage | Moved the unchanged entry to Approved and cited `/root/stage_a_cross_contract_review_4` plus `/root/s2_client_writer_zero_review/stage_a_post_correction_adversarial`; no protected bytes changed |

The correction-round-2 plan is not yet clean. It awaits two fresh independent
zero-finding re-reviews. No Stage B development may begin until both exact fresh
reviewers are recorded here.

#### Fresh plan re-review round 2

Both brand-new independent reviewers were read-only and ran no tests. Neither
was clean.

| Fresh reviewer | Finding | Resolution in correction round 3 |
|---|---|---|
| `/root/stage_a_cross_daemon_dev/plan_final_review_c` | The evidence seal scheduled native execution before the exact release tag and protected-environment authorization required by the frozen workflow | Reordered the seal to candidate -> clean clone -> exact tag -> workflow dispatch -> protected approval/authorization -> native build/attestation/publication/remote revalidation on the same immutable tag/SHA; any authoritative change requires a new candidate and tag/version under policy |
| `/root/stage_a_cross_posix_path_dev/plan_final_review_d` | D-CI-RELEASE required actual native execution, approval, publication, and remote evidence before later documentation/version scopes changed the release tuple | Limited D-CI-RELEASE to workflow implementation and local contract evidence; actual native/approval/publication/remote evidence now belongs only to the final-candidate evidence seal after D-DOCS-FINAL and D-VERSION-PROJECTION |
| `/root/stage_a_cross_posix_path_dev/plan_final_review_d` | C-SEARCH could change quoted-phrase argument semantics without owning the protected help/fixture/contract ledger path | Added a mandatory sequential C-SEARCH -> C-CLI-MCP contract handoff; C-CLI-MCP owns exact help, protected fixtures/tests, MCP/agent outputs, and contract-ledger approval before phrase support can close |

The correction-round-3 plan is not yet clean. It awaits two new independent
zero-finding re-reviews. No Stage B development may begin until both exact fresh
reviewers are recorded here.

#### Fresh plan re-review round 3

Both brand-new reviewers were read-only and ran no tests. Neither was clean.

| Fresh reviewer | Finding | Resolution in correction round 4 |
|---|---|---|
| `/root/plan_final_review_e` | C-SEARCH public contract closure depended on later C-CLI-MCP, creating a Stage C cycle | Split an independently clean internal C-SEARCH implementation from a new exact C-SEARCH-CONTRACT activation scope before configurer/CLI integration |
| `/root/plan_final_review_e` | Transition-required startup lacked a restricted reconciler capability, so the daemon could not produce the proof needed to unblock the gate | Added a two-phase, single-use transaction/profile/session-bound reconciler capability and finalize call; ordinary entrypoints remain blocked while only the restricted reconciliation path can produce proof |
| `/root/plan_final_review_e` | Release approval was not bound to the reviewed candidate SHA/workflow ref | Added exact tag plus expected full SHA dispatch inputs, an unprotected preflight binding workflow ref/definition/tag authority, expected-SHA checkout, and repeated tag/SHA checks before native and publication jobs |
| `/root/plan_final_review_e` | Same-run post-publication remote verification was missing | Required the publishing run to re-fetch the published release, require `draft=false`, and byte-verify the complete asset tuple after publication |
| `/root/plan_final_review_f` | C-SEARCH/C-CLI-MCP phrase handoff formed a dependency cycle | Resolved by the same pre-configurer C-SEARCH-CONTRACT activation scope with exact protected-file ownership and return-to-search correction path |
| `/root/plan_final_review_f` | Registrar updates after final reviews recreated an unbounded ledger/review cycle | Added one terminal non-mutating candidate-content audit whose external SHA-bound result reviews the registrar commit and causes no repository mutation; a finding discards the candidate and restarts the normal loop |

Correction round 4 freezes the plan to the next executable Stage B work. C/D
details remain amendable only when their stage begins; they do not justify
further Stage B delay unless they change a Stage B API boundary.

#### Stage B final gate round 1

The fresh Stage-B-only reviewer was read-only and ran no tests.

| Fresh reviewer | Finding | Resolution |
|---|---|---|
| `/root/stage_b_plan_gate_g` | Startup foundation was required to validate and finalize reconciliation before B-STORE defined the proof schema, while the later integration scope did not own the startup files | Limited foundation to gate/quarantine/token issuance; B-STORE freezes the proof schema; handed startup/profile-transition files and tests consecutively to B-STARTUP-INTEGRATION for schema validation, single-use finalization, and ready publication |
| `/root/stage_b_plan_gate_h` | Existing isolated home/store tests and their probe fixed direct `SanaStore` construction to the legacy singleton path but were unowned by scopes that must gate direct store-open | Assigned both files consecutively to startup foundation and its later integration handoff so the isolated direct-store contract can change with the gate |

This correction also applies the proportional local-process model to daemon
control: cooperative self-stop is the normal path, persisted PIDs are never
signaled, and an unresponsive daemon produces a manual-action result without
hostile same-user process machinery.

## Daemon lifecycle and cleanup completion

Development owner: `/root`.

Exact scope:

- `src/store/db.ts`;
- `src/sync/control.ts`, `src/sync/lock.ts`, `src/sync/spawn.ts`,
  `src/sync/daemon.ts`;
- `tests/sync/control.test.ts`, `tests/sync/daemon.test.ts`,
  `tests/runtime/secure-store.test.ts`;
- `tests/fixtures/contracts/seed-store.ts` and the corresponding
  `tests/contracts/mcp-stdio.test.ts` ready-daemon path;
- dependency/lock cleanup in `package.json` and `bun.lock`;
- deletion of the obsolete tracked live-profile browser scripts under
  `scripts/`.

| Development | Review | Findings | Resolution | Fresh result |
|---|---|---|---|---|
| `/root` | `/root/daemon_cleanup_review_2` | Readiness could accept a heartbeat before cooperative control publication; cleanup guidance still named npm after package-manager consolidation | Required both lease heartbeat and cooperative control; changed guidance to `bun install`; package/dependency/script cleanup was otherwise clean | correction required fresh review |
| `/root` | `/root/daemon_cleanup_review_2` | Control readiness matched only PID, and the already-running wait did not reread ownership/liveness | Bound SQLite lease, heartbeat, control, readiness, and cleanup to the same PID plus UUID; reread state and follow replacement, missing, dead, and stale-live transitions | correction required fresh review |
| `/root` | `/root/daemon_final_review` | The lease comment incorrectly said a stale live owner was replaced | Documented that a stale live owner remains observable for manual recovery | correction required fresh review |
| `/root` | `/root/daemon_zero_review` | none | n/a | CLEAN — zero findings |
| `/root` | `/root/daemon_contract_integration_review` | none after the full-suite integration correction | The isolated contract seed publishes the same explicit synthetic UUID to SQLite and cooperative control | CLEAN — zero findings |

## Final repository review

The bounded final execution gate completed on 2026-07-25:

- `bun run check` in an isolated temporary HOME, XDG, data, transcript, and
  temporary tree: 550 passed, 1 platform skip, 0 failed;
- exact MCP contract suite after daemon-fixture integration: 22 passed;
- focused daemon/control/store suite: 33 passed;
- focused installer suite: 38 passed;
- `bun install --frozen-lockfile --ignore-scripts --no-progress`: no changes;
- host standalone `bun-linux-x64` build, `__inspect`, and CLI help smoke:
  successful with the authoritative `0.3.2`/protocol-v1/keyword identity;
- `git diff --check`: clean;
- no Sana CLI, MCP, or daemon process remained after validation.

The platform-specific Windows ACL integration test remains the one intentional
host skip on WSL/Linux. No release was published and no live `data/` tree was
read, migrated, or mutated by these checks.

## Automatic release restoration and 0.4.0 projection

Development and correction owner: `/root`.

Exact scope:

- `.github/workflows/release.yml`;
- `package.json`, `README.md`, `install.sh`;
- `docs/dev/cli-specs.md`, `docs/dev/remediation-plan.md`;
- `tests/release/release.test.ts`,
  `tests/release/version-projection.test.ts`;
- `tests/install/manifest.test.ts`;
- `tests/fixtures/manifest/valid-all-targets.json`,
  `tests/fixtures/manifest/invalid-unknown-field.json`.

| Review | Findings | Resolution | Fresh result |
|---|---|---|---|
| `/root/release_trigger_final_review` | Tag probes were not confined to the exact tag namespace, and publication did not recheck the tag at both final state boundaries | Switched to exact `git/ref/tags` resolution with annotated-tag peeling and added pre/post-publication checks plus race tests | correction required fresh review |
| `/root/release_projection_final_review` | Projection status was stale and the current CLI-spec release label was outside the drift test | Marked the projection implemented and made the package-derived test cover the current CLI-spec label | `/root/release_projection_clean_review`: CLEAN - zero findings |
| `/root/release_trigger_clean_review` | An annotated-tag object 404 could be confused with an absent tag ref | Gave exact-ref absence a distinct status; all dereference failures remain fatal, with resolver and publisher coverage | correction required fresh review |
| `/root/release_trigger_edge_zero_review` | An already-published rerun could finish if the tag moved during remote asset verification | Rechecked the exact tag after byte verification and tested movement during download | correction required fresh review |
| `/root/release_trigger_terminal_review` | GitHub does not make `target_commitish` authoritative for an existing tag; publisher annotated-tag success lacked coverage | Removed that false identity assertion, kept exact tag-ref authority, corrected the fake API model, and added annotated publication success | `/root/release_api_terminal_zero_review`: CLEAN - zero findings |
| `/root/release_cross_cutting_zero_review` | none | n/a | CLEAN - zero findings |

Final candidate validation on 2026-07-25:

- isolated `bun run check`: 552 passed, 1 platform skip, 0 failed;
- focused release and projection suite: 6 passed, 0 failed;
- focused manifest suite: 17 passed, 0 failed;
- frozen Bun install: no worktree change;
- host standalone Linux x64 build, inspect, and help smoke: successful with
  authoritative `0.4.0`/protocol-v1/keyword identity;
- `git diff --check`: clean;
- no live `data/` tree was used.

### Native musl evidence correction

GitHub Actions run `30165390438` passed authorization, Windows x64, both macOS
targets, and both glibc targets. Both musl jobs failed before attestation because
bare Alpine does not include Bun's required `libstdc++` and `libgcc` runtime
packages; publication was correctly skipped and no partial release was created.

Correction owner: `/root`.

Exact correction files:

- `.github/workflows/release.yml`, `install.sh`, `README.md`;
- `docs/dev/cli-specs.md`;
- `tests/install/installers.test.ts`, `tests/release/release.test.ts`.

| Review | Findings | Resolution | Fresh result |
|---|---|---|---|
| `/root/musl_ci_failure_analysis` | A CI-only package install would conceal the same bare-Alpine end-user prerequisite | Added a non-mutating installer preflight with the exact `apk add` remediation and documented it alongside the CI runtime setup | correction required review |
| `/root/musl_correction_review` | Installer coverage matched source text but did not execute missing/present package states | Added isolated behavioral cases for each missing package, no release download on failure, and continuation when both are present | correction required fresh review |
| `/root/musl_correction_zero_review` | Documentation overstated the preflight as occurring before the installer itself is downloaded | Narrowed the claim to release metadata and binary assets | `/root/musl_terminal_review`: CLEAN - zero findings |
| `/root/release_musl_cross_review` | none | n/a | CLEAN - zero findings |

Post-correction validation:

- isolated `bun run check`: 553 passed, 1 platform skip, 0 failed;
- focused installer suite: 39 passed, 0 failed;
- focused release/projection suite: 6 passed, 0 failed;
- bare pinned Alpine emitted the exact prerequisite command before release
  resolution;
- a locally built Linux x64 musl artifact executed `__inspect` and `--help` in
  the pinned Alpine image after installing the declared runtime packages;
- `sh -n install.sh` and `git diff --check`: clean.

---
status: active
scope: installer-to-configurer transaction boundary
last_verified: 2026-07-25
authority: remediation-plan.md and AGENTS.md remain controlling
---

# Configurer transaction handoff

The POSIX release installer uses this structured transaction API after runtime
commit and cleanup. It presents the same configurer UI as Windows while retaining
journaled all-or-rollback client registration.

## Smallest required API

The CLI should expose an internal installer-only operation backed by the same
structured configurer core used by the human installer:

```text
__configure-transaction apply
  --journal <private-absolute-directory>
  --server-command <final-absolute-binary-path>
  [--yes]

__configure-transaction rollback
  --journal <private-absolute-directory>
```

`apply` must:

1. resolve the requested client selection before writing;
2. record each target's exact pre-install bytes or authoritative absence,
   normalized POSIX mode where applicable, validated path, and revision digest
   in the private journal;
3. compute and validate every intended registration using the final installed
   binary path;
4. apply writes with the existing per-file atomic writer;
5. roll back already-applied targets if any later target fails; and
6. return a typed non-zero result when either apply or its compensation is
   incomplete.

Without `--yes`, `apply` runs the same structured interactive wizard and Sana
sign-in flow as `sana-mcp install`. Human presentation and prompts use stderr;
stdout contains exactly one JSON protocol line. The wizard can reveal and
explicitly select safely configurable undetected clients, add registrations,
and remove existing owned registrations. Its complete selection is planned and
journaled as one batch before any client file is written. Authentication starts
only after that batch commits and is never included in the config journal.

With `--yes`, `apply` remains prompt-free, selects positively detected clients,
and does not attempt authentication. When no detector is positive, it inspects
every registration and succeeds only when all are authoritatively absent (or
revalidates an existing owned registration as a no-op); foreign or unavailable
state is an error. Unavailable unrelated clients remain non-fatal when a
positive target can be applied. Cancellation, no supported clients, and an
authoritative selection containing no changes return a successful `no-mutation`
outcome with the corresponding explicit disposition; they do not invent an
applied config set. A non-interactive invocation without `--yes` returns
`interaction-unavailable` and non-zero.

`rollback` must restore only targets listed as applied in the journal. Before
restoring a target, it must verify that the current bytes and, on POSIX, mode
still match the recorded post-apply image. Divergence observed before mutation
must produce a typed conflict and preserve the current file, journal, and
recovery material.

This boundary is an optimistic conditional update: it checks an exact
precondition, performs a same-directory atomic replacement or removal, and
verifies the resulting state. It is not a kernel compare-and-exchange and
cannot guarantee preservation against an uncooperative current-user writer in
the small interval between the final check and rename or unlink. The installer
serializes its own per-user operations; no native locking or FFI machinery is
required for this local application.

The journal is the machine-readable receipt. It must distinguish absent, empty,
and populated files, record POSIX mode as part of the image revision, and must
not invent client paths, selections, server commands, or successful empty
results. Windows records and compares exact bytes; POSIX mode bits are
deliberately omitted there because they do not represent Windows ACL state.
Authentication and Sana data are outside this API and must remain untouched.
Normal symlinked ancestors such as macOS `/var` to `/private/var` are
canonicalized once; the returned journal path and every later operation use
that canonical directory. The journal directory and journal leaf themselves
remain private, regular, and non-symlinked.

Journal and standalone-command identity are preflighted without creating a
directory before any prompt or unattended status scan. Preflight uses directory
entry inspection, so a dangling link, inaccessible entry, or any existing
receipt leaf is not mistaken for absence. The complete submitted selection is
then planned again from current bytes; stale wizard diffs are never used as
transaction preconditions. No-op decisions are bracketed by exact image reads
and revalidated before a no-mutation return, before receipt publication, and
again immediately before the mutation commit. Divergence is a typed conflict.
An all-no-op plan creates no directory or receipt. A journal path is returned
only after exclusive receipt publication and directory durability have been
proven. Ambiguous publication has its own non-zero outcome and does not claim
an owned recovery path.

A missing, unreadable, or malformed journal returns the typed
`journal-unavailable` outcome and a non-zero exit. Once a journal is readable,
any compensation that cannot be proven complete returns `rollback-incomplete`
or `conflict`; `failed-rolled-back` is reserved for proven compensation.
If every target is proven restored but the final terminal receipt cannot be
persisted, the distinct `journal-persistence-unknown` outcome reports that
recovery-state durability is unknown; it does not invent an unresolved target
to fit `rollback-incomplete`.

Journal parsing validates the complete receipt before changing its state:
top-level and per-target states must form a valid transition, no-op preimages
and postimages must be identical, every target must be bound to the top-level
server target, every mutating target must actually change its image, terminal
issues must match terminal states, and all paths and identity strings must be
structurally valid. An absent removal no-op is valid inside a mixed receipt.
Rollback retries discard stale aggregate issues and derive their result only
from targets still unresolved in that retry. A corrected retry therefore
returns `failed-rolled-back` without an obsolete message, while repeated
conflicts remain stable instead of accumulating duplicate text.
Terminal per-target issues remain attached until the same persisted transition
moves that target into `rolling-back`; a crash therefore cannot leave a receipt
that the rollback parser itself rejects. `rollback-incomplete` requires at least
one unresolved failed or conflicting target.

A successfully persisted Sana session is not part of client-config
compensation. If sign-in fails after the config batch, the batch is compensated
and its journal retained. A confirmed session whose sync transition is
incomplete is reported as authentication `retained`; other failures report
authentication as `unconfirmed`. Neither case claims authentication rollback.
Errors before the authentication phase remain configuration or interaction
errors with authentication `not-attempted`; this includes failures while
rendering post-apply client results.
Once authentication is confirmed, a later presentation failure is tracked as a
distinct post-auth phase. It reports retained authentication, keeps committed
client configuration, and never describes the session as unconfirmed.
Confirmed or deliberately skipped authentication whose local session handle
then fails to close is reported separately as an authentication-session cleanup
failure. It preserves the committed config and truthful retained/skipped auth
state; it is not mislabeled as a presentation failure and does not trigger
config rollback.
The POSIX outer installer applies a stricter recovery rule: every journal-bearing
nonzero handoff result is revalidated through rollback before retry guidance is
shown, even when the configurer core would otherwise retain that batch.
If a Sana sign-in prompt is cancelled and closing that same local auth session
also fails, the direct prompt-cancellation and cleanup siblings remain
authoritative: authentication is `skipped`, the exact applied/no-mutation batch
is retained, and the cleanup failure and cause remain visible without
compensating client configuration. A cancellation-shaped error nested inside an
authentication operation or cleanup cause is not treated as user cancellation.
The installer recognizes authentication authority only from a private nominal
error constructed by `maybeLogin`; it never infers authority from a public error
or aggregate shape. The nominal envelope separately records whether a flow
failure was caught, the normalized direct flow failure, the real `auth.close`
failure, session-open failure, authoritative auth phase/outcome, and any
presentation failures. This prevents raw aggregates and cleanup-shaped errors
nested in prompts, session opening, request-code, verify-code, observers, or
presentation from impersonating the real close path. Non-`Error` thrown values,
including every falsy value, become a typed error instead of being mistaken for
successful authentication.
Authentication disposition is private, explicit state rather than an
`instanceof` inference from public errors. Only the internal prompt-cancellation
signal or an explicit user skip sets `skipped`; only an authoritatively
confirmed current session or confirmed verify result (including
sync-unavailable) sets `confirmed`. Callback-thrown public cancellation or
partial-authentication errors remain ordinary unconfirmed failures unless a
controlled milestone had already established the real confirmed/skipped state.
Cleanup and presentation failures never change that disposition.
Successful login also returns a private, validated authority token. The
configurer uses it to wrap failures from the outer completion screen and the
actual-cancellation observer/screen, so those errors retain real confirmed or
skipped truth. The transaction adapter never grants auth authority from its
public phase observer; phase without a branded disposition remains an ordinary
unconfirmed failure.
`maybeLogin` constructs its nominal authority before rendering open or flow
failure messages. Rendering failures are appended separately without changing
the flow/cleanup authority. The transaction adapter therefore preserves
retained/skipped/unconfirmed truth and the correct compensation decision while
exposing primary flow, cleanup, and presentation errors together. In particular,
partial authentication plus cleanup never claims that setup completed and keeps
the sync-unavailable detail actionable.

Batch results have exact cardinality and provenance. A no-op result is emitted
only for a target authoritatively prepared as a no-op; a missing applied result
or missing batch result set is an invariant error, not an empty successful
fallback. Every returned client identity, desired operation, server name,
normalized path, terminal state, and committed server target is checked against
the submitted batch before presentation or authentication. A configured or
authenticated phase without an authoritative applied/no-mutation batch is a
typed invariant failure. Authentication failure after a genuine no-mutation
batch preserves that batch's exact no-op count and local result provenance.
Journal, atomic writer, and config-rendering errors retain bounded nested
`AggregateError` details so both the primary operation and cleanup failure
remain observable.

Windows rename and unlink operations use a small bounded retry for transient
`EPERM`/`EBUSY` responses. Every config retry rechecks the exact optimistic
preimage, and every journal replacement retry rechecks the exact existing
receipt before another mutation attempt.
Atomic post-publication mode verification follows the injected operations
platform, matching snapshot comparison and retry behavior. This keeps fake
Windows snapshots mode-free and requires reported modes for injected POSIX
operations regardless of the host running a test.

## Installer sequencing

Direct installers publish and validate the runtime, commit the installer
transaction, release installer locks, and complete installer cleanup before
opening setup exactly once. POSIX invokes `__configure-transaction apply` so a
failed client batch is compensated; Windows invokes the public configurer. Both
paths render the same setup UI. An updater handoff does not reopen setup, and a
post-install setup failure does not invalidate an already successful runtime
installation.

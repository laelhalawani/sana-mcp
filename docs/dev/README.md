---
status: active
scope: development-document authority and status index
last_verified: 2026-07-24
authority: navigation only; remediation-plan.md controls implementation
---

# Development documentation

The current implementation authority is
[`remediation-plan.md`](./remediation-plan.md), governed by
[`AGENTS.md`](../../AGENTS.md). If another development document conflicts with
either one, follow `AGENTS.md` first and the remediation plan second.

The status in each document's frontmatter has the following meaning:

- `active` - current process or implementation authority.
- `accepted` - a subordinate design or UX reference that remains useful within
  the boundaries stated in its frontmatter.
- `historical` - a snapshot of earlier code, decisions, or alternatives. Do not
  implement from it.
- `superseded` - implementation guidance replaced by the remediation plan. It is
  retained only for context.
- `research` - non-binding feasibility or technology research. Revalidate claims
  before relying on them.

## Active control documents

| Document | Role |
| --- | --- |
| [`remediation-plan.md`](./remediation-plan.md) | Authoritative dependency-aware implementation plan |
| [`review-ledger.md`](./review-ledger.md) | Required development and review evidence |
| [`contract-change-ledger.md`](./contract-change-ledger.md) | Protected agent/LLM contract baseline and approved-change record |

## Accepted subordinate references

These documents describe retained presentation or interaction goals. Their
implementation sketches are not authoritative where the remediation plan defines
new ports, lifecycle rules, security boundaries, or failure states.

| Document | Accepted scope |
| --- | --- |
| [`cli-feature-screens.md`](./cli-feature-screens.md) | Human-screen information architecture and interaction intent |
| [`cli-presentation-layer.md`](./cli-presentation-layer.md) | Separation of structured core data, human UI, and LLM-facing output |
| [`tui-rendering.md`](./tui-rendering.md) | Rendering vocabulary and one-region interaction intent only |

## Superseded implementation guidance

| Document | Replacement |
| --- | --- |
| [`analysis-app-shell.md`](./analysis-app-shell.md) | Stage A and Stage C app, core, startup, and CLI scopes |
| [`cli-app-architecture.md`](./cli-app-architecture.md) | Frozen command grammar and typed UI/runtime boundaries |
| [`cli-specs.md`](./cli-specs.md) | Remediation plan plus frozen contract fixtures and contract-change ledger |
| [`installer-flow-polish.md`](./installer-flow-polish.md) | Fail-closed installer transport, checksum, lifecycle, and presentation scopes |

## Historical snapshots

| Document | Context |
| --- | --- |
| [`binary-packaging.md`](./binary-packaging.md) | Earlier packaging and language-choice study |
| [`codebase-notes.md`](./codebase-notes.md) | Pre-remediation repository behavior and known quirks |

## Non-binding research

| Document | Topic |
| --- | --- |
| [`bun-port.md`](./bun-port.md) | Bun executable feasibility |
| [`go-port.md`](./go-port.md) | Go port feasibility |
| [`go-embeddings.md`](./go-embeddings.md) | Go embedding runtime |
| [`rust-port.md`](./rust-port.md) | Rust port feasibility |
| [`rust-embeddings.md`](./rust-embeddings.md) | Rust embedding runtime |
| [`tui-library-research.md`](./tui-library-research.md) | Terminal UI library survey |

Research timestamps describe when claims were investigated, not a guarantee that
toolchains, APIs, runner availability, or release targets are still current.

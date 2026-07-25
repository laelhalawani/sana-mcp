---
status: research
scope: non-binding terminal UI library survey
last_verified: 2026-07-24
authority: revalidate before use; remediation-plan.md controls implementation
---

# TUI library research for the sana-mcp CLI

Date: 2026-07-24. All claims web-verified; sources inline. Written for our
hard constraint: a beautiful, in-place-redrawing TUI that ships as a single
self-contained binary via `bun build --compile`, cross-compiled from one Linux
host to SIX targets (linux x64/arm64, darwin x64/arm64, windows x64/arm64),
with NO per-platform native artifacts, small size/RAM, and good Windows/WSL
behavior plus graceful non-TTY/NO_COLOR degradation.

Note on style: hyphens only below, no long dashes.

## TL;DR ranked recommendation

1. TOP PICK - `@inquirer/core` + `@inquirer/ansi` (hand-rolled full-screen
   renderer, optionally `ansi-escapes`). Pure JS, already in our stack,
   compiles and cross-compiles to all six targets with zero native artifacts,
   tiny footprint, best Windows/WSL story, trivial NO_COLOR/non-TTY fallback.
   Costs us more hand-written render code for the persistent layout.
2. RUNNER-UP - Ink 6 (version-pinned) + React 19, with mandatory build flags
   (`--external react-devtools-core`) and yoga.wasm handling. Genuinely
   beautiful and fast to author, still pure-JS+wasm so it CAN cross-compile,
   but `bun build --compile` support is finicky and must be re-tested on every
   Bun bump.
3. AVOID - OpenTUI (native Zig core via bun:ffi; breaks clean single-binary
   cross-compile and is self-described "not ready for production"), blessed /
   neo-blessed (dead / limited maintenance), terminal-kit (heavy, optional
   native deps).

---

## Q1. What do real Bun CLI/TUI apps use in 2026? Is there a Bun-blessed choice?

There is NO single dominant, Bun-blessed TUI library. The landscape splits:

- The flagship Bun-based coding agent, OpenCode (SST / anomalyco), does NOT use
  an off-the-shelf JS TUI. It started on Go + Bubble Tea, hit performance and
  capability limits at scale, and built its own framework, OpenTUI (Zig core +
  Bun + Solid/React), which now powers OpenCode in production. See
  https://github.com/anomalyco/opencode/issues/2956 and
  https://grokipedia.com/page/OpenTUI . So the most-watched Bun agent's answer
  was "roll our own native renderer," which is not reusable for a pure-JS
  single-binary product.
- The React-for-terminal library Ink dominates the Node/JS agent space: Claude
  Code and Gemini CLI both use Ink (https://github.com/wistrand/melker/blob/main/agent_docs/tui-comparison.md,
  March 2026 comparison; Ink ~35.6k stars). But those ship via Node/npm, not as
  `bun build --compile` single binaries, so they do not validate our specific
  constraint.
- Most compiled Bun CLIs use lightweight prompt libraries (`@clack/prompts`,
  `@inquirer/*`) or hand-rolled ANSI, precisely because those are pure JS and
  survive `--compile`. Bun's own docs and 2026 tutorials point at
  `@clack/prompts` for interactive CLIs
  (https://oneuptime.com/blog/post/2026-01-31-bun-cli-applications/view ,
  https://bun.com/docs/bundler/executables ).

Conclusion: for a pure-JS binary there is no blessed TUI framework; the safe,
common path is inquirer/clack/hand-rolled ANSI. The "React-in-terminal" crowd
(Ink) does not compile to a binary without workarounds, and the Bun-native crowd
(OpenTUI) uses native code that fights single-binary cross-compile.

## Q2. OpenTUI under `bun build --compile` (the likely dealbreaker)

Verdict: DEALBREAKER for us. Multiple independent reasons.

- Architecture: OpenTUI's rendering core is native Zig exposing a C ABI,
  loaded at runtime through `bun:ffi` `Bun.dlopen()`. The Zig code is
  cross-compiled per platform and shipped as SEPARATE npm packages
  (`@opentui/core-<os>-<arch>`, e.g. darwin-arm64, linux-x64, win32-x64...),
  pulled in as optional dependencies. At runtime `zig-renderlib.ts` picks the
  library by `process.platform` / `process.arch`. Sources:
  https://deepwiki.com/sst/opentui , https://opentui.com/docs/getting-started/ ,
  https://betterstack.com/community/guides/scaling-nodejs/opentui-react/ .
- Why that breaks single-binary CROSS-compile: the native lib is selected by
  the RUNTIME host's platform from node_modules, not embedded per target. To
  ship a Windows binary from Linux you must embed the Windows `.dll` (and the
  darwin `.dylib`, the linux `.so`, etc.) into each target's binary. OpenTUI's
  loader is not wired to do that for `bun build --compile`; you would be
  hand-embedding six different native libs and patching the loader for each
  target. That is exactly the "per-platform native artifact" outcome our
  constraint forbids.
- Bun's own FFI-embed path is fragile. `bun:ffi` embedding a native lib via
  `with: { type: "file" }` into a compiled binary regressed and BROKE
  COMPLETELY in the Rust rewrite: Bun 1.3.14-canary.1 (May 14, 2026), last-good
  1.3.13. The issue explicitly names @opentui/core and opencode as the packages
  that surfaced it. It was fixed in PR #30720, but the episode shows this
  codepath is young and brittle, and any future Bun change can break OpenTUI's
  binaries. Source: https://github.com/oven-sh/bun/issues/30717 and related
  https://github.com/oven-sh/bun/issues/14009 .
- Production readiness: the OpenTUI README itself says "Not ready for
  production use" (per the March 2026 comparison at
  https://github.com/wistrand/melker/blob/main/agent_docs/tui-comparison.md ),
  even while marketing that it "powers OpenCode in production." It also requires
  Zig installed to build packages and, for the native renderer, a very recent
  Node with `--experimental-ffi` (or Bun). License: MIT
  (https://github.com/anomalyco/opentui ).

Bottom line: beautiful and fast, but a native-FFI dependency is the single
worst fit for "one Linux host, six clean pure-JS binaries." Avoid.

## Q3. Ink 6 + React 19 under `bun build --compile`

It CAN work (it is pure JS + a WASM layout engine, no `.node`), so it can
cross-compile to all six targets, but only with a specific set of workarounds,
and it is finicky enough to require re-testing on each Bun release.

Required workarounds:

1. `--external react-devtools-core`. Ink imports react-devtools-core as an
   optional dev dependency; it is not installed in production, so the compile
   fails to resolve it (matches the error we already hit). Historically Ink
   guarded this with an inline `process.env['DEV'] === 'true'` check that
   bundlers could tree-shake. Ink 6.8.0 (Feb 20, 2026) refactored that into an
   `isDev()` function call, which DEFEATS tree-shaking and makes the failure
   worse. So either pin Ink <= 6.7.0, or keep 6.8.x and pass
   `--external react-devtools-core`. Source:
   https://github.com/vadimdemedes/ink/issues/886 , and prior reports
   https://github.com/vadimdemedes/ink/issues/650 .
2. yoga-layout WASM. Ink uses yoga-layout (Flexbox), which ships `yoga.wasm`.
   `bun build --compile` historically could not embed WASM and produced
   "Cannot find module './yoga.wasm'" at runtime. Sources:
   https://github.com/oven-sh/bun/issues/13552 (Aug 2024, Ink 5, Bun 1.1.26)
   and https://github.com/oven-sh/bun/issues/6567 . Newer Bun embeds wasm, but
   path-resolution edge cases persist, so you MUST test the produced binary on
   each target, not just trust that it built.
3. No native `.node` in Ink itself, so once (1) and (2) are satisfied it
   genuinely cross-compiles from Linux to windows/darwin via
   `--target=bun-<os>-<arch>` (Bun's cross-compile matrix now covers all six,
   including windows-arm64 as of Feb 2026:
   https://bun.com/docs/bundler/executables ,
   https://developer.mamezou-tech.com/en/blogs/2024/05/20/bun-cross-compile/ ).

Footprint: the dominant cost is Bun's embedded runtime, roughly 55-60 MB base
per binary regardless of app (https://bun.com/docs/bundler/executables ,
https://zenn.dev/dyoshikawa/articles/deno-to-bun-single-binary ). Ink + React +
reconciler + yoga.wasm adds a few MB of JS/wasm on top. RAM is the React
reconciler plus a virtual DOM per frame; fine for our scale but heavier than a
hand-rolled string renderer.

Net: usable as the runner-up, but the compile story is a moving target tied to
Bun and Ink versions. Pin both and keep a smoke test that runs the built binary.

## Q4. @clack/prompts

- Compile compatibility: YES. Pure JS, no native/wasm deps, good Windows
  support; Bun's docs recommend it for interactive CLIs
  (https://oneuptime.com/blog/post/2026-01-31-bun-cli-applications/view ,
  https://bomb.sh/docs/clack/packages/prompts/ ).
- BUT it is prompt-SEQUENCE only, not a persistent full-screen framework. It
  is a styled wrapper over `@clack/core` offering `intro`/`outro`, `log.*`,
  `spinner`, and a set of prompts (text, password, confirm, select,
  multiselect, autocomplete, path, etc.). Each prompt redraws its own area in
  place, then finalizes and the flow appends the next block to the normal
  scrollback. There is no alternate-screen, no header/list/footer that all
  redraw together. Source: https://github.com/bombshell-dev/clack ,
  https://www.npmjs.com/package/@clack/prompts .

So clack is excellent for our login form and the live-updating install
checklist (its spinner and `log` lines are exactly that idiom), but it would
"scroll" for the searchable/paginated meeting list and the in-place transcript
pager. Good supporting actor, wrong lead for a full-screen app.

## Q5. @inquirer/core (+ @inquirer/ansi) - what we already ship

- Compiles cleanly under `bun build --compile` today (it is already in our
  dependency tree: `@inquirer/core` ^11, `@inquirer/ansi` ^2). Pure JS, no wasm,
  no native. Cross-compiles to all six targets with only `--target`.
- `createPrompt()` is fundamentally ONE prompt at a time. It sets up a single
  reconciled render area: your render function returns the whole string for
  that area each frame, and core diffs line count and erases/redraws in place
  in the NORMAL buffer (this is how the built-in list prompts scroll their
  window). Source: https://github.com/SBoudrias/Inquirer.js/blob/main/packages/core/README.md .
- What that means for a full-screen layout: within ONE custom prompt you
  control the entire rendered string every frame, so you CAN draw a combined
  header + scrolling list + footer that all update together, because it is one
  reconciled block. That covers the meeting list and the transcript pager as
  single custom `createPrompt` components with the `useKeypress` /
  `usePagination` hooks.
- Limits to know: core does not manage the alternate screen buffer, does not
  give you independent multi-region redraw, and its reconciler writes into the
  scrollback, so if the rendered block exceeds the terminal height it grows the
  scrollback rather than clipping. Terminal-resize handling is manual. For a
  true persistent full-screen app (clear on enter, alternate buffer, clip to
  viewport, restore on exit) you step outside `createPrompt` and drive your own
  loop with `@inquirer/ansi` (cursor moves, erase-line/erase-display,
  hide/show cursor, cursor save/restore) plus `ansi-escapes` for
  alternate-screen enter/exit. This is straightforward, pure JS, and compiles
  with no flags.

Net: this is the lowest-risk way to hit "beautiful in-place TUI + six clean
binaries." It costs us the render-loop plumbing that Ink would give for free.

## Q6. Other options that cross-compile cleanly under bun

- blessed: pure JS (reimplements ncurses in JS) so it would compile, but the
  project has been effectively dead since Jan 2016. neo-blessed is a fork with
  only "limited maintenance." Both are stale and buggy against modern
  terminals. Sources:
  https://github.com/wistrand/melker/blob/main/agent_docs/tui-comparison.md ,
  https://github.com/embarklabs/neo-blessed , https://www.npmjs.com/package/neo-blessed .
  Avoid for a new 2026 product.
- neo-blessed-contrib: dashboards/widgets on top of neo-blessed; inherits the
  same staleness. https://github.com/chiguireitor/neo-blessed-contrib .
- terminal-kit: capable and pure-JS at the core, but heavy and it pulls
  optional native modules for some features; risk of breaking `--compile` and
  bloat. Not worth it versus a hand-rolled `@inquirer/ansi` renderer.
- ansi-escapes + hand-rolled renderer: pure JS, compiles perfectly, total
  control over alternate screen, clipping, and multi-region redraw. This is the
  same idea as the top pick and is the fallback/companion to `@inquirer/ansi`.

Anything with a native `.node` or FFI dependency (OpenTUI, node-pty-based
stacks, terminal-kit's optional natives) is the category to avoid: it either
cannot cross-compile cleanly from one Linux host or forces per-platform native
artifacts, and it exposes us to Bun's fragile FFI-embed codepath
(https://github.com/oven-sh/bun/issues/30717 ).

---

## Final recommendation for our constraints

TOP PICK: build the TUI on `@inquirer/core` + `@inquirer/ansi` (add
`ansi-escapes` for alternate-screen enter/exit). Rationale: already in our
stack, pure JS, cross-compiles to all six targets with only `--target` and no
native artifacts, smallest incremental size/RAM, best Windows/WSL behavior, and
trivial NO_COLOR/non-TTY degradation (detect `process.stdout.isTTY` and
`NO_COLOR`, fall back to plain sequential output). Implement each full-screen
(meeting list, transcript pager) as a single custom `createPrompt` component
that renders header+body+footer as one reconciled block; wrap the whole app in
manual alternate-screen enter/exit and a resize handler. Use `@clack/prompts`
(or inquirer prompts) for the login form and the install checklist, which are
sequence/spinner idioms.

RUNNER-UP: Ink 6 + React 19, ONLY if the hand-rolled render loop proves too
costly. It is the most beautiful-per-effort, but keep it on a leash:
  - pin Ink <= 6.7.0 OR always pass `--external react-devtools-core`
    (6.8.0 broke devtools tree-shaking, Feb 2026);
  - verify yoga.wasm actually embeds on the exact Bun version you ship;
  - build with `bun build --compile --external react-devtools-core
    --target=bun-<os>-<arch>` for each of the six targets;
  - RUN each produced binary in CI (build success does not imply the wasm/path
    resolution works at runtime).

AVOID: OpenTUI (native Zig FFI; no clean single-binary cross-compile; "not
ready for production"; fragile against Bun's FFI-embed regressions),
blessed/neo-blessed (dead/limited maintenance), terminal-kit (heavy, optional
native deps).

Required build flags summary:
  - inquirer route: `bun build --compile --target=bun-<os>-<arch> <entry>` (no
    special flags needed).
  - Ink route: add `--external react-devtools-core`, pin Ink, confirm wasm
    embed, smoke-test each binary.

## Sources

- OpenCode Go->OpenTUI migration: https://github.com/anomalyco/opencode/issues/2956
- OpenTUI docs / architecture: https://opentui.com/docs/getting-started/ ,
  https://deepwiki.com/sst/opentui ,
  https://betterstack.com/community/guides/scaling-nodejs/opentui-react/
- OpenTUI repo (MIT, Zig required): https://github.com/anomalyco/opentui
- OpenTUI overview / "not production ready" and Ink usage comparison:
  https://github.com/wistrand/melker/blob/main/agent_docs/tui-comparison.md ,
  https://grokipedia.com/page/OpenTUI
- Bun FFI embed regression (names @opentui/core, opencode):
  https://github.com/oven-sh/bun/issues/30717 ,
  https://github.com/oven-sh/bun/issues/14009
- Ink react-devtools-core tree-shaking break in 6.8.0:
  https://github.com/vadimdemedes/ink/issues/886 ,
  https://github.com/vadimdemedes/ink/issues/650
- Ink yoga.wasm under bun --compile: https://github.com/oven-sh/bun/issues/13552 ,
  https://github.com/oven-sh/bun/issues/6567
- Bun single-file executables + cross-compile matrix (incl. windows-arm64):
  https://bun.com/docs/bundler/executables ,
  https://developer.mamezou-tech.com/en/blogs/2024/05/20/bun-cross-compile/
- Bun binary size baseline: https://zenn.dev/dyoshikawa/articles/deno-to-bun-single-binary
- @clack/prompts: https://bomb.sh/docs/clack/packages/prompts/ ,
  https://github.com/bombshell-dev/clack ,
  https://oneuptime.com/blog/post/2026-01-31-bun-cli-applications/view
- @inquirer/core createPrompt model:
  https://github.com/SBoudrias/Inquirer.js/blob/main/packages/core/README.md
- blessed / neo-blessed status: https://github.com/embarklabs/neo-blessed ,
  https://www.npmjs.com/package/neo-blessed

# Interactive Application Design

The full-screen application opened by a bare `sana-mcp` on a TTY. It shows the
same meetings the agent sees, from the same local database, so a person can read
what an agent is reading and correct what an agent must not correct alone.

Built with `bubbletea` in the alternate screen, one `tea.Program` for the whole
application, following `interactive-terminal-mcp/internal/app`.

The screens and their keys follow the shipped TypeScript application, because
people already know them. Editing and history are new.

## Screens

```
      ┌──────────┐  enter        ┌────────────┐  t/enter   ┌────────────┐
      │   Menu   │ ────────────> │  Meetings  │ ─────────> │ Transcript │
      └────┬─────┘   <── esc     └────────────┘  <── esc   └─────┬──────┘
           │                            │ s/p/o                 │ e     │ h
           │ enter                      v                       v       v
      ┌────▼─────┐              ┌──────────────┐          ┌────────┐ ┌─────────┐
      │  Search  │ ──enter────> │ Summary etc. │          │  Edit  │ │ History │
      └──────────┘  (opens at   └──────────────┘          └────────┘ └─────────┘
                     the line)
```

## Menu

```
sana-mcp  0.5.0

  > Meetings
    Search transcripts
    Sync status
    Sana account
    Configuration
    Quit

  Up to date
```

The sync phase is always on screen, so "why is this empty" is answered without
navigating anywhere.

`up`/`down` or `k`/`j` navigate and wrap. `enter` selects. `q` quits.

## Meetings

```
Meetings  240

> Northwind x Lumen | Monthly Meeting
    2026-07-30 12:22  2696 words  ready
  NORTHWIND X Lumen Weekly Meeting
    2026-07-29 12:38  680 words  ready

  page 1 of 11
  enter/t transcript  s summary  p participants  o recording  / name  f status  PgUp/PgDn page  esc menu
```

Each meeting takes two rows, so the page size is half the available height.
`/` filters by name; `f` cycles the status filter, because there are only five
states and cycling is one key rather than another prompt. `esc` returns to the
menu, which the footer says - the shipped application did not.

## Transcript

```
Northwind x Lumen | Monthly Meeting

> 1 [0:00] Dana Whitfield: Hi hi, hello
  2 [0:01] Priya Raman: Hey,
  3 [1:03] Priya Raman: comparison between Fabrix and Northwind *

  up/down scroll  e edit line  h history  t/s/p/o switch  esc meetings  q quit
```

A corrected line is marked `*`, so an edit is never mistaken for what was said.

## Edit

`e` on the highlighted line.

```
Edit line 3

  As transcribed: comparison between Fabrik and Northwind

  comparison between Fabrix and Northwind

  Transcripts contain real product and personal names that look like
  misspellings. Only correct what you know is wrong.

  ctrl+s save  esc cancel
```

- The text Sana delivered is shown above the editor and never changes.
- `ctrl+s` asks `Save this correction? [y/n]` before writing.
- `esc` with unsaved changes asks `Discard your changes? [y/n]`; answering no
  returns to editing.
- The warning sits where someone is about to type, because that is where it can
  still change what they do.

## History

`h` from the transcript.

```
Edits in Northwind x Lumen | Monthly Meeting

> line 3  2026-07-31 01:12  user  applied
    original: comparison between Fabrik and Northwind
    current:  comparison between Fabrix and Northwind

  up/down navigate  r restore original  esc transcript
```

Every edit is listed with both texts and its state (`applied`, `superseded`,
`reverted`, `stale`). `r` restores the original after `[y/n]`.

A `stale` edit is one whose line vanished in a re-download. It is kept and shown
rather than dropped, so the correction is not silently lost.

## Search

```
Search transcripts

  > pricing
  enter search  esc menu
```

then

```
  12 results for "pricing"

> Northwind Project Timeline Review  2026-06-26  line 348
    and for designing as well. One of the pain points Northwind mentioned...

  up/down navigate  enter open at that line  esc edit query  q quit
```

`enter` opens the transcript **at the matching line**, which is the only reason
anyone opens a hit. A search that finds nothing explains that transcripts come
from speech recognition and a name may be spelled differently.

## Sync status, account, configuration

Sync status renders the same snapshot the installer and the `status` tool use -
one model, four renderers, so progress never has two sources of truth.

```
Sync status

  Syncing meetings

  [##########--------------------]
  transcripts   103 of 240
  meetings      103 of 240
  remaining     137
```

Account shows the signed-in address and workspace, or how to sign in.
Configuration shows the data directory, the sync interval, and the search mode,
and points at `sana-mcp configure` for changing which clients are connected.

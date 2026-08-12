# Agent Tool Contract

Status: implemented and tested.

Project, repository, binary, and MCP server name: `sana-mcp`.
Remote: `github.com/laelhalawani/sana-mcp`.

`sana-mcp` syncs your Sana.AI meeting transcripts to this machine and serves
them to an agent over MCP, to a person through a full-screen application, and to
scripts through a CLI. Everything except a recording link is answered from the
local database, so search and reading work offline.

## Entry Point Model

Same terminal-sensitive entrypoint as `apis-mcp` and `interactive-terminal-mcp`:

| Invocation | Behavior |
|---|---|
| `sana-mcp` on a TTY | Full-screen interactive application |
| `sana-mcp` without a TTY | stdio MCP server |
| `sana-mcp mcp` | stdio MCP server, always |
| `sana-mcp configure` | Installer / settings flow |
| `sana-mcp daemon [--stop]` | Background sync daemon |

stdio only. No HTTP, SSE, or other network transport is exposed.

The server uses the official Go MCP SDK at
`github.com/modelcontextprotocol/go-sdk`.

## One tool

Agents call a single tool, `meeting_transcripts`, with a `tool` name and an
optional `args` object:

```text
meeting_transcripts("<tool>", { ...args })
```

The name is deliberately unbranded: an agent should see what the tool *does*,
not who makes it.

| tool | args | returns |
|---|---|---|
| `help` | `{tool?}` | all tools, or the argument schema for one |
| `login` | `{email}`, then `{email, confirmation_code}` | passwordless sign-in by email code |
| `status` | (none) | sync progress and coverage |
| `list` | `{page?, limit?, query?, sort?, filter?}` | meetings: id, timestamp, title, status |
| `read` | `{meeting_id, full?, lines?, timestamps?}` | transcript lines, all or a `[start,end]` range |
| `search` | `{query, page?, limit?, sort?, filter?}` | matching lines with meeting id and line number |
| `summary` | `{meeting_id}` | summary, notes by topic, action items |
| `participants` | `{meeting_id}` | workspace members with access, and speakers heard in the transcript |
| `recording` | `{meeting_id}` | a temporary recording link, fetched live |

### Corrections

Transcripts come from speech recognition and contain errors. These three tools
fix them, and are the only tools that write.

| tool | args | returns |
|---|---|---|
| `edit_line` | `{meeting_id, line, expected_text, new_text}` | replaces one line |
| `line_history` | `{meeting_id, line?}` | what was changed, original and current |
| `restore_line` | `{meeting_id, line}` | puts a line back to what Sana delivered |

Rules, enforced rather than merely documented:

- **A line is addressed by `meeting_id` and a 1-based `line`**, the same
  numbering `read` prints and the application shows.
- **`expected_text` must equal the line as it currently reads.** If it does not,
  nothing is written and the error says which line to re-read. This is what
  stops a model editing a line it misread or one whose number shifted.
- **Nothing is destroyed.** The text Sana delivered is kept forever;
  `line_history` shows both, and `restore_line` reverses any edit.
- **Never edit without the user asking for that specific correction.** Meeting
  transcripts are full of product names, company names and personal names that
  look like misspellings and are not - `Zenolith`, `Fabrix`, `Vantik` are real.
  A rare word being unfamiliar to a model is not evidence that it is wrong.

## Semantics

- `list.sort` is `"newest"` (default) or `"oldest"`. `list.filter` is
  `{status: "ready"|"processing"|"retrying", date: {from, to}}`
  with ISO dates (`YYYY-MM-DD`) or epoch milliseconds.
- `read.lines` is a 1-based, inclusive `[start, end]` range. With no selection
  it reports the line count and the options rather than dumping the transcript;
  `full: true` returns everything.
- `search.sort` is `"best"` (relevance, default), `"newest"`, or `"oldest"`.
  `search` takes no date filter.
  Search is FTS5 BM25 over both the current text and what was originally
  transcribed, weighted 20:1 in favour of the current text.
- `recording` fetches a live Sana URL that expires after a few hours. It is the
  only tool that needs the network.

## Errors

A failure is returned as text with a concrete next call, not as a protocol
error, because a model can act on the former. A search that finds nothing
explains that a name may be spelled differently in the transcript. An unknown
tool name lists the real ones.

## Example

```text
meeting_transcripts("search", {"query": "pricing", "sort": "newest"})
meeting_transcripts("read",   {"meeting_id": "v72HzzJDZx9WqTmF", "lines": [22, 26]})
meeting_transcripts("edit_line", {
  "meeting_id": "v72HzzJDZx9WqTmF",
  "line": 24,
  "expected_text": "we should compare Fabrik and Northwind",
  "new_text": "we should compare Fabrix and Northwind"
})
```

package app

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/laelhalawani/sana-mcp/internal/render"
	"github.com/laelhalawani/sana-mcp/internal/store"
	"github.com/laelhalawani/sana-mcp/internal/tui"
)

// The search screen: a query line, a result list of cards with the matching
// terms highlighted, and the transcript opened at the matching line.

const searchPageSize = 10

// sorts are the orders s cycles through.
var sorts = []string{store.SortBest, store.SortNewest, store.SortOldest}

// searchView is which of the four states the screen is in.
type searchView string

const (
	searchQuery      searchView = "query"
	searchRunning    searchView = "running"
	searchResults    searchView = "results"
	searchTranscript searchView = "transcript"
)

type searchModel struct {
	app *application
	ui  tui.UI

	view      searchView
	editValue string
	query     string
	request   int
	sort      int
	page      int

	hits     []store.Hit
	total    int
	selected int
	listTop  int
	failure  string

	// transcript, opened at the matching line
	title  string
	lines  []string
	scroll int

	quitting bool
	done     bool
}

type searchResultMsg struct {
	// request is which search this answers. A slow query whose result lands
	// after the user has gone back to editing would otherwise yank them out of
	// the input mid-word, and render its rows under the new query's header.
	request int
	hits    []store.Hit
	total   int
	failure string
}

func (a *application) search() error {
	model := &searchModel{app: a, ui: a.terminal.UI, view: searchQuery, page: 1}

	program := tea.NewProgram(model,
		tea.WithContext(a.ctx),
		tea.WithInput(a.terminal.In),
		tea.WithOutput(a.terminal.Out),
	)
	final, err := program.Run()
	if err != nil {
		return err
	}
	if final.(*searchModel).quitting {
		return tui.ErrCancelled
	}
	return nil
}

func (s *searchModel) Init() tea.Cmd { return nil }

func (s *searchModel) run() tea.Cmd {
	s.request++
	query, sort, page, request := s.query, sorts[s.sort], s.page, s.request
	database := s.app.store
	s.view = searchRunning
	return func() tea.Msg {
		hits, err := database.Search(query, searchPageSize, (page-1)*searchPageSize, sort)
		if err != nil {
			return searchResultMsg{request: request, failure: err.Error()}
		}
		total, err := database.SearchCount(query)
		if err != nil {
			return searchResultMsg{request: request, hits: hits, total: len(hits)}
		}
		return searchResultMsg{request: request, hits: hits, total: total}
	}
}

func (s *searchModel) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.WindowSizeMsg:
		s.ui.Policy.Columns = msg.Width
		s.ui.Policy.Rows = msg.Height

	case searchResultMsg:
		if msg.request != s.request {
			return s, nil
		}
		s.hits, s.total, s.failure = msg.hits, msg.total, msg.failure
		s.selected, s.listTop = 0, 0
		s.view = searchResults

	case tea.KeyMsg:
		return s, s.key(msg)
	}
	return s, nil
}

func (s *searchModel) quit() tea.Cmd {
	s.quitting, s.done = true, true
	return tea.Quit
}

func (s *searchModel) key(key tea.KeyMsg) tea.Cmd {
	name := strings.ToLower(key.String())
	if name == "ctrl+c" {
		return s.quit()
	}

	switch s.view {
	case searchQuery:
		switch name {
		case "enter":
			s.query = strings.TrimSpace(s.editValue)
			s.page = 1
			if s.query == "" {
				s.failure = ""
				s.hits, s.total = nil, 0
				s.view = searchResults
				return nil
			}
			return s.run()
		case "esc":
			s.done = true
			return tea.Quit
		default:
			s.editValue, _ = tui.Typed(s.editValue, key)
		}
		return nil

	case searchRunning:
		switch name {
		case "esc":
			// Going back to the query abandons the search in flight; its answer
			// is no longer the one being waited for.
			s.request++
			s.view = searchQuery
		case "q":
			return s.quit()
		}
		return nil

	case searchTranscript:
		switch name {
		case "esc":
			s.view = searchResults
			return nil
		case "q":
			return s.quit()
		}
		return s.scrollTranscript(name)
	}

	switch name {
	case "q":
		return s.quit()
	case "esc", "/":
		s.view = searchQuery
		return nil
	case "r":
		if s.query != "" {
			return s.run()
		}
		return nil
	case "s":
		s.sort = (s.sort + 1) % len(sorts)
		if s.query != "" {
			s.page = 1
			return s.run()
		}
		return nil
	case "[":
		if s.page > 1 {
			s.page--
			return s.run()
		}
		return nil
	case "]":
		if s.page*searchPageSize < s.total {
			s.page++
			return s.run()
		}
		return nil
	case "enter":
		return s.openTranscript()
	}
	return s.move(name)
}

func (s *searchModel) move(name string) tea.Cmd {
	if len(s.hits) == 0 {
		return nil
	}
	step := max(1, s.ui.Policy.AvailableRows()/searchCardHeight)
	next := s.selected
	switch name {
	case "up", "k":
		next--
	case "down", "j":
		next++
	case "pgup":
		next -= step
	case "pgdown":
		next += step
	case "home":
		next = 0
	case "end":
		next = len(s.hits) - 1
	default:
		return nil
	}
	s.selected = max(0, min(len(s.hits)-1, next))
	return nil
}

// openTranscript shows the whole transcript with the matching line in view,
// which is the question a search result actually raises: what was said around
// this.
func (s *searchModel) openTranscript() tea.Cmd {
	if s.selected >= len(s.hits) {
		return nil
	}
	hit := s.hits[s.selected]
	lines, err := s.app.store.Lines(hit.MeetingID, 0, 0)
	if err != nil {
		s.failure = err.Error()
		return nil
	}
	s.title = hit.Title
	s.lines = transcriptLines(lines)

	target := 0
	for index, line := range lines {
		if line.LineNo == hit.LineNo {
			target = index
			break
		}
	}
	capacity := max(1, s.ui.Policy.AvailableRows()-2)
	maximum := max(0, len(s.lines)-capacity)
	s.scroll = max(0, min(maximum, target-capacity/2))
	s.view = searchTranscript
	return nil
}

func (s *searchModel) scrollTranscript(name string) tea.Cmd {
	capacity := max(1, s.ui.Policy.AvailableRows()-2)
	maximum := max(0, len(s.lines)-capacity)
	delta := 0
	switch name {
	case "up", "k":
		delta = -1
	case "down", "j":
		delta = 1
	case "pgup":
		delta = -capacity
	case "pgdown":
		delta = capacity
	case "home":
		s.scroll = 0
		return nil
	case "end":
		s.scroll = maximum
		return nil
	default:
		return nil
	}
	s.scroll = max(0, min(maximum, s.scroll+delta))
	return nil
}

// A card is a title, its metadata, up to snippetRows of the matching line, and
// a blank row.
const (
	snippetRows = 2
	// Plus one for the line that names an original-wording match, which only
	// some cards carry.
	searchCardHeight = 4 + snippetRows
)

var termPattern = regexp.MustCompile(`[\p{L}\p{N}]+`)

// queryTerms are the words to highlight, longest first so a longer term is
// matched before a shorter one it contains.
func queryTerms(query string) []string {
	found := termPattern.FindAllString(query, -1)
	seen := map[string]bool{}
	var terms []string
	for _, term := range found {
		lower := strings.ToLower(term)
		if seen[lower] {
			continue
		}
		seen[lower] = true
		terms = append(terms, term)
	}
	for index := 1; index < len(terms); index++ {
		for position := index; position > 0 && len(terms[position]) > len(terms[position-1]); position-- {
			terms[position], terms[position-1] = terms[position-1], terms[position]
		}
	}
	return terms
}

func literalPattern(terms []string) *regexp.Regexp {
	if len(terms) == 0 {
		return nil
	}
	quoted := make([]string, 0, len(terms))
	for _, term := range terms {
		quoted = append(quoted, regexp.QuoteMeta(term))
	}
	return regexp.MustCompile(`(?i)(` + strings.Join(quoted, "|") + `)`)
}

// highlight colours every occurrence of a search term.
func highlight(ui tui.UI, value string, pattern *regexp.Regexp) tui.Text {
	text := render.Sanitize(value)
	if pattern == nil {
		return tui.Text(text)
	}
	matches := pattern.FindAllStringIndex(text, -1)
	if len(matches) == 0 {
		return tui.Text(text)
	}
	var parts []any
	offset := 0
	for _, match := range matches {
		if match[0] > offset {
			parts = append(parts, text[offset:match[0]])
		}
		parts = append(parts, ui.Yellow(text[match[0]:match[1]]))
		offset = match[1]
	}
	if offset < len(text) {
		parts = append(parts, text[offset:])
	}
	return ui.Line(parts...)
}

// anchor is the query term to centre the snippet on.
//
// A match is an AND of the terms in any order, so the query as a whole is
// usually not a substring of the line. Anchoring on it meant a multi-word
// search showed the head of the line instead - a result card containing
// neither of the words that had been searched for.
func (s *searchModel) anchor(text string) string {
	runes := []rune(text)
	for _, term := range queryTerms(s.query) {
		if runeIndexFold(runes, []rune(term)) >= 0 {
			return term
		}
	}
	return s.query
}

// matchedOriginal reports a hit whose searched word is in the line as Sana
// delivered it but not in the line as it now reads.
//
// The index covers both, so correcting "Fabrics" to "Fabrix" leaves the old
// spelling findable - which is the point. Without saying so, the result showed
// the head of a line containing neither spelling and no reason for itself.
func (s *searchModel) matchedOriginal(hit store.Hit) bool {
	if hit.OriginalText == "" || hit.OriginalText == hit.Text {
		return false
	}
	current, original := []rune(hit.Text), []rune(hit.OriginalText)
	for _, term := range queryTerms(s.query) {
		if runeIndexFold(current, []rune(term)) < 0 &&
			runeIndexFold(original, []rune(term)) >= 0 {
			return true
		}
	}
	return false
}

// snippetAround centres the matching term in a window of the line, so a long
// line does not push the match off the right edge.
// runeIndexFold is the rune offset of needle within haystack, case-insensitive,
// or -1. Both are compared rune by rune, so neither index ever leaves its own
// string.
func runeIndexFold(haystack, needle []rune) int {
	if len(needle) == 0 {
		return -1
	}
	for start := 0; start+len(needle) <= len(haystack); start++ {
		matched := true
		for offset, want := range needle {
			if unicode.ToLower(haystack[start+offset]) != unicode.ToLower(want) {
				matched = false
				break
			}
		}
		if matched {
			return start
		}
	}
	return -1
}

// snippetAround centres the query in a window of pad columns either side.
//
// Columns, not runes. The rows it is wrapped into are measured in columns, so a
// window counted in runes is twice too wide for a line of CJK - and the match,
// sitting in the middle of it, lands on a row the card never draws.
//
// The match is located by walking runes rather than by taking a byte offset
// from a lowercased copy: lowercasing can change a string's length, so an
// offset into one is not an offset into the other.
func snippetAround(text, query string, pad int) string {
	collapse := func(value string) string { return strings.Join(strings.Fields(value), " ") }
	runes := []rune(text)

	index := runeIndexFold(runes, []rune(query))
	if index < 0 {
		// No match to centre on: the head of the line, marked when it was cut,
		// so a trimmed snippet never reads as a complete one.
		head := collapse(takeColumns(runes, 0, len(runes), pad*2, false))
		if head != collapse(text) {
			return head + "..."
		}
		return head
	}
	end := index + len([]rune(query))
	before := takeColumns(runes, 0, index, pad, true)
	after := takeColumns(runes, end, len(runes), pad, false)

	prefix, suffix := "", ""
	if len([]rune(before)) < index {
		prefix = "..."
	}
	if len([]rune(after)) < len(runes)-end {
		suffix = "..."
	}
	return prefix + collapse(before+string(runes[index:end])+after) + suffix
}

// takeColumns returns as much of runes[from:to] as fits in a column budget,
// taken from the end when trailing is set.
func takeColumns(runes []rune, from, to, columns int, trailing bool) string {
	if from >= to {
		return ""
	}
	used := 0
	if trailing {
		start := to
		for start > from {
			next := render.DisplayWidth(string(runes[start-1]))
			if used+next > columns {
				break
			}
			used += next
			start--
		}
		return string(runes[start:to])
	}
	end := from
	for end < to {
		next := render.DisplayWidth(string(runes[end]))
		if used+next > columns {
			break
		}
		used += next
		end++
	}
	return string(runes[from:end])
}

// searchCard is one result: the meeting, when and where, and the matching text.
func (s *searchModel) searchCard(hit store.Hit, selected bool, width int, pattern *regexp.Regexp) []tui.Text {
	ui := s.ui
	pointer := " "
	if selected {
		pointer = ui.Glyphs.Pointer
	}
	card := []tui.Text{
		ui.Plain(ui.Truncate(pointer+" "+hit.Title, width)),
		ui.Plain(ui.Truncate(fmt.Sprintf("  %s  line %d", render.Date(hit.CreatedMS), hit.LineNo), width)),
	}
	snippetWidth := max(1, width-2)
	// The window is sized to the two rows a card draws, with the match in the
	// middle of it. Anything larger spills onto a third row that is never
	// rendered, and the match goes with it - so the card showed a stretch of
	// the line containing none of the words searched for.
	anchor := s.anchor(hit.Text)
	if s.matchedOriginal(hit) {
		// Centre on where the word actually is, and say which text it is in.
		anchor = s.anchor(hit.OriginalText)
	}
	pad := max(1, snippetWidth-3-render.DisplayWidth(anchor)/2)
	source := hit.Text
	if s.matchedOriginal(hit) {
		source = hit.OriginalText
	}
	snippet := ui.Wrap(snippetAround(source, anchor, pad), snippetWidth)
	// Word wrapping does not divide evenly, so the window can spill onto a
	// third row. The rows that are drawn carry the marker themselves rather
	// than relying on one computed for a row nobody sees - otherwise a snippet
	// that was cut reads as the whole line.
	if len(snippet) > snippetRows {
		snippet = snippet[:snippetRows]
		last := snippetRows - 1
		if !strings.HasSuffix(snippet[last], ui.OverflowMarker) {
			snippet[last] = ui.Truncate(snippet[last]+ui.OverflowMarker, snippetWidth)
		}
	}
	for _, line := range snippet {
		card = append(card, ui.Line("  ", highlight(ui, line, pattern)))
	}
	if s.matchedOriginal(hit) {
		card = append(card, ui.Line("  ", ui.Dim(ui.Truncate(
			"matched \""+s.anchor(hit.OriginalText)+"\" in the original wording", width-2))))
	}
	return append(card, "")
}

func (s *searchModel) View() string {
	if s.done {
		return ""
	}
	ui := s.ui
	width := ui.Policy.Width()

	switch s.view {
	case searchQuery:
		return ui.Screen("Search transcripts",
			[]tui.Text{ui.Line("> ", s.editValue)},
			"Enter - search | Esc - menu |")

	case searchRunning:
		return ui.Screen("Search transcripts | loading",
			[]tui.Text{ui.Plain(ui.Truncate(fmt.Sprintf("Searching for %q...", s.query), width))},
			"Esc - edit query | q - quit |")

	case searchTranscript:
		capacity := max(1, ui.Policy.AvailableRows()-2)
		pattern := literalPattern(queryTerms(s.query))
		// Clamped here, and written back, because the window a position is
		// valid for changes with the terminal. Widening a window while scrolled
		// to the end otherwise left the position past it: eight lines of text
		// above thirty blank rows, and the first arrow key only brought the
		// number back in range without moving the screen.
		s.scroll = max(0, min(max(0, len(s.lines)-capacity), s.scroll))
		end := min(len(s.lines), s.scroll+capacity)
		body := make([]tui.Text, 0, max(0, end-s.scroll))
		for index := s.scroll; index < end; index++ {
			body = append(body, highlight(ui, ui.Truncate(s.lines[index], width), pattern))
		}
		scrollKeys := "Up/Down"
		if ui.Policy.Unicode {
			scrollKeys = "↑/↓"
		}
		return ui.Screen(s.title, body,
			scrollKeys+" - scroll | PgUp/PgDn - page | Esc - results | q - quit |")
	}

	return s.viewResults()
}

func (s *searchModel) viewResults() string {
	ui := s.ui
	width := ui.Policy.Width()
	capacity := max(0, ui.Policy.AvailableRows()-2)

	header := "Search transcripts"
	footer := "r - retry | / - edit | Esc - query | q - quit |"
	var body []tui.Text

	switch {
	case s.failure != "":
		header += " | error"
		body = []tui.Text{ui.Plain("Search failed:"), ui.Plain(s.failure)}
	case s.query == "":
		header += " | empty query"
		body = []tui.Text{ui.Plain("Enter at least one word to search.")}
	case len(s.hits) == 0:
		pages := max(1, (s.total+searchPageSize-1)/searchPageSize)
		header += fmt.Sprintf(" | %s | page %d/%d", sorts[s.sort], s.page, pages)
		if s.total == 0 {
			body = []tui.Text{ui.Plain(fmt.Sprintf("No transcript matches for %q.", s.query))}
			for _, line := range ui.Wrap(render.NoMatchHint, width) {
				body = append(body, ui.Dim(line))
			}
		} else {
			body = []tui.Text{ui.Plain(fmt.Sprintf(
				"No matches on page %d; %d matching lines exist.", s.page, s.total))}
		}
	default:
		pages := max(1, (s.total+searchPageSize-1)/searchPageSize)
		header += fmt.Sprintf(" | %s | page %d/%d", sorts[s.sort], s.page, pages)
		pattern := literalPattern(queryTerms(s.query))

		// Keep the selection in view: the window starts at whichever card lets
		// it fit.
		cards := max(1, capacity/searchCardHeight)
		s.listTop = max(0, min(s.listTop, max(0, len(s.hits)-cards)))
		if s.selected < s.listTop {
			s.listTop = s.selected
		}
		if s.selected >= s.listTop+cards {
			s.listTop = s.selected - cards + 1
		}
		for index := s.listTop; index < min(len(s.hits), s.listTop+cards); index++ {
			body = append(body, s.searchCard(s.hits[index], index == s.selected, width, pattern)...)
		}
		scrollKeys := "Up/Down"
		if ui.Policy.Unicode {
			scrollKeys = "↑/↓"
		}
		footer = scrollKeys + " - navigate | Enter - open | s - sort | [/] - page | q - quit |"
	}
	return ui.Screen(header, body, footer)
}

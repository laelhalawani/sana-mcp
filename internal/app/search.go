package app

import (
	"fmt"
	"regexp"
	"strings"

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
	query, sort, page := s.query, sorts[s.sort], s.page
	database := s.app.store
	s.view = searchRunning
	return func() tea.Msg {
		hits, err := database.Search(query, searchPageSize, (page-1)*searchPageSize, sort)
		if err != nil {
			return searchResultMsg{failure: err.Error()}
		}
		total, err := database.SearchCount(query)
		if err != nil {
			return searchResultMsg{hits: hits, total: len(hits)}
		}
		return searchResultMsg{hits: hits, total: total}
	}
}

func (s *searchModel) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.WindowSizeMsg:
		s.ui.Policy.Columns = msg.Width
		s.ui.Policy.Rows = msg.Height

	case searchResultMsg:
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

// searchCardHeight is title, metadata, up to two snippet rows, blank.
const searchCardHeight = 5

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

// snippetAround centres the matching term in a window of the line, so a long
// line does not push the match off the right edge.
func snippetAround(text, query string, pad int) string {
	collapse := func(value string) string { return strings.Join(strings.Fields(value), " ") }
	index := strings.Index(strings.ToLower(text), strings.ToLower(query))
	if index < 0 {
		if len(text) > pad*2 {
			text = text[:pad*2]
		}
		return collapse(text)
	}
	start := max(0, index-pad)
	end := min(len(text), index+len(query)+pad)
	core := collapse(text[start:end])
	prefix, suffix := "", ""
	if start > 0 {
		prefix = "..."
	}
	if end < len(text) {
		suffix = "..."
	}
	return prefix + core + suffix
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
	snippet := ui.Wrap(snippetAround(hit.Text, s.query, 80), snippetWidth)
	for index, line := range snippet {
		if index >= 2 {
			break
		}
		card = append(card, ui.Line("  ", highlight(ui, line, pattern)))
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

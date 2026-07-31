package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/laelhalawani/sana-mcp/internal/config"
	"github.com/laelhalawani/sana-mcp/internal/statusview"
	"github.com/laelhalawani/sana-mcp/internal/store"
	"github.com/laelhalawani/sana-mcp/internal/tui"
)

func testUI() tui.UI {
	return tui.New(tui.Policy{
		Interactive: true, Control: true, Color: true, Unicode: true,
		Columns: 80, Rows: 24,
	})
}

func TestSearchIsOfferedOnceThereIsAListToSearch(t *testing.T) {
	// A pending transcript is the normal state of a working install. Hiding
	// search for it took the feature away almost permanently.
	pending := statusview.Info{SignedIn: true, Status: store.Status{
		MeetingsTotal: 246, Meetings: 245, TranscriptsTotal: 246, TranscriptsDone: 245,
		Remaining: 1, Phase: store.PhaseDownloading,
	}}
	if pending.Preparing() {
		t.Fatal("a pending transcript is not a missing meeting list")
	}

	// Mid-cycle listing with meetings already stored is still browsable.
	listing := statusview.Info{SignedIn: true, Status: store.Status{
		MeetingsTotal: 246, Phase: store.PhaseListing,
	}}
	if listing.Preparing() {
		t.Fatal("re-listing an existing cache is not preparing")
	}

	empty := statusview.Info{SignedIn: true, Status: store.Status{Phase: store.PhaseListing}}
	if !empty.Preparing() {
		t.Fatal("no meetings at all is exactly what preparing means")
	}
	if (statusview.Info{}).Preparing() {
		t.Fatal("signed out is not preparing")
	}
}

func TestMenuFollowsTheSessionAndTheCache(t *testing.T) {
	labels := func(items []choice) string {
		var names []string
		for _, item := range items {
			names = append(names, item.label)
		}
		return strings.Join(names, "|")
	}
	if got := labels(signedOutChoices(false)); got != "Sign in to Sana|Configure AI clients|Quit" {
		t.Fatalf("signed out menu = %q", got)
	}
	if got := labels(signedOutChoices(true)); !strings.HasPrefix(got, "Sign in again (session expired)") {
		t.Fatalf("an expired session must say so, got %q", got)
	}
	if got := labels(signedInChoices(false)); !strings.Contains(got, "Search transcripts") {
		t.Fatalf("search must be offered, got %q", got)
	}
	if got := labels(signedInChoices(true)); strings.Contains(got, "Search transcripts") {
		t.Fatalf("search must wait for a cache, got %q", got)
	}
}

func TestMeetingCardIsThreeRowsWithARailWhenSelected(t *testing.T) {
	ui := testUI()
	meeting := store.Meeting{
		MeetingID: "m1", Title: "Weekly product review", CreatedMS: 1_700_000_000_000,
		Status: store.StatusReady, WordCount: 1200, TranscriptState: store.TranscriptComplete,
	}

	card := meetingCard(meeting, true, 79, ui)
	if len(card) != cardHeight {
		t.Fatalf("a card is %d rows, got %d", cardHeight, len(card))
	}
	if !strings.Contains(string(card[0]), ui.Glyphs.Pointer) {
		t.Fatalf("the selected card needs a pointer: %q", card[0])
	}
	if !strings.Contains(string(card[1]), ui.Glyphs.Rail) {
		t.Fatalf("the selected card needs a rail: %q", card[1])
	}
	if card[2] != "" {
		t.Fatalf("a card ends with a blank row, got %q", card[2])
	}

	unselected := meetingCard(meeting, false, 79, ui)
	if strings.Contains(string(unselected[0]), ui.Glyphs.Pointer) {
		t.Fatalf("an unselected card must not point: %q", unselected[0])
	}
}

func TestMeetingCardShedsMetadataRatherThanOverflowing(t *testing.T) {
	ui := testUI()
	meeting := store.Meeting{
		Title: "A meeting", CreatedMS: 1_700_000_000_000,
		Status: store.StatusReady, WordCount: 1200, TranscriptState: store.TranscriptComplete,
	}
	// Narrow enough that the date and the word count cannot both fit; the
	// status is what a person actually needs and must survive.
	card := meetingCard(meeting, false, 12, ui)
	if !strings.Contains(string(card[1]), "Ready") {
		t.Fatalf("the status was dropped instead of the word count: %q", card[1])
	}
}

func TestDisplayStatusSeparatesWaitingOnUsFromWaitingOnSana(t *testing.T) {
	ready := store.Meeting{Status: store.StatusReady, TranscriptState: store.TranscriptComplete}
	if got := displayStatus(ready); got != store.StatusReady {
		t.Fatalf("displayStatus = %q", got)
	}
	pending := store.Meeting{Status: store.StatusReady, TranscriptState: "absent"}
	if got := displayStatus(pending); got != statusDownloading {
		t.Fatalf("a stored meeting with no transcript is downloading, got %q", got)
	}
	processing := store.Meeting{Status: store.StatusProcessing, TranscriptState: "absent"}
	if got := displayStatus(processing); got != store.StatusProcessing {
		t.Fatalf("Sana is still working on this one, got %q", got)
	}
}

func TestQueryTermsAreUniqueAndLongestFirst(t *testing.T) {
	// Longest first, so "meeting" is highlighted before the "meet" inside it.
	got := queryTerms("meet meeting Meet notes")
	want := "meeting|notes|meet"
	if strings.Join(got, "|") != want {
		t.Fatalf("queryTerms = %q, want %q", got, want)
	}
	if len(queryTerms("")) != 0 {
		t.Fatal("an empty query has no terms")
	}
}

func TestHighlightMarksEveryMatchAndNothingElse(t *testing.T) {
	ui := testUI()
	pattern := literalPattern(queryTerms("fabrix"))
	got := string(highlight(ui, "The Fabrix pipeline and fabrix again", pattern))
	if strings.Count(got, "\x1b[33m") != 2 {
		t.Fatalf("both matches should be highlighted, got %q", got)
	}
	if !strings.Contains(got, "pipeline") {
		t.Fatalf("the surrounding text was lost: %q", got)
	}
	if got := string(highlight(ui, "unchanged", nil)); got != "unchanged" {
		t.Fatalf("no terms means no markup, got %q", got)
	}
}

func TestSnippetCentresTheMatch(t *testing.T) {
	long := strings.Repeat("filler ", 40) + "Fabrix" + strings.Repeat(" filler", 40)
	got := snippetAround(long, "Fabrix", 20)
	if !strings.Contains(got, "Fabrix") {
		t.Fatalf("the match fell out of the snippet: %q", got)
	}
	if !strings.HasPrefix(got, "...") || !strings.HasSuffix(got, "...") {
		t.Fatalf("a trimmed snippet must say so: %q", got)
	}
	// No match: the head of the line, with whitespace collapsed to one space so
	// a wrapped transcript line does not become a wall of gaps.
	if got := snippetAround("one\n two   three", "absent", 80); got != "one two three" {
		t.Fatalf("snippet = %q", got)
	}
}

func TestALineCanBeCorrectedMoreThanOnce(t *testing.T) {
	// The store's compare-and-swap is against the current text. Sending the
	// original meant the second correction of any line was rejected as a
	// mismatch, on the very line the error named.
	database, err := store.Open(filepath.Join(t.TempDir(), "sana.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	if err := database.PutMeetings([]store.Meeting{{
		MeetingID: "m1", Title: "Sync", CreatedMS: 1, Status: store.StatusReady,
	}}); err != nil {
		t.Fatal(err)
	}
	original := "the Fabrics pipeline"
	if err := database.PutTranscript("m1", []store.Line{
		{LineNo: 1, Speaker: "Lael", Text: original, OriginalText: original},
	}); err != nil {
		t.Fatal(err)
	}

	model := &browser{
		app: &application{store: database}, ui: testUI(),
		detailID: "m1", view: viewDetail,
	}
	model.reloadTranscript()

	for _, correction := range []string{"the Fabrix pipeline", "the Fabrix import pipeline"} {
		model.editLine, model.editBuffer = 1, correction
		model.confirm = "save"
		model.confirmKey("y")
		if model.failure != "" {
			t.Fatalf("correcting to %q failed: %s", correction, model.failure)
		}
		if got := model.currentText(1); got != correction {
			t.Fatalf("line reads %q, want %q", got, correction)
		}
	}
	// The original is still what Sana delivered, however many times it changed.
	if got := model.originalText(1); got != original {
		t.Fatalf("original = %q, want %q", got, original)
	}
}

func TestALateRecordingDoesNotLandOnAnotherDocument(t *testing.T) {
	model := &browser{app: &application{}, ui: testUI(), view: viewDetail}

	model.openDocument("", "t", backList) // claims request 1
	stale := detailMsg{request: model.request, id: "m1", title: "Recording",
		lines: []string{"https://example.invalid/x"}}

	model.request++ // the user opened something else
	model.title, model.lines = "Transcript", []string{"1 [0:00] Lael: hello"}
	model.Update(stale)

	if model.title != "Transcript" {
		t.Fatalf("a superseded fetch overwrote the screen: %q", model.title)
	}
}

func TestSnippetAnchorsOnATermThatIsPresent(t *testing.T) {
	// A match is an AND of the terms in any order, so the query as a whole is
	// usually not a substring of the line.
	model := &searchModel{ui: testUI(), query: "roadmap fabrix"}
	line := strings.Repeat("filler ", 20) + "the fabrix roadmap was discussed"

	snippet := snippetAround(line, model.anchor(line), 40)
	for _, term := range []string{"fabrix", "roadmap"} {
		if !strings.Contains(strings.ToLower(snippet), term) {
			t.Fatalf("snippet has no %q in it: %q", term, snippet)
		}
	}
}

func TestARejectedSessionIsNotShownAsProgress(t *testing.T) {
	// A cookie on disk only means a file exists. When Sana rejects it the
	// daemon records needs_login and clears last_error, so nothing else says
	// the sync is dead.
	info := statusview.Info{SignedIn: false, Expired: true, Status: store.Status{
		Phase: store.PhaseNeedsLogin, Meetings: 12, MeetingsTotal: 240, Remaining: 228,
	}}
	if !info.Expired {
		t.Fatal("an expired session must be distinguishable")
	}
	items := signedOutChoices(info.Expired)
	if !strings.HasPrefix(items[0].label, "Sign in again") {
		t.Fatalf("the expired label is unreachable: %q", items[0].label)
	}
}

func TestSigningInAgainTakesEffectImmediately(t *testing.T) {
	// The daemon only clears needs_login on its next cycle, up to the sync
	// interval away. Signing in clears it directly, or the screens keep
	// reporting a session that has just been replaced as expired.
	paths := config.PathsUnder(t.TempDir())
	database, err := store.Open(paths.Database)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.SetPhase(store.PhaseNeedsLogin); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.Session,
		[]byte(`{"cookies":{"sana-ai-session":"fresh"},"email":"a@b.c"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if info := statusview.Read(paths); !info.Expired {
		t.Fatalf("a rejected session must read as expired: %+v", info)
	}

	// What signIn does once the new session is stored.
	if err := database.SetPhase(store.PhaseIdle); err != nil {
		t.Fatal(err)
	}
	info := statusview.Read(paths)
	if !info.SignedIn || info.Expired {
		t.Fatalf("a fresh sign-in was ignored: %+v", info)
	}
}

func TestALapsedSessionKeepsTheMeetingsYouAlreadyHave(t *testing.T) {
	// A lapsed session is not the absence of one: the meetings already
	// downloaded are still readable, and the account entry is how to sign in
	// again. Reporting it as signed-out took every screen away instead.
	paths := config.PathsUnder(t.TempDir())
	database, err := store.Open(paths.Database)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.SetPhase(store.PhaseNeedsLogin); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.Session,
		[]byte(`{"cookies":{"sana-ai-session":"stale"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	info := statusview.Read(paths)
	if !info.SignedIn || !info.Expired {
		t.Fatalf("a rejected session must be both stored and expired: %+v", info)
	}
	// The counts are meaningless without a session Sana accepts, so they are
	// suppressed, and the screen says why.
	if !info.Preparing() {
		t.Log("no meetings yet, which is the normal fresh state")
	}
}

func TestSnippetCutsOnRunesNotBytes(t *testing.T) {
	line := strings.Repeat("zażółć gęślą jaźń ", 12) + "Fabrix" + strings.Repeat(" jaźń", 12)
	got := snippetAround(line, "Fabrix", 20)
	if !utf8.ValidString(got) {
		t.Fatalf("a multi-byte rune was cut in half: %q", got)
	}
	if !strings.Contains(got, "Fabrix") {
		t.Fatalf("the match fell out: %q", got)
	}
	// A snippet with no match is still trimmed, and says so.
	long := strings.Repeat("ą", 400)
	cut := snippetAround(long, "absent", 20)
	if !utf8.ValidString(cut) || !strings.HasSuffix(cut, "...") {
		t.Fatalf("a cut snippet must be valid and marked: %q", cut)
	}
}

func TestASavedCorrectionIsDrawnImmediately(t *testing.T) {
	// The wrapped layout is cached. A body replaced without changing the key
	// left the old rows on screen, so a save looked like it had done nothing
	// until the next refresh a second later.
	database, err := store.Open(filepath.Join(t.TempDir(), "sana.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.PutMeetings([]store.Meeting{{
		MeetingID: "m1", Title: "Sync", CreatedMS: 1, Status: store.StatusReady,
	}}); err != nil {
		t.Fatal(err)
	}
	if err := database.PutTranscript("m1", []store.Line{
		{LineNo: 1, Speaker: "Lael", Text: "the Fabrics pipeline", OriginalText: "the Fabrics pipeline"},
	}); err != nil {
		t.Fatal(err)
	}

	model := &browser{
		app: &application{store: database}, ui: testUI(),
		detailID: "m1", view: viewDetail,
	}
	model.reloadTranscript()
	model.View() // fills the cache

	model.editLine, model.editBuffer = 1, "the Fabrix pipeline"
	model.confirm = "save"
	model.confirmKey("y")

	if screen := model.View(); !strings.Contains(screen, "Fabrix") {
		t.Fatalf("the correction is not on screen:\n%s", screen)
	}
}

func TestOneScreenDoesNotRenderAnothersBody(t *testing.T) {
	// Every windowed screen shares the revision counter, so a cache keyed on
	// that alone handed the keyboard help's rows to whatever came next.
	model := &browser{app: &application{}, ui: testUI(), view: viewHelp}
	if help := model.View(); !strings.Contains(help, "Keyboard help") {
		t.Fatalf("expected the help screen:\n%s", help)
	}
	model.info = statusview.Info{SignedIn: true}
	model.view, model.scroll = viewList, 0

	list := model.View()
	if strings.Contains(list, "pgup/pgdn/home/end jump") {
		t.Fatalf("the help body leaked into the list:\n%s", list)
	}
}

func TestSnippetSurvivesLengthChangingCase(t *testing.T) {
	// Lowercasing can change a string's byte length, so a byte offset taken
	// from a lowered copy is not an offset into the original.
	line := strings.Repeat("İ", 60) + " the Fabrix roadmap"
	got := snippetAround(line, "Fabrix", 20)
	if !strings.Contains(got, "Fabrix") {
		t.Fatalf("the anchored term fell out of the snippet: %q", got)
	}
}

func TestSearchCardAlwaysShowsTheMatch(t *testing.T) {
	// A card draws two snippet rows. A window larger than they can hold spills
	// onto a third row that is never rendered, taking the match with it - and
	// the result shows a stretch of the line containing none of the words
	// searched for.
	lines := map[string]string{
		"url":     "we discussed https://example.invalid/very/long/path in the meeting today ok",
		"short":   strings.Repeat("aaa bbb ccc ", 12) + "fabrix " + strings.Repeat("ddd eee ", 12),
		"long":    strings.Repeat("supercalifragilisticexpialidocious ", 6) + "fabrix " + strings.Repeat("antidisestablishmentarianism ", 6),
		"midlong": strings.Repeat("meeting ", 30) + "fabrix " + strings.Repeat("notes ", 30),
		// Wide characters, because the rows are measured in columns and a
		// window counted in runes is twice too wide for them - which put the
		// match on a row the card never draws.
		"cjk":   strings.Repeat("会議の話", 20) + " fabrix " + strings.Repeat("面接の話", 20),
		"emoji": strings.Repeat("🎉🎈 ", 20) + "fabrix " + strings.Repeat("🚀✨ ", 20),
	}
	queries := map[string]string{
		"url": "path", "short": "fabrix", "long": "fabrix",
		"midlong": "fabrix", "cjk": "fabrix", "emoji": "fabrix",
	}

	for name, line := range lines {
		query := queries[name]
		for width := 8; width <= 120; width++ {
			policy := tui.Policy{Interactive: true, Control: true, Unicode: true,
				Columns: width + 1, Rows: 24}
			model := &searchModel{ui: tui.New(policy), query: query}
			card := model.searchCard(
				store.Hit{Title: "T", LineNo: 1, Text: line}, false, width, nil)

			var shown strings.Builder
			for _, row := range card {
				shown.WriteString(string(row))
			}
			// Whitespace removed: on a very narrow terminal the term is split
			// across the two rows, which is still legible.
			visible := strings.ToLower(strings.Join(strings.Fields(shown.String()), ""))
			if !strings.Contains(visible, query) {
				t.Fatalf("%s at width %d shows no match:\n%s", name, width, shown.String())
			}
		}
	}
}

func TestScrollSurvivesAResize(t *testing.T) {
	// A scroll position is only valid for the window it was clamped against.
	// Widening the terminal while scrolled to the end left it past the new end:
	// a few lines of text above a screenful of blank rows.
	lines := make([]string, 100)
	for index := range lines {
		lines[index] = fmt.Sprintf("%d [0:00] Lael: line %d", index+1, index+1)
	}

	policy := tui.Policy{Interactive: true, Control: true, Unicode: true,
		Columns: 80, Rows: 10}
	model := &searchModel{ui: tui.New(policy), view: searchTranscript,
		title: "T", lines: lines}
	model.scrollTranscript("end")

	model.ui.Policy.Rows = 40
	rendered := model.View()

	blank := 0
	for _, row := range strings.Split(rendered, "\n") {
		if row == "" {
			blank++
		}
	}
	if blank > 2 {
		t.Fatalf("a resize left %d blank rows:\n%s", blank, rendered)
	}
	if !strings.Contains(rendered, "line 100") {
		t.Fatalf("the end of the document is no longer shown:\n%s", rendered)
	}
}

func TestACutSnippetSaysItWasCut(t *testing.T) {
	// The window does not wrap into an exact number of rows, so it can spill
	// onto a row the card never draws - taking the marker with it, and leaving
	// a snippet that was cut reading as the whole line.
	line := strings.Repeat("meeting ", 60) + "fabrix " + strings.Repeat("notes ", 60)
	for width := 10; width <= 100; width += 2 {
		policy := tui.Policy{Interactive: true, Control: true, Unicode: true,
			Columns: width + 1, Rows: 24}
		ui := tui.New(policy)
		model := &searchModel{ui: ui, query: "fabrix"}

		card := model.searchCard(store.Hit{Title: "T", LineNo: 1, Text: line}, false, width, nil)
		if len(card) > searchCardHeight {
			t.Fatalf("width %d: a card is %d rows, limit %d", width, len(card), searchCardHeight)
		}
		var shown strings.Builder
		for _, row := range card {
			shown.WriteString(string(row))
		}
		if !strings.Contains(shown.String(), ui.OverflowMarker) {
			t.Fatalf("width %d: a cut snippet does not say so:\n%s", width, shown.String())
		}
	}
}

func TestAMatchOnlyInTheOriginalSaysSo(t *testing.T) {
	// The index covers the line as delivered as well as the line as corrected,
	// which is the point: the old spelling stays findable. Without saying so
	// the card showed the head of a line containing neither spelling.
	model := &searchModel{ui: testUI(), query: "Fabrics"}
	hit := store.Hit{
		Title: "Sync", LineNo: 1,
		Text:         "the Fabrix pipeline needs a crawler",
		OriginalText: "the Fabrics pipeline needs a crawler",
	}
	if !model.matchedOriginal(hit) {
		t.Fatal("a match only in the original must be recognised")
	}
	var shown strings.Builder
	for _, row := range model.searchCard(hit, false, 79, nil) {
		shown.WriteString(string(row) + "\n")
	}
	if !strings.Contains(shown.String(), "original wording") {
		t.Fatalf("the card does not explain itself:\n%s", shown.String())
	}
	if !strings.Contains(shown.String(), "Fabrics") {
		t.Fatalf("the searched word is not shown:\n%s", shown.String())
	}

	// A hit whose word is in the current text is an ordinary result.
	plain := store.Hit{Title: "Sync", LineNo: 1,
		Text: "the Fabrix pipeline", OriginalText: "the Fabrics pipeline"}
	model.query = "Fabrix"
	if model.matchedOriginal(plain) {
		t.Fatal("a word present in the current text is not an original-only match")
	}
}

func TestUnreadableStateIsNotReportedAsZeroMeetings(t *testing.T) {
	model := &browser{app: &application{}, ui: testUI(),
		info: statusview.Info{SignedIn: true, Unavailable: "database schema is version 3"}}
	lines := strings.Join(model.statusLines(), "\n")
	if strings.Contains(lines, "Meetings ready: 0") {
		t.Fatalf("counts that were never read must not be printed:\n%s", lines)
	}
	if !strings.Contains(lines, "Background sync unavailable") {
		t.Fatalf("the reason must be shown:\n%s", lines)
	}
}

func TestEveryMenuActionIsDispatched(t *testing.T) {
	// "Sign in to Sana" emitted an action dispatch had no case for, so choosing
	// it fell through the switch and redrew the menu: navigation worked and
	// nothing happened. Menus and the switch are written in different places,
	// so the two are tied together here rather than by eye.
	handled := map[string]bool{}
	source, err := os.ReadFile("app.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(source)
	start := strings.Index(body, "func (a *application) dispatch(")
	if start < 0 {
		t.Fatal("dispatch is gone; this test needs rewriting")
	}
	for _, line := range strings.Split(body[start:], "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "case \"") {
			continue
		}
		for _, part := range strings.Split(strings.TrimSuffix(
			strings.TrimPrefix(trimmed, "case "), ":"), ",") {
			handled[strings.Trim(strings.TrimSpace(part), "\"")] = true
		}
	}

	var menus [][]choice
	menus = append(menus, signedOutChoices(false), signedOutChoices(true),
		signedInChoices(false), signedInChoices(true))
	for _, menu := range menus {
		for _, item := range menu {
			if !handled[item.action] {
				t.Errorf("menu entry %q emits %q, which dispatch ignores",
					item.label, item.action)
			}
		}
	}
}

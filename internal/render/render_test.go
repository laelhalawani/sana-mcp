package render

import (
	"strings"
	"testing"

	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/store"
)

func ptr(s string) *string { return &s }

// The three surfaces had drifted on exactly these two cases before the layout
// was shared, so they are pinned here.
func TestSummaryTreatsWhitespaceOnlyAsEmpty(t *testing.T) {
	out := Summary(sana.Metadata{Summary: ptr("   \n  ")}, Styles{})
	if !strings.Contains(out, "no summary.") {
		t.Fatalf("a whitespace-only summary should count as absent, got %q", out)
	}
}

// Every shape a participant line can take. The old layout separated both the
// email and the host marker with the same two spaces, and both are optional, so
// the line had six shapes - two of which were unparseable and one of which was
// a blank line. These are pinned because a consumer splits this output.
func TestParticipantLineIsNeverAmbiguous(t *testing.T) {
	for _, testCase := range []struct {
		name        string
		participant sana.Participant
		want        string
	}{
		{"name, email and host", sana.Participant{
			DisplayName: "Dana Whitfield", Email: ptr("dana@example.com"), IsHost: true},
			"Dana Whitfield <dana@example.com> (host)"},
		{"name and email", sana.Participant{
			DisplayName: "Roy Feld", Email: ptr("roy@example.com")},
			"Roy Feld <roy@example.com>"},
		// The reported bug: with the old layout this read "Roy Feld  (host)",
		// so splitting on the separator recorded "(host)" as the address.
		{"host with no email", sana.Participant{
			DisplayName: "Roy Feld", IsHost: true},
			"Roy Feld (host)"},
		{"an empty email is the same as none", sana.Participant{
			DisplayName: "Roy Feld", Email: ptr("")},
			"Roy Feld"},
		// No name at all: the address is the only identity there is, so it
		// stands in rather than following an empty name.
		{"email only", sana.Participant{Email: ptr("sam@example.com")},
			"<sam@example.com>"},
		// Nothing at all. This used to render as a blank line.
		{"nothing at all", sana.Participant{}, "Unnamed participant"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			line := participantLine(testCase.participant, Styles{})
			if line != testCase.want {
				t.Fatalf("got %q, want %q", line, testCase.want)
			}
			if strings.TrimSpace(line) == "" {
				t.Fatal("a participant line must never be blank")
			}
			// An address only ever appears inside angle brackets, which is what
			// stops the host marker being mistaken for one.
			if strings.Contains(line, "@") && !strings.Contains(line, "<") {
				t.Fatalf("an email must be delimited, got %q", line)
			}
		})
	}
}

// The two groups answer different questions and must stay visibly separate:
// Sana's participant endpoint reports who has access, not who attended.
func TestAttendanceSeparatesMembersFromSpeakers(t *testing.T) {
	out := Attendance(
		[]sana.Participant{{DisplayName: "Dana Whitfield", Email: ptr("dana@example.com")}}, nil,
		[]store.Speaker{{Name: "Priya Raman", Lines: 48}, {Name: "Ines Duarte", Lines: 1}}, true,
		Styles{})

	for _, want := range []string{
		"Workspace members with access (1)",
		"Speakers in the transcript (2)",
		"Dana Whitfield <dana@example.com>",
		"Priya Raman",
		"48 lines",
		"1 line", // singular, not "1 lines"
		"Neither list is attendance",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("output is missing %q:\n%s", want, out)
		}
	}
	// A member who never spoke must not be presented as a speaker.
	members, _, found := strings.Cut(out, "Speakers in the transcript")
	if !found {
		t.Fatal("the two groups must be separately labelled")
	}
	if strings.Contains(members, "Priya Raman") {
		t.Fatal("a speaker must not appear in the members group")
	}
}

// An empty group and a group that has not been downloaded are different facts,
// and reporting the second as the first tells an agent a meeting had no members
// or no speakers when in truth nothing had arrived. The daemon fetches the
// metadata document and the transcript separately, so mid-sync every
// combination below is reachable.
func TestAttendanceDistinguishesEmptyFromNotDownloaded(t *testing.T) {
	member := []sana.Participant{{DisplayName: "Dana Whitfield"}}
	speaker := []store.Speaker{{Name: "Priya Raman", Lines: 3}}

	for _, testCase := range []struct {
		name              string
		participants      []sana.Participant
		membersErr        error
		speakers          []store.Speaker
		transcriptFetched bool
		want              []string
		reject            []string
	}{
		// No count either: "(0)" beside "Not downloaded yet" still reads as
		// "this meeting has no members" to anything parsing the heading.
		{"members not fetched", nil, store.ErrNotFound, speaker, true,
			[]string{"Workspace members with access\n", "Not downloaded yet"},
			[]string{"None are recorded", "Workspace members with access (0)"}},
		{"members fetched and genuinely empty", nil, nil, speaker, true,
			[]string{"None are recorded for this meeting"},
			[]string{"Not downloaded yet"}},
		{"transcript not fetched", member, nil, nil, false,
			[]string{"Speakers in the transcript\n", "Not downloaded yet"},
			[]string{"None are named", "Speakers in the transcript (0)"}},
		{"transcript fetched but names nobody", member, nil, nil, true,
			[]string{"None are named in this transcript"},
			[]string{"Not downloaded yet"}},
		{"nothing downloaded at all", nil, store.ErrNotFound, nil, false,
			[]string{"Not downloaded yet"},
			[]string{"None are recorded", "None are named", "(0)"}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			out := Attendance(testCase.participants, testCase.membersErr,
				testCase.speakers, testCase.transcriptFetched, Styles{})
			for _, want := range testCase.want {
				if !strings.Contains(out, want) {
					t.Fatalf("missing %q in:\n%s", want, out)
				}
			}
			for _, reject := range testCase.reject {
				if strings.Contains(out, reject) {
					t.Fatalf("must not claim %q in:\n%s", reject, out)
				}
			}
		})
	}
}

func TestSummaryRendersNotesAndActions(t *testing.T) {
	out := Summary(sana.Metadata{
		Summary: ptr("We compared vendors."),
		Notes:   []sana.NoteGroup{{Topic: "Vendors", Notes: []string{"Fabrix ruled out"}}},
		ActionItems: []sana.ActionItem{
			{AssignedTo: ptr("Priya"), Action: "scale to 500 products", DueDate: "2026-08-01"},
			{Action: "unassigned work"},
		},
	}, Styles{})
	for _, want := range []string{
		"We compared vendors.", "Vendors", "  - Fabrix ruled out",
		"Action items", "  - Priya: scale to 500 products (due 2026-08-01)",
		"  - unassigned work",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

func TestStylesAreOptional(t *testing.T) {
	upper := func(s string) string { return strings.ToUpper(s) }
	out := Summary(sana.Metadata{Notes: []sana.NoteGroup{{Topic: "topic", Notes: []string{"n"}}}},
		Styles{Heading: upper})
	if !strings.Contains(out, "TOPIC") {
		t.Fatalf("the heading style should apply, got %q", out)
	}
}

// A long meeting must not report 125:03 as 5:03.
func TestClockCarriesHours(t *testing.T) {
	cases := map[int64]string{0: "0:00", 62_000: "1:02", 3_600_000: "1:00:00", 7_505_000: "2:05:05"}
	for ms, want := range cases {
		if got := Clock(ms); got != want {
			t.Errorf("Clock(%d) = %q, want %q", ms, got, want)
		}
	}
}

func TestProgressBarDrawsNothingUntilTheTotalIsKnown(t *testing.T) {
	// A framed but empty bar is what the user saw for twenty minutes while the
	// first listing had not landed. It has to draw nothing instead.
	if bar := ProgressBar(0, 0, 24); bar != "" {
		t.Fatalf("an unknown total must not draw a bar, got %q", bar)
	}
	if bar := ProgressBar(2, 4, 4); bar != "" {
		t.Fatalf("a bar narrower than eight columns must not draw, got %q", bar)
	}
	if got := ProgressBar(4, 8, 8); got != "[####----]" {
		t.Fatalf("half progress = %q", got)
	}
	if got := ProgressBar(99, 8, 8); got != "[########]" {
		t.Fatalf("overflow must clamp, got %q", got)
	}
}

func TestStatusLinesReportCoverage(t *testing.T) {
	out := StatusLines(store.Status{
		Meetings: 77, MeetingsTotal: 240,
		TranscriptsDone: 77, TranscriptsTotal: 240, Remaining: 163,
	})
	for _, want := range []string{"meetings      77 of 240", "transcripts   77 of 240", "remaining     163"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

// Column alignment is by display width, not by %-*s, which pads by runes. The
// two agree for accented Latin names - "Łukasz Wójcik" is 15 bytes but 13 runes
// and 13 columns - and disagree wherever a rune is not one column wide. Both
// directions are covered here: a CJK name is two columns per rune, and a
// combining accent adds a rune worth zero columns. With only Latin names this
// test passes under either rule and proves nothing.
func TestSpeakerCountsAlignRegardlessOfCharacterWidth(t *testing.T) {
	out := Attendance(nil, nil, []store.Speaker{
		{Name: "\u5927\u885b \u9673", Lines: 12},
		{Name: "Jos\u00e9\u0301 Ruiz", Lines: 7},
		{Name: "Marcus Oyelaran", Lines: 3},
		{Name: "\u0141ukasz W\u00f3jcik", Lines: 1},
	}, true, Styles{})

	var columns []int
	for _, line := range strings.Split(out, "\n") {
		if !strings.HasPrefix(line, "  ") ||
			(!strings.HasSuffix(line, "line") && !strings.HasSuffix(line, "lines")) {
			continue
		}
		digit := strings.IndexAny(line, "0123456789")
		if digit < 0 {
			continue
		}
		columns = append(columns, DisplayWidth(line[:digit]))
	}
	if len(columns) != 4 {
		t.Fatalf("expected four speaker rows, found %d in:\n%s", len(columns), out)
	}
	for _, column := range columns[1:] {
		if column != columns[0] {
			t.Fatalf("counts start at columns %v, so they do not line up:\n%s", columns, out)
		}
	}
}

func TestParticipantNameThatIsOnlyWhitespaceFallsBack(t *testing.T) {
	for _, testCase := range []struct {
		name        string
		participant sana.Participant
		want        string
	}{
		{"whitespace name with an email", sana.Participant{
			DisplayName: "   ", Email: ptr("sam@example.com")}, "<sam@example.com>"},
		{"whitespace name with nothing else", sana.Participant{
			DisplayName: " \t "}, "Unnamed participant"},
		{"whitespace email is not an email", sana.Participant{
			DisplayName: "Roy Feld", Email: ptr("  ")}, "Roy Feld"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			line := participantLine(testCase.participant, Styles{})
			if line != testCase.want {
				t.Fatalf("got %q, want %q", line, testCase.want)
			}
		})
	}
}

// One participant is one line. A name carrying a newline would otherwise split
// into two, which is exactly what delimiting the address was meant to rule out.
func TestParticipantLineStaysOnOneLine(t *testing.T) {
	line := participantLine(sana.Participant{
		DisplayName: "Roy\nFeld", Email: ptr("roy@example.com")}, Styles{})
	if strings.Contains(line, "\n") {
		t.Fatalf("a participant must render as one line, got %q", line)
	}
}

// A non-empty list is proof its source arrived, so a caller holding a stale
// flag must not produce "Not downloaded yet" directly above the rows it just
// supplied. The browser derives its flag from a cached meeting row, so this is
// reachable rather than hypothetical.
func TestAttendanceNeverContradictsItself(t *testing.T) {
	out := Attendance(
		[]sana.Participant{{DisplayName: "Dana Whitfield"}}, store.ErrNotFound,
		[]store.Speaker{{Name: "Priya Raman", Lines: 4}}, false, Styles{})

	if strings.Contains(out, "Not downloaded yet") {
		t.Fatalf("rows were supplied, so nothing may claim they are missing:\n%s", out)
	}
	for _, want := range []string{
		"Workspace members with access (1)", "Dana Whitfield",
		"Speakers in the transcript (1)", "Priya Raman",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in:\n%s", want, out)
		}
	}
}

// The angle brackets are what make the address self-identifying, so a display
// name carrying its own must not be able to forge one.
func TestParticipantNameCannotForgeAnAddress(t *testing.T) {
	line := participantLine(sana.Participant{
		DisplayName: "Roy <roy@elsewhere.example>",
		Email:       ptr("real@example.com"),
	}, Styles{})

	if strings.Count(line, "<") != 1 || strings.Count(line, ">") != 1 {
		t.Fatalf("exactly one bracketed field is allowed, got %q", line)
	}
	if !strings.Contains(line, "<real@example.com>") {
		t.Fatalf("the delimited address must be the real one, got %q", line)
	}
}

// The invariant is "exactly one bracketed field", which has to hold from both
// sides: an address carrying its own delimiters would close the field early and
// hand a consumer a truncated address.
func TestParticipantEmailCannotBreakItsOwnDelimiters(t *testing.T) {
	line := participantLine(sana.Participant{
		DisplayName: "Roy", Email: ptr("roy<a>@example.com")}, Styles{})

	if strings.Count(line, "<") != 1 || strings.Count(line, ">") != 1 {
		t.Fatalf("exactly one bracketed field is allowed, got %q", line)
	}
	inside := line[strings.Index(line, "<")+1 : strings.Index(line, ">")]
	if inside != "roya@example.com" {
		t.Fatalf("the delimited field should be the whole address, got %q from %q", inside, line)
	}
}

// A diarization label that sanitises away must still name its row. The store's
// guard cannot catch these: a format character such as a left-to-right mark is
// not a space, so TrimSpace keeps it and only Sanitize removes it - leaving a
// line count credited to nobody under a heading claiming N speakers.
func TestSpeakerWhoseNameSanitisesAwayStillNamesItsRow(t *testing.T) {
	out := Attendance(nil, nil, []store.Speaker{
		{Name: "‎", Lines: 2},
		{Name: "Priya Raman", Lines: 5},
	}, true, Styles{})

	if !strings.Contains(out, "Unnamed speaker") {
		t.Fatalf("a nameless speaker needs a label, got:\n%s", out)
	}
	for _, line := range strings.Split(out, "\n") {
		if !strings.HasSuffix(line, "lines") && !strings.HasSuffix(line, "line") {
			continue
		}
		// Everything before the count must be more than whitespace.
		digit := strings.IndexAny(line, "0123456789")
		if digit >= 0 && strings.TrimSpace(line[:digit]) == "" {
			t.Fatalf("a line count is credited to nobody in:\n%s", out)
		}
	}
}
func TestSpeakerNameCannotForgeAnAddress(t *testing.T) {
	out := Attendance(
		[]sana.Participant{{DisplayName: "Dana", Email: ptr("dana@example.com")}}, nil,
		[]store.Speaker{{Name: "Mallory <ceo@corp.example>", Lines: 3}}, true, Styles{})

	_, speakerGroup, _ := strings.Cut(out, "Speakers in the transcript")
	if strings.Contains(speakerGroup, "<") || strings.Contains(speakerGroup, ">") {
		t.Fatalf("a speaker row must not carry address delimiters:\n%s", out)
	}
	if !strings.Contains(speakerGroup, "Mallory") {
		t.Fatalf("the label itself should survive:\n%s", out)
	}
}
func TestSpeakerNameHasNoInternalWhitespaceRuns(t *testing.T) {
	out := Attendance(nil, nil,
		[]store.Speaker{{Name: "Zara   Nolan", Lines: 2}}, true, Styles{})
	if !strings.Contains(out, "Zara Nolan") {
		t.Fatalf("internal runs should collapse to one space:\n%s", out)
	}
}

// One pipeline for every identity field, so the three call sites cannot drift.
// It is short by intent: these names come from the workspace directory and from
// Sana's diarization, so it handles malformed data rather than defending
// against a forged field.
func TestScrubbedNormalisesAName(t *testing.T) {
	for _, testCase := range []struct{ name, in, want string }{
		{"address delimiters cannot be forged", "Roy <a@b.c>", "Roy a@b.c"},
		{"whitespace runs collapse", "Roy    Vance", "Roy Vance"},
		{"control characters go", "Roy\x01 Vance", "Roy Vance"},
		{"invalid encoding goes", "Roy\xffVance", "RoyVance"},
		{"ordinary punctuation survives", "Roy (Contractor)", "Roy (Contractor)"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if got := scrubbed(testCase.in); got != testCase.want {
				t.Fatalf("scrubbed(%q) = %q, want %q", testCase.in, got, testCase.want)
			}
		})
	}
}

func TestCountAgreesWithItsNoun(t *testing.T) {
	for _, testCase := range []struct {
		n    int
		want string
	}{{0, "0 lines"}, {1, "1 line"}, {2, "2 lines"}, {48, "48 lines"}} {
		if got := Count(testCase.n, "line"); got != testCase.want {
			t.Fatalf("Count(%d) = %q, want %q", testCase.n, got, testCase.want)
		}
	}
}

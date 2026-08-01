package store

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// checkChunks asserts the invariants every split must hold, whatever the input.
func checkChunks(t *testing.T, text string, chunks []Chunk) {
	t.Helper()
	if len(chunks) == 0 {
		t.Fatal("a split must produce at least one chunk")
	}
	for index, piece := range chunks {
		if len(piece.Text) > splitMax {
			t.Fatalf("chunk %d is %d bytes, over the %d cap", index, len(piece.Text), splitMax)
		}
		if !utf8.ValidString(piece.Text) {
			t.Fatalf("chunk %d was cut inside a character", index)
		}
		// The offset must actually locate the chunk in the source. Correction
		// remapping addresses chunks by offset, so a wrong one silently moves
		// an edit to the wrong line.
		at := piece.Start
		if at < 0 || at+len(piece.Text) > len(text) || text[at:at+len(piece.Text)] != piece.Text {
			t.Fatalf("chunk %d does not sit at its stated offset %d", index, piece.Start)
		}
		if index > 0 {
			previous := chunks[index-1]
			if piece.Start < previous.Start+len(previous.Text) {
				t.Fatalf("chunk %d overlaps the one before it", index)
			}
		}
	}
	// Nothing but whitespace may be dropped. Checking the gaps between chunks
	// directly is exact, where rebuilding and comparing has to guess whether a
	// seam had a space in it.
	previousEnd := 0
	for index, piece := range chunks {
		if gap := text[previousEnd:piece.Start]; strings.TrimSpace(gap) != "" {
			t.Fatalf("content dropped before chunk %d: %q", index, gap)
		}
		previousEnd = piece.Start + len(piece.Text)
	}
	if tail := text[previousEnd:]; strings.TrimSpace(tail) != "" {
		t.Fatalf("content dropped after the last chunk: %q", tail)
	}
	// Re-splitting output must return it unchanged, or the migration is not
	// safe to run twice.
	for index, piece := range chunks {
		again := splitLine(piece.Text)
		if len(again) != 1 || again[0].Text != piece.Text {
			t.Fatalf("chunk %d splits further on a second pass", index)
		}
	}
}

func TestSplitLeavesShortTurnsAlone(t *testing.T) {
	for _, text := range []string{"Yeah.", "", "Got it, thanks."} {
		chunks := splitLine(text)
		if len(chunks) != 1 || chunks[0].Text != text || chunks[0].Start != 0 {
			t.Fatalf("%q should pass through whole, got %+v", text, chunks)
		}
	}
}

func TestSplitBreaksALongTurnAtSentences(t *testing.T) {
	sentence := "So then we import the products from the integration and it maps them across. "
	text := strings.Repeat(sentence, 40) // ~3,100 bytes
	chunks := splitLine(text)

	if len(chunks) < 3 {
		t.Fatalf("expected several chunks, got %d", len(chunks))
	}
	checkChunks(t, text, chunks)
	for index, piece := range chunks[:len(chunks)-1] {
		// Every chunk but the tail should end where a sentence ended.
		if !strings.HasSuffix(strings.TrimSpace(piece.Text), ".") {
			t.Fatalf("chunk %d does not end at a sentence: %q", index, piece.Text)
		}
	}
}

func TestSplitDoesNotBreakAtAbbreviationsOrNumbers(t *testing.T) {
	// Each of these full stops is part of a word or a number. Breaking at one
	// would cut a sentence in half.
	for _, testCase := range []struct{ name, filler string }{
		{"polish abbreviation", "Robimy to np. w tym tygodniu i potem jeszcze raz w kolejnym miesiacu razem. "},
		{"polish ordinal", "Zrobimy to 5. razem z zespolem i potem jeszcze raz w kolejnym miesiacu tez. "},
		{"decimal", "The budget moved from 3.5 to 4.75 across the quarter and then settled again. "},
		{"initials", "That was J. Kowalski who set the whole integration up for us last quarter. "},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			text := strings.Repeat(testCase.filler, 30)
			chunks := splitLine(text)
			checkChunks(t, text, chunks)

			// The guarded token must never be left dangling at the end of a
			// chunk, which is what a wrong break looks like.
			for _, piece := range chunks {
				trimmed := strings.TrimSpace(piece.Text)
				for _, bad := range []string{"np.", "5.", "3.", "4.", "J."} {
					if strings.HasSuffix(trimmed, bad) {
						t.Fatalf("broke after %q: %q", bad, trimmed)
					}
				}
			}
		})
	}
}

func TestSplitFallsBackWhenThereIsNoPunctuation(t *testing.T) {
	// A run-on with no sentence end at all still has to be broken, and must
	// break at a word gap rather than inside a word.
	text := strings.Repeat("and then we went and did the thing again ", 80)
	chunks := splitLine(text)
	checkChunks(t, text, chunks)
	if len(chunks) < 3 {
		t.Fatalf("expected the run-on to be broken up, got %d chunks", len(chunks))
	}
	for index, piece := range chunks {
		if strings.HasPrefix(piece.Text, " ") || strings.HasSuffix(piece.Text, " ") {
			t.Fatalf("chunk %d carries the whitespace at a seam: %q", index, piece.Text)
		}
	}
}

func TestSplitHandlesTextWithNoSpacesAtAll(t *testing.T) {
	// Not speech, but it must not cut a character in half or loop forever.
	text := strings.Repeat("ąćęłńóśźż", 300) // multi-byte, no spaces
	chunks := splitLine(text)
	checkChunks(t, text, chunks)
}

func TestSplitKeepsPolishTextIntact(t *testing.T) {
	sentence := "Nie mamy jeszcze zaimportowanej tej kolumny z opisami od dostawcow w systemie. "
	text := strings.Repeat(sentence, 40)
	chunks := splitLine(text)
	checkChunks(t, text, chunks)
}

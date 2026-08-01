package store

import "strings"

// Splitting a speaker turn into addressable lines.
//
// The rule is a pure function of the text and nothing else. That is what lets
// resplit.go re-run it over stored transcripts and reproduce exactly the
// boundaries a fresh download would produce, so migrating costs no re-fetch.
// Anything that needs the word timings, the speaker, or a model would break
// that guarantee - which is why pause-based splitting was rejected despite the
// per-word timestamps being right there at download.
//
// Sizes. Measured against a real corpus, speech recognition here ends a
// sentence every 82 characters inside the long segments, slightly more often
// than the 87 it averages corpus-wide. So punctuation is a dependable signal
// precisely where the splitting happens, and a 600-character target is around
// seven sentences.
//
// The size matters more than it would for a vector index. SQLite FTS5 hard-codes
// BM25 with b=0.75 and no way to tune it, so a line is penalised by its length
// over the corpus average. With a median line of 13 characters that average is
// tiny, and a 25,000-character monologue is penalised so heavily that a term
// inside it ranks far below the same term in a one-word reply. Long lines are
// not merely awkward to read, they are close to unfindable.
const (
	// splitTarget is where packing stops: sentences are added to a line until
	// the next one would take it past this.
	splitTarget = 600
	// splitMax is the hard cap, and also the point below which a line is left
	// alone entirely. Those are the same number on purpose: every emitted line
	// is at most splitMax, so re-running the splitter over its own output
	// returns it unchanged. That idempotence is what makes the migration safe
	// to run twice.
	splitMax = 1000
	// splitMin stops a boundary near the very start of a line producing a
	// fragment with no content in it.
	splitMin = 200
)

// SplitSegment breaks one speaker turn into the lines it will be stored as.
//
// The download path calls this so that a transcript arriving now is split the
// same way the migration splits one that arrived a year ago. Two rules would
// mean two line conventions in the same database.
func SplitSegment(text string) []Chunk {
	return splitLine(text)
}

// splitLine breaks one speaker turn into lines. A turn at or below splitMax is
// returned whole, as a single chunk starting at zero.
//
// Note that the rule only ever splits. If these constants or the abbreviation
// list change later, already-split lines are not re-joined - a line that is now
// too short stays short. Widening the rule is therefore a decision to live with
// the old boundaries, not something a migration can undo.
func splitLine(text string) []Chunk {
	if len(text) <= splitMax {
		return []Chunk{{Text: text, Start: 0}}
	}
	var chunks []Chunk
	start := 0
	for start < len(text) {
		if len(text)-start <= splitMax {
			chunks = appendTrimmed(chunks, text, start, len(text))
			break
		}
		cut := chooseCut(text, start)
		chunks = appendTrimmed(chunks, text, start, cut)
		// The whitespace between two lines belongs to neither, so it is dropped
		// rather than left to begin the next one.
		for cut < len(text) && text[cut] == ' ' {
			cut++
		}
		start = cut
	}
	return chunks
}

// appendTrimmed adds text[from:to] as a chunk with the whitespace at either end
// removed, keeping the offset pointing at the first character that survives.
// A line is a thing someone reads, so it does not begin or end in blanks - and
// the offset has to follow the trim or correction remapping addresses the wrong
// bytes.
func appendTrimmed(chunks []Chunk, text string, from, to int) []Chunk {
	for from < to && isSpace(text[from]) {
		from++
	}
	for to > from && isSpace(text[to-1]) {
		to--
	}
	if from == to {
		return chunks
	}
	return append(chunks, Chunk{Text: text[from:to], Start: from})
}

// chooseCut is where one line ends, given where it starts.
//
// Boundary kinds are tried strongest first: a sentence end, then a clause end,
// then any word gap. Within a kind, the line is packed as full as it can be
// without passing splitTarget; if that kind has no boundary before the target,
// the first one after it is taken instead, provided it still fits under
// splitMax. Only when a kind offers nothing in range at all does the next one
// get a turn.
func chooseCut(text string, start int) int {
	soft := min(start+splitTarget, len(text))
	hard := min(start+splitMax, len(text))
	floor := start + splitMin

	for _, boundaries := range []func(string, int, int) []int{
		sentenceBoundaries, clauseBoundaries, spaceBoundaries,
	} {
		found := boundaries(text, floor, hard)
		if len(found) == 0 {
			continue
		}
		// Pack: the last boundary that still fits under the target.
		best := -1
		for _, at := range found {
			if at <= soft {
				best = at
			}
		}
		if best > 0 {
			return best
		}
		// Nothing before the target, so overshoot to the nearest one that is
		// still inside the hard cap.
		return found[0]
	}
	// A stretch this long with no space in it is not speech, but the line still
	// has to end somewhere, and it must not end mid-character.
	return runeStart(text, hard)
}

// sentenceBoundaries lists the positions in (floor, limit] where a sentence
// ends: a terminator followed by whitespace, minus the cases where a full stop
// is part of a word rather than the end of one.
func sentenceBoundaries(text string, floor, limit int) []int {
	var found []int
	for index := floor; index < limit; index++ {
		switch text[index] {
		case '.':
			if !terminalPeriod(text, index) {
				continue
			}
		case '?', '!':
		default:
			continue
		}
		end := index + 1
		// A terminator can be followed by a closing quote or bracket before the
		// space: `he said "yes." Then...`
		for end < limit && strings.IndexByte(`"')]`, text[end]) >= 0 {
			end++
		}
		if end < len(text) && isSpace(text[end]) && end <= limit {
			found = append(found, end)
		}
	}
	return found
}

// terminalPeriod reports whether the full stop at index ends a sentence.
//
// Speech recognition output is full of full stops that do not. Polish writes
// ordinals and years with one - "5. punkt", "2026. rok" - and both languages
// abbreviate. Guessing wrong here cuts a line mid-sentence, whereas declining a
// real boundary costs nothing: at a sentence every 82 characters there is
// always another one along shortly. So every guard errs towards declining.
func terminalPeriod(text string, index int) bool {
	if index+1 < len(text) && text[index+1] == '.' {
		return false // an ellipsis is a pause, not an end
	}
	if index > 0 && text[index-1] == '.' {
		return false
	}
	if index == 0 {
		return false
	}
	previous := text[index-1]
	// "12.05.2026", "3.5" - and Polish ordinals, where the stop is part of the
	// number. English years lose a genuine boundary here, which is the cheap
	// direction to be wrong in.
	if previous >= '0' && previous <= '9' {
		return false
	}
	// A lone capital is an initial: "J. Feld".
	if previous >= 'A' && previous <= 'Z' && (index == 1 || isSpace(text[index-2])) {
		return false
	}
	return !isAbbreviation(text, index)
}

// isAbbreviation reports whether the word ending at the full stop is a known
// abbreviation.
func isAbbreviation(text string, index int) bool {
	begin := index
	for begin > 0 && !isSpace(text[begin-1]) {
		begin--
	}
	word := strings.ToLower(text[begin : index+1])
	_, known := abbreviations[word]
	return known
}

// abbreviations are the words whose full stop is part of the word. The Polish
// half matters most: these transcripts are half Polish, and "np." or "itd."
// mid-sentence is common.
var abbreviations = map[string]struct{}{}

func init() {
	for _, word := range strings.Fields(`
		np. tzn. tj. itp. itd. m.in. in. dr. prof. inż. mgr. hab. ul. al. godz.
		str. ok. r. nr. tys. mln. mld. zob. por. wg. ww. cd. św. płk. gen. mjr.
		poj. ust. art. pkt. rys. tab. tzw. jw. ds. im. woj. pow. gm.
		mr. mrs. ms. dr. prof. e.g. i.e. etc. vs. approx. inc. ltd. co. corp.
		fig. no. a.m. p.m. u.s. u.k. st. ave. dept. est. min. max. vol. ref.
		jan. feb. mar. apr. jun. jul. aug. sep. sept. oct. nov. dec.
	`) {
		abbreviations[word] = struct{}{}
	}
}

// clauseBoundaries lists weaker breaks: the punctuation that ends a clause.
// An ellipsis lands here rather than with the sentence ends, because in speech
// it marks trailing off mid-thought.
func clauseBoundaries(text string, floor, limit int) []int {
	var found []int
	for index := floor; index < limit; index++ {
		width := 1
		switch text[index] {
		case ';', ':', ',', '-':
		default:
			// The em dash and the ellipsis are multi-byte, so they are matched
			// as strings rather than compared as bytes.
			switch {
			case strings.HasPrefix(text[index:], "—"):
				width = len("—")
			case strings.HasPrefix(text[index:], "…"):
				width = len("…")
			default:
				continue
			}
		}
		end := index + width
		if end < len(text) && isSpace(text[end]) && end <= limit {
			found = append(found, end)
		}
	}
	return found
}

// spaceBoundaries lists every word gap, the last resort before cutting inside a
// word.
func spaceBoundaries(text string, floor, limit int) []int {
	var found []int
	for index := floor; index < limit; index++ {
		if isSpace(text[index]) {
			found = append(found, index)
		}
	}
	return found
}

func isSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r'
}

// runeStart walks back to the start of the character containing at, so a line
// never ends half way through a multi-byte character. Polish text is full of
// them.
func runeStart(text string, at int) int {
	for at > 0 && at < len(text) && text[at]&0xC0 == 0x80 {
		at--
	}
	return at
}

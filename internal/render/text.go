package render

import (
	"strings"
	"unicode"
)

// Pure terminal layout helpers, ported from the TypeScript src/app/render.ts.
//
// These functions never add terminal control sequences. Inputs are treated as
// untrusted display text and are sanitised before measurement or rendering.

// StripSequences removes CSI, OSC, DCS, APC, PM, SOS and two-byte escapes.
func StripSequences(input string) string {
	var out strings.Builder
	runes := []rune(input)
	for index := 0; index < len(runes); {
		char := runes[index]
		if char == 0x1b {
			var next rune
			if index+1 < len(runes) {
				next = runes[index+1]
			}
			switch next {
			case 0x5b: // CSI
				index = consumeCSI(runes, index+2)
			case 0x5d, 0x50, 0x58, 0x5e, 0x5f: // OSC, DCS, SOS, PM, APC
				index = consumeControlString(runes, index+2)
			default:
				index = min(len(runes), index+2)
			}
			continue
		}
		if char == 0x9b {
			index = consumeCSI(runes, index+1)
			continue
		}
		if char == 0x90 || char == 0x98 || char == 0x9d || char == 0x9e || char == 0x9f {
			index = consumeControlString(runes, index+1)
			continue
		}
		out.WriteRune(char)
		index++
	}
	return out.String()
}

func consumeCSI(runes []rune, start int) int {
	for index := start; index < len(runes); index++ {
		if runes[index] >= 0x40 && runes[index] <= 0x7e {
			return index + 1
		}
	}
	return len(runes)
}

func consumeControlString(runes []rune, start int) int {
	for index := start; index < len(runes); index++ {
		if runes[index] == 0x07 || runes[index] == 0x9c {
			return index + 1
		}
		if runes[index] == 0x1b && index+1 < len(runes) && runes[index+1] == 0x5c {
			return index + 2
		}
	}
	return len(runes)
}

// isBidiControl reports the directional overrides that reorder text on screen.
// They are removed to keep paths, identities and errors visually ordered.
func isBidiControl(char rune) bool {
	switch {
	case char == 0x061c, char == 0x200e, char == 0x200f:
		return true
	case char >= 0x202a && char <= 0x202e:
		return true
	case char >= 0x2066 && char <= 0x2069:
		return true
	case char >= 0x206a && char <= 0x206f:
		return true
	}
	return false
}

// Sanitize converts untrusted content to inert terminal text.
//
// Tabs and line breaks become spaces so content cannot move the cursor or forge
// additional UI rows.
func Sanitize(value string) string { return sanitize(value, false) }

// SanitizeMultiline keeps tabs and line boundaries, for terminal documents.
func SanitizeMultiline(value string) string { return sanitize(value, true) }

func sanitize(value string, multiline bool) string {
	// Invalid encoding is dropped before anything else. A lone C1 byte is not a
	// character a terminal can draw, and leaving it in would both show as
	// mojibake and be counted as a column that is never painted.
	input := StripSequences(strings.ToValidUTF8(value, ""))
	input = strings.ReplaceAll(input, "\r\n", "\n")
	input = strings.ReplaceAll(input, "\r", "\n")

	var out strings.Builder
	endsWithSpace := func() bool { return strings.HasSuffix(out.String(), " ") }
	for _, char := range input {
		switch char {
		case '\n':
			if multiline {
				out.WriteRune('\n')
			} else if !endsWithSpace() {
				out.WriteRune(' ')
			}
			continue
		case '\t':
			if multiline {
				out.WriteRune('\t')
			} else if !endsWithSpace() {
				out.WriteRune(' ')
			}
			continue
		}
		if char < 0x20 || (char >= 0x7f && char <= 0x9f) {
			continue
		}
		if isBidiControl(char) {
			continue
		}
		out.WriteRune(char)
	}
	return out.String()
}

// isWide reports the code points a terminal draws two columns wide.
func isWide(char rune) bool {
	if char < 0x1100 {
		return false
	}
	switch {
	case char <= 0x115f,
		char == 0x2329, char == 0x232a,
		char >= 0x2e80 && char <= 0xa4cf && char != 0x303f,
		char >= 0xac00 && char <= 0xd7a3,
		char >= 0xf900 && char <= 0xfaff,
		char >= 0xfe10 && char <= 0xfe19,
		char >= 0xfe30 && char <= 0xfe6f,
		char >= 0xff00 && char <= 0xff60,
		char >= 0xffe0 && char <= 0xffe6,
		char >= 0x1f300 && char <= 0x1faff,
		char >= 0x20000 && char <= 0x3fffd:
		return true
	}
	return false
}

func isRegionalIndicator(char rune) bool { return char >= 0x1f1e6 && char <= 0x1f1ff }

func isSkinTone(char rune) bool { return char >= 0x1f3fb && char <= 0x1f3ff }

// isPictographic approximates Extended_Pictographic for width purposes: the
// emoji blocks a terminal renders double width.
func isPictographic(char rune) bool {
	switch {
	case char >= 0x1f000 && char <= 0x1faff,
		char >= 0x2600 && char <= 0x27bf,
		char == 0x2b50, char == 0x2b55:
		return true
	}
	return false
}

// graphemes splits into clusters, keeping combining marks, variation selectors,
// skin tones, ZWJ sequences and regional-indicator pairs with their base.
func graphemes(value string) []string {
	runes := []rune(value)
	clusters := make([]string, 0, len(runes))
	for index := 0; index < len(runes); {
		cluster := []rune{runes[index]}
		index++
		if isRegionalIndicator(cluster[0]) && index < len(runes) && isRegionalIndicator(runes[index]) {
			cluster = append(cluster, runes[index])
			index++
		}
		for index < len(runes) {
			next := runes[index]
			if unicode.Is(unicode.M, next) || next == 0xfe0e || next == 0xfe0f || isSkinTone(next) {
				cluster = append(cluster, next)
				index++
				continue
			}
			if next == 0x200d && index+1 < len(runes) {
				cluster = append(cluster, next, runes[index+1])
				index += 2
				continue
			}
			break
		}
		clusters = append(clusters, string(cluster))
	}
	return clusters
}

func graphemeWidth(cluster string) int {
	if cluster == "" {
		return 0
	}
	runes := []rune(cluster)
	indicators := 0
	for _, char := range runes {
		if isRegionalIndicator(char) {
			indicators++
		}
		if char == 0x20e3 { // combining enclosing keycap
			return 2
		}
	}
	if indicators >= 2 {
		return 2
	}
	for _, char := range runes {
		if isPictographic(char) {
			return 2
		}
	}
	width := 0
	for _, char := range runes {
		if char == 0x200d || unicode.Is(unicode.M, char) || unicode.Is(unicode.Cf, char) {
			continue
		}
		if isWide(char) {
			width = max(width, 2)
			continue
		}
		width = max(width, 1)
	}
	return width
}

// DisplayWidth is how many columns the text occupies once sanitised.
func DisplayWidth(value string) int { return safeDisplayWidth(Sanitize(value)) }

func safeDisplayWidth(text string) int {
	width := 0
	for _, cluster := range graphemes(text) {
		width += graphemeWidth(cluster)
	}
	return width
}

func takeWidth(value string, width int) string {
	var out strings.Builder
	used := 0
	for _, cluster := range graphemes(value) {
		next := graphemeWidth(cluster)
		if used+next > width {
			break
		}
		out.WriteString(cluster)
		used += next
	}
	return out.String()
}

// Truncate cuts text to a display width, appending the marker when it had to
// cut. Width counts columns, so a CJK title is not cut to half its intended
// size the way a rune count would cut it.
func Truncate(value string, width int, marker string) string {
	if width <= 0 {
		return ""
	}
	text := Sanitize(value)
	if safeDisplayWidth(text) <= width {
		return text
	}
	safeMarker := Sanitize(marker)
	markerWidth := safeDisplayWidth(safeMarker)
	if markerWidth >= width {
		return takeWidth(safeMarker, width)
	}
	return takeWidth(text, width-markerWidth) + safeMarker
}

// TruncateStyled cuts text to a display width, passing escape sequences through
// without counting them and closing any style it leaves open.
//
// Truncation used to be skipped for styled text, because cutting it naively
// severs an escape sequence and bleeds colour across the rest of the screen.
// Skipping meant every styled row was free to overflow the terminal, which
// soft-wraps it, pushes the layout down a line and scrolls the footer off - and
// each new styled row was a fresh chance to do it. Counting only what is drawn
// removes the whole class.
func TruncateStyled(value string, width int, marker string) string {
	if width <= 0 {
		return ""
	}
	if !strings.Contains(value, "\x1b[") {
		return Truncate(value, width, marker)
	}
	if StyledWidth(value) <= width {
		return value
	}
	safeMarker := Sanitize(marker)
	markerWidth := safeDisplayWidth(safeMarker)
	if markerWidth >= width {
		// No room for both, so the marker is what gets cut - the same rule
		// Truncate follows. Appending it whole made the row wider than the
		// width it had just been cut to.
		return takeWidth(safeMarker, width)
	}
	budget := max(0, width-markerWidth)

	var out strings.Builder
	used := 0
	styled := false
	runes := []rune(value)
	for index := 0; index < len(runes); {
		if runes[index] == 0x1b {
			end := consumeCSI(runes, index+2)
			if index+1 < len(runes) && runes[index+1] != 0x5b {
				end = min(len(runes), index+2)
			}
			out.WriteString(string(runes[index:end]))
			styled = true
			index = end
			continue
		}
		// A whole cluster at a time. Measuring rune by rune counted each part
		// of a ZWJ sequence as its own character, and cut the sequence in half.
		cluster := nextCluster(runes, index)
		next := graphemeWidth(cluster)
		if used+next > budget {
			break
		}
		out.WriteString(cluster)
		used += next
		index += len([]rune(cluster))
	}
	out.WriteString(safeMarker)
	if styled {
		// Whatever was open when the cut happened is closed here, or the colour
		// runs on into the rest of the screen.
		out.WriteString("\x1b[0m")
	}
	return out.String()
}

// nextCluster is the grapheme cluster starting at index, stopping before any
// escape sequence so styling never lands inside one.
func nextCluster(runes []rune, index int) string {
	end := index + 1
	for end < len(runes) && runes[end] != 0x1b {
		next := runes[end]
		if unicode.Is(unicode.M, next) || next == 0xfe0e || next == 0xfe0f || isSkinTone(next) {
			end++
			continue
		}
		if next == 0x200d && end+1 < len(runes) && runes[end+1] != 0x1b {
			end += 2
			continue
		}
		if isRegionalIndicator(runes[index]) && isRegionalIndicator(next) && end == index+1 {
			end++
			continue
		}
		break
	}
	return string(runes[index:end])
}

// StyledWidth is the display width of text that may carry escape sequences.
func StyledWidth(value string) int { return safeDisplayWidth(Sanitize(StripSequences(value))) }

// hardWrapToken breaks a single token that is wider than the line. A grapheme
// too wide to ever fit becomes the overflow marker rather than being dropped.
func hardWrapToken(token string, width int, overflow string) []string {
	var lines []string
	var current strings.Builder
	used := 0
	for _, cluster := range graphemes(token) {
		next := graphemeWidth(cluster)
		if current.Len() > 0 && used+next > width {
			lines = append(lines, current.String())
			current.Reset()
			used = 0
		}
		if next > width {
			lines = append(lines, takeWidth(overflow, width))
			continue
		}
		current.WriteString(cluster)
		used += next
	}
	if current.Len() > 0 || len(lines) == 0 {
		lines = append(lines, current.String())
	}
	return lines
}

// splitTokens splits a line into words and whitespace runs, dropping nothing,
// so wrapping can tell "a space here" from "no space here".
func splitTokens(line string) []string {
	var tokens []string
	var current strings.Builder
	inSpace := false
	for _, char := range line {
		space := char == ' ' || char == '\t' || char == '\v' || char == '\f'
		if current.Len() > 0 && space != inSpace {
			tokens = append(tokens, current.String())
			current.Reset()
		}
		inSpace = space
		current.WriteRune(char)
	}
	if current.Len() > 0 {
		tokens = append(tokens, current.String())
	}
	return tokens
}

func isSpaceRun(token string) bool {
	return strings.TrimLeft(token, " \t\v\f") == "" && token != ""
}

// Wrap breaks text to a display width on whitespace, keeping blank lines and
// hard-breaking a word that cannot fit.
func Wrap(value string, width int, overflow string) []string {
	width = max(1, width)
	text := SanitizeMultiline(value)
	safeOverflow := Sanitize(overflow)
	var output []string

	for _, sourceLine := range strings.Split(text, "\n") {
		if sourceLine == "" {
			output = append(output, "")
			continue
		}
		current := ""
		currentWidth := 0
		for _, token := range splitTokens(sourceLine) {
			normalized := token
			if isSpaceRun(token) {
				normalized = " "
			}
			if normalized == " " && current == "" {
				continue
			}
			tokenWidth := 1
			if normalized != " " {
				tokenWidth = safeDisplayWidth(normalized)
			}
			if currentWidth+tokenWidth <= width {
				current += normalized
				currentWidth += tokenWidth
				continue
			}
			if current != "" {
				output = append(output, strings.TrimRight(current, " \t"))
				current = ""
				currentWidth = 0
			}
			if normalized == " " {
				continue
			}
			pieces := hardWrapToken(normalized, width, safeOverflow)
			output = append(output, pieces[:len(pieces)-1]...)
			current = pieces[len(pieces)-1]
			currentWidth = safeDisplayWidth(current)
		}
		// A trailing space run flushes the line and leaves current empty, so
		// appending unconditionally invents a blank row - which also inflates
		// the row count a scroll limit is computed from.
		if trimmed := strings.TrimRight(current, " \t"); trimmed != "" || len(output) == 0 ||
			currentWidth > 0 {
			output = append(output, trimmed)
		}
	}
	return output
}

// Pad extends text to a display width. Alignment "right" pads on the left.
func Pad(value string, width int, alignment string) string {
	missing := max(0, width-DisplayWidth(value))
	if alignment == "right" {
		return strings.Repeat(" ", missing) + value
	}
	return value + strings.Repeat(" ", missing)
}

// Rule draws a horizontal line.
func Rule(width int, unicodeOK bool) string {
	if width <= 0 {
		return ""
	}
	if unicodeOK {
		return strings.Repeat("─", width)
	}
	return strings.Repeat("-", width)
}

// DisplayRow is a marker, a label and an optional detail, laid out as one line.
type DisplayRow struct {
	Marker string
	Label  string
	Detail string
}

// Row renders a DisplayRow within a width. The detail follows a colon, which is
// how every settled line in the installer reads.
func Row(row DisplayRow, width int, marker string) string {
	value := Sanitize(row.Marker) + " " + Sanitize(row.Label)
	if row.Detail != "" {
		value += ": " + Sanitize(row.Detail)
	}
	return Truncate(value, width, marker)
}

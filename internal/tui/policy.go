// Package tui is the terminal surface: the policy that decides what this
// terminal can render, the glyphs and colours chosen from it, and the
// composition helpers every screen is built from.
//
// This is a port of the TypeScript app/ui.ts. Colour codes, glyph sets, spinner
// frames, separators and layout rules are its rules, not new ones. See
// docs/ux-conformance.md.
package tui

import (
	"os"
	"regexp"
	"runtime"
	"strings"
)

// Policy is what this terminal can do. Every styling, glyph and layout decision
// derives from it, so a screen never probes the environment itself.
type Policy struct {
	InputTTY  bool
	OutputTTY bool
	// Interactive means a full-screen prompt can run at all.
	Interactive bool
	// Control means the output is a terminal worth sending sequences to.
	Control bool
	Color   bool
	Unicode bool
	Columns int // 0 when unknown
	Rows    int // 0 when unknown
	Windows bool
}

// enabledFlag reads an environment flag the way the original does: present and
// not one of the falsey spellings.
func enabledFlag(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	return normalized != "" && normalized != "0" && normalized != "false" && normalized != "no"
}

var utf8Locale = regexp.MustCompile(`(?i)utf-?8`)

// DetectPolicy resolves the policy from the environment and the terminal.
//
// control = output is a TTY, not CI, not TERM=dumb
// color   = control and NO_COLOR is unset
// unicode = control and (Windows: a terminal known to render it; else a UTF-8 locale)
func DetectPolicy(inputTTY, outputTTY bool, columns, rows int) Policy {
	ci := enabledFlag(os.Getenv("CI"))
	dumb := strings.ToLower(strings.TrimSpace(os.Getenv("TERM"))) == "dumb"
	_, noColor := os.LookupEnv("NO_COLOR")
	control := outputTTY && !ci && !dumb

	locale := os.Getenv("LC_ALL")
	if locale == "" {
		locale = os.Getenv("LC_CTYPE")
	}
	if locale == "" {
		locale = os.Getenv("LANG")
	}
	windows := runtime.GOOS == "windows"
	windowsUnicode := os.Getenv("WT_SESSION") != "" ||
		os.Getenv("TERM_PROGRAM") == "vscode" ||
		enabledFlag(os.Getenv("ConEmuANSI"))

	unicode := control && utf8Locale.MatchString(locale)
	if windows {
		unicode = control && windowsUnicode
	}
	return Policy{
		InputTTY:    inputTTY,
		OutputTTY:   outputTTY,
		Interactive: inputTTY && outputTTY && !ci && !dumb,
		Control:     control,
		Color:       control && !noColor,
		Unicode:     unicode,
		Columns:     columns,
		Rows:        rows,
		Windows:     windows,
	}
}

// Glyphs are the marks a screen draws. Two sets, chosen by Policy.Unicode, so a
// terminal that cannot render the first degrades instead of showing mojibake.
type Glyphs struct {
	OK      string
	Disable string
	Noop    string
	Skip    string
	Fail    string
	Pending string
	Pointer string
	Check   string
	Uncheck string
	// Rail is the vertical divider inside a list card. It is not part of the
	// original glyph set; the meeting list draws it and needs an ASCII form.
	Rail string
}

var unicodeGlyphs = Glyphs{
	OK: "✔", Disable: "−", Noop: "·", Skip: "·", Fail: "✖",
	Pending: "·", Pointer: "❯", Check: "◉", Uncheck: "◯", Rail: "│",
}

var asciiGlyphs = Glyphs{
	OK: "+", Disable: "-", Noop: ".", Skip: "~", Fail: "x",
	Pending: ".", Pointer: ">", Check: "[x]", Uncheck: "[ ]", Rail: "|",
}

var unicodeSpinner = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
var asciiSpinner = []string{"-", "\\", "|", "/"}

// Glyphs returns the set this terminal can render.
func (p Policy) Glyphs() Glyphs {
	if p.Unicode {
		return unicodeGlyphs
	}
	return asciiGlyphs
}

// SpinnerFrames returns the frames this terminal can render.
func (p Policy) SpinnerFrames() []string {
	if p.Unicode {
		return unicodeSpinner
	}
	return asciiSpinner
}

// Width is the usable render width: one column is left free so the terminal
// never soft-wraps a full line into a second row.
func (p Policy) Width() int {
	if p.Columns <= 1 {
		return 1
	}
	return p.Columns - 1
}

// AvailableRows is how many rows a screen may paint.
func (p Policy) AvailableRows() int {
	if p.Rows <= 0 {
		return 1
	}
	if p.Columns == 1 {
		return max(0, p.Rows-1)
	}
	return p.Rows
}

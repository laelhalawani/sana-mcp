package store

import (
	"database/sql"
	"os"
	"sort"
	"strings"
	"testing"
)

// TestDryRunAgainstRealCorpus reports what the splitter would do to a real
// database without writing to it. It is skipped unless SANA_DRYRUN_DB names a
// copy of one.
func TestDryRunAgainstRealCorpus(t *testing.T) {
	path := os.Getenv("SANA_DRYRUN_DB")
	if path == "" {
		t.Skip("set SANA_DRYRUN_DB to a copy of a real database")
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	rows, err := db.Query(`SELECT text FROM transcript_lines`)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()

	var (
		linesBefore, linesAfter int
		splitLines              int
		longestBefore           int
		longestAfter            int
		sizes                   []int
		sentenceEnds            int
		notIdempotent           int
		producedChunks          int
		producedAtSentence      int
		producedBytes           int
		tiny                    int
	)
	for rows.Next() {
		var text string
		if err := rows.Scan(&text); err != nil {
			t.Fatalf("scan: %v", err)
		}
		linesBefore++
		if len(text) > longestBefore {
			longestBefore = len(text)
		}
		chunks := splitLine(text)
		if len(chunks) > 1 {
			splitLines++
		}
		for _, piece := range chunks {
			linesAfter++
			// Quality is only meaningful for chunks the splitter created. Lines
			// it passed through untouched are mostly one-word replies that
			// already end in a full stop, and they swamp the average.
			if len(chunks) > 1 {
				producedChunks++
				trimmedNew := strings.TrimSpace(piece.Text)
				if strings.HasSuffix(trimmedNew, ".") || strings.HasSuffix(trimmedNew, "?") ||
					strings.HasSuffix(trimmedNew, "!") {
					producedAtSentence++
				}
				producedBytes += len(piece.Text)
			}
			sizes = append(sizes, len(piece.Text))
			if len(piece.Text) > longestAfter {
				longestAfter = len(piece.Text)
			}
			if len(piece.Text) < 50 {
				tiny++
			}
			trimmed := strings.TrimSpace(piece.Text)
			if strings.HasSuffix(trimmed, ".") || strings.HasSuffix(trimmed, "?") ||
				strings.HasSuffix(trimmed, "!") {
				sentenceEnds++
			}
			if again := splitLine(piece.Text); len(again) != 1 {
				notIdempotent++
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}

	sort.Ints(sizes)
	median := 0
	p99 := 0
	if len(sizes) > 0 {
		median = sizes[len(sizes)/2]
		p99 = sizes[len(sizes)*99/100]
	}
	t.Logf("lines           %d -> %d (+%.1f%%)", linesBefore, linesAfter,
		float64(linesAfter-linesBefore)/float64(linesBefore)*100)
	t.Logf("lines split     %d", splitLines)
	t.Logf("longest line    %d -> %d bytes", longestBefore, longestAfter)
	t.Logf("median / p99    %d / %d bytes", median, p99)
	t.Logf("end at sentence %.1f%%", float64(sentenceEnds)/float64(linesAfter)*100)
	t.Logf("under 50 bytes  %d", tiny)
	if producedChunks > 0 {
		t.Logf("--- chunks the splitter actually produced ---")
		t.Logf("count           %d", producedChunks)
		t.Logf("mean size       %d bytes", producedBytes/producedChunks)
		t.Logf("end at sentence %.1f%%", float64(producedAtSentence)/float64(producedChunks)*100)
	}

	if notIdempotent != 0 {
		t.Fatalf("%d chunks split further on a second pass", notIdempotent)
	}
	if longestAfter > splitMax {
		t.Fatalf("a chunk exceeded the cap: %d", longestAfter)
	}
}

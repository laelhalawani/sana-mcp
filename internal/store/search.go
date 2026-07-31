package store

import "strings"

// Hit is one search result.
type Hit struct {
	MeetingID string
	Title     string
	LineNo    int
	Text      string
	CreatedMS int64
}

// Column weights for bm25. The current text is preferred 20:1 over the original,
// because almost nobody searches for how a word was mispronounced: an
// original-only match should be reachable as a last resort, never competing with
// a correct hit. The two UNINDEXED columns take weight 0.
const bm25Weights = `0.0, 0.0, 10.0, 0.5`

// Sort orders for Search.
const (
	SortBest   = "best"
	SortNewest = "newest"
	SortOldest = "oldest"
)

// Search runs a keyword query across transcripts. It is the primary channel:
// BM25 wins on proper nouns, which is what people actually search meetings for.
//
// The sort is applied in SQL rather than to the returned page. Sorting a page
// that relevance already selected would order a handful of rows and call it
// "newest", which is not what the caller asked for.
func (s *Store) Search(query string, limit, offset int, sort string) ([]Hit, error) {
	match := ftsQuery(query)
	if match == "" {
		return nil, nil
	}
	order := "page.score"
	switch sort {
	case SortNewest:
		order = "m.created_ms DESC, page.score"
	case SortOldest:
		order = "m.created_ms ASC, page.score"
	}
	// Inside the ranking CTE the columns are not yet qualified by page.
	rankedOrder := strings.ReplaceAll(order, "page.score", "score")
	// The page is chosen before anything is joined to it.
	//
	// Joining meetings and transcript_lines to every match and then taking the
	// page did two index lookups per match to render a few rows: measured 14.3
	// ms for a query matching 1,359 lines, against 4.0 ms this way, and 112 ms
	// against 34 ms for a very common word. Only the sorts that need a column
	// from meetings pull that table into the ranking step.
	ranked := `SELECT ls.meeting_id, ls.line_no, bm25(line_search, ` + bm25Weights + `) AS score
	             FROM line_search ls
	            WHERE line_search MATCH ?
	            ORDER BY score
	            LIMIT ? OFFSET ?`
	if sort == SortNewest || sort == SortOldest {
		ranked = `SELECT ls.meeting_id, ls.line_no, bm25(line_search, ` + bm25Weights + `) AS score
		            FROM line_search ls
		            JOIN meetings m ON m.meeting_id = ls.meeting_id
		           WHERE line_search MATCH ?
		           ORDER BY ` + rankedOrder + `
		           LIMIT ? OFFSET ?`
	}
	rows, err := s.db.Query(
		`WITH page AS (`+ranked+`)
		 SELECT page.meeting_id, m.title, page.line_no, l.text, m.created_ms
		   FROM page
		   JOIN meetings m ON m.meeting_id = page.meeting_id
		   JOIN transcript_lines l
		     ON l.meeting_id = page.meeting_id AND l.line_no = page.line_no
		  ORDER BY `+order,
		match, limit, offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var hits []Hit
	for rows.Next() {
		var hit Hit
		if err := rows.Scan(
			&hit.MeetingID, &hit.Title, &hit.LineNo, &hit.Text, &hit.CreatedMS,
		); err != nil {
			return nil, err
		}
		hits = append(hits, hit)
	}
	return hits, rows.Err()
}

// ftsQuery turns a user's words into an FTS5 MATCH expression. Every term is
// quoted, so punctuation a person types cannot become FTS5 syntax and cannot
// make the query fail.
func ftsQuery(query string) string {
	var terms []string
	for _, field := range strings.Fields(query) {
		cleaned := strings.Trim(field, `"'`)
		if cleaned == "" {
			continue
		}
		terms = append(terms, `"`+strings.ReplaceAll(cleaned, `"`, `""`)+`"`)
	}
	return strings.Join(terms, " ")
}

package store

import "strings"

// Hit is one search result.
type Hit struct {
	MeetingID string
	Title     string
	LineNo    int
	Text      string
	CreatedMS int64
	Score     float64 // FTS5 bm25: lower is better
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
	order := "score"
	switch sort {
	case SortNewest:
		order = "m.created_ms DESC, score"
	case SortOldest:
		order = "m.created_ms ASC, score"
	}
	rows, err := s.db.Query(
		`SELECT ls.meeting_id, m.title, ls.line_no, l.text, m.created_ms,
		        bm25(line_search, `+bm25Weights+`) AS score
		   FROM line_search ls
		   JOIN meetings m ON m.meeting_id = ls.meeting_id
		   JOIN transcript_lines l
		     ON l.meeting_id = ls.meeting_id AND l.line_no = ls.line_no
		  WHERE line_search MATCH ?
		  ORDER BY `+order+`
		  LIMIT ? OFFSET ?`,
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
			&hit.MeetingID, &hit.Title, &hit.LineNo, &hit.Text, &hit.CreatedMS, &hit.Score,
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

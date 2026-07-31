package daemon

import (
	"context"
	"errors"
	"sync"

	"github.com/laelhalawani/sana-mcp/internal/sana"
)

// fetchWorkers bounds how many meetings are fetched at once.
//
// The work is almost entirely latency: a request to Sana takes roughly a second
// and the store write that follows takes single-digit milliseconds. Fetching
// one meeting at a time made a cycle about 45 s, so a first sync of several
// hundred meetings ran past the ten minutes the installer waits.
//
// Four is deliberately modest. Sana's rate limits are not documented, and the
// gain from here is sublinear anyway.
const fetchWorkers = 4

// fetched is one meeting's result, carried back to the single writer.
type fetched[T any] struct {
	meetingID string
	value     T
	err       error
}

// fetchEach runs fetch over the meetings concurrently and calls store for each
// success, in the calling goroutine.
//
// Writes stay on one goroutine, so the store keeps its single-writer
// discipline. A meeting that fails is logged and left pending for the next
// cycle, except for an expired session, which aborts the cycle: retrying every
// remaining meeting against a session that will reject all of them is just a
// slower way to fail.
func fetchEach[T any](
	ctx context.Context,
	server *Server,
	meetings []string,
	what string,
	fetch func(context.Context, string) (T, error),
	store func(string, T) error,
) (int, error) {
	if len(meetings) == 0 {
		return 0, nil
	}
	workers := min(fetchWorkers, len(meetings))
	ids := make(chan string)
	results := make(chan fetched[T], len(meetings))

	var wait sync.WaitGroup
	wait.Add(workers)
	for worker := 0; worker < workers; worker++ {
		go func() {
			defer wait.Done()
			for meetingID := range ids {
				value, err := fetch(ctx, meetingID)
				results <- fetched[T]{meetingID: meetingID, value: value, err: err}
			}
		}()
	}
	go func() {
		defer close(ids)
		for _, meetingID := range meetings {
			select {
			case <-ctx.Done():
				return
			case ids <- meetingID:
			}
		}
	}()
	go func() {
		wait.Wait()
		close(results)
	}()

	count := 0
	var fatal error
	for result := range results {
		if result.err != nil {
			if errors.Is(result.err, sana.ErrUnauthorized) && fatal == nil {
				fatal = result.err
			} else {
				server.logf("%s %s failed: %v", what, result.meetingID, result.err)
			}
			continue
		}
		if fatal != nil {
			// Still draining so the workers can finish; nothing more is stored.
			continue
		}
		if err := store(result.meetingID, result.value); err != nil {
			fatal = err
			continue
		}
		count++
	}
	return count, fatal
}

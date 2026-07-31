package daemon

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/laelhalawani/sana-mcp/internal/sana"
)

func meetingIDs(count int) []string {
	ids := make([]string, count)
	for index := range ids {
		ids[index] = fmt.Sprintf("m%d", index)
	}
	return ids
}

// Writes must all happen on the calling goroutine: the store is a single
// writer, and that is the property the concurrency here must not break.
func TestFetchEachWritesOnOneGoroutine(t *testing.T) {
	var mutex sync.Mutex
	var concurrent, peak int

	count, err := fetchEach(context.Background(), &Server{}, meetingIDs(20), "thing",
		func(_ context.Context, id string) (string, error) {
			time.Sleep(time.Millisecond)
			return id, nil
		},
		func(_ string, _ string) error {
			mutex.Lock()
			concurrent++
			if concurrent > peak {
				peak = concurrent
			}
			mutex.Unlock()
			time.Sleep(time.Millisecond)
			mutex.Lock()
			concurrent--
			mutex.Unlock()
			return nil
		})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if count != 20 {
		t.Fatalf("stored %d of 20", count)
	}
	if peak != 1 {
		t.Fatalf("writes overlapped: peak concurrency %d", peak)
	}
}

// One meeting failing must not stop the rest; it is left pending for the next
// cycle rather than aborting the batch.
func TestFetchEachSkipsFailuresAndKeepsGoing(t *testing.T) {
	stored := 0
	count, err := fetchEach(context.Background(), &Server{}, meetingIDs(6), "thing",
		func(_ context.Context, id string) (string, error) {
			if id == "m2" || id == "m4" {
				return "", errors.New("upstream refused")
			}
			return id, nil
		},
		func(string, string) error { stored++; return nil })
	if err != nil {
		t.Fatalf("a per-meeting failure must not fail the batch: %v", err)
	}
	if count != 4 || stored != 4 {
		t.Fatalf("expected 4 stored, got count=%d stored=%d", count, stored)
	}
}

// An expired session aborts the cycle: retrying the rest against a session that
// will reject all of them is a slower way to fail.
func TestFetchEachAbortsOnExpiredSession(t *testing.T) {
	count, err := fetchEach(context.Background(), &Server{}, meetingIDs(8), "thing",
		func(_ context.Context, id string) (string, error) {
			if id == "m3" {
				return "", sana.ErrUnauthorized
			}
			return id, nil
		},
		func(string, string) error { return nil })
	if !errors.Is(err, sana.ErrUnauthorized) {
		t.Fatalf("expected the expired session to surface, got %v (count %d)", err, count)
	}
}

// Fetching runs in parallel; that is the entire point.
func TestFetchEachFetchesConcurrently(t *testing.T) {
	var mutex sync.Mutex
	var concurrent, peak int

	if _, err := fetchEach(context.Background(), &Server{}, meetingIDs(12), "thing",
		func(_ context.Context, id string) (string, error) {
			mutex.Lock()
			concurrent++
			if concurrent > peak {
				peak = concurrent
			}
			mutex.Unlock()
			time.Sleep(5 * time.Millisecond)
			mutex.Lock()
			concurrent--
			mutex.Unlock()
			return id, nil
		},
		func(string, string) error { return nil }); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if peak < 2 {
		t.Fatalf("fetches did not overlap: peak concurrency %d", peak)
	}
	if peak > fetchWorkers {
		t.Fatalf("fan-out exceeded its bound: %d > %d", peak, fetchWorkers)
	}
}

func TestFetchEachHandlesAnEmptyBatch(t *testing.T) {
	count, err := fetchEach(context.Background(), &Server{}, nil, "thing",
		func(context.Context, string) (string, error) { t.Fatal("should not fetch"); return "", nil },
		func(string, string) error { t.Fatal("should not store"); return nil })
	if err != nil || count != 0 {
		t.Fatalf("empty batch: count=%d err=%v", count, err)
	}
}

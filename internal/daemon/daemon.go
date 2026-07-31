// Package daemon owns the background sync with Sana: discovering meetings,
// fetching the transcripts of the ones that are ready, and keeping the search
// index current.
//
// Unlike interactive-terminal-mcp, this daemon holds nothing that outlives it.
// The SQLite database is the shared state, so readers open it directly instead
// of talking to the daemon. The daemon only needs to be the single writer,
// which a file lock provides.
package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gofrs/flock"
	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/store"
)

// ErrAlreadyRunning is returned by Open when another daemon holds the lock.
var ErrAlreadyRunning = errors.New("a sync daemon is already running")

// errNoRecordedPID means the lock is held but the holder did not record its
// process id, so it cannot be asked to stop.
var errNoRecordedPID = errors.New("a daemon holds the lock but recorded no process id")

// pageSize bounds how many transcripts one cycle fetches before it re-reads its
// own state, so a large backfill still reports progress as it goes.
const transcriptBatch = 25

// Server is a running sync daemon.
type Server struct {
	runtime *bootstrap.Runtime
	store   *store.Store
	lock    *flock.Flock
	log     *os.File
	pidPath string
}

// Open acquires the singleton lock and opens the store.
func Open(runtime *bootstrap.Runtime) (*Server, error) {
	if err := os.MkdirAll(runtime.Paths.Root, 0o700); err != nil {
		return nil, err
	}
	lock := flock.New(runtime.Paths.Lock)
	held, err := lock.TryLock()
	if err != nil {
		return nil, fmt.Errorf("acquire daemon lock: %w", err)
	}
	if !held {
		return nil, ErrAlreadyRunning
	}
	database, err := store.Open(runtime.Paths.Database)
	if err != nil {
		lock.Unlock()
		return nil, err
	}
	logFile, err := os.OpenFile(runtime.Paths.Log, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		database.Close()
		lock.Unlock()
		return nil, err
	}
	// The pid is recorded so `daemon --stop` has something to signal. It is
	// written after the lock is held, so it always describes the lock holder.
	pidPath := filepath.Join(runtime.Paths.Root, "daemon.pid")
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		logFile.Close()
		database.Close()
		lock.Unlock()
		return nil, err
	}
	return &Server{
		runtime: runtime, store: database, lock: lock, log: logFile, pidPath: pidPath,
	}, nil
}

// Close releases the store and the lock.
func (s *Server) Close() {
	if s.store != nil {
		s.store.Close()
	}
	if s.log != nil {
		s.logf("daemon stopped")
		s.log.Close()
	}
	if s.pidPath != "" {
		os.Remove(s.pidPath)
	}
	if s.lock != nil {
		s.lock.Unlock()
	}
}

func (s *Server) logf(format string, args ...any) {
	if s.log == nil {
		return
	}
	fmt.Fprintf(s.log, "%s %s\n",
		time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(format, args...))
}

// Serve runs sync cycles until the context is cancelled.
func (s *Server) Serve(ctx context.Context) error {
	s.logf("daemon started, pid %d", os.Getpid())
	interval := time.Duration(s.runtime.Config.SyncIntervalMinutes) * time.Minute
	if interval <= 0 {
		interval = 15 * time.Minute
	}
	for {
		if err := s.SyncOnce(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			s.logf("sync failed: %v", err)
			s.store.SetError(err.Error())
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(interval):
		}
	}
}

// SyncOnce runs one full cycle: discover meetings, then fetch the transcripts
// that are still missing.
func (s *Server) SyncOnce(ctx context.Context) error {
	session, err := sana.LoadSession(s.runtime.Paths.Session)
	if err != nil {
		return fmt.Errorf("read session: %w", err)
	}
	if session == nil || session.Cookies[sana.SessionCookie] == "" {
		return s.store.SetPhase(store.PhaseNeedsLogin)
	}
	client := sana.New(os.Getenv("SANA_BASE_URL"), session)

	if err := s.store.SetPhase(store.PhaseListing); err != nil {
		return err
	}
	discovered, err := s.discover(ctx, client)
	if err != nil {
		if errors.Is(err, sana.ErrUnauthorized) {
			return s.store.SetPhase(store.PhaseNeedsLogin)
		}
		return err
	}
	s.logf("listed %d meetings", discovered)

	if err := s.store.SetPhase(store.PhaseDownloading); err != nil {
		return err
	}
	fetched, err := s.fetchTranscripts(ctx, client)
	if err != nil {
		if errors.Is(err, sana.ErrUnauthorized) {
			return s.store.SetPhase(store.PhaseNeedsLogin)
		}
		return err
	}
	if fetched > 0 {
		s.logf("fetched %d transcripts", fetched)
	}

	// Summaries and participants are stored too, so every tool except the
	// recording link works without a network round trip.
	documents, err := s.fetchMetadata(ctx, client)
	if err != nil {
		if errors.Is(err, sana.ErrUnauthorized) {
			return s.store.SetPhase(store.PhaseNeedsLogin)
		}
		return err
	}
	if documents > 0 {
		s.logf("fetched %d meeting documents", documents)
	}

	status, err := s.store.Status()
	if err != nil {
		return err
	}
	if status.Remaining == 0 {
		return s.store.SetPhase(store.PhaseSynced)
	}
	// More is pending than one cycle fetches; stay in downloading so the next
	// cycle picks it up without claiming to be finished.
	return s.store.SetPhase(store.PhaseDownloading)
}

// discover walks the meeting list and records every meeting it finds.
func (s *Server) discover(ctx context.Context, client *sana.Client) (int, error) {
	count := 0
	var walkErr error
	err := client.WalkMeetings(ctx, func(page []sana.MeetingSummary) bool {
		for _, summary := range page {
			meeting := store.Meeting{
				MeetingID: summary.ID,
				Title:     summary.Name,
				CreatedMS: int64(summary.CreatedAtMS),
				Status:    meetingStatus(summary),
			}
			if err := s.store.PutMeeting(meeting); err != nil {
				walkErr = err
				return false
			}
			count++
		}
		return ctx.Err() == nil
	})
	if walkErr != nil {
		return count, walkErr
	}
	return count, err
}

// meetingStatus maps Sana's processing phase onto the status the tool contract
// exposes. Anything not finished is reported as processing rather than ready,
// because only a finished meeting can supply a transcript.
func meetingStatus(summary sana.MeetingSummary) string {
	phase := ""
	if summary.ProcessingPhase != nil {
		phase = strings.ToLower(*summary.ProcessingPhase)
	}
	switch phase {
	case "done", "completed", "complete", "ready", "":
		return "ready"
	case "failed", "error":
		return "retrying"
	default:
		return "processing"
	}
}

// fetchTranscripts downloads transcripts for meetings that do not have one.
// A meeting whose transcript is already stored is never re-fetched.
func (s *Server) fetchTranscripts(ctx context.Context, client *sana.Client) (int, error) {
	pending, err := s.store.PendingTranscripts(transcriptBatch)
	if err != nil {
		return 0, err
	}
	fetched := 0
	for _, meetingID := range pending {
		if ctx.Err() != nil {
			return fetched, nil
		}
		segments, err := client.Transcript(ctx, meetingID)
		if err != nil {
			if errors.Is(err, sana.ErrUnauthorized) {
				return fetched, err
			}
			// One meeting failing must not stop the rest: it is left pending
			// and retried on the next cycle.
			s.logf("transcript %s failed: %v", meetingID, err)
			continue
		}
		if err := s.store.PutTranscript(meetingID, linesFrom(segments)); err != nil {
			return fetched, err
		}
		fetched++
	}
	return fetched, nil
}

// fetchMetadata stores the summary document and participants for meetings that
// do not have them yet. A failure here never fails the cycle: the transcript is
// the thing people need, and the document is retried next time.
func (s *Server) fetchMetadata(ctx context.Context, client *sana.Client) (int, error) {
	pending, err := s.store.PendingMetadata(transcriptBatch)
	if err != nil {
		return 0, err
	}
	stored := 0
	for _, meetingID := range pending {
		if ctx.Err() != nil {
			return stored, nil
		}
		metadata, err := client.Meeting(ctx, meetingID)
		if err != nil {
			if errors.Is(err, sana.ErrUnauthorized) {
				return stored, err
			}
			s.logf("metadata %s failed: %v", meetingID, err)
			continue
		}
		participants, err := client.Participants(ctx, meetingID)
		if err != nil {
			if errors.Is(err, sana.ErrUnauthorized) {
				return stored, err
			}
			s.logf("participants %s failed: %v", meetingID, err)
			continue
		}
		summaryJSON, err := json.Marshal(metadata)
		if err != nil {
			return stored, err
		}
		participantsJSON, err := json.Marshal(participants)
		if err != nil {
			return stored, err
		}
		words, err := s.store.WordCount(meetingID)
		if err != nil {
			return stored, err
		}
		if err := s.store.PutMetadata(
			meetingID, string(summaryJSON), string(participantsJSON), words,
		); err != nil {
			return stored, err
		}
		stored++
	}
	return stored, nil
}

// linesFrom turns speaker segments into numbered transcript lines. One segment
// is one line, which is what the tool contract's line numbers refer to.
func linesFrom(segments []sana.Segment) []store.Line {
	lines := make([]store.Line, 0, len(segments))
	for index, segment := range segments {
		var text strings.Builder
		start := 0.0
		for wordIndex, word := range segment.Words {
			if wordIndex == 0 {
				start = word.StartTimestamp
			} else {
				text.WriteByte(' ')
			}
			text.WriteString(word.Text)
		}
		lines = append(lines, store.Line{
			LineNo:       index + 1,
			Speaker:      segment.Speaker,
			StartMS:      int64(start * 1000),
			OriginalText: text.String(),
		})
	}
	return lines
}

// Stop asks a running daemon to exit. It reports whether one was running.
//
// The lock file is the only handle on the daemon, so "is it running" is exactly
// "can the lock be taken".
func Stop(ctx context.Context, runtime *bootstrap.Runtime) (bool, error) {
	lock := flock.New(runtime.Paths.Lock)
	held, err := lock.TryLock()
	if err != nil {
		return false, err
	}
	if held {
		lock.Unlock()
		return false, nil
	}
	pidPath := filepath.Join(runtime.Paths.Root, "daemon.pid")
	return stopByPID(pidPath)
}

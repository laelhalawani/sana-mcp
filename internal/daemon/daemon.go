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
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
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

// newLock builds the singleton lock. It is one function so that Open and the
// autostart check cannot disagree about which file is the lock.
func newLock(path string) *flock.Flock { return flock.New(path) }

// daemonRunning reports whether a daemon holds the lock, without taking it.
//
// Callers differ only in what they do when the answer cannot be determined, so
// the probe itself has one definition.
func daemonRunning(path string) (bool, error) {
	lock := newLock(path)
	held, err := lock.TryLock()
	if err != nil {
		return false, err
	}
	if held {
		lock.Unlock()
		return false, nil
	}
	return true, nil
}

// Server is a running sync daemon.
type Server struct {
	runtime *bootstrap.Runtime
	store   *store.Store
	lock    *flock.Flock
	log     *os.File
	pidPath string
	// backfilling is set while cycles run back to back to work through stored
	// transcripts, so those cycles skip re-listing meetings.
	backfilling bool
}

// Open acquires the singleton lock and opens the store.
func Open(runtime *bootstrap.Runtime) (*Server, error) {
	if err := os.MkdirAll(runtime.Paths.Root, 0o700); err != nil {
		return nil, err
	}
	lock := newLock(runtime.Paths.Lock)
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
	pidPath := runtime.Paths.PID
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
		before, _ := s.store.Status()
		if err := s.SyncOnce(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			s.logf("sync failed: %v", err)
			s.store.SetError(err.Error())
		}
		after, err := s.store.Status()
		if err != nil {
			after = before
		}
		if backfilling(before, after) {
			if ctx.Err() != nil {
				return nil
			}
			s.backfilling = true
			continue
		}
		s.backfilling = false
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(interval):
		}
	}
}

// backfilling reports whether the last cycle should be followed immediately by
// another, rather than waiting for the poll interval.
//
// A cycle fetches a bounded batch, so a first sync of hundreds of meetings
// needs many of them, and waiting between batches would turn a backfill into
// hours of idling. But "work remains" is not sufficient on its own: when every
// pending transcript fails - a meeting Sana will not serve, a network that is
// down - work remains forever, and looping on that alone is a hot loop that
// hammers the API, spins the CPU, and fills the log.
//
// So the condition is progress, not pending work. If a cycle stored nothing new,
// the daemon waits, and the next interval retries what failed.
func backfilling(before, after store.Status) bool {
	if after.Complete() || after.Phase != store.PhaseDownloading {
		return false
	}
	return after.TranscriptsDone > before.TranscriptsDone
}

// SyncUntilIdle runs cycles until there is nothing left to fetch, no progress
// is being made, or the context ends.
//
// The installer needs this to show real progress while it waits. It exists here
// rather than in the installer so that the backfilling guard - the thing that
// keeps a stalled sync from becoming a hot loop against the API - is applied by
// whoever drives a sync, not reimplemented per caller.
func (s *Server) SyncUntilIdle(ctx context.Context) error {
	for {
		before, _ := s.store.Status()
		if err := s.SyncOnce(ctx); err != nil {
			return err
		}
		after, err := s.store.Status()
		if err != nil {
			return err
		}
		if !backfilling(before, after) || ctx.Err() != nil {
			s.backfilling = false
			return nil
		}
		s.backfilling = true
	}
}

// SyncOnce runs one full cycle: discover meetings, then fetch the transcripts
// that are still missing.
//
// An expired session is translated here, once, rather than after each step:
// every step can raise it, and a fourth step added later cannot forget to.
func (s *Server) SyncOnce(ctx context.Context) error {
	before := s.sessionCookie()
	err := s.syncCycle(ctx)
	if errors.Is(err, sana.ErrUnauthorized) {
		// Rejected - but rejected with the cookie this cycle started with. If
		// somebody signed in while it was running, recording the verdict would
		// mark the new session expired, and every screen would say so until the
		// next cycle came round.
		if s.sessionCookie() != before {
			return nil
		}
		return s.store.SetPhase(store.PhaseNeedsLogin)
	}
	return err
}

// sessionCookie identifies the stored sign-in, so a cycle can tell whether the
// one it used is still the current one.
func (s *Server) sessionCookie() string {
	session, err := sana.LoadSession(s.runtime.Paths.Session)
	if err != nil || session == nil {
		return ""
	}
	return session.Cookies[sana.SessionCookie]
}

func (s *Server) syncCycle(ctx context.Context) error {
	session, err := sana.LoadSession(s.runtime.Paths.Session)
	if err != nil {
		return fmt.Errorf("read session: %w", err)
	}
	if !session.SignedIn() {
		return s.store.SetPhase(store.PhaseNeedsLogin)
	}
	client := sana.New("", session)

	// Discovery is skipped while backfilling. A backfill runs many cycles to
	// work through the transcript batches, and re-paginating the whole meeting
	// list for each of them re-fetched and rewrote every row to learn nothing:
	// only the transcripts changed. It still runs once per poll interval, which
	// is what picks up meetings whose processing has finished.
	if !s.backfilling {
		if err := s.store.SetPhase(store.PhaseListing); err != nil {
			return err
		}
		discovered, err := s.discover(ctx, client)
		if err != nil {
			return err
		}
		s.logf("listed %d meetings", discovered)
	}

	if err := s.store.SetPhase(store.PhaseDownloading); err != nil {
		return err
	}
	fetched, err := s.fetchTranscripts(ctx, client)
	if err != nil {
		return err
	}
	if fetched > 0 {
		s.logf("fetched %d transcripts", fetched)
	}

	// Summaries and participants are stored too, so every tool except the
	// recording link works without a network round trip.
	documents, err := s.fetchMetadata(ctx, client)
	if err != nil {
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
		meetings := make([]store.Meeting, 0, len(page))
		for _, summary := range page {
			meetings = append(meetings, store.Meeting{
				MeetingID: summary.ID,
				Title:     summary.Name,
				CreatedMS: int64(summary.CreatedAtMS),
				Status:    meetingStatus(summary),
			})
		}
		if err := s.store.PutMeetings(meetings); err != nil {
			walkErr = err
			return false
		}
		count += len(meetings)
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
		return store.StatusReady
	case "failed", "error":
		return store.StatusRetrying
	default:
		return store.StatusProcessing
	}
}

// fetchTranscripts downloads transcripts for meetings that do not have one.
// A meeting whose transcript is already stored is never re-fetched.
func (s *Server) fetchTranscripts(ctx context.Context, client *sana.Client) (int, error) {
	pending, err := s.store.PendingTranscripts(transcriptBatch)
	if err != nil {
		return 0, err
	}
	return fetchEach(ctx, s, pending, "transcript",
		client.Transcript,
		func(meetingID string, segments []sana.Segment) error {
			return s.store.PutTranscript(meetingID, linesFrom(segments))
		})
}

// fetchMetadata stores the summary document and participants for meetings that
// do not have them yet. A failure here never fails the cycle: the transcript is
// the thing people need, and the document is retried next time.
func (s *Server) fetchMetadata(ctx context.Context, client *sana.Client) (int, error) {
	pending, err := s.store.PendingMetadata(transcriptBatch)
	if err != nil {
		return 0, err
	}
	return fetchEach(ctx, s, pending, "metadata",
		func(ctx context.Context, meetingID string) (meetingDocuments, error) {
			// The summary document and the participants are independent
			// requests and both are always needed, so they go out together.
			var (
				documents meetingDocuments
				metaErr   error
				peopleErr error
				wait      sync.WaitGroup
			)
			wait.Add(2)
			go func() {
				defer wait.Done()
				documents.metadata, metaErr = client.Meeting(ctx, meetingID)
			}()
			go func() {
				defer wait.Done()
				documents.participants, peopleErr = client.Participants(ctx, meetingID)
			}()
			wait.Wait()
			return documents, firstError(metaErr, peopleErr)
		},
		func(meetingID string, documents meetingDocuments) error {
			// The word count is not recomputed here: PutTranscript already
			// stored it from the same lines.
			return s.store.PutMetadata(meetingID, documents.metadata, documents.participants)
		})
}

// meetingDocuments is the pair fetched together for one meeting.
type meetingDocuments struct {
	metadata     sana.Metadata
	participants []sana.Participant
}

// firstError returns the first non-nil error, preferring an expired session so
// a cycle stops rather than logging it as one meeting failing.
func firstError(errs ...error) error {
	for _, err := range errs {
		if errors.Is(err, sana.ErrUnauthorized) {
			return err
		}
	}
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
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
	running, err := daemonRunning(runtime.Paths.Lock)
	if err != nil {
		return false, err
	}
	if !running {
		return false, nil
	}
	return stopByPID(runtime.Paths.PID)
}

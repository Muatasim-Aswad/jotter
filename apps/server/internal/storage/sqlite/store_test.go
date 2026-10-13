package sqlite

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/Muatasim-Aswad/jotter/apps/server/internal/scratchpad"
)

func TestMigrationsBootstrapAndPragmasAreDurable(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "jotter.db")
	now := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	store := openTestStore(t, path, func() time.Time { return now }, sequenceIDs("scratchpad-id"))
	state, err := store.Bootstrap(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if state.Scratchpad.ID != "scratchpad-id" || state.Scratchpad.Revision != 0 || state.Scratchpad.Content != "" {
		t.Fatalf("initial scratchpad = %#v", state.Scratchpad)
	}
	second, err := store.Bootstrap(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if second.Scratchpad.ID != state.Scratchpad.ID {
		t.Fatalf("singleton ID changed: %q to %q", state.Scratchpad.ID, second.Scratchpad.ID)
	}

	assertIntQuery(t, store, `SELECT COUNT(*) FROM scratchpads`, 1)
	assertIntQuery(t, store, `SELECT COUNT(*) FROM goose_db_version WHERE version_id = 1 AND is_applied = 1`, 1)
	assertIntQuery(t, store, `PRAGMA foreign_keys`, 1)
	assertIntQuery(t, store, `PRAGMA busy_timeout`, 5000)
	assertIntQuery(t, store, `PRAGMA synchronous`, 2)
	var journalMode string
	if err := store.db.QueryRow(`PRAGMA journal_mode`).Scan(&journalMode); err != nil {
		t.Fatal(err)
	}
	if journalMode != "wal" {
		t.Fatalf("journal_mode = %q", journalMode)
	}
	assertReceiptSchemaContainsNoContent(t, store)
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened := openTestStore(t, path, func() time.Time { return now.Add(time.Hour) }, sequenceIDs("unused"))
	t.Cleanup(func() { _ = reopened.Close() })
	restarted, err := reopened.Bootstrap(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if restarted.Scratchpad.ID != state.Scratchpad.ID {
		t.Fatalf("restart singleton ID = %q, want %q", restarted.Scratchpad.ID, state.Scratchpad.ID)
	}
	assertIntQuery(t, reopened, `SELECT COUNT(*) FROM goose_db_version WHERE version_id = 1 AND is_applied = 1`, 1)
}

func TestSaveRetryConflictResolutionAndRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "jotter.db")
	now := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	store := openTestStore(t, path, func() time.Time { return now }, sequenceIDs("scratchpad", "conflict-1", "conflict-2"))
	service := scratchpad.NewService(store, scratchpad.WithClock(func() time.Time { return now }))
	state, err := service.Bootstrap(ctx)
	if err != nil {
		t.Fatal(err)
	}
	id := state.Scratchpad.ID

	first := save(t, service, scratchpad.SaveCommand{ScratchpadID: id, Content: "one\r\ntwo", BaseRevision: 0, ClientID: "client-1", SessionID: "session-1", MutationID: "mutation-1"})
	if first.Kind != scratchpad.SaveAccepted || first.Receipt.AcceptedRevision != 1 {
		t.Fatalf("first save = %#v", first)
	}
	now = now.Add(time.Second)
	second := save(t, service, scratchpad.SaveCommand{ScratchpadID: id, Content: "later", BaseRevision: 1, ClientID: "client-2", SessionID: "session-2", MutationID: "mutation-2"})
	if second.Receipt.AcceptedRevision != 2 {
		t.Fatalf("second revision = %d", second.Receipt.AcceptedRevision)
	}

	retry := save(t, service, scratchpad.SaveCommand{ScratchpadID: id, Content: "one\r\ntwo", BaseRevision: 0, ClientID: "client-1", SessionID: "session-1", MutationID: "mutation-1"})
	if retry.Kind != scratchpad.SaveAccepted || retry.Receipt.AcceptedRevision != 1 || !retry.Receipt.CreatedAt.Equal(first.Receipt.CreatedAt) {
		t.Fatalf("lost-ack retry = %#v, want original receipt %#v", retry, first)
	}
	current, err := service.Bootstrap(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if current.Scratchpad.Content != "later" || current.Scratchpad.Revision != 2 {
		t.Fatalf("retry changed canonical state: %#v", current.Scratchpad)
	}

	now = now.Add(time.Second)
	stale := save(t, service, scratchpad.SaveCommand{ScratchpadID: id, Content: "local", BaseRevision: 0, ClientID: "client-3", SessionID: "session-3", MutationID: "mutation-3"})
	if stale.Kind != scratchpad.SaveConflicted || stale.Conflict.ServerContent != "later" || stale.Conflict.ServerRevision != 2 {
		t.Fatalf("stale save = %#v", stale)
	}
	now = now.Add(time.Second)
	third := save(t, service, scratchpad.SaveCommand{ScratchpadID: id, Content: "newest", BaseRevision: 2, ClientID: "client-4", SessionID: "session-4", MutationID: "mutation-4"})
	if third.Receipt.AcceptedRevision != 3 {
		t.Fatalf("third revision = %d", third.Receipt.AcceptedRevision)
	}
	staleRetry := save(t, service, scratchpad.SaveCommand{ScratchpadID: id, Content: "local", BaseRevision: 0, ClientID: "client-3", SessionID: "session-3", MutationID: "mutation-3"})
	if staleRetry.Conflict.ID != stale.Conflict.ID || staleRetry.Conflict.ServerRevision != 2 || staleRetry.Conflict.SubmittedContent != "local" {
		t.Fatalf("stale retry = %#v, want original conflict %#v", staleRetry.Conflict, stale.Conflict)
	}

	filtered, err := service.ListConflicts(ctx, scratchpad.ConflictFilter{ClientID: "client-3", SessionID: "session-3"})
	if err != nil || len(filtered) != 1 || filtered[0].ID != stale.Conflict.ID {
		t.Fatalf("filtered conflicts = %#v, %v", filtered, err)
	}
	_, err = service.ResolveConflict(ctx, scratchpad.ResolveCommand{ConflictID: stale.Conflict.ID, Content: "proposed", BaseRevision: 2})
	if scratchpad.ErrorCodeOf(err) != scratchpad.ErrorStaleRevision {
		t.Fatalf("stale resolution error = %v", err)
	}
	filtered, err = service.ListConflicts(ctx, scratchpad.ConflictFilter{})
	if err != nil || len(filtered) != 1 {
		t.Fatalf("conflict was lost after stale resolution: %#v, %v", filtered, err)
	}
	now = now.Add(time.Second)
	resolved, err := service.ResolveConflict(ctx, scratchpad.ResolveCommand{ConflictID: stale.Conflict.ID, Content: "resolved\rvalue", BaseRevision: 3})
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Scratchpad.Content != "resolved\nvalue" || resolved.Scratchpad.Revision != 4 {
		t.Fatalf("resolved state = %#v", resolved.Scratchpad)
	}
	filtered, err = service.ListConflicts(ctx, scratchpad.ConflictFilter{})
	if err != nil || len(filtered) != 0 {
		t.Fatalf("resolved conflict remains: %#v, %v", filtered, err)
	}

	now = now.Add(time.Second)
	persistedConflict := save(t, service, scratchpad.SaveCommand{ScratchpadID: id, Content: "offline", BaseRevision: 0, ClientID: "client-5", SessionID: "session-5", MutationID: "mutation-5"})
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := openTestStore(t, path, func() time.Time { return now }, sequenceIDs("unused"))
	t.Cleanup(func() { _ = reopened.Close() })
	restarted, err := scratchpad.NewService(reopened).Bootstrap(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if restarted.Scratchpad.Content != "resolved\nvalue" || restarted.Scratchpad.Revision != 4 || len(restarted.Conflicts) != 1 || restarted.Conflicts[0].ID != persistedConflict.Conflict.ID {
		t.Fatalf("restart state = %#v", restarted)
	}
}

func TestSimultaneousBaseRevisionPreservesBothVersions(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t, filepath.Join(t.TempDir(), "jotter.db"), time.Now, nil)
	t.Cleanup(func() { _ = store.Close() })
	service := scratchpad.NewService(store)
	state, err := service.Bootstrap(ctx)
	if err != nil {
		t.Fatal(err)
	}
	commands := []scratchpad.SaveCommand{
		{ScratchpadID: state.Scratchpad.ID, Content: "alpha", BaseRevision: 0, ClientID: "client-a", SessionID: "session-a", MutationID: "mutation-a"},
		{ScratchpadID: state.Scratchpad.ID, Content: "beta", BaseRevision: 0, ClientID: "client-b", SessionID: "session-b", MutationID: "mutation-b"},
	}
	results := make(chan scratchpad.SaveResult, 2)
	errors := make(chan error, 2)
	var wait sync.WaitGroup
	for _, command := range commands {
		wait.Add(1)
		go func(command scratchpad.SaveCommand) {
			defer wait.Done()
			result, err := service.Save(ctx, command)
			results <- result
			errors <- err
		}(command)
	}
	wait.Wait()
	close(results)
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	var accepted, conflicted int
	var submitted, canonical string
	for result := range results {
		switch result.Kind {
		case scratchpad.SaveAccepted:
			accepted++
		case scratchpad.SaveConflicted:
			conflicted++
			submitted, canonical = result.Conflict.SubmittedContent, result.Conflict.ServerContent
		}
	}
	if accepted != 1 || conflicted != 1 || submitted == canonical || (submitted != "alpha" && submitted != "beta") || (canonical != "alpha" && canonical != "beta") {
		t.Fatalf("accepted=%d conflicted=%d submitted=%q canonical=%q", accepted, conflicted, submitted, canonical)
	}
}

func TestReceiptPruningUsesAgeAndPerScratchpadLimit(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	store := openTestStore(t, filepath.Join(t.TempDir(), "jotter.db"), func() time.Time { return now }, sequenceIDs("scratchpad"))
	t.Cleanup(func() { _ = store.Close() })
	state, err := store.Bootstrap(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rows := []struct {
		id       string
		revision int
		created  time.Time
	}{
		{"old", 1, now.Add(-8 * 24 * time.Hour)},
		{"second", 2, now.Add(-2 * 24 * time.Hour)},
		{"third", 3, now.Add(-24 * time.Hour)},
		{"newest", 4, now},
	}
	for _, row := range rows {
		if _, err := store.db.Exec(`INSERT INTO mutation_receipts (scratchpad_id, mutation_id, accepted_revision, created_at) VALUES (?, ?, ?, ?)`, state.Scratchpad.ID, row.id, row.revision, formatTime(row.created)); err != nil {
			t.Fatal(err)
		}
	}
	deleted, err := store.PruneReceipts(ctx, now.Add(-7*24*time.Hour), 2)
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 2 {
		t.Fatalf("deleted = %d, want 2", deleted)
	}
	dbRows, err := store.db.Query(`SELECT mutation_id FROM mutation_receipts ORDER BY mutation_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer dbRows.Close()
	var ids []string
	for dbRows.Next() {
		var id string
		if err := dbRows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if fmt.Sprint(ids) != "[newest third]" {
		t.Fatalf("remaining receipts = %v", ids)
	}
}

func openTestStore(t *testing.T, path string, now func() time.Time, ids func() (string, error)) *Store {
	t.Helper()
	options := []Option{WithClock(now)}
	if ids != nil {
		options = append(options, WithIDGenerator(ids))
	}
	store, err := Open(context.Background(), path, options...)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func sequenceIDs(values ...string) func() (string, error) {
	var mutex sync.Mutex
	index := 0
	return func() (string, error) {
		mutex.Lock()
		defer mutex.Unlock()
		if index >= len(values) {
			return "", fmt.Errorf("no test identifier available")
		}
		value := values[index]
		index++
		return value, nil
	}
}

func save(t *testing.T, service *scratchpad.Service, command scratchpad.SaveCommand) scratchpad.SaveResult {
	t.Helper()
	result, err := service.Save(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func assertIntQuery(t *testing.T, store *Store, query string, want int) {
	t.Helper()
	var got int
	if err := store.db.QueryRow(query).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("%s = %d, want %d", query, got, want)
	}
}

func assertReceiptSchemaContainsNoContent(t *testing.T, store *Store) {
	t.Helper()
	rows, err := store.db.Query(`PRAGMA table_info(mutation_receipts)`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var columns []string
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			t.Fatal(err)
		}
		columns = append(columns, name)
	}
	sort.Strings(columns)
	if fmt.Sprint(columns) != "[accepted_revision created_at mutation_id request_hash scratchpad_id]" {
		t.Fatalf("receipt columns = %v", columns)
	}
}

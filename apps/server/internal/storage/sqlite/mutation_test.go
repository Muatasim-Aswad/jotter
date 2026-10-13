package sqlite

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/Muatasim-Aswad/jotter/apps/server/internal/scratchpad"
)

func TestMutationIdentityRejectsChangedRequests(t *testing.T) {
	changes := map[string]func(*scratchpad.SaveCommand){
		"content":       func(c *scratchpad.SaveCommand) { c.Content = "different" },
		"base revision": func(c *scratchpad.SaveCommand) { c.BaseRevision++ },
		"client":        func(c *scratchpad.SaveCommand) { c.ClientID = "other" },
		"session":       func(c *scratchpad.SaveCommand) { c.SessionID = "other" },
		"scratchpad":    func(c *scratchpad.SaveCommand) { c.ScratchpadID = "other" },
	}
	for _, stale := range []bool{false, true} {
		for name, change := range changes {
			t.Run(name+map[bool]string{false: "/receipt", true: "/conflict"}[stale], func(t *testing.T) {
				ctx := context.Background()
				store := openTestStore(t, filepath.Join(t.TempDir(), "jotter.db"), time.Now, nil)
				t.Cleanup(func() { _ = store.Close() })
				service := scratchpad.NewService(store)
				state, err := service.Bootstrap(ctx)
				if err != nil {
					t.Fatal(err)
				}
				command := scratchpad.SaveCommand{ScratchpadID: state.Scratchpad.ID, Content: "original", ClientID: "client", SessionID: "session", MutationID: "mutation"}
				if stale {
					seed := command
					seed.MutationID = "seed"
					save(t, service, seed)
				}
				first := save(t, service, command)
				changed := command
				change(&changed)
				if _, err := service.Save(ctx, changed); scratchpad.ErrorCodeOf(err) != scratchpad.ErrorMutationMismatch {
					t.Fatalf("changed request: %v", err)
				}
				retry := save(t, service, command)
				if retry.Kind != first.Kind {
					t.Fatalf("retry kind = %s", retry.Kind)
				}
				current, err := service.Bootstrap(ctx)
				if err != nil || current.Scratchpad.Content != "original" || current.Scratchpad.Revision != 1 {
					t.Fatalf("canonical state changed: %#v, %v", current, err)
				}
			})
		}
	}
}

func TestLegacyReceiptRequiresNewIdentityAndPreservesConflict(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "jotter.db")
	store := openTestStore(t, path, time.Now, nil)
	service := scratchpad.NewService(store)
	state, err := service.Bootstrap(ctx)
	if err != nil {
		t.Fatal(err)
	}
	command := scratchpad.SaveCommand{ScratchpadID: state.Scratchpad.ID, Content: "original", ClientID: "client", SessionID: "session", MutationID: "legacy"}
	save(t, service, command)
	if _, err := store.db.Exec(`UPDATE mutation_receipts SET request_hash = NULL`); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store = openTestStore(t, path, time.Now, nil)
	t.Cleanup(func() { _ = store.Close() })
	service = scratchpad.NewService(store)
	if _, err := service.Save(ctx, command); scratchpad.ErrorCodeOf(err) != scratchpad.ErrorMutationMismatch {
		t.Fatalf("legacy receipt: %v", err)
	}
	command.MutationID = "replacement"
	command.Content = "pending local text"
	result := save(t, service, command)
	if result.Kind != scratchpad.SaveConflicted || result.Conflict.SubmittedContent != command.Content || result.Conflict.ServerContent != "original" {
		t.Fatalf("legacy replay: %#v", result)
	}
}

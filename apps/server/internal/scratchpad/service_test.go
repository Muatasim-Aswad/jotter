package scratchpad

import (
	"context"
	"testing"
	"time"
)

type fakeStore struct {
	state       State
	saved       SaveCommand
	resolved    ResolveCommand
	pruneBefore time.Time
	pruneLimit  int
}

func (store *fakeStore) Bootstrap(context.Context) (State, error) { return store.state, nil }
func (store *fakeStore) Save(_ context.Context, command SaveCommand) (SaveResult, error) {
	store.saved = command
	return SaveResult{Kind: SaveAccepted, Scratchpad: &store.state.Scratchpad}, nil
}
func (store *fakeStore) ListConflicts(context.Context, ConflictFilter) ([]Conflict, error) {
	return nil, nil
}
func (store *fakeStore) ResolveConflict(_ context.Context, command ResolveCommand) (ResolveResult, error) {
	store.resolved = command
	return ResolveResult{}, nil
}
func (store *fakeStore) PruneReceipts(_ context.Context, before time.Time, limit int) (int64, error) {
	store.pruneBefore, store.pruneLimit = before, limit
	return 2, nil
}

func TestServiceNormalizesBeforeAtomicSave(t *testing.T) {
	store := &fakeStore{state: State{Scratchpad: Scratchpad{ID: "scratchpad", Content: "one\ntwo\nthree", Revision: 1}}}
	service := NewService(store)
	result, err := service.Save(context.Background(), SaveCommand{
		ScratchpadID: "scratchpad", Content: "one\r\ntwo\rthree", BaseRevision: 0,
		ClientID: "client", SessionID: "session", MutationID: "mutation",
	})
	if err != nil {
		t.Fatal(err)
	}
	if store.saved.Content != "one\ntwo\nthree" {
		t.Fatalf("stored content = %q", store.saved.Content)
	}
	if result.Scratchpad == nil || result.Scratchpad.Revision != 1 {
		t.Fatalf("committed scratchpad = %#v", result.Scratchpad)
	}
}

func TestServiceRejectsInvalidInputBeforeStore(t *testing.T) {
	store := &fakeStore{}
	service := NewService(store)
	_, err := service.Save(context.Background(), SaveCommand{ScratchpadID: "scratchpad", Content: "ok", BaseRevision: -1, ClientID: "client", SessionID: "session", MutationID: "mutation"})
	if ErrorCodeOf(err) != ErrorInvalidState {
		t.Fatalf("error = %v", err)
	}
	if store.saved.MutationID != "" {
		t.Fatal("store was called for invalid input")
	}
}

func TestServiceNormalizesConflictResolution(t *testing.T) {
	store := &fakeStore{}
	service := NewService(store)
	_, err := service.ResolveConflict(context.Background(), ResolveCommand{ConflictID: "conflict", Content: "a\rb", BaseRevision: 2})
	if err != nil {
		t.Fatal(err)
	}
	if store.resolved.Content != "a\nb" {
		t.Fatalf("resolved content = %q", store.resolved.Content)
	}
}

func TestServicePrunesByRetentionAndLimit(t *testing.T) {
	now := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	store := &fakeStore{}
	service := NewService(store, WithClock(func() time.Time { return now }))
	count, err := service.PruneReceipts(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 || store.pruneLimit != ReceiptLimit || !store.pruneBefore.Equal(now.Add(-ReceiptRetention)) {
		t.Fatalf("prune = (%d, %s, %d)", count, store.pruneBefore, store.pruneLimit)
	}
}

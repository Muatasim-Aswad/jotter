package sqlite

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Muatasim-Aswad/jotter/apps/server/internal/scratchpad"
)

func TestRestoredCopyPreservesContentConflictsAndReceipts(t *testing.T) {
	ctx := context.Background()
	source := filepath.Join(t.TempDir(), "jotter.db")
	store := openTestStore(t, source, time.Now, nil)
	service := scratchpad.NewService(store)
	state, err := service.Bootstrap(ctx)
	if err != nil {
		t.Fatal(err)
	}
	command := scratchpad.SaveCommand{ScratchpadID: state.Scratchpad.ID, Content: "accepted", ClientID: "client", SessionID: "session", MutationID: "accepted"}
	receipt := save(t, service, command).Receipt
	stale := command
	stale.Content, stale.MutationID, stale.SessionID = "offline work", "stale", "other-session"
	conflict := save(t, service, stale).Conflict
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	restored := filepath.Join(t.TempDir(), "jotter.db")
	copyDatabaseFamily(t, source, restored)
	if err := VerifyCopy(ctx, restored); err != nil {
		t.Fatal(err)
	}
	reopened := openTestStore(t, restored, time.Now, nil)
	t.Cleanup(func() { _ = reopened.Close() })
	restoredService := scratchpad.NewService(reopened)
	recovered, err := restoredService.Bootstrap(ctx)
	if err != nil || recovered.Scratchpad.Content != "accepted" || recovered.Scratchpad.Revision != 1 || len(recovered.Conflicts) != 1 || recovered.Conflicts[0].ID != conflict.ID || recovered.Conflicts[0].SubmittedContent != "offline work" {
		t.Fatalf("restored state = %#v, %v", recovered, err)
	}
	if retry := save(t, restoredService, command); retry.Receipt.AcceptedRevision != receipt.AcceptedRevision || !retry.Receipt.CreatedAt.Equal(receipt.CreatedAt) {
		t.Fatalf("restored receipt = %#v, want %#v", retry.Receipt, receipt)
	}
	corrupt := filepath.Join(t.TempDir(), "jotter.db")
	if err := os.WriteFile(corrupt, []byte("not a database"), 0o600); err != nil {
		t.Fatal(err)
	}
	if VerifyCopy(ctx, corrupt) == nil {
		t.Fatal("corrupt copy accepted")
	}
	if err := VerifyCopy(ctx, source); err != nil {
		t.Fatalf("source affected: %v", err)
	}
}

func TestDatabaseRequiresExclusiveOwnership(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jotter.db")
	first, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = first.Close() })
	if VerifyCopy(context.Background(), path) == nil {
		t.Fatal("verified a live database")
	}
	second, err := Open(context.Background(), path)
	if err == nil {
		_ = second.Close()
		t.Fatal("second database owner accepted")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	third, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("ownership not released: %v", err)
	}
	_ = third.Close()
}

func copyDatabaseFamily(t *testing.T, source, destination string) {
	t.Helper()
	for _, suffix := range []string{"", "-wal", "-shm"} {
		data, err := os.ReadFile(source + suffix)
		if os.IsNotExist(err) && suffix != "" {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(destination+suffix, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

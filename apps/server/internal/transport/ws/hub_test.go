package wstransport

import (
	"testing"
	"time"

	"github.com/Muatasim-Aswad/jotter/apps/server/internal/protocol"
	"github.com/coder/websocket"
)

func TestHubEvictsSlowClientWithoutBlockingOthers(t *testing.T) {
	hub := NewHub()
	closed := make(chan struct{}, 1)
	slow := &session{id: "slow", outgoing: make(chan []byte, 1), close: func(websocket.StatusCode, string) error { closed <- struct{}{}; return nil }}
	fast := &session{id: "fast", outgoing: make(chan []byte, 1), close: func(websocket.StatusCode, string) error { return nil }}
	slow.outgoing <- []byte("already full")
	if !hub.register(slow) || !hub.register(fast) {
		t.Fatal("hub rejected live sessions")
	}
	hub.Publish(&protocol.UpdateEnvelope{V: 1, Type: "update", Scratchpad: protocol.ScratchpadState{ID: "scratchpad", Content: "committed", Revision: 1, UpdatedAt: "2026-09-20T00:00:00Z"}, MutationID: "mutation"})
	if hub.sessionCount() != 1 {
		t.Fatalf("session count = %d, want 1", hub.sessionCount())
	}
	if len(fast.outgoing) != 1 {
		t.Fatal("fast client did not receive committed update")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("slow client was not closed")
	}
}

func TestHubCanExcludeOriginConnection(t *testing.T) {
	hub := NewHub()
	one := &session{id: "one", outgoing: make(chan []byte, 1), close: func(websocket.StatusCode, string) error { return nil }}
	two := &session{id: "two", outgoing: make(chan []byte, 1), close: func(websocket.StatusCode, string) error { return nil }}
	hub.register(one)
	hub.register(two)
	hub.publishExcept(&protocol.UpdateEnvelope{V: 1, Type: "update", Scratchpad: protocol.ScratchpadState{ID: "scratchpad", Content: "committed", Revision: 1, UpdatedAt: "2026-09-20T00:00:00Z"}, MutationID: "mutation"}, "one")
	if len(one.outgoing) != 0 || len(two.outgoing) != 1 {
		t.Fatalf("queue lengths = (%d, %d)", len(one.outgoing), len(two.outgoing))
	}
}

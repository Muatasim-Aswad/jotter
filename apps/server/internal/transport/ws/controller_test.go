package wstransport

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/Muatasim-Aswad/jotter/apps/server/internal/protocol"
	"github.com/Muatasim-Aswad/jotter/apps/server/internal/scratchpad"
	"github.com/coder/websocket"
)

type fakeLiveService struct {
	mu       sync.Mutex
	state    scratchpad.Scratchpad
	receipts map[string]scratchpad.MutationReceipt
}

func newFakeLiveService() *fakeLiveService {
	now := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	return &fakeLiveService{state: scratchpad.Scratchpad{ID: "scratchpad", Revision: 0, CreatedAt: now, UpdatedAt: now}, receipts: make(map[string]scratchpad.MutationReceipt)}
}

func (service *fakeLiveService) Bootstrap(context.Context) (scratchpad.State, error) {
	service.mu.Lock()
	defer service.mu.Unlock()
	return scratchpad.State{Scratchpad: service.state}, nil
}

func (service *fakeLiveService) ListConflicts(context.Context, scratchpad.ConflictFilter) ([]scratchpad.Conflict, error) {
	return nil, nil
}

func (service *fakeLiveService) Save(_ context.Context, command scratchpad.SaveCommand) (scratchpad.SaveResult, error) {
	service.mu.Lock()
	defer service.mu.Unlock()
	if receipt, ok := service.receipts[command.MutationID]; ok {
		state := service.state
		return scratchpad.SaveResult{Kind: scratchpad.SaveAccepted, Receipt: &receipt, Scratchpad: &state}, nil
	}
	service.state.Content = command.Content
	service.state.Revision++
	service.state.UpdatedAt = service.state.UpdatedAt.Add(time.Second)
	receipt := scratchpad.MutationReceipt{ScratchpadID: service.state.ID, MutationID: command.MutationID, AcceptedRevision: service.state.Revision, CreatedAt: service.state.UpdatedAt}
	service.receipts[command.MutationID] = receipt
	state := service.state
	return scratchpad.SaveResult{Kind: scratchpad.SaveAccepted, Receipt: &receipt, Scratchpad: &state}, nil
}

func TestControllerHandshakesAcknowledgesAndBroadcastsCommittedState(t *testing.T) {
	service := newFakeLiveService()
	hub := NewHub()
	controller, err := New(service, hub, "http://allowed.test")
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	controller.Register(mux)
	server := httptest.NewServer(mux)
	defer server.Close()

	first := dialTestClient(t, server.URL)
	defer first.CloseNow()
	second := dialTestClient(t, server.URL)
	defer second.CloseNow()
	readEnvelope[*protocol.StateEnvelope](t, first)
	readEnvelope[*protocol.StateEnvelope](t, second)

	save := &protocol.SaveEnvelope{V: 1, Type: "save", ScratchpadID: "scratchpad", Content: "committed", BaseRevision: 0, ClientID: "client-1", SessionID: "session-1", MutationID: "mutation-1"}
	writeTestEnvelope(t, first, save)
	ack := readEnvelope[*protocol.AckEnvelope](t, first)
	update := readEnvelope[*protocol.UpdateEnvelope](t, second)
	if ack.Revision != 1 || update.Scratchpad.Content != "committed" || update.Scratchpad.Revision != 1 {
		t.Fatalf("ack/update = %#v / %#v", ack, update)
	}

	writeTestEnvelope(t, first, save)
	duplicate := readEnvelope[*protocol.AckEnvelope](t, first)
	if duplicate.Revision != ack.Revision {
		t.Fatalf("duplicate revision = %d, want %d", duplicate.Revision, ack.Revision)
	}
}

func TestControllerRejectsUnexpectedOrigin(t *testing.T) {
	controller, err := New(newFakeLiveService(), NewHub(), "http://allowed.test")
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	controller.Register(mux)
	request := httptest.NewRequest(http.MethodGet, "/ws", nil)
	request.Header.Set("Origin", "http://other.test")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func dialTestClient(t *testing.T, serverURL string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection, _, err := websocket.Dial(ctx, "ws"+serverURL[len("http"):]+"/ws", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"http://allowed.test"}}})
	if err != nil {
		t.Fatal(err)
	}
	hello := &protocol.HelloEnvelope{V: 1, Type: "hello", ScratchpadID: "scratchpad", ClientID: "client-1", SessionID: "session-1", KnownRevision: 0, PendingMutationIDs: []string{}}
	writeTestEnvelope(t, connection, hello)
	return connection
}

func writeTestEnvelope(t *testing.T, connection *websocket.Conn, envelope protocol.Envelope) {
	t.Helper()
	data, err := protocol.Encode(envelope)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := connection.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatal(err)
	}
}

func readEnvelope[T protocol.Envelope](t *testing.T, connection *websocket.Conn) T {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := connection.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	value, err := protocol.Decode(data)
	if err != nil {
		t.Fatal(err)
	}
	typed, ok := value.(T)
	if !ok {
		t.Fatalf("envelope = %T", value)
	}
	return typed
}

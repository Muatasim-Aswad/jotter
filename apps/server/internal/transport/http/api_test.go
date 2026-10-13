package httptransport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Muatasim-Aswad/jotter/apps/server/internal/protocol"
	"github.com/Muatasim-Aswad/jotter/apps/server/internal/scratchpad"
)

type fakePublisher struct{ update *protocol.UpdateEnvelope }

func (publisher *fakePublisher) Publish(update *protocol.UpdateEnvelope) { publisher.update = update }

type fakeScratchpadService struct {
	state         scratchpad.State
	conflicts     []scratchpad.Conflict
	resolveResult scratchpad.ResolveResult
	err           error
	filter        scratchpad.ConflictFilter
	resolve       scratchpad.ResolveCommand
}

func (service *fakeScratchpadService) Bootstrap(context.Context) (scratchpad.State, error) {
	return service.state, service.err
}

func (service *fakeScratchpadService) ListConflicts(_ context.Context, filter scratchpad.ConflictFilter) ([]scratchpad.Conflict, error) {
	service.filter = filter
	return service.conflicts, service.err
}

func (service *fakeScratchpadService) ResolveConflict(_ context.Context, command scratchpad.ResolveCommand) (scratchpad.ResolveResult, error) {
	service.resolve = command
	return service.resolveResult, service.err
}

func TestBootstrapReturnsWireState(t *testing.T) {
	now := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	service := &fakeScratchpadService{state: scratchpad.State{
		Scratchpad: scratchpad.Scratchpad{ID: "scratchpad", Content: "text", Revision: 4, UpdatedAt: now},
		Conflicts:  []scratchpad.Conflict{{ID: "conflict", ScratchpadID: "scratchpad", MutationID: "mutation", SubmittedContent: "local", ServerContent: "server", ServerRevision: 4, ClientID: "client", SessionID: "session", CreatedAt: now}},
	}}
	response := serveAPI(t, service, http.MethodGet, "/api/v1/bootstrap", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	var body struct {
		Scratchpad struct {
			ID       string `json:"id"`
			Revision int64  `json:"revision"`
		} `json:"scratchpad"`
		Conflicts []struct {
			ConflictID string `json:"conflictId"`
		} `json:"conflicts"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Scratchpad.ID != "scratchpad" || body.Scratchpad.Revision != 4 || len(body.Conflicts) != 1 || body.Conflicts[0].ConflictID != "conflict" {
		t.Fatalf("body = %#v", body)
	}
}

func TestConflictListPassesOriginFilter(t *testing.T) {
	service := &fakeScratchpadService{}
	response := serveAPI(t, service, http.MethodGet, "/api/v1/conflicts?clientId=client&sessionId=session", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if service.filter.ClientID != "client" || service.filter.SessionID != "session" {
		t.Fatalf("filter = %#v", service.filter)
	}
}

func TestResolveConflictDecodesStrictRequest(t *testing.T) {
	now := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	service := &fakeScratchpadService{resolveResult: scratchpad.ResolveResult{Scratchpad: scratchpad.Scratchpad{ID: "scratchpad", Content: "chosen", Revision: 3, UpdatedAt: now}}}
	response := serveAPI(t, service, http.MethodPost, "/api/v1/conflicts/conflict-1/resolve", `{"content":"chosen","baseRevision":2}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	if service.resolve.ConflictID != "conflict-1" || service.resolve.Content != "chosen" || service.resolve.BaseRevision != 2 {
		t.Fatalf("resolve command = %#v", service.resolve)
	}

	invalid := serveAPI(t, service, http.MethodPost, "/api/v1/conflicts/conflict-1/resolve", `{"content":"chosen","baseRevision":2,"extra":true}`)
	assertErrorBody(t, invalid, http.StatusBadRequest, "invalid_message")
}

func TestResolveConflictPublishesOnlyCommittedResult(t *testing.T) {
	now := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	service := &fakeScratchpadService{resolveResult: scratchpad.ResolveResult{Scratchpad: scratchpad.Scratchpad{ID: "scratchpad", Content: "chosen", Revision: 3, UpdatedAt: now}}}
	publisher := &fakePublisher{}
	mux := http.NewServeMux()
	NewAPI(service, publisher).Register(mux)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/conflicts/conflict-1/resolve", strings.NewReader(`{"content":"chosen","baseRevision":2}`))
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK || publisher.update == nil {
		t.Fatalf("status/update = %d / %#v", response.Code, publisher.update)
	}
	if publisher.update.Scratchpad.Content != "chosen" || publisher.update.Scratchpad.Revision != 3 || publisher.update.MutationID != "conflict-1" {
		t.Fatalf("update = %#v", publisher.update)
	}
}

func TestServiceErrorsUseStableContentFreeBodies(t *testing.T) {
	service := &fakeScratchpadService{err: &scratchpad.Error{Code: scratchpad.ErrorStaleRevision, Message: "private proposed content"}}
	response := serveAPI(t, service, http.MethodPost, "/api/v1/conflicts/conflict-1/resolve", `{"content":"secret","baseRevision":2}`)
	assertErrorBody(t, response, http.StatusConflict, "stale_revision")
	if strings.Contains(response.Body.String(), "private") || strings.Contains(response.Body.String(), "secret") {
		t.Fatalf("response leaked content: %s", response.Body.String())
	}
}

func TestInvalidServiceResponseNeverReachesCaller(t *testing.T) {
	service := &fakeScratchpadService{state: scratchpad.State{Scratchpad: scratchpad.Scratchpad{ID: "scratchpad", Content: "private text", Revision: -1}}}
	response := serveAPI(t, service, http.MethodGet, "/api/v1/bootstrap", "")
	assertErrorBody(t, response, http.StatusInternalServerError, "internal_error")
	if strings.Contains(response.Body.String(), "private text") {
		t.Fatal("invalid response leaked content")
	}
}

func serveAPI(t *testing.T, service ScratchpadService, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	NewAPI(service).Register(mux)
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	return response
}

func assertErrorBody(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d: %s", response.Code, status, response.Body.String())
	}
	var body protocol.HttpErrorResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if string(body.Error.Code) != code || body.Error.Message == "" || body.Error.RequestID != response.Header().Get("X-Request-ID") {
		t.Fatalf("error body = %#v", body)
	}
}

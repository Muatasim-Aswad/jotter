package httptransport

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/Muatasim-Aswad/jotter/apps/server/internal/protocol"
	"github.com/Muatasim-Aswad/jotter/apps/server/internal/scratchpad"
)

const maxJSONBodyBytes = scratchpad.MaxContentBytes + 4096

type ScratchpadService interface {
	Bootstrap(context.Context) (scratchpad.State, error)
	ListConflicts(context.Context, scratchpad.ConflictFilter) ([]scratchpad.Conflict, error)
	ResolveConflict(context.Context, scratchpad.ResolveCommand) (scratchpad.ResolveResult, error)
}

type UpdatePublisher interface {
	Publish(*protocol.UpdateEnvelope)
}

type API struct {
	service   ScratchpadService
	publisher UpdatePublisher
}

func NewAPI(service ScratchpadService, publishers ...UpdatePublisher) *API {
	api := &API{service: service}
	if len(publishers) != 0 {
		api.publisher = publishers[0]
	}
	return api
}

func (api *API) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/bootstrap", api.bootstrap)
	mux.HandleFunc("GET /api/v1/conflicts", api.conflicts)
	mux.HandleFunc("POST /api/v1/conflicts/{id}/resolve", api.resolveConflict)
}

func (api *API) bootstrap(response http.ResponseWriter, request *http.Request) {
	state, err := api.service.Bootstrap(request.Context())
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writePayload(response, http.StatusOK, "BootstrapResponse", stateResponse{
		Scratchpad: scratchpadResponseFrom(state.Scratchpad),
		Conflicts:  conflictResponsesFrom(state.Conflicts),
	})
}

func (api *API) conflicts(response http.ResponseWriter, request *http.Request) {
	filter := scratchpad.ConflictFilter{
		ClientID:  request.URL.Query().Get("clientId"),
		SessionID: request.URL.Query().Get("sessionId"),
	}
	conflicts, err := api.service.ListConflicts(request.Context(), filter)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writePayload(response, http.StatusOK, "ConflictListResponse", conflictResponsesFrom(conflicts))
}

func (api *API) resolveConflict(response http.ResponseWriter, request *http.Request) {
	var input protocol.ResolveRequest
	if err := decodeJSON(response, request, &input); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(response, http.StatusRequestEntityTooLarge, "request_too_large", "request body is too large")
			return
		}
		writeError(response, http.StatusBadRequest, "invalid_message", "request body is invalid")
		return
	}
	result, err := api.service.ResolveConflict(request.Context(), scratchpad.ResolveCommand{
		ConflictID: request.PathValue("id"), Content: input.Content, BaseRevision: input.BaseRevision,
	})
	if err != nil {
		writeServiceError(response, err)
		return
	}
	if api.publisher != nil {
		api.publisher.Publish(&protocol.UpdateEnvelope{
			V: protocol.Version, Type: "update", Scratchpad: protocol.ScratchpadState{
				ID: result.Scratchpad.ID, Content: result.Scratchpad.Content, Revision: result.Scratchpad.Revision, UpdatedAt: formatTime(result.Scratchpad.UpdatedAt),
			}, MutationID: request.PathValue("id"),
		})
	}
	slog.Info("conflict resolved", "request_id", response.Header().Get("X-Request-ID"), "revision", result.Scratchpad.Revision)
	writePayload(response, http.StatusOK, "ResolveResponse", scratchpadResponseFrom(result.Scratchpad))
}

func decodeJSON(response http.ResponseWriter, request *http.Request, target any) error {
	request.Body = http.MaxBytesReader(response, request.Body, maxJSONBodyBytes)
	data, err := io.ReadAll(request.Body)
	if err != nil {
		return err
	}
	if err := protocol.ValidateJSON("ResolveRequest", data); err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func writeServiceError(response http.ResponseWriter, err error) {
	code := scratchpad.ErrorCodeOf(err)
	status := http.StatusInternalServerError
	message := scratchpad.PublicMessage(code)
	switch code {
	case scratchpad.ErrorContentTooLarge:
		status = http.StatusRequestEntityTooLarge
	case scratchpad.ErrorStaleRevision, scratchpad.ErrorUnresolvedConflict, scratchpad.ErrorMutationMismatch:
		status = http.StatusConflict
	case scratchpad.ErrorInvalidState:
		status = http.StatusBadRequest
	case scratchpad.ErrorStorageUnavailable:
		status = http.StatusServiceUnavailable
	}

	writeError(response, status, string(code), message)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	id := response.Header().Get("X-Request-ID")
	if id == "" {
		id = rand.Text()
		response.Header().Set("X-Request-ID", id)
	}
	response.Header().Del("Content-Length")
	body := protocol.HttpErrorResponse{Error: protocol.HttpError{Status: status, Code: protocol.ErrorCode(code), Message: message, RequestID: id}}
	if code == "invalid_message" {
		body.Error.Issues = []protocol.ValidationIssue{{Path: "/", Message: "request body must match the endpoint contract"}}
	}
	if err := protocol.ValidatePayload("HttpErrorResponse", body); err != nil {
		body.Error = protocol.HttpError{Status: http.StatusInternalServerError, Code: protocol.ErrorInternal, Message: "request could not be completed", RequestID: id}
		status = http.StatusInternalServerError
	}
	if writer, ok := response.(*boundaryWriter); ok {
		writer.failureCode = string(body.Error.Code)
	}
	writeJSON(response, status, body)
}

type scratchpadResponse = protocol.ScratchpadState
type conflictResponse = protocol.ConflictRecord
type stateResponse = protocol.BootstrapResponse

func scratchpadResponseFrom(value scratchpad.Scratchpad) scratchpadResponse {
	return scratchpadResponse{ID: value.ID, Content: value.Content, Revision: value.Revision, UpdatedAt: formatTime(value.UpdatedAt)}
}

func conflictResponsesFrom(values []scratchpad.Conflict) []conflictResponse {
	result := make([]conflictResponse, 0, len(values))
	for _, value := range values {
		result = append(result, conflictResponse{
			ConflictID: value.ID, ScratchpadID: value.ScratchpadID, MutationID: value.MutationID,
			SubmittedContent: value.SubmittedContent, BaseRevision: value.BaseRevision,
			ServerContent: value.ServerContent, ServerRevision: value.ServerRevision,
			ClientID: value.ClientID, SessionID: value.SessionID, CreatedAt: formatTime(value.CreatedAt),
		})
	}
	return result
}

func formatTime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

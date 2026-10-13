package httptransport

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Muatasim-Aswad/jotter/apps/server/internal/protocol"
	"github.com/Muatasim-Aswad/jotter/apps/server/internal/scratchpad"
	"github.com/Muatasim-Aswad/jotter/apps/server/internal/transport"
)

func TestBoundaryCorrelatesAndSanitizesFailures(t *testing.T) {
	for _, kind := range []string{"routing", "method", "panic", "storage", "unexpected"} {
		t.Run(kind, func(t *testing.T) {
			var logs bytes.Buffer
			original := slog.Default()
			slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
			t.Cleanup(func() { slog.SetDefault(original) })
			mux := http.NewServeMux()
			var contextID string
			mux.HandleFunc("GET /api/test", func(response http.ResponseWriter, request *http.Request) {
				contextID = transport.RequestID(request.Context())
				switch kind {
				case "panic":
					panic("private document text")
				case "storage":
					writeServiceError(response, &scratchpad.Error{Code: scratchpad.ErrorStorageUnavailable, Cause: errors.New("private document text")})
				case "unexpected":
					writeServiceError(response, errors.New("private document text"))
				}
			})
			method, path := http.MethodGet, "/api/test"
			if kind == "method" {
				method = http.MethodPost
			}
			if kind == "routing" {
				path = "/missing"
			}
			request := httptest.NewRequest(method, path, nil)
			request.Header.Set("X-Request-ID", "private injected value")
			response := httptest.NewRecorder()
			Boundary(mux).ServeHTTP(response, request)
			var body protocol.HttpErrorResponse
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			id := response.Header().Get("X-Request-ID")
			if id == "" || body.Error.RequestID != id || body.Error.Status != response.Code {
				t.Fatalf("uncorrelated response: %#v", body)
			}
			if contextID != "" && contextID != id {
				t.Fatal("context ID differs")
			}
			if err := protocol.ValidateJSON("HttpErrorResponse", response.Body.Bytes()); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(response.Body.String()+logs.String(), "private") {
				t.Fatal("private values leaked")
			}
			if strings.Count(logs.String(), "request failed") != 1 || !strings.Contains(logs.String(), id) {
				t.Fatalf("failure was not logged once: %s", logs.String())
			}
		})
	}
}

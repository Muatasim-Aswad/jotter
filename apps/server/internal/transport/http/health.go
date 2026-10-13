package httptransport

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/Muatasim-Aswad/jotter/apps/server/internal/protocol"
)

type Health struct {
	ready atomic.Bool
	probe func(context.Context) error
}

func NewHealth(probes ...func(context.Context) error) *Health {
	health := &Health{}
	if len(probes) != 0 {
		health.probe = probes[0]
	}
	return health
}

func (health *Health) SetReady(ready bool) { health.ready.Store(ready) }

func (health *Health) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /health/live", jsonStatus(http.StatusOK, "live"))
	mux.HandleFunc("GET /health/ready", func(response http.ResponseWriter, request *http.Request) {
		ready := health.ready.Load()
		if ready && health.probe != nil {
			ctx, cancel := context.WithTimeout(request.Context(), time.Second)
			defer cancel()
			ready = health.probe(ctx) == nil
		}
		if !ready {
			writePayload(response, http.StatusServiceUnavailable, "HealthResponse", protocol.HealthResponse{Status: "starting"})
			return
		}
		writePayload(response, http.StatusOK, "HealthResponse", protocol.HealthResponse{Status: "ready"})
	})
}

func jsonStatus(status int, value string) http.HandlerFunc {
	return func(response http.ResponseWriter, _ *http.Request) {
		writePayload(response, status, "HealthResponse", protocol.HealthResponse{Status: value})
	}
}

func writePayload(response http.ResponseWriter, status int, name string, body any) {
	if err := protocol.ValidatePayload(name, body); err != nil {
		writeError(response, http.StatusInternalServerError, "internal_error", "response could not be encoded")
		return
	}
	writeJSON(response, status, body)
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}

package httptransport

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReadinessTracksDatabaseDependency(t *testing.T) {
	available := true
	health := NewHealth(func(context.Context) error {
		if !available {
			return errors.New("database closed")
		}
		return nil
	})
	health.SetReady(true)
	mux := http.NewServeMux()
	health.Register(mux)
	assertStatus(t, mux, "/health/ready", http.StatusOK)
	available = false
	assertStatus(t, mux, "/health/ready", http.StatusServiceUnavailable)
	assertStatus(t, mux, "/health/live", http.StatusOK)
}

func TestHealthEndpoints(t *testing.T) {
	health := NewHealth()
	mux := http.NewServeMux()
	health.Register(mux)

	assertStatus(t, mux, "/health/live", http.StatusOK)
	assertStatus(t, mux, "/health/ready", http.StatusServiceUnavailable)
	health.SetReady(true)
	assertStatus(t, mux, "/health/ready", http.StatusOK)
}

func assertStatus(t *testing.T, handler http.Handler, path string, want int) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != want {
		t.Fatalf("%s status = %d, want %d", path, response.Code, want)
	}
}

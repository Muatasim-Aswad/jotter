package httptransport

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestSecurityRejectsUnexpectedHost(t *testing.T) {
	handler, err := Security("https://jotter.example", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("unexpected host reached application") }))
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "https://attacker.example/", nil))
	if response.Code != http.StatusForbidden || strings.Contains(response.Body.String(), "attacker.example") {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestSecurityBoundsWorkBeforeCallingApplication(t *testing.T) {
	for _, path := range []string{"/api/v1/bootstrap", "/ws"} {
		t.Run(path, func(t *testing.T) {
			capacity := 32
			if path == "/ws" {
				capacity = 16
			}
			entered := make(chan struct{}, capacity)
			release := make(chan struct{})
			handler, err := Security("https://jotter.example", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { entered <- struct{}{}; <-release }))
			if err != nil {
				t.Fatal(err)
			}
			var workers sync.WaitGroup
			for range capacity {
				workers.Go(func() {
					handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "http://127.0.0.1"+path, nil))
				})
				<-entered
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://127.0.0.1"+path, nil))
			close(release)
			workers.Wait()
			if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") != "1" {
				t.Fatalf("capacity response = %d", response.Code)
			}
		})
	}
}

func TestSecurityAppliesHeadersAndAllowsConfiguredOrigin(t *testing.T) {
	handler, err := Security("https://jotter.example", http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	}))
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/v1/conflicts/id/resolve", strings.NewReader("{}"))
	request.Header.Set("Origin", "https://jotter.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d", response.Code)
	}
	for _, name := range []string{"Content-Security-Policy", "Cross-Origin-Opener-Policy", "Cross-Origin-Resource-Policy", "Permissions-Policy", "Referrer-Policy", "Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options"} {
		if response.Header().Get(name) == "" {
			t.Errorf("missing %s", name)
		}
	}
	if strings.Contains(response.Header().Get("Content-Security-Policy"), "https:") {
		t.Fatalf("CSP permits an external scheme: %q", response.Header().Get("Content-Security-Policy"))
	}
}

func TestSecurityRejectsUnexpectedOriginWithoutCallingApplication(t *testing.T) {
	called := false
	handler, err := Security("https://jotter.example", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/v1/bootstrap", nil)
	request.Header.Set("Origin", "https://attacker.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || called {
		t.Fatalf("status/called = %d/%v", response.Code, called)
	}
	if strings.Contains(response.Body.String(), "attacker.example") {
		t.Fatalf("error reflected origin: %s", response.Body.String())
	}
}

func TestSecurityRejectsDeclaredOversizedRequest(t *testing.T) {
	handler, err := Security("http://localhost:5173", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("application received oversized request")
	}))
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/v1/conflicts/id/resolve", strings.NewReader("{}"))
	request.ContentLength = maxJSONBodyBytes + 1
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d", response.Code)
	}
}

func TestSecurityOmitsHSTSForDevelopmentHTTP(t *testing.T) {
	handler, err := Security("http://localhost:5173", http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {}))
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://127.0.0.1/", nil))
	if response.Header().Get("Strict-Transport-Security") != "" {
		t.Fatal("development response enabled HSTS")
	}
}

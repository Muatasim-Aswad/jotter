package webassets

import (
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestIdentityAndUncachedVersion(t *testing.T) {
	assets := fstest.MapFS{"version.json": {Data: []byte(`{"version":"1.0.0","revision":"dev","committedAt":null,"builtAt":"2026-10-13T00:00:00Z"}`)}}
	identity, err := Identity(assets)
	if err != nil || *identity.Version != "1.0.0" || identity.Revision != "dev" {
		t.Fatalf("identity: %+v, %v", identity, err)
	}
	for _, method := range []string{"GET", "HEAD"} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(method, "/version.json?check=1", nil)
		Handler(assets).ServeHTTP(response, request)
		if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("uncached identity: %+v", response.Result())
		}
	}
}

func TestIdentityRejectsMissingAndIncompleteMetadata(t *testing.T) {
	for _, assets := range []fstest.MapFS{{}, {"version.json": {Data: []byte(`{}`)}}, {"version.json": {Data: []byte(`invalid`)}}} {
		if _, err := Identity(assets); err == nil {
			t.Fatal("invalid identity accepted")
		}
	}
}

package config

import (
	"strings"
	"testing"
)

func TestDevelopmentDefaultsAreLoopbackSafe(t *testing.T) {
	config, err := Load(mapLookup(nil))
	if err != nil {
		t.Fatal(err)
	}
	if config.ListenAddr != "127.0.0.1:8080" {
		t.Fatalf("ListenAddr = %q", config.ListenAddr)
	}
	if config.PublicOrigin != "http://127.0.0.1:5173" {
		t.Fatalf("PublicOrigin = %q", config.PublicOrigin)
	}
	if config.AuthDisabled {
		t.Fatal("development must not claim AUTH_DISABLED was explicit")
	}
}

func TestProductionRequiresExplicitAuthDisableAndHTTPSOrigin(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"missing public origin", map[string]string{"JOTTER_ENV": "production", "AUTH_DISABLED": "true"}, "JOTTER_PUBLIC_ORIGIN"},
		{"missing auth flag", map[string]string{"JOTTER_ENV": "production", "JOTTER_PUBLIC_ORIGIN": "https://jotter.example"}, "AUTH_DISABLED=true"},
		{"non-explicit auth flag", map[string]string{"JOTTER_ENV": "production", "JOTTER_PUBLIC_ORIGIN": "https://jotter.example", "AUTH_DISABLED": "TRUE"}, "AUTH_DISABLED=true"},
		{"insecure origin", map[string]string{"JOTTER_ENV": "production", "JOTTER_PUBLIC_ORIGIN": "http://jotter.example", "AUTH_DISABLED": "true"}, "must use HTTPS"},
		{"origin with path", map[string]string{"JOTTER_ENV": "production", "JOTTER_PUBLIC_ORIGIN": "https://jotter.example/app", "AUTH_DISABLED": "true"}, "without a path"},
		{"origin with credentials", map[string]string{"JOTTER_ENV": "production", "JOTTER_PUBLIC_ORIGIN": "https://user@jotter.example", "AUTH_DISABLED": "true"}, "without a path"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := Load(mapLookup(testCase.env))
			if err == nil || !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("Load() error = %v, want %q", err, testCase.want)
			}
		})
	}
}

func TestProductionAcceptsExplicitBoundaryDelegation(t *testing.T) {
	config, err := Load(mapLookup(map[string]string{"JOTTER_ENV": "production", "JOTTER_PUBLIC_ORIGIN": "https://jotter.example", "AUTH_DISABLED": "true"}))
	if err != nil {
		t.Fatal(err)
	}
	if !config.AuthDisabled {
		t.Fatal("AuthDisabled = false")
	}
}

func mapLookup(values map[string]string) LookupEnv {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

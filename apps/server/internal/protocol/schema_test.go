package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSharedHTTPFixtures(t *testing.T) {
	type fixture struct {
		Name   string
		Schema string
		Input  json.RawMessage
	}
	var cases struct {
		Valid   []fixture
		Invalid []fixture
	}
	readFixture(t, "http.json", &cases)
	for _, f := range cases.Valid {
		t.Run("valid/"+f.Name, func(t *testing.T) {
			if err := ValidateJSON(f.Schema, f.Input); err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, f := range cases.Invalid {
		t.Run("invalid/"+f.Name, func(t *testing.T) {
			if err := ValidateJSON(f.Schema, f.Input); err == nil {
				t.Fatal("invalid HTTP contract accepted")
			}
		})
	}
}

func TestHTTPContentUsesNormalizedUTF8ByteLimit(t *testing.T) {
	for _, text := range []string{strings.Repeat("é", MaxContentBytes/2+1), strings.Repeat("😀", MaxContentBytes/4+1)} {
		if err := ValidatePayload("ResolveRequest", ResolveRequest{Content: text}); err == nil {
			t.Fatal("oversized multibyte content accepted")
		}
	}
	if err := ValidatePayload("ResolveRequest", ResolveRequest{Content: strings.Repeat("\r\n", MaxContentBytes)}); err != nil {
		t.Fatal(err)
	}
}

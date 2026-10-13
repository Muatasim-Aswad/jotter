package protocol

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type envelopeFixture struct {
	Name     string          `json:"name"`
	Error    ErrorCode       `json:"error"`
	Input    json.RawMessage `json:"input"`
	Expected json.RawMessage `json:"expected"`
}

func TestSharedEnvelopeFixtures(t *testing.T) {
	var fixtures struct {
		Valid   []envelopeFixture `json:"valid"`
		Invalid []envelopeFixture `json:"invalid"`
	}
	readFixture(t, "envelopes.json", &fixtures)

	for _, fixture := range fixtures.Valid {
		t.Run("valid/"+fixture.Name, func(t *testing.T) {
			envelope, err := Decode(fixture.Input)
			if err != nil {
				t.Fatalf("Decode() error = %v", err)
			}
			encoded, err := Encode(envelope)
			if err != nil {
				t.Fatalf("Encode() error = %v", err)
			}
			if _, err := Decode(encoded); err != nil {
				t.Fatalf("encoded envelope rejected: %v", err)
			}
			if len(fixture.Expected) > 0 && !jsonEqual(encoded, fixture.Expected) {
				t.Fatalf("encoded = %s, want %s", encoded, fixture.Expected)
			}
		})
	}

	for _, fixture := range fixtures.Invalid {
		t.Run("invalid/"+fixture.Name, func(t *testing.T) {
			_, err := Decode(fixture.Input)
			var codecErr *CodecError
			if !errors.As(err, &codecErr) {
				t.Fatalf("Decode() error = %v, want CodecError", err)
			}
			if codecErr.Code != fixture.Error {
				t.Fatalf("error code = %q, want %q", codecErr.Code, fixture.Error)
			}
		})
	}
}

func TestSharedUTF8SizeFixtures(t *testing.T) {
	var fixture struct {
		Cases []struct {
			Name   string `json:"name"`
			Value  string `json:"value"`
			Repeat int    `json:"repeat"`
			Valid  bool   `json:"valid"`
		} `json:"cases"`
	}
	readFixture(t, "content-size.json", &fixture)

	for _, testCase := range fixture.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			_, err := Encode(&SaveEnvelope{V: 1, Type: "save", ScratchpadID: "scratchpad-1", Content: strings.Repeat(testCase.Value, testCase.Repeat), ClientID: "client-1", SessionID: "session-1", MutationID: "mutation-1"})
			if testCase.Valid && err != nil {
				t.Fatalf("Encode() error = %v", err)
			}
			if !testCase.Valid {
				var codecErr *CodecError
				if !errors.As(err, &codecErr) || codecErr.Code != ErrorContentTooLarge {
					t.Fatalf("Encode() error = %v, want content_too_large", err)
				}
			}
		})
	}
}

func readFixture(t *testing.T, name string, target any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "protocol", "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, target); err != nil {
		t.Fatal(err)
	}
}

func jsonEqual(a, b []byte) bool {
	var left, right any
	return json.Unmarshal(a, &left) == nil && json.Unmarshal(b, &right) == nil && equalJSON(left, right)
}

func equalJSON(left, right any) bool {
	a, _ := json.Marshal(left)
	b, _ := json.Marshal(right)
	return string(a) == string(b)
}

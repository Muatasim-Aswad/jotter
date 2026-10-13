package scratchpad

import (
	"strings"
	"testing"
)

func TestNormalizeContent(t *testing.T) {
	content, err := NormalizeContent("one\r\ntwo\rthree\n")
	if err != nil {
		t.Fatal(err)
	}
	if content != "one\ntwo\nthree\n" {
		t.Fatalf("NormalizeContent() = %q", content)
	}
}

func TestNormalizeContentUTF8Boundary(t *testing.T) {
	if _, err := NormalizeContent(strings.Repeat("😀", MaxContentBytes/4)); err != nil {
		t.Fatalf("content at limit: %v", err)
	}
	_, err := NormalizeContent(strings.Repeat("😀", MaxContentBytes/4+1))
	if ErrorCodeOf(err) != ErrorContentTooLarge {
		t.Fatalf("over-limit error = %v", err)
	}
}

func TestNormalizeContentPreservesWhitespace(t *testing.T) {
	want := "  leading\ntrailing  \n\n"
	got, err := NormalizeContent(want)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("NormalizeContent() = %q, want %q", got, want)
	}
}

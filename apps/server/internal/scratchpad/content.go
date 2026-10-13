package scratchpad

import (
	"strings"
	"unicode/utf8"
)

func NormalizeContent(content string) (string, error) {
	if !utf8.ValidString(content) {
		return "", &Error{Code: ErrorInvalidState, Message: "content must be valid UTF-8"}
	}
	normalized := strings.ReplaceAll(strings.ReplaceAll(content, "\r\n", "\n"), "\r", "\n")
	if len(normalized) > MaxContentBytes {
		return "", &Error{Code: ErrorContentTooLarge, Message: "content exceeds the 1 MiB UTF-8 limit"}
	}
	return normalized, nil
}

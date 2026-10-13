package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode/utf8"
)

type CodecError struct {
	Code ErrorCode
	Msg  string
}

func (e *CodecError) Error() string { return e.Msg }

func Decode(data []byte) (Envelope, error) {
	var header struct {
		V    int    `json:"v"`
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &header); err != nil {
		return nil, codecError(ErrorInvalidMessage, "message must be valid JSON")
	}
	if header.V != Version {
		return nil, codecError(ErrorUnsupportedVersion, "protocol version is unsupported")
	}

	var envelope Envelope
	switch header.Type {
	case "hello":
		envelope = &HelloEnvelope{}
	case "state":
		envelope = &StateEnvelope{}
	case "save":
		envelope = &SaveEnvelope{}
	case "ack":
		envelope = &AckEnvelope{}
	case "update":
		envelope = &UpdateEnvelope{}
	case "conflict":
		envelope = &ConflictEnvelope{}
	case "error":
		envelope = &ErrorEnvelope{}
	default:
		return nil, codecError(ErrorInvalidMessage, "message type is unsupported")
	}

	if err := ValidateJSON("Envelope", data); err != nil {
		var codec *CodecError
		if errors.As(err, &codec) {
			return nil, codec
		}
		return nil, codecError(ErrorInvalidMessage, "message shape is invalid")
	}
	if err := decodeStrict(data, envelope); err != nil {
		return nil, codecError(ErrorInvalidMessage, "message shape is invalid")
	}
	if err := validate(envelope); err != nil {
		return nil, err
	}
	return envelope, nil
}

func Encode(envelope Envelope) ([]byte, error) {
	if envelope == nil {
		return nil, codecError(ErrorInvalidMessage, "message is required")
	}
	if err := validate(envelope); err != nil {
		return nil, err
	}
	data, err := json.Marshal(envelope)
	if err != nil {
		return nil, err
	}
	if err := ValidateJSON("Envelope", data); err != nil {
		return nil, codecError(ErrorInvalidMessage, "message shape is invalid")
	}
	return data, nil
}

func decodeStrict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("message must contain one JSON object")
	}
	return nil
}

func validate(envelope Envelope) error {
	switch value := envelope.(type) {
	case *HelloEnvelope:
		if err := base(value.V, value.Type, "hello"); err != nil {
			return err
		}
		if err := IDs(value.ScratchpadID, value.ClientID, value.SessionID); err != nil {
			return err
		}
		if err := revision(value.KnownRevision); err != nil {
			return err
		}
		for _, mutationID := range value.PendingMutationIDs {
			if err := ID(mutationID); err != nil {
				return err
			}
		}
	case *StateEnvelope:
		if err := base(value.V, value.Type, "state"); err != nil {
			return err
		}
		if err := scratchpad(&value.Scratchpad); err != nil {
			return err
		}
		for i := range value.Conflicts {
			if err := conflict(&value.Conflicts[i]); err != nil {
				return err
			}
		}
	case *SaveEnvelope:
		if err := base(value.V, value.Type, "save"); err != nil {
			return err
		}
		if err := IDs(value.ScratchpadID, value.ClientID, value.SessionID, value.MutationID); err != nil {
			return err
		}
		if err := revision(value.BaseRevision); err != nil {
			return err
		}
		normalized, err := normalizeAndCheckContent(value.Content)
		if err != nil {
			return err
		}
		value.Content = normalized
	case *AckEnvelope:
		if err := base(value.V, value.Type, "ack"); err != nil {
			return err
		}
		if err := IDs(value.ScratchpadID, value.MutationID); err != nil {
			return err
		}
		if err := revision(value.Revision); err != nil {
			return err
		}
		if err := timestamp(value.UpdatedAt); err != nil {
			return err
		}
	case *UpdateEnvelope:
		if err := base(value.V, value.Type, "update"); err != nil {
			return err
		}
		if err := scratchpad(&value.Scratchpad); err != nil {
			return err
		}
		if err := ID(value.MutationID); err != nil {
			return err
		}
	case *ConflictEnvelope:
		if err := base(value.V, value.Type, "conflict"); err != nil {
			return err
		}
		if err := conflict(&value.ConflictRecord); err != nil {
			return err
		}
	case *ErrorEnvelope:
		if err := base(value.V, value.Type, "error"); err != nil {
			return err
		}
		if !validErrorCode(value.Code) {
			return codecError(ErrorInvalidMessage, "error code is unsupported")
		}
		if value.Message == "" {
			return codecError(ErrorInvalidMessage, "error message is required")
		}
		if value.MutationID != nil {
			if err := ID(*value.MutationID); err != nil {
				return err
			}
		}
		if value.RetryAfterMS != nil {
			if err := revision(*value.RetryAfterMS); err != nil {
				return err
			}
		}
	default:
		return codecError(ErrorInvalidMessage, "message type is unsupported")
	}
	return nil
}

func base(version int, actual, expected string) error {
	if version != Version {
		return codecError(ErrorUnsupportedVersion, "protocol version is unsupported")
	}
	if actual != expected {
		return codecError(ErrorInvalidMessage, "message type does not match envelope")
	}
	return nil
}

func IDs(values ...string) error {
	for _, value := range values {
		if err := ID(value); err != nil {
			return err
		}
	}
	return nil
}

func ID(value string) error {
	if len(value) == 0 || len(value) > MaxIdentifierBytes || !utf8.ValidString(value) {
		return codecError(ErrorInvalidMessage, "identifier must contain 1 to 128 UTF-8 bytes")
	}
	return nil
}

func revision(value int64) error {
	if value < 0 || value > MaxRevision {
		return codecError(ErrorInvalidMessage, "revision must be a non-negative safe integer")
	}
	return nil
}

func scratchpad(value *ScratchpadState) error {
	if err := ID(value.ID); err != nil {
		return err
	}
	if err := revision(value.Revision); err != nil {
		return err
	}
	if err := timestamp(value.UpdatedAt); err != nil {
		return err
	}
	normalized, err := normalizeAndCheckContent(value.Content)
	if err != nil {
		return err
	}
	value.Content = normalized
	return nil
}

func conflict(value *ConflictRecord) error {
	if err := IDs(value.ConflictID, value.ScratchpadID, value.MutationID, value.ClientID, value.SessionID); err != nil {
		return err
	}
	if err := revision(value.BaseRevision); err != nil {
		return err
	}
	if err := revision(value.ServerRevision); err != nil {
		return err
	}
	if err := timestamp(value.CreatedAt); err != nil {
		return err
	}
	local, err := normalizeAndCheckContent(value.SubmittedContent)
	if err != nil {
		return err
	}
	server, err := normalizeAndCheckContent(value.ServerContent)
	if err != nil {
		return err
	}
	value.SubmittedContent, value.ServerContent = local, server
	return nil
}

func normalizeAndCheckContent(value string) (string, error) {
	if !utf8.ValidString(value) {
		return "", codecError(ErrorInvalidMessage, "content must be valid UTF-8")
	}
	value = strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
	if len(value) > MaxContentBytes {
		return "", codecError(ErrorContentTooLarge, fmt.Sprintf("content exceeds %d UTF-8 bytes", MaxContentBytes))
	}
	return value, nil
}

func timestamp(value string) error {
	if !strings.HasSuffix(value, "Z") {
		return codecError(ErrorInvalidMessage, "timestamp must be UTC RFC 3339")
	}
	if _, err := time.Parse(time.RFC3339Nano, value); err != nil {
		return codecError(ErrorInvalidMessage, "timestamp must be UTC RFC 3339")
	}
	return nil
}

func codecError(code ErrorCode, message string) error {
	return &CodecError{Code: code, Msg: message}
}

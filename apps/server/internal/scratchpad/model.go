package scratchpad

import (
	"errors"
	"time"
)

const (
	MaxContentBytes = 1_048_576
	MaxRevision     = int64(9_007_199_254_740_991)
)

type Scratchpad struct {
	ID        string
	Content   string
	Revision  int64
	CreatedAt time.Time
	UpdatedAt time.Time
}

type Conflict struct {
	ID               string
	ScratchpadID     string
	MutationID       string
	SubmittedContent string
	BaseRevision     int64
	ServerContent    string
	ServerRevision   int64
	ClientID         string
	SessionID        string
	CreatedAt        time.Time
}

type MutationReceipt struct {
	ScratchpadID     string
	MutationID       string
	AcceptedRevision int64
	CreatedAt        time.Time
}

type State struct {
	Scratchpad Scratchpad
	Conflicts  []Conflict
}

type SaveCommand struct {
	ScratchpadID string
	Content      string
	BaseRevision int64
	ClientID     string
	SessionID    string
	MutationID   string
}

type SaveKind string

const (
	SaveAccepted   SaveKind = "accepted"
	SaveConflicted SaveKind = "conflicted"
)

type SaveResult struct {
	Kind       SaveKind
	Receipt    *MutationReceipt
	Conflict   *Conflict
	Scratchpad *Scratchpad
}

type ConflictFilter struct {
	ClientID  string
	SessionID string
}

type ResolveCommand struct {
	ConflictID   string
	Content      string
	BaseRevision int64
}

type ResolveResult struct {
	Scratchpad Scratchpad
}

type ErrorCode string

const (
	ErrorStaleRevision      ErrorCode = "stale_revision"
	ErrorContentTooLarge    ErrorCode = "content_too_large"
	ErrorUnresolvedConflict ErrorCode = "unresolved_conflict"
	ErrorInvalidState       ErrorCode = "invalid_state"
	ErrorMutationMismatch   ErrorCode = "mutation_mismatch"
	ErrorInternal           ErrorCode = "internal_error"
	ErrorStorageUnavailable ErrorCode = "storage_unavailable"
)

type Error struct {
	Code    ErrorCode
	Message string
	Cause   error
}

func (err *Error) Error() string { return err.Message }

func (err *Error) Unwrap() error { return err.Cause }

var publicMessages = map[ErrorCode]string{
	ErrorStaleRevision:      "scratchpad revision changed",
	ErrorContentTooLarge:    "content exceeds the 1 MiB UTF-8 limit",
	ErrorUnresolvedConflict: "client has an unresolved conflict",
	ErrorInvalidState:       "request state is invalid",
	ErrorMutationMismatch:   "mutation identity does not match the original request",
	ErrorStorageUnavailable: "storage unavailable",
	ErrorInternal:           "request could not be completed",
}

func PublicMessage(code ErrorCode) string {
	if message, ok := publicMessages[code]; ok {
		return message
	}
	return publicMessages[ErrorInternal]
}

func ErrorCodeOf(err error) ErrorCode {
	var application *Error
	if errors.As(err, &application) {
		if _, ok := publicMessages[application.Code]; ok {
			return application.Code
		}
	}
	return ErrorInternal
}

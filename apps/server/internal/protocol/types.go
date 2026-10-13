// Generated from packages/protocol/openapi.json. Do not edit.
package protocol

const (
	Version            = 1
	MaxContentBytes    = 1048576
	MaxRevision        = int64(9007199254740991)
	MaxIdentifierBytes = 128
)

type Identifier = string

type Content = string

type Revision = int64

type Timestamp = string

type ErrorCode string

const (
	ErrorStaleRevision      ErrorCode = "stale_revision"
	ErrorContentTooLarge    ErrorCode = "content_too_large"
	ErrorUnresolvedConflict ErrorCode = "unresolved_conflict"
	ErrorInvalidState       ErrorCode = "invalid_state"
	ErrorMutationMismatch   ErrorCode = "mutation_mismatch"
	ErrorStorageUnavailable ErrorCode = "storage_unavailable"
	ErrorInvalidMessage     ErrorCode = "invalid_message"
	ErrorUnsupportedVersion ErrorCode = "unsupported_version"
	ErrorInternal           ErrorCode = "internal_error"
	ErrorNotFound           ErrorCode = "not_found"
	ErrorMethodNotAllowed   ErrorCode = "method_not_allowed"
	ErrorInvalidOrigin      ErrorCode = "invalid_origin"
	ErrorRequestTooLarge    ErrorCode = "request_too_large"
	ErrorTooManyRequests    ErrorCode = "too_many_requests"
)

func validErrorCode(value ErrorCode) bool {
	switch value {
	case ErrorStaleRevision, ErrorContentTooLarge, ErrorUnresolvedConflict, ErrorInvalidState, ErrorMutationMismatch, ErrorStorageUnavailable, ErrorInvalidMessage, ErrorUnsupportedVersion, ErrorInternal, ErrorNotFound, ErrorMethodNotAllowed, ErrorInvalidOrigin, ErrorRequestTooLarge, ErrorTooManyRequests:
		return true
	}
	return false
}

type ScratchpadState struct {
	ID        Identifier `json:"id"`
	Content   Content    `json:"content"`
	Revision  Revision   `json:"revision"`
	UpdatedAt Timestamp  `json:"updatedAt"`
}

type ConflictRecord struct {
	ConflictID       Identifier `json:"conflictId"`
	ScratchpadID     Identifier `json:"scratchpadId"`
	MutationID       Identifier `json:"mutationId"`
	SubmittedContent Content    `json:"submittedContent"`
	BaseRevision     Revision   `json:"baseRevision"`
	ServerContent    Content    `json:"serverContent"`
	ServerRevision   Revision   `json:"serverRevision"`
	ClientID         Identifier `json:"clientId"`
	SessionID        Identifier `json:"sessionId"`
	CreatedAt        Timestamp  `json:"createdAt"`
}

type HelloEnvelope struct {
	V                  int          `json:"v"`
	Type               string       `json:"type"`
	ScratchpadID       Identifier   `json:"scratchpadId"`
	ClientID           Identifier   `json:"clientId"`
	SessionID          Identifier   `json:"sessionId"`
	KnownRevision      Revision     `json:"knownRevision"`
	PendingMutationIDs []Identifier `json:"pendingMutationIds"`
}

func (*HelloEnvelope) isEnvelope() {}

type StateEnvelope struct {
	V          int              `json:"v"`
	Type       string           `json:"type"`
	Scratchpad ScratchpadState  `json:"scratchpad"`
	Conflicts  []ConflictRecord `json:"conflicts,omitempty"`
}

func (*StateEnvelope) isEnvelope() {}

type SaveEnvelope struct {
	V            int        `json:"v"`
	Type         string     `json:"type"`
	ScratchpadID Identifier `json:"scratchpadId"`
	Content      Content    `json:"content"`
	BaseRevision Revision   `json:"baseRevision"`
	ClientID     Identifier `json:"clientId"`
	SessionID    Identifier `json:"sessionId"`
	MutationID   Identifier `json:"mutationId"`
}

func (*SaveEnvelope) isEnvelope() {}

type AckEnvelope struct {
	V            int        `json:"v"`
	Type         string     `json:"type"`
	ScratchpadID Identifier `json:"scratchpadId"`
	MutationID   Identifier `json:"mutationId"`
	Revision     Revision   `json:"revision"`
	UpdatedAt    Timestamp  `json:"updatedAt"`
}

func (*AckEnvelope) isEnvelope() {}

type UpdateEnvelope struct {
	V          int             `json:"v"`
	Type       string          `json:"type"`
	Scratchpad ScratchpadState `json:"scratchpad"`
	MutationID Identifier      `json:"mutationId"`
}

func (*UpdateEnvelope) isEnvelope() {}

type ConflictEnvelope struct {
	ConflictRecord
	V    int    `json:"v"`
	Type string `json:"type"`
}

func (*ConflictEnvelope) isEnvelope() {}

type ErrorEnvelope struct {
	V            int         `json:"v"`
	Type         string      `json:"type"`
	Code         ErrorCode   `json:"code"`
	Message      string      `json:"message"`
	MutationID   *Identifier `json:"mutationId,omitempty"`
	RetryAfterMS *Revision   `json:"retryAfterMs,omitempty"`
}

func (*ErrorEnvelope) isEnvelope() {}

type Envelope interface{ isEnvelope() }

type BootstrapResponse struct {
	Scratchpad ScratchpadState  `json:"scratchpad"`
	Conflicts  []ConflictRecord `json:"conflicts"`
}

type ConflictListResponse = []ConflictRecord

type ResolveRequest struct {
	Content      Content  `json:"content"`
	BaseRevision Revision `json:"baseRevision"`
}

type ResolveResponse = ScratchpadState

type HealthResponse struct {
	Status string `json:"status"`
}

type ValidationIssue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

type HttpError struct {
	Status    int               `json:"status"`
	Code      ErrorCode         `json:"code"`
	Message   string            `json:"message"`
	RequestID Identifier        `json:"request_id"`
	Details   map[string]any    `json:"details,omitempty"`
	Issues    []ValidationIssue `json:"issues,omitempty"`
}

type HttpErrorResponse struct {
	Error HttpError `json:"error"`
}

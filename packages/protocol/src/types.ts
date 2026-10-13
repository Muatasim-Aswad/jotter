// Generated from packages/protocol/openapi.json. Do not edit.

export const PROTOCOL_VERSION = 1 as const;
export const MAX_CONTENT_BYTES = 1048576;
export const MAX_REVISION = 9007199254740991;
export const MAX_IDENTIFIER_BYTES = 128;
export const errorCodes = [
  "stale_revision",
  "content_too_large",
  "unresolved_conflict",
  "invalid_state",
  "mutation_mismatch",
  "storage_unavailable",
  "invalid_message",
  "unsupported_version",
  "internal_error",
  "not_found",
  "method_not_allowed",
  "invalid_origin",
  "request_too_large",
  "too_many_requests",
] as const;

export type Identifier = string;

export type Content = string;

export type Revision = number;

export type Timestamp = string;

export type ErrorCode = (typeof errorCodes)[number];

export interface ScratchpadState {
  id: Identifier;
  content: Content;
  revision: Revision;
  updatedAt: Timestamp;
}

export interface ConflictRecord {
  conflictId: Identifier;
  scratchpadId: Identifier;
  mutationId: Identifier;
  submittedContent: Content;
  baseRevision: Revision;
  serverContent: Content;
  serverRevision: Revision;
  clientId: Identifier;
  sessionId: Identifier;
  createdAt: Timestamp;
}

export interface HelloEnvelope {
  v: 1;
  type: "hello";
  scratchpadId: Identifier;
  clientId: Identifier;
  sessionId: Identifier;
  knownRevision: Revision;
  pendingMutationIds: Array<Identifier>;
}

export interface StateEnvelope {
  v: 1;
  type: "state";
  scratchpad: ScratchpadState;
  conflicts?: Array<ConflictRecord> | null;
}

export interface SaveEnvelope {
  v: 1;
  type: "save";
  scratchpadId: Identifier;
  content: Content;
  baseRevision: Revision;
  clientId: Identifier;
  sessionId: Identifier;
  mutationId: Identifier;
}

export interface AckEnvelope {
  v: 1;
  type: "ack";
  scratchpadId: Identifier;
  mutationId: Identifier;
  revision: Revision;
  updatedAt: Timestamp;
}

export interface UpdateEnvelope {
  v: 1;
  type: "update";
  scratchpad: ScratchpadState;
  mutationId: Identifier;
}

export interface ConflictEnvelope extends ConflictRecord {
  v: 1;
  type: "conflict";
}

export interface ErrorEnvelope {
  v: 1;
  type: "error";
  code: ErrorCode;
  message: string;
  mutationId?: Identifier | null;
  retryAfterMs?: Revision | null;
}

export type Envelope =
  | HelloEnvelope
  | StateEnvelope
  | SaveEnvelope
  | AckEnvelope
  | UpdateEnvelope
  | ConflictEnvelope
  | ErrorEnvelope;

export interface BootstrapResponse {
  scratchpad: ScratchpadState;
  conflicts: Array<ConflictRecord>;
}

export type ConflictListResponse = Array<ConflictRecord>;

export interface ResolveRequest {
  content: Content;
  baseRevision: Revision;
}

export type ResolveResponse = ScratchpadState;

export interface HealthResponse {
  status: "live" | "ready" | "starting";
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface HttpError {
  status: number;
  code: ErrorCode;
  message: string;
  request_id: Identifier;
  details?: Record<string, unknown>;
  issues?: Array<ValidationIssue>;
}

export interface HttpErrorResponse {
  error: HttpError;
}

export interface HttpPayloads {
  BootstrapResponse: BootstrapResponse;
  ConflictListResponse: ConflictListResponse;
  ResolveRequest: ResolveRequest;
  ResolveResponse: ResolveResponse;
  HealthResponse: HealthResponse;
  HttpErrorResponse: HttpErrorResponse;
}

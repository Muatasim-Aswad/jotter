# Jotter protocol v1

[openapi.json](openapi.json) is the authoritative HTTP and WebSocket contract. `mise run contracts:generate` produces Go/TypeScript types, the embedded server schema, and static browser validators; `mise run contracts:check` rejects drift. Both languages execute the shared HTTP, envelope, and content-size fixtures. The browser validators are compiled ahead of time to work under the same-origin CSP without dynamic evaluation.

## Encoding rules

- Every WebSocket message is one UTF-8 JSON object with `v: 1` and a discriminating `type`.
- Unknown, missing, or wrongly typed fields are rejected. Required string fields never accept `null`; fields explicitly marked optional may be omitted or `null` as specified below.
- Revisions are non-negative integers no larger than `9007199254740991` so Go and JavaScript represent them identically.
- Content is normalized from CRLF or CR to LF, then limited to 1,048,576 UTF-8 bytes. Empty content is valid.
- Identifiers are opaque, non-empty strings of at most 128 UTF-8 bytes. The server generates scratchpad IDs, revisions, and timestamps.
- Timestamps are UTC RFC 3339 strings. Transport errors contain stable codes and never document content.

## WebSocket envelopes

`hello` starts every connection and carries `scratchpadId`, `clientId`, `sessionId`, `knownRevision`, and the durable `pendingMutationIds`. The server answers with `state`, containing a `scratchpad` object and optional `conflicts`; `conflicts` may be omitted when not requested or explicitly `null` when unavailable. Decoders accept explicit `null` for nullable optional fields and serializers canonicalize it to omission.

`save` carries `scratchpadId`, complete `content`, `baseRevision`, `clientId`, `sessionId`, and `mutationId`. A committed save produces `ack` for the origin and `update` for other sessions. A stale save produces `conflict`, preserving both submitted and server content plus their revisions and origin identifiers.

`error` carries a stable `code`, a content-free `message`, and optional nullable `mutationId` and `retryAfterMs` fields. Stable codes are `stale_revision`, `content_too_large`, `unresolved_conflict`, `invalid_state`, `storage_unavailable`, `invalid_message`, `unsupported_version`, and `internal_error`.

## HTTP surface

All non-health API routes are versioned under `/api/v1`:

- `GET /api/v1/bootstrap` returns the singleton scratchpad and unresolved conflicts.
- `GET /api/v1/conflicts` returns unresolved conflicts relevant to the installation/session.
- `POST /api/v1/conflicts/{id}/resolve` submits complete chosen content and the latest observed server revision. Resolution is rejected if the server advanced.
- `GET /ws` upgrades to the versioned WebSocket protocol. There is no HTTP save fallback.
- `GET /health/live` reports process liveness. `GET /health/ready` reports whether startup completed and storage is ready.
- `POST /share` is reserved for the service worker's URL-encoded Android share target.

HTTP success and error bodies use JSON. Errors follow `HttpErrorResponse` in the OpenAPI contract.

## Compatibility

V1 rejects any protocol version other than `1`. Compatible additions require a new optional field; incompatible field or meaning changes require a new protocol version and parallel decoder support during migration.

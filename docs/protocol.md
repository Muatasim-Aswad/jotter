# Protocol

Jotter protocol version 1 uses strict UTF-8 JSON. [OpenAPI](../packages/protocol/openapi.json) defines the shared contract; Go and TypeScript types and validators are generated from it and tested against the same fixtures. Unknown fields, missing required fields, `null` required values, unsupported versions, unsafe revisions, invalid timestamps, and oversized or invalid UTF-8 content are rejected.

Content is complete plain text, not an operation stream. CRLF and CR normalize to LF; all other whitespace is preserved; empty content is valid; the limit is 1,048,576 encoded bytes. Revisions range from zero through JavaScript's maximum safe integer. Identifiers are opaque nonempty UTF-8 strings of at most 128 bytes. Server timestamps are UTC RFC 3339.

## HTTP

| Request | Response |
| --- | --- |
| `GET /api/v1/bootstrap` | `{scratchpad, conflicts}` with canonical state and unresolved conflicts. |
| `GET /api/v1/conflicts?clientId=…&sessionId=…` | A conflict array filtered to the supplied origin identity when present. |
| `POST /api/v1/conflicts/{id}/resolve` | Accepts `{content, baseRevision}` and returns the scratchpad directly after an atomic current-revision resolution. |
| `GET /health/live` | Content-free process liveness. |
| `GET /health/ready` | Content-free startup/readiness state. |
| `GET /ws` | WebSocket upgrade; the browser `Origin` must exactly match `JOTTER_PUBLIC_ORIGIN`. |
| `POST /share` | Intercepted by the installed service worker as URL-encoded `title`, `text`, and `url`; it is not a server save endpoint. |

API responses use `application/json` and `Cache-Control: no-store`. Errors use `{error: {status, code, message, request_id, issues?}}`; the correlation ID also appears in `X-Request-ID` and boundary logs. Validation issues use content-free descriptions. Application, routing, origin, size, and unexpected failures share this shape. HTTP has no save fallback.

## WebSocket sequence

Every connection starts with `hello`:

```json
{"v":1,"type":"hello","scratchpadId":"…","clientId":"…","sessionId":"…","knownRevision":4,"pendingMutationIds":["…"]}
```

The server replies with `state`, including the authoritative scratchpad and conflicts relevant to the client/session. Only `save` is valid after the handshake:

```json
{"v":1,"type":"save","scratchpadId":"…","content":"complete text","baseRevision":4,"clientId":"…","sessionId":"…","mutationId":"…"}
```

An accepted save commits before returning `ack` to the sender and `update` to other connections. Retrying the same mutation returns its original accepted revision. A stale save returns `conflict`, which includes submitted content/base revision and server content/revision plus the originating identifiers and creation time. The server never merges or applies last-write-wins.

`error` contains one stable code, a content-free message, and optional `mutationId`/`retryAfterMs`. Stable codes are `stale_revision`, `content_too_large`, `unresolved_conflict`, `invalid_state`, `mutation_mismatch`, `storage_unavailable`, `invalid_message`, `unsupported_version`, and `internal_error`.

The server permits one reader per connection, bounds outbound queues, disconnects slow clients, and closes live sockets with status `going away` during shutdown. Clients preserve pending mutations and reconnect with exponential backoff; an online event triggers an immediate attempt.

## Compatibility

Version 1 rejects every other version. A compatible change may add an optional field whose absence preserves meaning. Incompatible shape or semantic changes require a new protocol version and an explicit transition strategy. Database migrations are a separate ordered forward-only contract.

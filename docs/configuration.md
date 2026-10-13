# Configuration

Jotter reads configuration only from environment variables.

| Variable | Development default | Production rule |
| --- | --- | --- |
| `JOTTER_ENV` | `development` | Set to `production`. Other values are rejected. |
| `JOTTER_LISTEN_ADDR` | `127.0.0.1:8080` | Set the container listener, normally `0.0.0.0:8080`; publish it on host loopback only. |
| `JOTTER_PUBLIC_ORIGIN` | `http://127.0.0.1:5173` | Required explicitly as one HTTPS origin, for example `https://jotter.example`; credentials, a path, query, fragment, whitespace, and a trailing slash are rejected. |
| `JOTTER_DATA_DIR` | `./data` | Set to the writable bind mount, normally `/data`. |
| `JOTTER_LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, or `error`. Logs remain content-free JSON at every level. |
| `AUTH_DISABLED` | unset | Must be exactly `true`; this delegates access control to the trusted private deployment boundary. |

The application has no secret configuration in V1. `AUTH_DISABLED=true` is an acknowledgement, not authentication. Place deployment environment files outside the repository with mode `0600` because they describe the private service boundary and may gain secrets in later versions.

## Fixed limits

- Scratchpad content: 1,048,576 UTF-8 bytes after CRLF/CR normalization to LF.
- HTTP JSON body: content limit plus 4 KiB of envelope overhead.
- WebSocket message: content limit plus 16 KiB of envelope overhead.
- WebSocket handshake: 10 seconds; writes: 5 seconds.
- HTTP headers: 16 KiB; request and response I/O: 15 seconds; idle connections: 60 seconds.
- Graceful HTTP shutdown: 10 seconds; supplied container stop grace: 15 seconds.
- SQLite receipts: newest 1,000 per scratchpad for at most seven days.

The process sets a restrictive file-creation mask. The data directory is `0700`, and new SQLite database, WAL, and shared-memory files are owner-only.

## Compose variables

`compose.yaml` additionally requires host-side interpolation values:

| Variable | Purpose |
| --- | --- |
| `APP_VERSION` | Required image/build version; derive from root `package.json`. |
| `JOTTER_IMAGE` | Optional verified image digest or tag; defaults to `ghcr.io/muatasim-aswad/jotter:v${APP_VERSION}`. |
| `JOTTER_HOST_DATA_DIR` | Absolute local-filesystem directory bind-mounted to `/data`. Do not use a network filesystem. |
| `JOTTER_HOST_PORT` | Loopback host port; defaults to `8080`. |
| `JOTTER_PUBLIC_ORIGIN` | The private HTTPS origin passed into the container. |
| `JOTTER_LOG_LEVEL` | Optional log threshold; defaults to `info`. |

Compose enforces numeric user `10001:10001`, no new privileges, all-capability drop, read-only root filesystem, 128 PIDs, 256 MiB memory, one CPU, three rotating 10 MiB log files, local health checking, and `restart: unless-stopped`.

[`.env.example`](../.env.example) provides neutral Compose placeholders. `APP_REVISION`, `APP_COMMIT_TIME`, `APP_BUILD_TIME`, and `SOURCE_DATE_EPOCH` are build inputs, not runtime settings; use `mise run container` to derive them consistently. Container release builds without `.git` require a full revision SHA and both UTC timestamps equal to the commit-derived epoch. Omitted identity reports `dev`; partial or inconsistent metadata is rejected.

# Configuration

Jotter reads configuration only from environment variables.

| Variable | Development default | Production rule |
| --- | --- | --- |
| `JOTTER_ENV` | `development` | Set to `production`. Other values are rejected. |
| `JOTTER_LISTEN_ADDR` | `127.0.0.1:8080` | Set the container listener, normally `0.0.0.0:8080`; publish it on host loopback only. |
| `JOTTER_PUBLIC_ORIGIN` | `http://127.0.0.1:5173` | Required explicitly as one HTTPS origin, for example `https://jotter.example`; credentials, a path, query, fragment, whitespace, and a trailing slash are rejected. |
| `JOTTER_DATA_DIR` | `./data` | Set to the writable local storage mount, normally `/data`. |
| `JOTTER_LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, or `error`. Logs remain content-free JSON at every level. |
| `AUTH_DISABLED` | unset | Must be exactly `true`; this delegates access control to the trusted private deployment boundary. |

The application has no secret configuration in V1. `AUTH_DISABLED=true` is an acknowledgement, not authentication. Keep deployment environment files out of Git and protect them with mode `0600`.

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

`compose.yaml` accepts these host-side interpolation values; only the origin is required:

| Variable | Purpose |
| --- | --- |
| `JOTTER_IMAGE` | Optional image digest or tag; defaults to `ghcr.io/muatasim-aswad/jotter:v1.0.1`. Set `jotter:local` after building from source. |
| `JOTTER_HOST_PORT` | Loopback host port; defaults to `8080`. |
| `JOTTER_PUBLIC_ORIGIN` | The private HTTPS origin passed into the container. |
| `JOTTER_LOG_LEVEL` | Optional log threshold; defaults to `info`. |

Compose uses project name `jotter` and creates local named volume `jotter_data` at `/data`, initialized with the image's `10001:10001` ownership. No host directory or manual ownership setup is required. Keep this volume for upgrades; network filesystems and multiple replicas are unsupported. A custom Compose project name selects a separate volume.

Compose enforces numeric user `10001:10001`, no new privileges, all-capability drop, read-only root filesystem, 128 PIDs, 256 MiB memory, one CPU, three rotating 10 MiB log files, local health checking, and `restart: unless-stopped`.

Its optional `build` section uses the repository Dockerfile. Published deployments start with `--no-build`; source deployments select `JOTTER_IMAGE=jotter:local` before building or starting. The three `APP_*` identity fields are optional Compose build arguments for deployment managers; they are never needed at runtime.

[`.env.example`](../.env.example) provides optional Compose settings. Save them in an ignored `.env` beside `compose.yaml`, export them in your shell, or pass them inline as in [deployment](deployment.md). Provide the origin for every Compose command, including logs, stop, and upgrades.

`APP_VERSION`, `APP_REVISION`, `APP_COMMIT_TIME`, `APP_BUILD_TIME`, and `SOURCE_DATE_EPOCH` are optional release build inputs, not runtime settings. Plain `docker build` derives the product version from `package.json` and reports revision `dev`. The release driver supplies a full revision SHA and UTC timestamps equal to the commit-derived epoch; partial or inconsistent identity metadata is rejected.

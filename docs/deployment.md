# Deployment

Run one Linux amd64 container on one host with local SQLite storage. A trusted private HTTPS access boundary must provide access control; Jotter has no application authentication.

## Compose

Create a protected data directory owned by numeric UID/GID `10001:10001`. Choose an unused loopback port and the private HTTPS origin:

```sh
sudo install -d -m 0700 -o 10001 -g 10001 /path/to/jotter-data
export JOTTER_HOST_DATA_DIR=/path/to/jotter-data
export JOTTER_HOST_PORT=8080
export JOTTER_PUBLIC_ORIGIN=https://jotter.example
export APP_VERSION="$(node -p 'require("./package.json").version')"
mise run container
docker compose up -d --pull never jotter
curl -fsS http://127.0.0.1:8080/health/ready
```

Start from [`.env.example`](../.env.example) and replace its placeholders. Load its values when building and running. The Compose file takes host paths, port, and origin from variables; no host-specific override is needed. Keep persistent environment values in a file outside the checkout with mode `0600`, and pass it with `docker compose --env-file /path/to/config.env …`. Keep credentials, databases, and backups outside Git.

Terminate private HTTPS outside the container and proxy to loopback. Preserve the configured public `Host` header and WebSocket upgrades; the application rejects other non-loopback hosts and unexpected origins. SQLite must use local storage. One process acquires ownership before startup migrations; multiple replicas and network filesystems are unsupported.

The container runs as `10001:10001` with a read-only root, dropped capabilities, resource limits, and bounded logs. Its writable paths are `/data` and a small temporary filesystem. Readiness probes SQLite; liveness reports the running HTTP process.

## Published images and binaries

After release, select `ghcr.io/muatasim-aswad/jotter:v1.0.0` or, preferably, its verified digest from the [release](https://github.com/Muatasim-Aswad/jotter/releases). Set `APP_VERSION` from root `package.json` and `JOTTER_IMAGE` to that accepted image. Compose disables implicit pulling; pull explicitly with `docker pull "$JOTTER_IMAGE"`, then use `docker compose up -d --pull never jotter`. Version and full-commit tags identify releases; `latest` is mutable. Availability begins with publication.

The release also contains a Linux amd64 binary archive retaining LICENSE, source archive, checksums, provenance, and container archives. Download from the canonical release and run `sha256sum -c SHA256SUMS` against the complete asset set before use. The binary uses the same [environment configuration](configuration.md) and private HTTPS boundary; run `jotter --version` and `jotter build-info` to inspect it. Other platforms are untested.

## Build identity and upgrades

The PWA embeds its version, commit, commit time, and build time; `/version.json` serves that record without service-worker caching. `mise run container` derives the version from root `package.json` and complete identity from clean source; dirty sources report `dev`. In release builds, `APP_REVISION` is the full commit SHA, `SOURCE_DATE_EPOCH` is its Unix commit time, and `APP_COMMIT_TIME`/`APP_BUILD_TIME` are that same instant in UTC. No `.git` enters the container build. Record the tested image digest; release attempt timestamps are separate evidence. About Jotter shows running/deployed identity, check failures, and Reload when a different build is deployed; it persists edits before reloading.

Before replacing a running service, follow the [consistent-copy and verified-restore procedure](release.md). After applying, check Compose health, loopback and private HTTPS readiness, build identity, data ownership, structured logs, and restart persistence. Keep the prior local image digest and verified safety copy for rollback. Never delete the active data directory or run `docker compose down -v`.

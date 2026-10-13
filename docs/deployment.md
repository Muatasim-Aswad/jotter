# Deployment

Run one Linux amd64 instance with local SQLite storage. Configure a trusted private HTTPS proxy first: Jotter has no built-in login. Replace `https://jotter.example` below with your private origin.

## Published image

Requires Docker with Compose. Download the Compose file and start the published image; no clone or build tools are required:

```sh
mkdir -p jotter && cd jotter
curl -fsSLO https://raw.githubusercontent.com/Muatasim-Aswad/jotter/v1.0.1/compose.yaml
JOTTER_PUBLIC_ORIGIN=https://jotter.example docker compose up -d --no-build
```

Compose pulls `ghcr.io/muatasim-aswad/jotter:v1.0.1` if missing and creates local named volume `jotter_data` with the required ownership. No host data directory or `sudo` setup is needed.

## Build from source

Requires Git and Docker with Compose. The Dockerfile builds the web assets and server inside Docker:

```sh
git clone https://github.com/Muatasim-Aswad/jotter.git
cd jotter
docker build --platform linux/amd64 -t jotter:local .
JOTTER_IMAGE=jotter:local JOTTER_PUBLIC_ORIGIN=https://jotter.example docker compose up -d --no-build --pull never
```

`-t jotter:local` names the local image; `JOTTER_IMAGE` selects it in the same Compose file. Nothing is published. No host mise, Python, Node, pnpm, Go, or build identity inputs are needed. The product version comes from `package.json`; the revision reports `dev`. Rebuild and repeat the start command to apply source changes, following the [backup and upgrade procedure](release.md#upgrade-and-rollback).

The same Compose file also describes the optional source build. From the checkout, `JOTTER_IMAGE=jotter:local JOTTER_PUBLIC_ORIGIN=https://jotter.example docker compose build` replaces the plain Docker build command above. Deployment managers can use it without separate build configuration. Published-image users need only the downloaded Compose file and always start with `--no-build`.

## Configuration and operations

Set the origin for every Compose command. For repeated use, export `JOTTER_PUBLIC_ORIGIN` and any overrides in your shell, or save them in an ignored mode `0600` `.env` beside `compose.yaml`; [`.env.example`](../.env.example) lists the [available settings](configuration.md#compose-variables). Source deployments must also retain `JOTTER_IMAGE=jotter:local`.

Compose stores ports, storage, environment, restart policy, resource limits, and security settings in one file. With your settings loaded:

```sh
docker compose ps
docker compose logs -f jotter
curl -fsS http://127.0.0.1:8080/health/ready
```

Terminate private HTTPS outside the container and proxy to `127.0.0.1:8080`. Preserve the configured public `Host` header and WebSocket upgrades; the application rejects unexpected hosts and origins. SQLite must use local storage; multiple replicas and network filesystems are unsupported.

The container runs as `10001:10001` with a read-only root, dropped capabilities, resource limits, and bounded logs. Writable paths are `/data` and a small temporary filesystem. Readiness probes SQLite; liveness reports the running HTTP process. The named volume survives container replacement and `docker compose down`; never run `docker compose down -v` against live data.

Existing bind-mount deployments must retain their original mount or stop the service and copy the complete data directory into the new volume with ownership preserved before starting. Changing the mount alone does not migrate notes. Keep a verified backup before changing storage.

## Without Compose

Docker can run either image directly. On Linux amd64, select the published image below or replace it with `jotter:local` after building:

```sh
docker run -d --name jotter --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v jotter_data:/data \
  -e AUTH_DISABLED=true \
  -e JOTTER_PUBLIC_ORIGIN=https://jotter.example \
  ghcr.io/muatasim-aswad/jotter:v1.0.1
```

Docker pulls the image if missing and creates the named volume. This minimal command uses the same data volume as default Compose; stop and remove the existing container before switching between them. Compose additionally supplies filesystem restrictions, resource limits, and log rotation.

## Releases and upgrades

The [published image](https://github.com/Muatasim-Aswad/jotter/pkgs/container/jotter) can be pulled anonymously. Prefer a verified digest from the [release](https://github.com/Muatasim-Aswad/jotter/releases); version and full-commit tags identify releases, while `latest` is mutable. Set `JOTTER_IMAGE` to your accepted tag or digest. With your settings loaded:

```sh
docker compose pull --policy always jotter
docker compose up -d --no-build --pull never
```

Release tooling handles build metadata, archive creation, and verification separately from ordinary source builds. Published images already embed identity and expose it at `/about`. The About view compares the running PWA with uncached `/version.json` metadata and offers Reload when a different build is deployed.

The release also contains a Linux amd64 binary archive, LICENSE, source archive, checksums, provenance, and container archives. Download from the canonical release and run `sha256sum -c SHA256SUMS` against the complete asset set before use. The binary uses the same [environment configuration](configuration.md) and private HTTPS boundary; inspect it with `jotter --version` and `jotter build-info`. Other platforms are untested.

Before replacement, follow the [consistent-backup and verified-restore procedure](release.md). Afterward, check Compose health, loopback and private HTTPS readiness, build identity, data ownership, logs, and restart persistence. Keep the previous image digest and verified safety copy for rollback. Keep credentials, databases, and backups outside Git.

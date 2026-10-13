# Deployment

Run one Linux amd64 container on one host with local SQLite storage. A trusted private HTTPS access boundary must provide access control; Jotter has no application authentication.

## Compose

Docker with Compose is enough; no clone, Node, mise, or build metadata is required. Download the deployment files into a dedicated directory:

```sh
mkdir jotter && cd jotter
curl -fsSLO https://raw.githubusercontent.com/Muatasim-Aswad/jotter/main/compose.yaml
curl -fsSL https://raw.githubusercontent.com/Muatasim-Aswad/jotter/main/.env.example -o config.env
chmod 0600 config.env
sudo install -d -m 0700 -o 10001 -g 10001 /path/to/jotter-data
```

Edit `config.env`: set `JOTTER_HOST_DATA_DIR` to that absolute data path, `JOTTER_PUBLIC_ORIGIN` to your private HTTPS origin, and `JOTTER_HOST_PORT` to an unused loopback port. Then start the published image:

```sh
docker compose --env-file config.env up -d jotter
curl -fsS http://127.0.0.1:8080/health/ready
```

Compose defaults to `ghcr.io/muatasim-aswad/jotter:v1.0.0` and pulls it if missing. Set `JOTTER_IMAGE` in `config.env` to select another verified version or digest. For repeatable deployments, retain the downloaded configuration and accepted image digest. Keep credentials, databases, and backups outside Git.

Terminate private HTTPS outside the container and proxy to loopback. Preserve the configured public `Host` header and WebSocket upgrades; the application rejects other non-loopback hosts and unexpected origins. SQLite must use local storage. One process acquires ownership before startup migrations; multiple replicas and network filesystems are unsupported.

The container runs as `10001:10001` with a read-only root, dropped capabilities, resource limits, and bounded logs. Its writable paths are `/data` and a small temporary filesystem. Readiness probes SQLite; liveness reports the running HTTP process.

## Build from source

Requires Git, [mise](https://mise.jdx.dev/), Python 3.11+, and Docker with Compose and Buildx 0.13+. Clone the source and build a local Linux amd64 image:

```sh
git clone https://github.com/Muatasim-Aswad/jotter.git
cd jotter
MISE_LOCKED_SCOPES=project mise install --locked
export JOTTER_IMAGE=jotter:local
mise run container
```

The build runs inside Docker and loads `jotter:local` into your local Docker engine; it publishes nothing. The build driver collects version, revision, and timestamps automatically. No `APP_*` inputs or host `pnpm install` are needed. Use a clean checkout for a verified revision; modified sources report `dev`.

Prepare the data directory and private HTTPS boundary as described under [Compose](#compose). Copy `.env.example` to a mode `0600` file outside the checkout, fill in its data path, origin, and port, and add `JOTTER_IMAGE=jotter:local`. Then run your built image:

```sh
docker compose --env-file /absolute/path/to/config.env up -d --pull never jotter
```

Use that same environment file for subsequent Compose commands. To apply source changes, rebuild with `mise run container` and repeat the start command; follow the [backup and upgrade procedure](release.md#upgrade-and-rollback) before replacing a running service. `docker compose build` is unnecessary because Compose only runs the selected image.

## Published images and binaries

The [published image](https://github.com/Muatasim-Aswad/jotter/pkgs/container/jotter) can be pulled anonymously. Prefer a verified digest from the [release](https://github.com/Muatasim-Aswad/jotter/releases); version and full-commit tags identify releases, while `latest` is mutable. To replace an existing local image deliberately, select the accepted image in `config.env`, run `docker compose --env-file config.env pull jotter`, then recreate with `docker compose --env-file config.env up -d --pull never jotter`.

The release also contains a Linux amd64 binary archive retaining LICENSE, source archive, checksums, provenance, and container archives. Download from the canonical release and run `sha256sum -c SHA256SUMS` against the complete asset set before use. The binary uses the same [environment configuration](configuration.md) and private HTTPS boundary; run `jotter --version` and `jotter build-info` to inspect it. Other platforms are untested.

## Build identity and upgrades

Build information is already embedded in published images. Current source builds use `/about`; the published `v1.0.0` image still uses the editor’s About footer until the next release. The About view compares the running PWA with uncached `/version.json` metadata and offers Reload when a different build is deployed. No build identity variables are needed to run the image. The [source-build instructions](#build-from-source) collect identity automatically.

Before replacing a running service, follow the [consistent-copy and verified-restore procedure](release.md). After applying, check Compose health, loopback and private HTTPS readiness, build identity, data ownership, structured logs, and restart persistence. Keep the prior local image digest and verified safety copy for rollback. Never delete the active data directory or run `docker compose down -v`.

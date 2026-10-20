# Deployment

Run one Linux amd64 instance with local SQLite storage. Configure a trusted private HTTPS proxy first: Jotter has no built-in login. Replace `https://jotter.example` below with your private origin.

## Published image

Requires Docker with Compose:

```sh
mkdir -p jotter && cd jotter
curl -fsSLO https://raw.githubusercontent.com/Muatasim-Aswad/jotter/v1.0.2/compose.yaml
JOTTER_PUBLIC_ORIGIN=https://jotter.example docker compose up -d --no-build
```

Compose pulls the published image and creates `jotter_data` with the required ownership. No clone, build tools, or host data directory are needed.

## Build from source

Requires Git and Docker with Compose:

```sh
git clone https://github.com/Muatasim-Aswad/jotter.git
cd jotter
export JOTTER_IMAGE=jotter:local JOTTER_PUBLIC_ORIGIN=https://jotter.example
docker compose build
docker compose up -d --no-build --pull never
```

Docker builds the web assets and server; no host toolchains are needed. The version comes from `package.json`; the revision reports `dev`. Rebuild and repeat the start command for source changes, following [backup and upgrade](release.md#upgrade-and-rollback).

## Deploy with srvr

Jotter supports [srvr 0.2.0 or newer](https://github.com/Muatasim-Aswad/srvr/blob/main/docs/install.md) for image or source deployments, health checks, and named-volume backups. Choose one setup for a new deployment.

### Published image

```sh
mkdir -p ~/services/jotter && cd ~/services/jotter
curl -fsSLO https://raw.githubusercontent.com/Muatasim-Aswad/jotter/v1.0.2/compose.yaml
(umask 077; printf '%s\n' 'JOTTER_PUBLIC_ORIGIN=https://jotter.example' > .env)
docker compose --env-file .env create --no-build jotter
srvr add jotter --kind image --workdir "$PWD" \
  --env-file "$PWD/.env" --data-volume jotter_data \
  --health http://127.0.0.1:8080/health/ready \
  --url https://jotter.example --start --backup -y
```

### From source

```sh
mkdir -p ~/services
git clone https://github.com/Muatasim-Aswad/jotter.git ~/services/jotter
cd ~/services/jotter
(umask 077; printf '%s\n' 'JOTTER_PUBLIC_ORIGIN=https://jotter.example' 'JOTTER_IMAGE=jotter:local' > .env)
docker volume create --label com.docker.compose.project=jotter \
  --label com.docker.compose.volume=data jotter_data
srvr add jotter --kind git --branch main --workdir "$PWD" \
  --env-file "$PWD/.env" --data-volume jotter_data \
  --health http://127.0.0.1:8080/health/ready \
  --version-url http://127.0.0.1:8080/version.json \
  --url https://jotter.example --start --backup -y
```

Both setups prepare the volume before srvr starts Jotter, checks readiness, and backs up its data. Use your private origin in `.env` and `--url`. If changing the port, update the proxy and health/version URLs too.

For an existing deployment, register without `--start`, retaining its env file, project name (`--project`), and volume name (`--data-volume`). Source checkouts must be clean.

Check health with `srvr health jotter`; back up with `srvr backup jotter`. Update source deployments with `srvr update jotter`, or image deployments with `srvr update jotter --image "ghcr.io/muatasim-aswad/jotter:<version>"`, choosing a verified tag or digest. See srvr’s [updates and rollback](https://github.com/Muatasim-Aswad/srvr/blob/main/docs/updates.md) and [off-server backups](https://github.com/Muatasim-Aswad/srvr/blob/main/docs/backups.md).

## Configuration and operations

For every Compose command, export `JOTTER_PUBLIC_ORIGIN` and overrides, or save them in a mode `0600` `.env` beside `compose.yaml`. Source deployments also need `JOTTER_IMAGE=jotter:local`. See [`.env.example`](../.env.example) and [configuration](configuration.md).

With your settings loaded:

```sh
docker compose ps
docker compose logs -f jotter
curl -fsS http://127.0.0.1:8080/health/ready
```

Proxy private HTTPS to `127.0.0.1:8080`, preserving the configured public `Host` and WebSocket upgrades. Unexpected hosts and origins are rejected. SQLite requires local storage; replicas and network filesystems are unsupported.

The container runs as `10001:10001` with a read-only root, writable `/data` and temporary storage, dropped capabilities, resource limits, and bounded logs. Readiness checks SQLite; liveness checks the HTTP process. The volume survives replacement and `docker compose down`; never use `down -v` against live data.

For existing bind mounts, keep the mount or stop Jotter and copy the complete data directory into the new volume, preserving ownership. Back up first; changing the mount alone does not migrate notes.

## Without Compose

For another manager or direct Docker use, preserve the image, environment, loopback port, volume, user, filesystem restrictions, resource limits, and logging settings from [`compose.yaml`](../compose.yaml). Stop the previous container and retain its data volume when switching managers.

## Releases and upgrades

Pull the [published image](https://github.com/Muatasim-Aswad/jotter/pkgs/container/jotter) anonymously. Set `JOTTER_IMAGE` to a verified [release](https://github.com/Muatasim-Aswad/jotter/releases) digest or tag; `latest` is mutable. With settings loaded:

```sh
docker compose pull --policy always jotter
docker compose up -d --no-build --pull never
```

Check build identity at `/about`; it offers Reload when a different build is deployed.

Images are distributed through GHCR. GitHub releases provide Linux amd64 binaries, source, LICENSE, checksums, and provenance; older immutable releases retain legacy image archives. Download the matching asset set and run `sha256sum -c SHA256SUMS`. Binaries use the same [configuration](configuration.md) and private HTTPS boundary; inspect them with `jotter --version` and `jotter build-info`. Other platforms are untested.

Follow [backup, restore, and rollback](release.md) before upgrading. Afterward, check health over loopback and private HTTPS, build identity, ownership, logs, and restart persistence. Retain the previous image digest and verified backup; keep credentials, databases, and backups outside Git.

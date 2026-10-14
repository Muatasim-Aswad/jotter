# Development and testing

## Prerequisites

Install `mise`, Python 3.11+, Docker with Compose and Buildx 0.13+ (multiple exporters), and the system libraries required by Playwright Chromium. `mise.toml`/`mise.lock` pin Go, Node, pnpm, Staticcheck, Gitleaks, actionlint, and regctl; pnpm uses the committed dependency lockfile.

```sh
MISE_LOCKED_SCOPES=project mise install --locked
pnpm install --frozen-lockfile
mise run browser:install
mise run hooks:install
```

## Development server

```sh
mise run dev
```

Go listens on `127.0.0.1:8080`; Vite listens on `127.0.0.1:5173` and proxies API, health, and WebSocket traffic. Production behavior is tested from the embedded build rather than the proxy.

## Tasks

| Task | Purpose |
| --- | --- |
| `mise run verify` | Run the complete local/CI gate, including race, audit, container hardening and restore. |
| `mise run check:fast` | Run contracts, formatting, lint, types, unit and Go checks; used by the pre-commit hook. |
| `mise run contracts:generate` | Refresh generated contracts and validators after editing OpenAPI. |
| `mise run contracts:check` | Reject generated contract drift. |
| `mise run format` | Apply gofmt and Oxfmt. |
| `mise run format:check` | Check formatting without modifying files. |
| `mise run lint` | Run go vet, Staticcheck, and Oxlint. |
| `mise run typecheck` | Run TypeScript without emitting output. |
| `mise run test:unit` | Run TypeScript protocol, state, storage, share, and UI tests. |
| `mise run test:go` | Run Go protocol, service, SQLite, HTTP, and WebSocket tests. |
| `mise run test:e2e` | Build the embedded production server and run every Chromium PWA scenario on port `4173`. |
| `mise run test:race` | Run all Go tests with the race detector. |
| `mise run build` | Build the PWA, copy it into the embed tree, and link `.build/jotter`. |
| `mise run check` | Run formatting, lint, typecheck, unit, Go, build, and production Chromium gates. |

Set `JOTTER_PLAYWRIGHT_OUTPUT` to redirect Playwright traces and artifacts. Browser tests cover local durability, sync and conflicts, PWA updates, share ingestion, same-origin resources, warm loading, 300 ms save debounce, maximum-size input responsiveness, and sub-second clean-client propagation on the local test host. The debounce test controls browser time after an acknowledged save; propagation tests wait for both clients to synchronize before measuring.

## Continuous integration

GitHub Actions runs the same `mise run verify` command on pushes and pull requests. Failed browser runs retain traces for seven days. CI also scans push/PR ranges for secrets with redacted Gitleaks output. Actions are pinned to commit hashes; validation permissions are read-only. Only the dependent release publishing job receives write permissions.

## Build a Docker image

Follow [Build from source](deployment.md#build-from-source). Compose reads the build settings from `compose.yaml`; no host mise, Python, Node, pnpm, or Go is required. The build publishes nothing and reports revision `dev`.

## Container verification

`./scripts/verify-container.sh` rebuilds the candidate, uses loopback port `18080`, saves a known probe through the real WebSocket protocol, restarts and recreates the container, then verifies and starts an offline staging restore, and verifies the probe survived in the named-volume SQLite database. It also checks initial volume ownership, the numeric user, filesystem and capability restrictions, resource limits, loopback binding, health/application responses, CSP, invalid-origin rejection, owner-only data modes, structured content-free logs, and graceful shutdown. A trap removes the test container, volume, and staging directory on success or failure.

The script builds through the release driver using digest-pinned Node, Go, Alpine, and BuildKit inputs. It never pulls or pushes a Jotter image. To reuse a tested local image, set `JOTTER_IMAGE`, `JOTTER_SKIP_IMAGE_BUILD=1`, and its expected `APP_VERSION`, `APP_REVISION`, `APP_COMMIT_TIME`, `APP_BUILD_TIME`, and `SOURCE_DATE_EPOCH`; served identity must match.

## Source-only checkout

Build assets are ignored. The embed tree retains only a placeholder so Go tests compile from a fresh checkout; run `mise run build` before running the production binary. Regenerate the README image with `mise run build && mise exec -- node scripts/capture-screenshot.mjs`. The generator launches that binary on a temporary loopback port with disposable SQLite/browser data, writes only synthetic groceries, a reminder, and a thought for later, waits for a server acknowledgement, and captures the top 390×320 CSS pixels of a 390×844 mobile viewport with touch emulation and 2× pixel density. It closes the server/browser and deletes disposable data. Inspect the PNG for clipping or errors after regeneration. This capture does not prove real Android keyboard or share-sheet behavior.

## Build identity

Root `package.json` owns the product version. Clean host builds derive revision and commit time from Git; dirty or missing sources report `dev`. Plain Docker builds report `dev` because `.git` is excluded from the build context. Release builds use the release driver to supply `APP_REVISION`, `APP_COMMIT_TIME`, `APP_BUILD_TIME`, and `SOURCE_DATE_EPOCH`, with `builtAt` and normalized timestamps derived from commit time; actual attempt times are separate evidence. Generated identity stays in ignored assets. Run `.build/jotter --version` or `.build/jotter build-info` after building; the server logs the same identity at startup. The `/about` page compares the running build with uncached deployed metadata and offers a manual Reload when different.

Dependency version PRs are grouped per npm workspace, Go module, GitHub Actions, and Docker, with an explicit three-day cooldown. Security updates bypass that cooldown and version schedules when enabled in repository settings; configuration alone does not enable them. See the [GitHub options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference). CodeQL uses repository default setup rather than a separate workflow.

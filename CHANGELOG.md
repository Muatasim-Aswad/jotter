# Changelog

Notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/). Root `package.json` is the version authority.

## [Unreleased]

### Changed

- Future container releases use GHCR only; Docker/OCI exports stay internal to CI instead of becoming release downloads.

## [1.0.1]

### Changed

- One Compose file supports published images and optional source builds, with explicit build/pull selection and Docker-managed persistent storage.
- Docker deployment, configuration, and backup instructions use the same simple workflows.
- Moved build information to `/about`, keeping the editor free of navigation controls.
- Shortened the mobile README screenshot while retaining some writing space.

## [1.0.0]

### Added

- A focused scratchpad with immediate writing, durable offline drafts, synchronization across devices, and explicit conflict review.
- An installable Chrome PWA with Android text/link share ingestion and device-local cursor restoration.
- A single Go server with local SQLite persistence, bounded retry receipts, private-origin checks, content-free logs, and offline backup verification.
- About Jotter with running/deployed build identity, uncached checks, visible failures, and Reload for a different deployment; server version and build-information commands.
- Verified source and Linux amd64 binary/container release tooling, deterministic artifact timestamps, checksums, provenance, and a local no-publish rehearsal.

### Scope and validation

One scratchpad behind a trusted private HTTPS boundary; no built-in login, history, automatic merge, or multi-process deployment. Chrome desktop and Android are the supported browser targets; other binary/container platforms are untested. The release gate includes automated Chromium, Go race, persistence, restore, dependency, and secret checks. Actual candidate results belong to release evidence. Desktop/Android keyboard, share sheet, private HTTPS, offline launch, and two-device checks remain required before release; mobile emulation alone does not establish real-device behavior.

[Unreleased]: https://github.com/Muatasim-Aswad/jotter/compare/v1.0.1...HEAD
[1.0.0]: https://github.com/Muatasim-Aswad/jotter/releases/tag/v1.0.0
[1.0.1]: https://github.com/Muatasim-Aswad/jotter/releases/tag/v1.0.1

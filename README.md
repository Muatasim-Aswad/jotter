# Jotter

One place to jot things down.

Jotter is a minimal, focused scratchpad that opens straight into writing. Capture a thought, a link, or a quick note, then find the same text on your other devices.

<img src="docs/images/editor.png" alt="Jotter’s mobile editor with synthetic groceries, a reminder, and a thought for later" width="390" />

Self-hosted, with offline writing, sync when connected, and Android sharing for text and links.

> [!WARNING]
>
> Jotter currently has no built-in login. Deploy behind a trusted private HTTPS access boundary. Anyone who can reach the service can access the scratchpad. Production requires `AUTH_DISABLED=true` to acknowledge that boundary.

## Run locally

```sh
git clone https://github.com/Muatasim-Aswad/jotter.git
cd jotter
MISE_LOCKED_SCOPES=project mise install --locked
pnpm install --frozen-lockfile
mise run dev
```

Requires [mise](https://mise.jdx.dev/), Python 3.11+, and the pinned toolchains. Open `http://127.0.0.1:5173`. Both development listeners use loopback. Build information is available at `/about`.

## Deploy

Use the published image: download one Compose file, set your private HTTPS origin, and start. Or build from source through the same Compose file. Docker manages persistent storage; no host build tools or data-directory setup are required. The [limitations](docs/limitations.md) describe browser verification, offline recovery, and backup requirements.

For managing Jotter alongside other self-hosted apps, you can use [srvr](https://github.com/Muatasim-Aswad/srvr).

## Development

See [development](docs/development.md) for setup and `mise run verify`, the shared local/CI gate. [Contributions](CONTRIBUTING.md) use focused pull requests from forks.

## Documentation

- [Deployment](docs/deployment.md) — Run Jotter locally or deploy it behind private HTTPS.
- [Backup, restore, and releases](docs/release.md) — Back up your notes, recover data, or roll back an upgrade.
- [Limitations and data handling](docs/limitations.md) — Check what Jotter supports and where it stores data.
- [Security](SECURITY.md) — Understand the private access boundary and report vulnerabilities.
- [Development](docs/development.md) — Set up a checkout, run checks, and find contribution instructions.
- [Architecture](docs/architecture.md) — Find where the code lives and understand how synchronization works.
- [Changelog](CHANGELOG.md) — See what changed in each release.

Licensed under [MIT](LICENSE). Bundled validator attribution is in [third-party notices](THIRD_PARTY_NOTICES.md).

# Releases, backup, and restore

## Verify and rehearse a candidate

Root `package.json` owns the product version; workspace versions, the Compose default image, and the `vX.Y.Z` tag must agree. From an exact clean committed candidate with mise, Python 3.11+, Docker/Compose, Buildx 0.13+, and Chromium libraries installed:

```sh
MISE_LOCKED_SCOPES=project mise install --locked
pnpm install --frozen-lockfile
mise run browser:install
mise run verify
python3 scripts/release.py rehearse --commit HEAD --tag v1.0.1 --output .build/release-bundle
python3 scripts/release.py check-bundle --bundle .build/release-bundle
python3 scripts/release.py smoke-bundle --bundle .build/release-bundle
```

The rehearsal publishes nothing. It rejects dirty/untracked sources and mismatched versions, exports only `git archive` of the exact commit, installs pinned inputs, runs the full gate, scans source/artifacts with redacted Gitleaks, checks explicit inventories, and smoke-tests the Linux amd64 binary and tested container. The output directory must not already exist; retain accepted bytes for retries. A later `mise run build` clears `.build`, so preserve accepted bundles in a protected location before building again.

The CI bundle contains source and Linux amd64 binary archives, `SHA256SUMS`, `PROVENANCE.json`, `BUILD-ATTEMPT.json`, and temporary OCI/Docker image exports for verification and registry import. Only the five public assets are attached to GitHub releases and listed in `SHA256SUMS`; GHCR is the sole image distribution path. Provenance schema 2 checks the internal image exports separately and records the published image digest. Existing immutable releases retain their original assets and format. Binary downloads include `LICENSE` and generated `DEPENDENCY-NOTICES.txt`; containers carry them in `/usr/share/licenses/jotter/`. Web dependency notices are served at `/licenses.txt`. Build scripts copy notices from the installed locked dependencies, including their versions and license hashes. Identity and normalized archive timestamps use commit-derived `SOURCE_DATE_EPOCH`; provenance records source/runtime inventories and digests, while build-attempt evidence records actual times and tool versions.

Before release, check current desktop and Android Chrome: warm/offline launches, edit/reload, keyboard viewport, online/offline shares, reconnect, private HTTPS, and a real two-device conflict. Automated Chromium tests and the mobile screenshot do not replace these checks. Record results, source revision, image digest, schema version, and relevant configuration in release evidence.

## Publication and retries

Only a `vX.Y.Z` tag push triggers release publication. Read-only jobs validate the exact tag/commit, build, then download/check/smoke-test the complete bundle; the dependent publisher alone receives contents/packages write permission. Maintainers must first enable and verify immutable releases and set Actions variable `JOTTER_IMMUTABLE_RELEASES_ENABLED=true`. Repository security settings and GHCR permissions are separate prerequisites.

The publisher uploads only the public assets from the verified CI bundle to a draft, verifies remote asset bytes, imports the tested OCI manifest digest into GHCR under version and full-SHA tags, and publishes the immutable release. Image exports remain CI intermediates. `latest` advances only for GitHub's latest release. Recover by rerunning failed publication jobs using retained validation artifacts (30-day retention); do not move tags or rebuild from `main`. Retries verify existing assets/digests and only fill missing draft assets. Changed immutable assets or version/SHA image tags are rejected. Retain the exact bundle if recovery exceeds artifact retention; investigate before attempting publication again.

## Select a recovery image

Use a verified release digest or the retained locally tested image; never rebuild the old version for rollback. A local version tag can be inspected with:

```sh
export JOTTER_IMAGE=ghcr.io/muatasim-aswad/jotter:v1.0.1
docker image inspect "$JOTTER_IMAGE" --format '{{.Id}}'
```

## Make a consistent backup

Stop the service before copying the entire data directory, including any `jotter.db-wal` and `jotter.db-shm` sidecars. Use the running image as a copy helper, preserve ownership, and restart once the copy is complete. This works with named volumes and existing bind mounts:

```sh
backup_root=/absolute/protected-backups
backup_name="pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ)"
backup="$backup_root/$backup_name"
container="$(docker compose ps -aq jotter)"
image="$(docker inspect "$container" --format '{{.Image}}')"
docker compose stop jotter
sudo install -d -m 0700 "$backup_root"
docker run --rm --pull never --user 0:0 \
  --volumes-from "$container":ro \
  --mount "type=bind,src=$backup_root,dst=/backups" \
  --env BACKUP_NAME="$backup_name" \
  --entrypoint /bin/sh "$image" -c 'cp -a /data "/backups/$BACKUP_NAME"'
docker compose start jotter
```

These commands assume Docker runs locally on Linux, the service container exists, and the [Compose settings](deployment.md#configuration-and-operations) are loaded. Use a new backup name each time. If copying fails, keep the service stopped until the failure is resolved. A consistent local copy is not an off-server backup. Choose an encrypted off-server destination and retention policy appropriate to the notes; automatic backup scheduling is outside V1. Older content can remain in backups and browser replicas after it changes on the server.

## Verify a staging restore

Never verify by replacing live data. Copy the backup into a separate staging directory and run the candidate binary’s offline verifier first:

```sh
staging=/absolute/restore-staging
candidate_image="$JOTTER_IMAGE" # Set to the verified candidate tag or digest.
sudo cp -a "$backup" "$staging"
docker run --rm --pull never --user 10001:10001 --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --mount "type=bind,src=$staging,dst=/data" \
  "$candidate_image" verify-data /data
```

Use a new staging path each time. The verifier refuses a database with an active owner and checks SQLite integrity, foreign keys, supported migration version, and Jotter tables. It opens SQLite read-only, does not migrate, and reports no note content. The staging directory remains writable for ownership locks and SQLite sidecars.

Then start a separate instance of the intended image against staging on an unused loopback port, without the production proxy. Inspect notes and conflicts through that instance, restart it, and stop it before promotion. Opening that instance may apply forward migrations to staging, so repeat this step with the exact image intended for recovery. The automated container verifier performs this exercise with synthetic data; operators must check their own backup and configuration.

## Upgrade and rollback

Before upgrading, retain the previous image digest and a verified pre-upgrade backup. Review forward migrations and rollback compatibility, select the verified release image or build the exact clean source revision locally, record the new digest, recreate with `docker compose up -d --no-build --pull never jotter`, and verify readiness, build identity, logs, and persistence through the private HTTPS boundary.

A binary-only rollback is safe only if the previous binary supports the current schema. Select the retained previous digest and recreate without rebuilding it. Do not automatically run down migrations.

If a database restore is necessary, first stop the service and back up its failed state under a new protected path using the copy procedure above. For a named volume, use a root copy helper to replace its contents with the separately verified staging directory's contents; for a bind mount, promote staging to the configured live path. Retain `10001:10001` ownership and owner-only modes, then start the intended compatible image. Repeat readiness and content checks before restoring access through the private proxy. Keep the failed state and original backup until recovery is confirmed.

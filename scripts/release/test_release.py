"""Safety tests use synthetic files and never publish or build an image."""
import importlib.util
import json
import hashlib
import io
from pathlib import Path
import os
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("jotter_release", Path(__file__).parents[1] / "release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def image_archives(root):
    config = json.dumps({"architecture": "amd64", "os": "linux", "rootfs": {"type": "layers", "diff_ids": []}, "config": {}}).encode()
    digest = "sha256:" + hashlib.sha256(config).hexdigest()
    descriptor = {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": digest, "size": len(config)}
    manifest = json.dumps({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json", "config": descriptor, "layers": []}).encode()
    manifest_digest = "sha256:" + hashlib.sha256(manifest).hexdigest()
    index = {"schemaVersion": 2, "manifests": [{"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": manifest_digest, "size": len(manifest)}]}
    for name, contents in [("docker-image.tar", {"manifest.json": json.dumps([{"Config": "config.json", "Layers": [], "RepoTags": ["synthetic:fixture"]}]).encode(), "config.json": config}),
                           ("image.tar", {"oci-layout": b'{"imageLayoutVersion":"1.0.0"}', "index.json": json.dumps(index).encode(),
                                          "blobs/sha256/" + digest.split(":")[1]: config, "blobs/sha256/" + manifest_digest.split(":")[1]: manifest})]:
        with tarfile.open(root / name, "w") as tar:
            for path, data in contents.items():
                entry = tarfile.TarInfo(path)
                entry.size = len(data)
                tar.addfile(entry, io.BytesIO(data))
    return digest, manifest_digest


class ReleaseSafety(unittest.TestCase):
    def test_product_manifest_versions_must_agree(self):
        manifests = {name: {"version": "1.0.0"} for name in ["package.json", "apps/web/package.json", "packages/protocol/package.json"]}
        release.validate_manifest_versions("1.0.0", manifests)
        manifests["apps/web/package.json"]["version"] = "1.0.1"
        with self.assertRaisesRegex(release.ReleaseError, "apps/web/package.json"):
            release.validate_manifest_versions("1.0.0", manifests)
        del manifests["apps/web/package.json"]
        with self.assertRaisesRegex(release.ReleaseError, "version manifests"):
            release.validate_manifest_versions("1.0.0", manifests)

    def test_authored_release_notes_match_the_tagged_version(self):
        changelog = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n\n### Added\n\n- Synthetic feature.\n\n[1.0.0]: https://example.invalid/release\n"
        self.assertEqual(release.release_notes(changelog, "1.0.0"), "### Added\n\n- Synthetic feature.")
        for text in ["## [1.0.1]\nOther version", "## [1.0.0]\n\n", "## [1.0.0]\nFirst\n## [1.0.0]\nDuplicate"]:
            with self.subTest(text=text), self.assertRaises(release.ReleaseError):
                release.release_notes(text, "1.0.0")

    def test_version_and_tag(self):
        release.validate_version("1.0.0", "v1.0.0")
        for version, tag in [(None, "v1.0.0"), ("01.0.0", "v01.0.0"), ("1.0.0-rc", "v1.0.0-rc"),
                             ("1.0.0", "v1.0.1"), ("1.0.0", "1.0.0"), ("1.0.0", "v1.0.0\n")]:
            with self.subTest(version=version, tag=tag), self.assertRaises(release.ReleaseError):
                release.validate_version(version, tag)

    def test_dirty_image_environment_is_valid_and_honest(self):
        identity = {"version": "1.0.0", "revision": "dev", "committedAt": None, "builtAt": release.utc(1700000000)}
        env = release.build_env(Path("fixture"), identity, 1700000000)
        self.assertEqual(env["APP_REVISION"], "dev")
        self.assertEqual(env["APP_COMMIT_TIME"], "")
        self.assertTrue(all(isinstance(value, str) for value in env.values()))

    def test_actual_dirty_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            release.run("git", "init", "--quiet", cwd=root)
            release.validate_clean(root)
            (root / "private-file").write_text("synthetic")
            with self.assertRaises(release.ReleaseError):
                release.validate_clean(root)
            release.run("git", "add", "private-file", cwd=root)
            with self.assertRaises(release.ReleaseError):
                release.validate_clean(root)

    def test_commit_and_tag_rejection(self):
        responses = ["a" * 40, "b" * 40]
        with patch.object(release, "validate_clean"), patch.object(release, "git", side_effect=responses):
            with self.assertRaisesRegex(release.ReleaseError, "exact release commit"):
                release.source_identity(Path("."), "HEAD", "v1.0.0")
        responses = ["a" * 40, "a" * 40, '{"version":"1.0.0"}', "b" * 40]
        with patch.object(release, "validate_clean"), patch.object(release, "git", side_effect=responses):
            with self.assertRaisesRegex(release.ReleaseError, "another commit"):
                release.source_identity(Path("."), "HEAD", "v1.0.0", True)

    def test_private_paths_and_inventory(self):
        for name in [".env", ".env.production", "docs/plans/notes.md", "host.local.md", "../key", "/key", "data/jotter.db", ".git/config", "node_modules/key"]:
            with self.subTest(name=name), self.assertRaises(release.ReleaseError):
                release.safe_path(name)
        release.safe_path(".env.example")
        release.exact_inventory(["LICENSE", "package.json"], ["LICENSE", "package.json"], "source")
        for actual in [["LICENSE", "private-key.pem"], ["LICENSE"], ["LICENSE", "package.json", "package.json"]]:
            with self.assertRaises(release.ReleaseError):
                release.exact_inventory(actual, ["LICENSE", "package.json"], "source")

    def test_web_unexpected_files_and_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ["index.html", "jotter.svg", "manifest.webmanifest", "sw.js", "version.json", "licenses.txt", "assets/index-abc123.js"]:
                target = root / name
                target.parent.mkdir(exist_ok=True)
                target.write_text("synthetic")
            release.validate_web(root)
            (root / "private.txt").write_text("synthetic")
            with self.assertRaises(release.ReleaseError):
                release.validate_web(root)
            (root / "private.txt").unlink()
            (root / "link").symlink_to(root / "index.html")
            with self.assertRaises(release.ReleaseError):
                release.inventory(root)

    def test_archive_normalization(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            (source / "LICENSE").write_text("synthetic license")
            (source / "jotter").write_bytes(b"synthetic executable")
            (source / "jotter").chmod(0o700)
            one, two = root / "one.tar.gz", root / "two.tar.gz"
            release.archive_normalized(source, ["jotter", "LICENSE"], one, "jotter-1.0.0", 1234567890)
            os.utime(source / "LICENSE", (1, 2))
            (source / "jotter").chmod(0o755)
            release.archive_normalized(source, ["LICENSE", "jotter"], two, "jotter-1.0.0", 1234567890)
            self.assertEqual(one.read_bytes(), two.read_bytes())
            with tarfile.open(one) as tar:
                self.assertEqual([m.name for m in tar], ["jotter-1.0.0/LICENSE", "jotter-1.0.0/jotter"])
                for member in tar:
                    self.assertEqual((member.uid, member.gid, member.mtime, member.uname, member.gname), (0, 0, 1234567890, "", ""))
            output = root / "unpacked"
            release.extract_regular(one, output, "jotter-1.0.0")
            self.assertEqual(release.inventory(output), ["LICENSE", "jotter"])
            self.assertEqual((output / "jotter").stat().st_mode & 0o777, 0o755)

    def test_unsafe_archives(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, kind in [("../escape", tarfile.REGTYPE), ("link", tarfile.SYMTYPE), ("fifo", tarfile.FIFOTYPE)]:
                archive = root / "unsafe.tar"
                with tarfile.open(archive, "w") as tar:
                    entry = tarfile.TarInfo(name)
                    entry.type = kind
                    tar.addfile(entry)
                with self.assertRaises(release.ReleaseError):
                    release.extract_regular(archive, root / "output")

    def test_checksums_detect_tampering(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "asset").write_bytes(b"synthetic")
            original = release.checksum_manifest(root)
            (root / "SHA256SUMS").write_text(original)
            self.assertEqual(release.checksum_manifest(root), original)
            (root / "asset").write_bytes(b"changed")
            self.assertNotEqual(release.checksum_manifest(root), original)

    def test_release_retry(self):
        expected = {"source": "a" * 64, "binary": "b" * 64, "SHA256SUMS": "c" * 64}
        self.assertEqual(release.retry_plan(expected, {}, False), ["SHA256SUMS", "binary", "source"])
        self.assertEqual(release.retry_plan(expected, {"source": "a" * 64}, False), ["SHA256SUMS", "binary"])
        self.assertEqual(release.retry_plan(expected, expected.copy(), True), [])
        for existing, published in [({"source": "d" * 64}, False), ({"private": "x"}, False), ({"source": "a" * 64}, True)]:
            with self.subTest(existing=existing), self.assertRaises(release.ReleaseError):
                release.retry_plan(expected, existing, published)

    def test_existing_image_tags_are_verified_without_moving(self):
        provenance = {"identity": {"version": "1.0.0", "revision": "a" * 40}, "imageDigest": "sha256:" + "a" * 64}
        with patch.object(release, "registry_digest", return_value=provenance["imageDigest"]), patch.object(release, "run", side_effect=AssertionError("image tag moved")):
            release.push_image(provenance, Path("fixture"))
        with patch.object(release, "registry_digest", return_value="sha256:" + "b" * 64):
            with self.assertRaisesRegex(release.ReleaseError, "refusing to move"):
                release.push_image(provenance, Path("fixture"))

    def test_old_release_retry_does_not_promote_latest(self):
        with patch.object(release, "api", return_value={"tag_name": "v1.1.0"}):
            self.assertFalse(release.should_promote_latest("v1.0.0"))
            self.assertTrue(release.should_promote_latest("v1.1.0"))
            self.assertTrue(release.should_promote_latest("v2.0.0"))

    def test_image_archive_closed_inventory_and_digest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_digest, manifest_digest = image_archives(root)
            self.assertEqual(release.validate_image_archive(root / "docker-image.tar", config_digest), config_digest)
            self.assertEqual(release.validate_oci_archive(root / "image.tar", config_digest), manifest_digest)
            with self.assertRaises(release.ReleaseError):
                release.validate_oci_archive(root / "image.tar", "sha256:" + "0" * 64)
            for name in ["docker-image.tar", "image.tar"]:
                with tarfile.open(root / name, "a") as tar:
                    entry = tarfile.TarInfo("private-key.pem")
                    entry.size = 9
                    tar.addfile(entry, io.BytesIO(b"synthetic"))
                with self.assertRaises(release.ReleaseError):
                    (release.validate_oci_archive if name == "image.tar" else release.validate_image_archive)(root / name, config_digest)

    def test_runtime_inventory_rejects_private_files_and_base_changes(self):
        base = {"bin/sh": {"sha256": "base"}}
        actual = dict(base)
        for name in ["data", "usr/local", "usr/local/bin", "usr/local/bin/jotter", "usr/share", "usr/share/licenses", "usr/share/licenses/jotter", "usr/share/licenses/jotter/LICENSE", "usr/share/licenses/jotter/DEPENDENCY-NOTICES.txt"]:
            actual[name] = {"mode": 0o755, "uid": 0, "gid": 0}
        actual["data"] = {"mode": 0o700, "uid": 10001, "gid": 10001}
        actual["usr/local/bin/jotter"]["mode"] = 0o555
        actual["usr/share/licenses/jotter/LICENSE"]["mode"] = 0o444
        actual["usr/share/licenses/jotter/DEPENDENCY-NOTICES.txt"]["mode"] = 0o444
        release.validate_runtime_inventory(base, actual)
        actual["private-key.pem"] = {"sha256": "synthetic"}
        with self.assertRaises(release.ReleaseError):
            release.validate_runtime_inventory(base, actual)
        del actual["private-key.pem"]
        actual["bin/sh"] = {"sha256": "changed"}
        with self.assertRaises(release.ReleaseError):
            release.validate_runtime_inventory(base, actual)

    def test_bundle_checksums_inventories_and_license(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, binary, bundle = root / "source", root / "binary", root / "bundle"
            for folder in [source, binary, bundle]:
                folder.mkdir()
            names = sorted(["CHANGELOG.md", "LICENSE", "apps/web/package.json", "packages/protocol/package.json", "mise.lock", "package.json", "pnpm-lock.yaml", "scripts/release/source-inventory.txt"])
            (source / "scripts/release").mkdir(parents=True)
            (source / "scripts/release/source-inventory.txt").write_text("\n".join(names) + "\n")
            (source / "package.json").write_text('{"version":"1.0.0"}')
            for name in ["apps/web/package.json", "packages/protocol/package.json"]:
                path = source / name
                path.parent.mkdir(parents=True)
                path.write_text('{"version":"1.0.0"}')
            (source / "CHANGELOG.md").write_text('## [1.0.0]\n\nSynthetic release notes.\n')
            for name in ["LICENSE", "mise.lock", "pnpm-lock.yaml"]:
                (source / name).write_text("synthetic")
            (binary / "LICENSE").write_text("synthetic")
            (binary / "DEPENDENCY-NOTICES.txt").write_text("synthetic notices")
            (binary / "jotter").write_bytes(b"\x7fELFsynthetic")
            epoch = 1700000000
            identity = {"version": "1.0.0", "revision": "a" * 40, "committedAt": release.utc(epoch), "builtAt": release.utc(epoch)}
            config_digest, manifest_digest = image_archives(bundle)
            release.archive_normalized(source, names, bundle / "jotter-1.0.0-source.tar.gz", "jotter-1.0.0", epoch)
            release.archive_normalized(binary, ["jotter", "LICENSE", "DEPENDENCY-NOTICES.txt"], bundle / "jotter-1.0.0-linux-amd64.tar.gz", "jotter-1.0.0", epoch)
            release.write_json(bundle / "PROVENANCE.json", {"schema": 1, "builder": release.BUILDKIT, "repository": release.REPOSITORY, "image": release.IMAGE,
                               "identity": identity, "tag": "v1.0.0", "sourceDateEpoch": epoch, "platform": "linux/amd64", "imageConfigDigest": config_digest,
                               "imageDigest": manifest_digest, "sourceInventory": names, "binaryInventory": ["DEPENDENCY-NOTICES.txt", "LICENSE", "jotter"],
                               "dependencyNoticesSha256": release.sha256(binary / "DEPENDENCY-NOTICES.txt"),
                               "runtimeInventory": {"usr/share/licenses/jotter/DEPENDENCY-NOTICES.txt": {"sha256": release.sha256(binary / "DEPENDENCY-NOTICES.txt")}},
                               "releaseNotes": "Synthetic release notes.",
                               "toolLockSha256": release.sha256(source / "mise.lock"), "dependencyLockSha256": release.sha256(source / "pnpm-lock.yaml")})
            release.write_json(bundle / "BUILD-ATTEMPT.json", {"schema": 1, "revision": identity["revision"], "startedAt": release.utc(epoch), "endedAt": release.utc(epoch + 1), "published": False})
            (bundle / "SHA256SUMS").write_text(release.checksum_manifest(bundle))
            release.check_bundle(bundle)
            (binary / "DEPENDENCY-NOTICES.txt").write_text("tampered notices")
            release.archive_normalized(binary, ["jotter", "LICENSE", "DEPENDENCY-NOTICES.txt"], bundle / "jotter-1.0.0-linux-amd64.tar.gz", "jotter-1.0.0", epoch)
            (bundle / "SHA256SUMS").write_text(release.checksum_manifest(bundle))
            with self.assertRaisesRegex(release.ReleaseError, "dependency notices mismatch"):
                release.check_bundle(bundle)
            (binary / "DEPENDENCY-NOTICES.txt").write_text("synthetic notices")
            release.archive_normalized(binary, ["jotter", "LICENSE", "DEPENDENCY-NOTICES.txt"], bundle / "jotter-1.0.0-linux-amd64.tar.gz", "jotter-1.0.0", epoch)
            (bundle / "SHA256SUMS").write_text(release.checksum_manifest(bundle))
            (bundle / "BUILD-ATTEMPT.json").write_text("tampered")
            with self.assertRaises(release.ReleaseError):
                release.check_bundle(bundle)
            release.write_json(bundle / "BUILD-ATTEMPT.json", {"schema": 1, "revision": identity["revision"], "startedAt": release.utc(epoch), "endedAt": release.utc(epoch + 1), "published": False})
            (binary / "LICENSE").unlink()
            release.archive_normalized(binary, ["jotter"], bundle / "jotter-1.0.0-linux-amd64.tar.gz", "jotter-1.0.0", epoch)
            (bundle / "SHA256SUMS").write_text(release.checksum_manifest(bundle))
            with self.assertRaisesRegex(release.ReleaseError, "binary archive inventory"):
                release.check_bundle(bundle)

    def test_published_retry_uses_get_only_and_never_replaces_assets(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = Path(temporary)
            identity = {"version": "1.0.0", "revision": "a" * 40}
            provenance = {"identity": identity, "tag": "v1.0.0", "imageDigest": "sha256:" + "a" * 64}
            for name in release.bundle_names("1.0.0"):
                (bundle / name).write_text("synthetic " + name)
            hashes = {name: release.sha256(bundle / name) for name in release.bundle_names("1.0.0")}
            calls = []
            def fake_api(path, method="GET", body=None, raw=False):
                calls.append((path, method))
                self.assertEqual(method, "GET", "immutable retry attempted a release mutation")
                if path == "":
                    return {"private": False}
                if path == "/releases/latest":
                    return {"tag_name": "v1.0.0"}
                return {"id": 1, "tag_name": "v1.0.0", "prerelease": False, "draft": False, "immutable": True}
            environment = {"GITHUB_REPOSITORY": release.REPOSITORY, "GITHUB_REF": "refs/tags/v1.0.0", "GITHUB_SHA": identity["revision"],
                           "JOTTER_IMMUTABLE_RELEASES_ENABLED": "true", "GITHUB_ACTOR": "synthetic", "GITHUB_TOKEN": "synthetic"}
            with patch.dict(os.environ, environment), patch.object(release, "check_bundle", return_value=provenance), \
                 patch.object(release, "api", side_effect=fake_api), patch.object(release, "resolve_remote_tag", return_value=identity["revision"]), \
                 patch.object(release, "remote_assets", return_value=hashes), patch.object(release, "registry_digest", return_value=provenance["imageDigest"]), \
                 patch.object(release, "run") as commands:
                with patch("builtins.print"):
                    release.publish(type("Args", (), {"bundle": str(bundle)})())
            self.assertTrue(calls)
            # Credentials remain a synthetic stdin value; only the login is needed.
            self.assertEqual(commands.call_count, 1)
            self.assertEqual(commands.call_args.args[:3], ("regctl", "registry", "login"))

    def test_no_publication_in_rehearsal(self):
        with patch.object(release, "api", side_effect=AssertionError("publication attempted")), patch.object(release, "source_identity", side_effect=release.ReleaseError("dirty")):
            with self.assertRaises(release.ReleaseError):
                release.rehearse(type("Args", (), {"commit": "HEAD", "tag": "v1.0.0", "require_tag": False})())

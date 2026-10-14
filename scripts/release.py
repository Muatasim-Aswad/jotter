#!/usr/bin/env python3
"""Export, verify, package, and publish one exact Jotter release."""
import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True

REPOSITORY = "Muatasim-Aswad/jotter"
IMAGE = "ghcr.io/muatasim-aswad/jotter"
BUILDKIT = "moby/buildkit:v0.24.0@sha256:6eceb8971ce4fceb3daca562832642706238b7eea72941fcf9896c93c3c4a53e"
ROOT = Path(__file__).resolve().parent.parent
SUPPORT = ROOT / "scripts/release"
SEMVER = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"


class ReleaseError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def run(*args, cwd=ROOT, env=None, capture=False, input=None):
    result = subprocess.run(args, cwd=cwd, env=env, input=input, check=True,
                            stdout=subprocess.PIPE if capture else None, text=True)
    return result.stdout.strip() if capture else None


def git(*args, cwd=ROOT):
    return run("git", *args, cwd=cwd, capture=True)


def utc(epoch=None):
    value = dt.datetime.now(dt.timezone.utc) if epoch is None else dt.datetime.fromtimestamp(epoch, dt.timezone.utc)
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def validate_version(version, tag):
    require(isinstance(version, str) and re.fullmatch(SEMVER, version), "version must be stable SemVer")
    require(tag == "v" + version, "tag does not match root package.json version")


def validate_manifest_versions(version, manifests):
    expected = {"package.json", "apps/web/package.json", "packages/protocol/package.json"}
    exact_inventory(list(manifests), expected, "version manifests")
    for name, manifest in manifests.items():
        require(manifest.get("version") == version, "product version differs in " + name)


def release_notes(changelog, version):
    entries = re.findall(r"^## \[" + re.escape(version) + r"\][^\n]*\n(.*?)(?=^## |\Z)", changelog, re.MULTILINE | re.DOTALL)
    require(len(entries) == 1, "changelog must contain exactly one entry for " + version)
    notes = re.sub(r"^\[[^\]]+\]:[^\n]*$", "", entries[0], flags=re.MULTILINE).strip()
    require(bool(notes), "release changelog entry is empty")
    return notes


def validate_compose_version(version, compose):
    expected = "    image: ${JOTTER_IMAGE:-" + IMAGE + ":v" + version + "}"
    require(expected in compose.splitlines(), "Compose default image differs from product version")


def check_version():
    names = ["package.json", "apps/web/package.json", "packages/protocol/package.json"]
    manifests = {name: json.loads((ROOT / name).read_text()) for name in names}
    version = manifests["package.json"].get("version")
    validate_version(version, "v" + str(version))
    validate_manifest_versions(version, manifests)
    release_notes((ROOT / "CHANGELOG.md").read_text(), version)
    validate_compose_version(version, (ROOT / "compose.yaml").read_text())


def validate_clean(root):
    require(not git("status", "--porcelain", "--untracked-files=all", cwd=root), "release source is dirty or has untracked files")


def source_identity(root, commit, tag, require_tag=False):
    validate_clean(root)
    revision = git("rev-parse", "--verify", commit + "^{commit}", cwd=root)
    require(re.fullmatch(r"[0-9a-f]{40}", revision), "invalid commit")
    require(revision == git("rev-parse", "HEAD", cwd=root), "checkout must be at the exact release commit")
    manifest = json.loads(git("show", revision + ":package.json", cwd=root))
    version = manifest.get("version")
    tag = tag or "v" + str(version)
    validate_version(version, tag)
    if require_tag:
        require(git("rev-parse", "refs/tags/" + tag + "^{commit}", cwd=root) == revision, "tag points at another commit")
    manifests = {"package.json": manifest}
    for name in ["apps/web/package.json", "packages/protocol/package.json"]:
        manifests[name] = json.loads(git("show", revision + ":" + name, cwd=root))
    validate_manifest_versions(version, manifests)
    release_notes(git("show", revision + ":CHANGELOG.md", cwd=root), version)
    epoch = int(git("show", "-s", "--format=%ct", revision, cwd=root))
    return {"version": version, "revision": revision, "committedAt": utc(epoch), "builtAt": utc(epoch)}, tag, epoch


def build_env(root, identity, epoch):
    env = os.environ.copy()
    env.update(APP_VERSION=identity["version"], APP_REVISION=identity["revision"],
               APP_COMMIT_TIME=identity["committedAt"] or "", APP_BUILD_TIME=identity["builtAt"],
               SOURCE_DATE_EPOCH=str(epoch), MISE_TRUSTED_CONFIG_PATHS=str(root / "mise.toml"),
               MISE_LOCKED_SCOPES="project", GOOS="linux", GOARCH="amd64", CGO_ENABLED="0",
               GOTOOLCHAIN="local", GOFLAGS="-mod=readonly -trimpath -buildvcs=false")
    # A full verification gate includes the Go race detector, which requires CGO.
    env.pop("CGO_ENABLED")
    return env


def safe_path(name):
    path = PurePosixPath(name)
    require(name and not path.is_absolute() and ".." not in path.parts and str(path) == name,
            "unsafe inventory path: " + name)
    require(not any(part in {".git", "node_modules", ".build", "data"} for part in path.parts), "private/generated inventory path: " + name)
    require(not name.startswith("docs/plans/") and not name.endswith(".local.md"), "private inventory path: " + name)
    require(not any(part.startswith(".env") and part != ".env.example" for part in path.parts), "private environment file: " + name)


def inventory(root):
    files = []
    for path in sorted(root.rglob("*")):
        require(not path.is_symlink(), "symlinks are not allowed in release inventories")
        if path.is_file():
            files.append(path.relative_to(root).as_posix())
    return files


def source_allowlist(root):
    lines = (root / "scripts/release/source-inventory.txt").read_text().splitlines()
    require(lines == sorted(set(lines)), "source inventory must be sorted and unique")
    for name in lines:
        safe_path(name)
    return lines


def exact_inventory(actual, expected, label):
    require(len(actual) == len(set(actual)), label + " contains duplicate files")
    require(set(actual) == set(expected), label + " inventory mismatch; unexpected=" + repr(sorted(set(actual) - set(expected))) + "; missing=" + repr(sorted(set(expected) - set(actual))))


def validate_web(root):
    rules = json.loads((SUPPORT / "web-inventory.json").read_text())
    files = inventory(root)
    require(set(rules["required"]).issubset(files), "web output is missing required files")
    for name in files:
        require(any(re.fullmatch(pattern, name) for pattern in rules["allowed"]), "unexpected web output: " + name)
    return files


def extract_regular(archive, destination, prefix=""):
    with tarfile.open(archive, "r:*") as tar:
        members = tar.getmembers()
        seen = set()
        for member in members:
            name = member.name.rstrip("/")
            require(not PurePosixPath(name).is_absolute() and ".." not in PurePosixPath(name).parts, "unsafe archive path")
            require(member.isdir() or member.isfile(), "archive links and special files are forbidden")
            if member.isdir():
                continue
            require(name not in seen, "duplicate archive member")
            seen.add(name)
            require(not prefix or name.startswith(prefix + "/"), "archive prefix mismatch")
            relative = name[len(prefix) + 1:] if prefix else name
            safe_path(relative)
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(member) as stream:
                target.write_bytes(stream.read())
            target.chmod(0o755 if member.mode & 0o111 else 0o644)


def archive_normalized(root, names, target, prefix, epoch):
    with target.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=epoch) as zipped:
        with tarfile.open(fileobj=zipped, mode="w", format=tarfile.USTAR_FORMAT) as tar:
            for name in sorted(names):
                safe_path(name)
                path = root / name
                require(path.is_file() and not path.is_symlink(), "non-regular archive input")
                entry = tarfile.TarInfo(prefix + "/" + name)
                entry.size = path.stat().st_size
                entry.mode = 0o755 if path.stat().st_mode & 0o111 else 0o644
                entry.mtime = epoch
                entry.uid = entry.gid = 0
                entry.uname = entry.gname = ""
                with path.open("rb") as stream:
                    tar.addfile(entry, stream)


def scan(root, env, target):
    scanner_env = env.copy()
    for key in list(scanner_env):
        if key.startswith("GITLEAKS_"):
            del scanner_env[key]
    run("mise", "exec", "--", "gitleaks", "dir", "--redact=100", "--no-banner", "--no-color",
        "--ignore-gitleaks-allow", "--gitleaks-ignore-path", str(root / "scripts/release/empty-ignore"),
        "--config", str(root / "scripts/release/gitleaks.toml"), "--max-archive-depth", "4", str(target), cwd=root, env=scanner_env)


def image_build(root, identity, epoch, image):
    env = build_env(root, identity, epoch)
    builder = "jotter-release-" + str(os.getpid())
    with tempfile.TemporaryDirectory(prefix="jotter-image-export-") as temporary:
        oci = Path(env.get("JOTTER_IMAGE_ARCHIVE", str(Path(temporary) / "image.tar")))
        docker = Path(env.get("JOTTER_DOCKER_ARCHIVE", str(Path(temporary) / "docker-image.tar")))
        run("docker", "buildx", "create", "--name", builder, "--driver", "docker-container", "--driver-opt", "image=" + BUILDKIT, env=env)
        try:
            args = ["docker", "buildx", "build", "--builder", builder, "--platform", "linux/amd64", "--pull", "--provenance=false", "--tag", image,
                    "--output", "type=oci,compression=gzip,force-compression=true,rewrite-timestamp=true,dest=" + str(oci),
                    "--output", "type=docker,rewrite-timestamp=true,dest=" + str(docker),
                    "--build-arg", "SOURCE_DATE_EPOCH=" + str(epoch)]
            metadata = {"APP_VERSION": identity["version"]}
            if identity["revision"] != "dev":
                metadata.update(APP_REVISION=identity["revision"], APP_COMMIT_TIME=identity["committedAt"], APP_BUILD_TIME=identity["builtAt"])
            for name, value in metadata.items():
                args += ["--build-arg", name + "=" + (value or "")]
            run(*args, str(root), env=env)
            run("docker", "load", "--input", str(docker), env=env)
        finally:
            run("docker", "buildx", "rm", builder, env=env)
        image_id = run("docker", "image", "inspect", image, "--format", "{{.Id}}", capture=True)
        config_digest = validate_image_archive(docker)
        validate_oci_archive(oci, config_digest)
        validate_loaded_image(docker, image)
        return image_id


def smoke_binary(binary, identity):
    require(json.loads(run(str(binary), "build-info", capture=True)) == identity, "packaged CLI build identity mismatch")
    version = run(str(binary), "--version", capture=True)
    require(identity["version"] in version and identity["revision"] in version, "packaged CLI version mismatch")
    with tempfile.TemporaryDirectory(prefix="jotter-binary-smoke-") as temporary:
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        env = os.environ.copy()
        env.update(AUTH_DISABLED="true", JOTTER_ENV="production", JOTTER_DATA_DIR=temporary,
                   JOTTER_LISTEN_ADDR=f"127.0.0.1:{port}", JOTTER_PUBLIC_ORIGIN="https://jotter.invalid")
        with open(os.devnull, "w") as log:
            process = subprocess.Popen([str(binary)], env=env, stdout=log, stderr=log)
            try:
                url = f"http://127.0.0.1:{port}"
                for _ in range(100):
                    require(process.poll() is None, "packaged binary exited before readiness")
                    try:
                        with urllib.request.urlopen(url + "/health/ready", timeout=1):
                            break
                    except (urllib.error.URLError, TimeoutError):
                        time.sleep(0.1)
                else:
                    raise ReleaseError("packaged binary readiness timeout")
                with urllib.request.urlopen(url + "/version.json", timeout=5) as response:
                    require(response.headers.get("Cache-Control") == "no-store", "packaged identity must be uncached")
                    require(json.load(response) == identity, "packaged binary identity mismatch")
                with urllib.request.urlopen(url + "/", timeout=5) as response:
                    require(b"<title>Jotter</title>" in response.read(), "packaged binary lacks editor")
            finally:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


IMAGE_EXPORTS = ("docker-image.tar", "image.tar")


def release_names(version):
    return ["BUILD-ATTEMPT.json", "PROVENANCE.json", "SHA256SUMS",
            f"jotter-{version}-linux-amd64.tar.gz", f"jotter-{version}-source.tar.gz"]


def bundle_names(version):
    return release_names(version) + list(IMAGE_EXPORTS)


def checksum_manifest(bundle):
    return "".join(f"{sha256(bundle / name)}  {name}\n" for name in sorted(inventory(bundle)) if name not in ("SHA256SUMS", *IMAGE_EXPORTS))


def check_bundle(bundle):
    provenance = json.loads((bundle / "PROVENANCE.json").read_text())
    require(provenance["schema"] == 2 and provenance["builder"] == BUILDKIT, "bundle build policy mismatch")
    identity = provenance["identity"]
    validate_version(identity["version"], provenance["tag"])
    require(provenance["repository"] == REPOSITORY and provenance["image"] == IMAGE, "bundle repository mismatch")
    require(re.fullmatch(r"[0-9a-f]{40}", identity["revision"]), "bundle revision invalid")
    require(identity["committedAt"] == identity["builtAt"] == utc(provenance["sourceDateEpoch"]), "bundle timestamp policy mismatch")
    exact_inventory(inventory(bundle), bundle_names(identity["version"]), "bundle")
    require((bundle / "SHA256SUMS").read_text() == checksum_manifest(bundle), "bundle checksum mismatch")
    exact_inventory(provenance["imageExports"], IMAGE_EXPORTS, "CI image exports")
    for name, digest in provenance["imageExports"].items():
        require(sha256(bundle / name) == digest, "CI image export checksum mismatch: " + name)
    attempt = json.loads((bundle / "BUILD-ATTEMPT.json").read_text())
    require(attempt["schema"] == 1 and attempt["revision"] == identity["revision"] and attempt["published"] is False, "build attempt identity mismatch")
    require(dt.datetime.fromisoformat(attempt["startedAt"]) <= dt.datetime.fromisoformat(attempt["endedAt"]), "build attempt timestamps out of order")
    exact_inventory(provenance["binaryInventory"], ["DEPENDENCY-NOTICES.txt", "LICENSE", "jotter"], "provenance binary")
    with tempfile.TemporaryDirectory(prefix="jotter-check-bundle-") as temporary:
        root = Path(temporary)
        source = root / "source"
        binary = root / "binary"
        version = identity["version"]
        extract_regular(bundle / f"jotter-{version}-source.tar.gz", source, "jotter-" + version)
        exact_inventory(inventory(source), source_allowlist(source), "source archive")
        exact_inventory(inventory(source), provenance["sourceInventory"], "provenance source")
        require(sha256(source / "mise.lock") == provenance["toolLockSha256"], "tool lock provenance mismatch")
        require(sha256(source / "pnpm-lock.yaml") == provenance["dependencyLockSha256"], "dependency lock provenance mismatch")
        manifests = {name: json.loads((source / name).read_text()) for name in ["package.json", "apps/web/package.json", "packages/protocol/package.json"]}
        validate_manifest_versions(version, manifests)
        require(provenance["releaseNotes"] == release_notes((source / "CHANGELOG.md").read_text(), version), "release notes differ from source changelog")
        extract_regular(bundle / f"jotter-{version}-linux-amd64.tar.gz", binary, "jotter-" + version)
        exact_inventory(inventory(binary), ["jotter", "LICENSE", "DEPENDENCY-NOTICES.txt"], "binary archive")
        require((binary / "LICENSE").read_bytes() == (source / "LICENSE").read_bytes(), "binary license mismatch")
        require(sha256(binary / "DEPENDENCY-NOTICES.txt") == provenance["dependencyNoticesSha256"], "binary dependency notices mismatch")
        require(provenance["runtimeInventory"]["usr/share/licenses/jotter/DEPENDENCY-NOTICES.txt"]["sha256"] == provenance["dependencyNoticesSha256"], "runtime dependency notices mismatch")
        require((binary / "jotter").read_bytes()[:4] == b"\x7fELF", "binary must be Linux ELF")
    validate_image_archive(bundle / "docker-image.tar", provenance["imageConfigDigest"])
    require(validate_oci_archive(bundle / "image.tar", provenance["imageConfigDigest"]) == provenance["imageDigest"], "OCI manifest provenance mismatch")
    require(provenance["platform"] == "linux/amd64", "bundle platform mismatch")
    return provenance


def smoke_bundle(bundle):
    provenance = check_bundle(bundle)
    identity = provenance["identity"]
    with tempfile.TemporaryDirectory(prefix="jotter-smoke-bundle-") as temporary:
        root = Path(temporary)
        extract_regular(bundle / f"jotter-{identity['version']}-linux-amd64.tar.gz", root, "jotter-" + identity["version"])
        smoke_binary(root / "jotter", identity)
    run("docker", "load", "--input", str(bundle / "docker-image.tar"))
    image = provenance["localImage"]
    validate_loaded_image(bundle / "docker-image.tar", image)
    env = build_env(ROOT, identity, provenance["sourceDateEpoch"])
    env.update(JOTTER_IMAGE=image, JOTTER_SKIP_IMAGE_BUILD="1")
    run("bash", "scripts/verify-container.sh", env=env)


def rehearse(args):
    started = utc()
    identity, tag, epoch = source_identity(ROOT, args.commit, args.tag, args.require_tag)
    output = Path(args.output).resolve()
    require(not output.exists(), "output must not already exist; retain the tested bundle for publication retries")
    # Exported tools and allowlists must be from the same commit as the artifacts.
    with tempfile.TemporaryDirectory(prefix="jotter-release-") as temporary:
        work = Path(temporary)
        exported = work / "source"
        raw = work / "git-archive.tar"
        with raw.open("wb") as stream:
            subprocess.run(["git", "archive", "--format=tar", identity["revision"]], cwd=ROOT, stdout=stream, check=True)
        extract_regular(raw, exported)
        expected = source_allowlist(exported)
        exact_inventory(inventory(exported), expected, "exported source")
        env = build_env(exported, identity, epoch)
        image = IMAGE + ":rehearsal-" + identity["revision"]
        env["JOTTER_IMAGE"] = image
        env["JOTTER_IMAGE_ARCHIVE"] = str(work / "image.tar")
        env["JOTTER_DOCKER_ARCHIVE"] = str(work / "docker-image.tar")
        run("mise", "install", "--locked", cwd=exported, env=env)
        scan(exported, env, exported)
        run("mise", "exec", "--", "pnpm", "install", "--frozen-lockfile", cwd=exported, env=env)
        run("mise", "exec", "--", "pnpm", "--filter", "@jotter/web", "exec", "playwright", "install", "chromium", cwd=exported, env=env)
        run("mise", "run", "verify", cwd=exported, env=env)
        web_files = validate_web(exported / "apps/web/dist")
        require(json.loads((exported / "apps/web/dist/version.json").read_text()) == identity, "built web identity mismatch")
        scan(exported, env, exported / "apps/web/dist")
        packaged = work / "binary"
        packaged.mkdir()
        # The race gate runs with CGO; the distributed binary is a static amd64 build.
        binary_env = env.copy()
        binary_env["CGO_ENABLED"] = "0"
        run("mise", "exec", "--", "go", "build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w", "-o", str(packaged / "jotter"), "./cmd/jotter", cwd=exported / "apps/server", env=binary_env)
        shutil.copyfile(exported / "LICENSE", packaged / "LICENSE")
        notices = run("mise", "exec", "--", "go", "run", "../../scripts/release/go-notices.go", cwd=exported / "apps/server", env=binary_env, capture=True)
        (packaged / "DEPENDENCY-NOTICES.txt").write_text(notices + "\n" + (exported / "apps/web/dist/licenses.txt").read_text())
        smoke_binary(packaged / "jotter", identity)
        scan(exported, env, packaged)
        image_id = run("docker", "image", "inspect", image, "--format", "{{.Id}}", capture=True)
        runtime_files = scan_runtime(exported, image, env, work)
        require(runtime_files["usr/share/licenses/jotter/DEPENDENCY-NOTICES.txt"]["sha256"] == sha256(packaged / "DEPENDENCY-NOTICES.txt"), "runtime/binary dependency notices differ")
        bundle = work / "bundle"
        bundle.mkdir()
        # Archive pristine exported files, never generated files or installed dependencies.
        pristine = work / "pristine"
        extract_regular(raw, pristine)
        archive_normalized(pristine, expected, bundle / f"jotter-{identity['version']}-source.tar.gz", "jotter-" + identity["version"], epoch)
        archive_normalized(packaged, ["jotter", "LICENSE", "DEPENDENCY-NOTICES.txt"], bundle / f"jotter-{identity['version']}-linux-amd64.tar.gz", "jotter-" + identity["version"], epoch)
        shutil.copyfile(work / "image.tar", bundle / "image.tar")
        shutil.copyfile(work / "docker-image.tar", bundle / "docker-image.tar")
        config_digest = validate_image_archive(bundle / "docker-image.tar")
        image_digest = validate_oci_archive(bundle / "image.tar", config_digest)
        scan(exported, env, bundle)
        write_json(bundle / "PROVENANCE.json", {"schema": 2, "repository": REPOSITORY, "image": IMAGE,
                   "identity": identity, "tag": tag, "sourceDateEpoch": epoch, "platform": "linux/amd64",
                   "releaseNotes": release_notes((pristine / "CHANGELOG.md").read_text(), identity["version"]),
                   "imageConfigDigest": config_digest, "imageDigest": image_digest, "localImage": image, "builder": BUILDKIT, "sourceInventory": expected,
                   "imageExports": {name: sha256(bundle / name) for name in IMAGE_EXPORTS},
                   "dependencyNoticesSha256": sha256(packaged / "DEPENDENCY-NOTICES.txt"), "webInventory": web_files, "runtimeInventory": runtime_files, "binaryInventory": ["DEPENDENCY-NOTICES.txt", "LICENSE", "jotter"],
                   "gate": "mise run verify", "toolLockSha256": sha256(pristine / "mise.lock"),
                   "dependencyLockSha256": sha256(pristine / "pnpm-lock.yaml")})
        write_json(bundle / "BUILD-ATTEMPT.json", {"schema": 1, "startedAt": started, "endedAt": utc(),
                   "revision": identity["revision"], "localImageId": image_id,
                   "python": sys.version.split()[0], "mise": run("mise", "--version", cwd=exported, env=env, capture=True),
                   "docker": run("docker", "version", "--format", "{{.Client.Version}} / {{.Server.Version}}", capture=True),
                   "buildx": run("docker", "buildx", "version", capture=True), "runId": os.environ.get("GITHUB_RUN_ID"),
                   "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"), "published": False})
        (bundle / "SHA256SUMS").write_text(checksum_manifest(bundle))
        scan(exported, env, bundle)
        check_bundle(bundle)
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(bundle, output)
    print("verified no-publish bundle: " + str(output))


def filesystem_inventory(path):
    result = {}
    with tarfile.open(path) as tar:
        for member in tar.getmembers():
            name = member.name.rstrip("/")
            require(name and not PurePosixPath(name).is_absolute() and ".." not in PurePosixPath(name).parts, "unsafe runtime path")
            require(name not in result, "duplicate runtime path")
            record = {"type": member.type.decode(), "mode": member.mode, "uid": member.uid, "gid": member.gid}
            if member.isfile():
                if name in {"etc/hostname", "etc/hosts", "etc/resolv.conf", ".dockerenv"}:
                    record["runtimeGenerated"] = True
                else:
                    with tar.extractfile(member) as stream:
                        record["sha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
            elif member.issym() or member.islnk():
                record["target"] = member.linkname
            result[name] = record
    return result


def validate_runtime_inventory(base, actual):
    additions = {"data", "usr/local", "usr/local/bin", "usr/local/bin/jotter", "usr/share", "usr/share/licenses", "usr/share/licenses/jotter", "usr/share/licenses/jotter/LICENSE", "usr/share/licenses/jotter/DEPENDENCY-NOTICES.txt"}
    mutable = {"etc/passwd", "etc/group", "etc/shadow", "etc/gshadow", "etc/hostname", "etc/hosts", "etc/resolv.conf", ".dockerenv"}
    expected = set(base) | additions
    # Parent directories already present in the base remain unchanged.
    require(set(actual) == expected, "unexpected or missing runtime image paths: " + repr(sorted(set(actual) ^ expected)))
    for name in base:
        if name not in mutable:
            require(actual[name] == base[name], "unexpected changed base-image path: " + name)
    require(actual["data"]["mode"] == 0o700 and actual["data"]["uid"] == actual["data"]["gid"] == 10001, "runtime data directory ownership mismatch")
    require(actual["usr/local/bin/jotter"]["mode"] == 0o555, "runtime executable permissions mismatch")
    for name in ["LICENSE", "DEPENDENCY-NOTICES.txt"]:
        require(actual["usr/share/licenses/jotter/" + name]["mode"] == 0o444, "runtime license permissions mismatch")


def scan_runtime(root, image, env, work):
    dockerfile = (root / "Dockerfile").read_text()
    base_image = re.search(r"^FROM (alpine:[^ ]+@sha256:[0-9a-f]{64}) AS runtime$", dockerfile, re.MULTILINE)
    require(base_image is not None, "runtime base must be digest-pinned Alpine")
    run("docker", "pull", "--platform", "linux/amd64", base_image[1])
    snapshots = []
    for selected in [base_image[1], image]:
        container = run("docker", "create", "--platform", "linux/amd64", "--entrypoint", "/bin/true", selected, capture=True)
        try:
            path = work / ("base-rootfs.tar" if not snapshots else "runtime-rootfs.tar")
            run("docker", "export", "--output", str(path), container)
            snapshots.append(filesystem_inventory(path))
        finally:
            run("docker", "rm", container)
    validate_runtime_inventory(*snapshots)
    require(snapshots[1]["usr/share/licenses/jotter/LICENSE"]["sha256"] == sha256(root / "LICENSE"), "runtime license content differs from source")
    scan(root, env, work / "runtime-rootfs.tar")
    return snapshots[1]


def validate_oci_archive(path, image_id):
    with tarfile.open(path) as tar:
        files = [member.name for member in tar.getmembers() if member.isfile()]
        require(len(files) == len(set(files)), "duplicate OCI archive member")
        for member in tar.getmembers():
            require(member.isfile() or member.isdir(), "OCI archive links are forbidden")
            require(not PurePosixPath(member.name).is_absolute() and ".." not in PurePosixPath(member.name).parts, "unsafe OCI archive path")
        require(json.load(tar.extractfile("oci-layout")) == {"imageLayoutVersion": "1.0.0"}, "unsupported OCI layout")
        index = json.load(tar.extractfile("index.json"))
        require(len(index["manifests"]) == 1, "OCI archive must contain one image")
        descriptor = index["manifests"][0]
        require(descriptor["mediaType"] == "application/vnd.oci.image.manifest.v1+json", "OCI archive must describe one platform manifest")
        expected = {"oci-layout", "index.json"}
        pending = [descriptor]
        manifest_digest = descriptor["digest"]
        while pending:
            descriptor = pending.pop()
            digest = descriptor["digest"]
            require(re.fullmatch(r"sha256:[0-9a-f]{64}", digest), "invalid OCI digest")
            name = "blobs/sha256/" + digest.split(":")[1]
            data = tar.extractfile(name).read()
            require(len(data) == descriptor["size"] and hashlib.sha256(data).hexdigest() == digest.split(":")[1], "OCI blob integrity mismatch")
            require(name not in expected, "duplicate OCI reference")
            expected.add(name)
            if descriptor["mediaType"] == "application/vnd.oci.image.manifest.v1+json":
                manifest = json.loads(data)
                require(manifest["config"]["digest"] == image_id, "OCI and tested Docker config differ")
                pending.extend([manifest["config"], *manifest["layers"]])
            elif descriptor["mediaType"] == "application/vnd.oci.image.config.v1+json":
                config = json.loads(data)
                require(config["os"] == "linux" and config["architecture"] == "amd64", "OCI platform mismatch")
        exact_inventory(files, expected, "OCI archive")
        return manifest_digest


def validate_image_archive(path, expected=None):
    # Docker-save inventory is closed over the manifest, config, and layer references.
    with tarfile.open(path) as tar:
        members = {member.name: member for member in tar.getmembers() if member.isfile()}
        require(len(members) == len([member for member in tar.getmembers() if member.isfile()]), "duplicate image archive member")
        for member in tar.getmembers():
            require(member.isfile() or member.isdir(), "unexpected image archive type")
            require(not PurePosixPath(member.name).is_absolute() and ".." not in PurePosixPath(member.name).parts, "unsafe image archive path")
        manifest = json.load(tar.extractfile("manifest.json"))
        require(len(manifest) == 1, "image archive must contain one image")
        config_name = manifest[0]["Config"]
        config = tar.extractfile(config_name).read()
        config_digest = "sha256:" + hashlib.sha256(config).hexdigest()
        require(expected is None or config_digest == expected, "image config digest mismatch")
        expected = {"manifest.json", config_name, *manifest[0]["Layers"]}
        # Modern Docker emits an OCI-compatible index as well as a Docker manifest.
        if "index.json" in members:
            index = json.load(tar.extractfile("index.json"))
            expected.update({"index.json", "oci-layout"})
            pending = list(index["manifests"])
            while pending:
                descriptor = pending.pop()
                digest = descriptor["digest"]
                require(re.fullmatch(r"sha256:[0-9a-f]{64}", digest), "invalid OCI descriptor")
                name = "blobs/sha256/" + digest.split(":")[1]
                data = tar.extractfile(name).read()
                require(hashlib.sha256(data).hexdigest() == digest.split(":")[1], "OCI blob digest mismatch")
                expected.add(name)
                if "manifest" in descriptor["mediaType"] or "index" in descriptor["mediaType"]:
                    doc = json.loads(data)
                    pending += doc.get("manifests", []) + doc.get("layers", [])
                    if "config" in doc:
                        pending.append(doc["config"])
        if "repositories" in members:
            expected.add("repositories")
        exact_inventory(list(members), expected, "saved image")
        config_doc = json.loads(config)
        require(config_doc["architecture"] == "amd64" and config_doc["os"] == "linux", "saved image is not linux/amd64")
        return config_digest


def validate_loaded_image(archive, image):
    with tarfile.open(archive) as tar:
        manifest = json.load(tar.extractfile("manifest.json"))[0]
        config = json.load(tar.extractfile(manifest["Config"]))
    actual = json.loads(run("docker", "image", "inspect", image, capture=True))[0]
    require(actual["Os"] == "linux" and actual["Architecture"] == "amd64", "loaded image platform mismatch")
    require(actual["RootFS"]["Layers"] == config["rootfs"]["diff_ids"], "loaded image filesystem differs from OCI build")
    for field in ["Env", "Entrypoint", "User", "WorkingDir", "ExposedPorts", "Labels", "StopSignal", "Healthcheck"]:
        require(actual["Config"].get(field) == config["config"].get(field), "loaded image config differs: " + field)


def scan_source():
    env = os.environ.copy()
    env.update(MISE_TRUSTED_CONFIG_PATHS=str(ROOT / "mise.toml"), MISE_LOCKED_SCOPES="project")
    names = source_allowlist(ROOT)
    with tempfile.TemporaryDirectory(prefix="jotter-source-scan-") as temporary:
        target = Path(temporary)
        for name in names:
            source = ROOT / name
            require(source.is_file() and not source.is_symlink(), "missing/non-regular source scan input: " + name)
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        scan(ROOT, env, target)


def scan_range(args):
    env = os.environ.copy()
    env.update(MISE_TRUSTED_CONFIG_PATHS=str(ROOT / "mise.toml"), MISE_LOCKED_SCOPES="project")
    for revision in [args.before, args.after]:
        require(re.fullmatch(r"[0-9a-f]{40}", revision), "scan range must use full commit SHAs")
    require(args.after != "0" * 40, "cannot scan a deleted ref")
    git("rev-parse", "--verify", args.after + "^{commit}")
    if args.before == "0" * 40:
        range_arg = args.after
    else:
        git("rev-parse", "--verify", args.before + "^{commit}")
        range_arg = args.before + ".." + args.after
    run("mise", "exec", "--", "gitleaks", "git", "--redact=100", "--no-banner", "--no-color", "--ignore-gitleaks-allow",
        "--config", str(SUPPORT / "gitleaks.toml"), "--gitleaks-ignore-path", str(SUPPORT / "empty-ignore"),
        "--log-opts=" + range_arg, str(ROOT), env=env)


class AssetRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        require(urllib.parse.urlparse(new_url).scheme == "https", "non-HTTPS API redirect")
        redirected = super().redirect_request(request, response, code, message, headers, new_url)
        if redirected:
            redirected.remove_header("Authorization")
        return redirected


def api(path, method="GET", body=None, raw=False):
    url = path if path.startswith("https://") else "https://api.github.com/repos/" + REPOSITORY + path
    require(urllib.parse.urlparse(url).hostname in {"api.github.com", "uploads.github.com"}, "unexpected API host")
    headers = {"Authorization": "Bearer " + os.environ["GITHUB_TOKEN"], "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "jotter-release"}
    if raw:
        headers["Accept"] = "application/octet-stream"
    if body is not None:
        headers["Content-Type"] = "application/octet-stream" if isinstance(body, bytes) else "application/json"
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    with urllib.request.build_opener(AssetRedirect()).open(request, timeout=120) as response:
        result = response.read()
    return result if raw else json.loads(result) if result else None


def retry_plan(expected, existing, published):
    require(len(existing) == len(set(existing)), "duplicate remote assets")
    require(set(existing).issubset(expected), "unexpected remote release assets")
    for name, digest in existing.items():
        require(digest == expected[name], "remote asset differs: " + name)
    missing = sorted(set(expected) - set(existing))
    require(not published or not missing, "published release is incomplete; immutable assets cannot be changed")
    return missing


def remote_assets(release):
    assets = api(f"/releases/{release['id']}/assets?per_page=100")
    require(len(assets) < 100, "too many release assets")
    result = {}
    for asset in assets:
        require(asset["name"] not in result and asset["state"] == "uploaded", "duplicate or incomplete remote asset")
        content = api(asset["url"], raw=True)
        result[asset["name"]] = hashlib.sha256(content).hexdigest()
    return result


def resolve_remote_tag(tag):
    ref = api("/git/ref/tags/" + tag)["object"]
    for _ in range(5):
        if ref["type"] == "commit":
            return ref["sha"]
        require(ref["type"] == "tag", "unexpected remote tag target")
        ref = api("/git/tags/" + ref["sha"])["object"]
    raise ReleaseError("remote tag nesting is too deep")


def registry_digest(tag):
    result = subprocess.run(["regctl", "image", "digest", IMAGE + ":" + tag], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        require("not found" in result.stderr.lower() or "manifest unknown" in result.stderr.lower(), "registry lookup failed; refusing to treat it as missing")
        return None
    digest = result.stdout.strip()
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", digest), "registry returned invalid digest")
    return digest


def push_image(provenance, bundle, latest=False):
    expected = provenance["imageDigest"]
    for tag in ["v" + provenance["identity"]["version"], "sha-" + provenance["identity"]["revision"]] + (["latest"] if latest else []):
        remote = registry_digest(tag)
        if remote == expected:
            continue
        require(remote is None or tag == "latest", "refusing to move existing image tag: " + tag)
        run("regctl", "image", "import", IMAGE + ":" + tag, str(bundle / "image.tar"))
        require(registry_digest(tag) == expected, "published image manifest digest mismatch")


def should_promote_latest(tag):
    try:
        latest = api("/releases/latest")["tag_name"]
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return True
        raise
    require(re.fullmatch("v" + SEMVER, latest), "latest release tag is not stable SemVer")
    return tuple(map(int, tag[1:].split("."))) >= tuple(map(int, latest[1:].split(".")))


def publish(args):
    bundle = Path(args.bundle).resolve()
    provenance = check_bundle(bundle)
    identity = provenance["identity"]
    tag = provenance["tag"]
    require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY and os.environ.get("GITHUB_REF") == "refs/tags/" + tag,
            "publication requires the canonical repository tag workflow")
    require(os.environ.get("GITHUB_SHA") == identity["revision"], "workflow commit differs from tested bundle")
    require(api("")["private"] is False, "release repository must be public")
    # The settings endpoint needs admin read, unavailable to GITHUB_TOKEN. The
    # coordinator sets this variable only after querying the enabled setting.
    require(os.environ.get("JOTTER_IMMUTABLE_RELEASES_ENABLED") == "true", "coordinator must verify immutable releases and set JOTTER_IMMUTABLE_RELEASES_ENABLED=true")
    require(resolve_remote_tag(tag) == identity["revision"], "remote tag differs from tested commit")
    try:
        release = api("/releases/tags/" + tag)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        releases = api("/releases?per_page=100")
        require(len(releases) < 100, "release lookup requires pagination")
        matches = [item for item in releases if item["tag_name"] == tag]
        require(len(matches) <= 1, "duplicate remote releases for tag")
        release = matches[0] if matches else None
    expected = {name: sha256(bundle / name) for name in release_names(identity["version"])}
    if release:
        require(release["tag_name"] == tag and not release["prerelease"], "release identity mismatch")
        require(release["draft"] or release.get("immutable") is True, "published release is not immutable")
        missing = retry_plan(expected, remote_assets(release), not release["draft"])
    else:
        release = api("/releases", "POST", {"tag_name": tag, "target_commitish": identity["revision"], "name": tag,
                      "draft": True, "prerelease": False, "body": provenance["releaseNotes"] + "\n\nVerified with `mise run verify`, exact source/artifact inventories, secret scans, and packaged binary/container smoke tests. Build identity, tool/dependency locks, and SHA-256 checksums are included in the release assets."})
        missing = sorted(expected)
    for name in missing:
        url = release["upload_url"].split("{")[0] + "?" + urllib.parse.urlencode({"name": name})
        api(url, "POST", (bundle / name).read_bytes())
    retry_plan(expected, remote_assets(release), True)
    require(resolve_remote_tag(tag) == identity["revision"], "remote tag changed during upload")
    with tempfile.TemporaryDirectory(prefix="jotter-registry-auth-") as docker_config:
        previous = os.environ.get("REGCTL_CONFIG")
        os.environ["REGCTL_CONFIG"] = str(Path(docker_config) / "config.json")
        try:
            run("regctl", "registry", "login", "ghcr.io", "--user", os.environ["GITHUB_ACTOR"], "--pass-stdin", input=os.environ["GITHUB_TOKEN"] + "\n")
            push_image(provenance, bundle)
            if release["draft"]:
                release = api(f"/releases/{release['id']}", "PATCH", {"draft": False, "make_latest": "true" if should_promote_latest(tag) else "false"})
            require(release.get("immutable") is True, "published release is not immutable")
            retry_plan(expected, remote_assets(release), True)
            if api("/releases/latest")["tag_name"] == tag:
                push_image(provenance, bundle, latest=True)
        finally:
            if previous is None:
                os.environ.pop("REGCTL_CONFIG", None)
            else:
                os.environ["REGCTL_CONFIG"] = previous
    print("published immutable verified bundle " + tag)


def self_test():
    import unittest
    sys.path.insert(0, str(SUPPORT))
    import test_release
    suite = unittest.defaultTestLoader.loadTestsFromModule(test_release)
    require(unittest.TextTestRunner(verbosity=1).run(suite).wasSuccessful(), "release self-tests failed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("self-test")
    sub.add_parser("check-version")
    rehearsal = sub.add_parser("rehearse")
    rehearsal.add_argument("--commit", default="HEAD")
    rehearsal.add_argument("--tag")
    rehearsal.add_argument("--require-tag", action="store_true")
    rehearsal.add_argument("--output", default=".build/release-bundle")
    sub.add_parser("image-build")
    sub.add_parser("scan-source")
    for command in ["check-bundle", "smoke-bundle", "publish"]:
        cmd = sub.add_parser(command)
        cmd.add_argument("--bundle", required=True)
    scanner = sub.add_parser("scan-range")
    scanner.add_argument("--before", required=True)
    scanner.add_argument("--after", required=True)
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
    elif args.command == "check-version":
        check_version()
        print("product versions, Compose image, and changelog agree")
    elif args.command == "rehearse":
        rehearse(args)
    elif args.command == "image-build":
        if os.environ.get("APP_REVISION"):
            identity = {"version": json.loads((ROOT / "package.json").read_text())["version"],
                        "revision": os.environ["APP_REVISION"], "committedAt": os.environ["APP_COMMIT_TIME"], "builtAt": os.environ["APP_BUILD_TIME"]}
            epoch = int(os.environ["SOURCE_DATE_EPOCH"])
            require(re.fullmatch(r"[0-9a-f]{40}", identity["revision"]), "explicit image revision must be a full SHA")
            require(identity["builtAt"] == identity["committedAt"] == utc(epoch), "explicit image time must derive from commit epoch")
        else:
            # Local verification can build dirty sources, honestly labelled dev.
            version = json.loads((ROOT / "package.json").read_text())["version"]
            try:
                identity, _, epoch = source_identity(ROOT, "HEAD", None)
            except ReleaseError:
                epoch = int(git("show", "-s", "--format=%ct", "HEAD"))
                identity = {"version": version, "revision": "dev", "committedAt": None, "builtAt": utc(epoch)}
        print(image_build(ROOT, identity, epoch, os.environ.get("JOTTER_IMAGE", IMAGE + ":v" + identity["version"])))
    elif args.command == "scan-source":
        scan_source()
    elif args.command == "scan-range":
        scan_range(args)
    elif args.command == "check-bundle":
        check_bundle(Path(args.bundle).resolve())
        print("bundle inventories and checksums passed")
    elif args.command == "smoke-bundle":
        smoke_bundle(Path(args.bundle).resolve())
    else:
        publish(args)


if __name__ == "__main__":
    try:
        main()
    except (ReleaseError, subprocess.CalledProcessError, urllib.error.URLError, KeyError, ValueError, OSError) as error:
        print("release failed: " + str(error), file=sys.stderr)
        sys.exit(1)

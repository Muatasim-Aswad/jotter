#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "${repository_root}/package.json")"
image="${JOTTER_IMAGE:-ghcr.io/muatasim-aswad/jotter:v${version}}"
expected_revision="${APP_REVISION:-dev}"
if test -z "${APP_REVISION:-}" && git -C "${repository_root}" rev-parse --is-inside-work-tree >/dev/null 2>&1 && test -z "$(git -C "${repository_root}" status --porcelain --untracked-files=all)"; then
  expected_revision="$(git -C "${repository_root}" rev-parse HEAD)"
fi
container="jotter-f1-${BASHPID}"
temporary_root="$(mktemp -d -t jotter-container.XXXXXXXX)"
data_directory="${temporary_root}/data"
sentinel="container-persistence-sentinel"

cleanup() {
  docker rm -f "${container}" >/dev/null 2>&1 || true
  if test -d "${data_directory}" && docker image inspect "${image}" >/dev/null 2>&1; then
    docker run --rm --pull never --user 0:0 \
      --env HOST_UID="$(id -u)" --env HOST_GID="$(id -g)" \
      --mount "type=bind,src=${temporary_root},dst=/data" \
      --entrypoint /bin/sh "${image}" \
      -c 'find /data -mindepth 1 -delete; chown "$HOST_UID:$HOST_GID" /data; chmod 0700 /data' \
      >/dev/null 2>&1 || true
  fi
  rm -rf "${temporary_root}"
}
trap cleanup EXIT INT TERM

if ss -H -ltn '( sport = :18080 )' | grep -q .; then
  printf 'port 18080 is already in use\n' >&2
  exit 1
fi

if test "${JOTTER_SKIP_IMAGE_BUILD:-0}" != 1; then
  JOTTER_IMAGE="${image}" python3 "${repository_root}/scripts/release.py" image-build
fi
mkdir -m 0700 "${data_directory}"
docker run --rm --pull never --user 0:0 \
  --mount "type=bind,src=${data_directory},dst=/data" \
  --entrypoint /bin/sh "${image}" -c 'chown 10001:10001 /data; chmod 0700 /data'

start_container() {
  local selected_data="${1:-${data_directory}}"
  docker run --detach --name "${container}" --pull never \
    --user 10001:10001 \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
    --security-opt no-new-privileges:true \
    --cap-drop ALL \
    --pids-limit 128 \
    --memory 256m \
    --cpus 1.0 \
    --restart unless-stopped \
    --log-opt max-size=10m \
    --log-opt max-file=3 \
    --stop-timeout 15 \
    --publish 127.0.0.1:18080:8080 \
    --mount "type=bind,src=${selected_data},dst=/data" \
    --env AUTH_DISABLED=true \
    --env JOTTER_ENV=production \
    --env JOTTER_LISTEN_ADDR=0.0.0.0:8080 \
    --env JOTTER_PUBLIC_ORIGIN=https://jotter.invalid \
    --env JOTTER_DATA_DIR=/data \
    --env JOTTER_LOG_LEVEL=info \
    "${image}" >/dev/null
}

wait_ready() {
  local attempt
  for attempt in $(seq 1 80); do
    if curl --fail --silent --show-error http://127.0.0.1:18080/health/ready >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  docker logs "${container}" >&2 || true
  return 1
}

assert_serving() {
  EXPECTED_REVISION="${expected_revision}" EXPECTED_VERSION="${version}" python3 - <<'PY_IDENTITY'
import json
import os
import urllib.request
with urllib.request.urlopen("http://127.0.0.1:18080/version.json", timeout=5) as response:
    identity = json.load(response)
    assert response.headers.get("Cache-Control") == "no-store", "identity is cacheable"
assert identity["revision"] == os.environ["EXPECTED_REVISION"], "stale container revision"
assert identity["version"] == os.environ["EXPECTED_VERSION"], "container version mismatch"
for field, variable in [("committedAt", "APP_COMMIT_TIME"), ("builtAt", "APP_BUILD_TIME")]:
    if os.environ.get(variable):
        assert identity[field] == os.environ[variable], "container timestamp mismatch"
PY_IDENTITY
  curl --fail --silent --show-error http://127.0.0.1:18080/ | grep -Fq '<title>Jotter</title>'
  test "$(curl --silent --output /dev/null --write-out '%{http_code}' --header 'Origin: https://invalid.example' http://127.0.0.1:18080/api/v1/bootstrap)" = "403"
  curl --fail --silent --show-error --dump-header "${temporary_root}/headers" --output /dev/null http://127.0.0.1:18080/
  grep -Eiq '^content-security-policy:.*default-src .self.' "${temporary_root}/headers"
  if grep -Eiq '^content-security-policy:.*https?:' "${temporary_root}/headers"; then
    printf 'CSP permits an external HTTP scheme\n' >&2
    return 1
  fi
}

write_sentinel() {
  SENTINEL="${sentinel}" python3 - <<'PY'
import base64
import json
import os
import socket
import struct
import urllib.request

base_url = "http://127.0.0.1:18080"
with urllib.request.urlopen(base_url + "/api/v1/bootstrap", timeout=5) as response:
    bootstrap = json.load(response)["scratchpad"]

connection = socket.create_connection(("127.0.0.1", 18080), timeout=5)
key = base64.b64encode(os.urandom(16)).decode()
request = (
    "GET /ws HTTP/1.1\r\n"
    "Host: 127.0.0.1:18080\r\n"
    "Connection: Upgrade\r\n"
    "Upgrade: websocket\r\n"
    f"Sec-WebSocket-Key: {key}\r\n"
    "Sec-WebSocket-Version: 13\r\n"
    "Origin: https://jotter.invalid\r\n\r\n"
)
connection.sendall(request.encode())
headers = b""
while b"\r\n\r\n" not in headers:
    headers += connection.recv(4096)
if not headers.startswith(b"HTTP/1.1 101"):
    raise SystemExit("WebSocket upgrade failed")

def send_text(value):
    payload = json.dumps(value, separators=(",", ":")).encode()
    mask = os.urandom(4)
    length = len(payload)
    header = bytearray([0x81])
    if length < 126:
        header.append(0x80 | length)
    elif length <= 65535:
        header.append(0x80 | 126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack("!Q", length))
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    connection.sendall(bytes(header) + mask + masked)

def receive_json():
    def exact(length):
        result = b""
        while len(result) < length:
            chunk = connection.recv(length - len(result))
            if not chunk:
                raise SystemExit("WebSocket closed unexpectedly")
            result += chunk
        return result

    first, second = exact(2)
    opcode = first & 0x0F
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", exact(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", exact(8))[0]
    mask = exact(4) if second & 0x80 else None
    payload = exact(length)
    if mask:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    if opcode == 8:
        raise SystemExit("WebSocket closed before acknowledgement")
    return json.loads(payload)

client_id = "container-verifier-client"
session_id = "container-verifier-session"
mutation_id = "container-verifier-mutation"
send_text({
    "v": 1,
    "type": "hello",
    "scratchpadId": bootstrap["id"],
    "clientId": client_id,
    "sessionId": session_id,
    "knownRevision": bootstrap["revision"],
    "pendingMutationIds": [mutation_id],
})
state = receive_json()
if state.get("type") != "state":
    raise SystemExit("server did not send initial state")
send_text({
    "v": 1,
    "type": "save",
    "scratchpadId": bootstrap["id"],
    "content": os.environ["SENTINEL"],
    "baseRevision": bootstrap["revision"],
    "clientId": client_id,
    "sessionId": session_id,
    "mutationId": mutation_id,
})
ack = receive_json()
if ack.get("type") != "ack" or ack.get("mutationId") != mutation_id:
    raise SystemExit("server did not acknowledge persistence probe")
connection.close()
PY
}

assert_persisted() {
  SENTINEL="${sentinel}" python3 - <<'PY'
import json
import os
import urllib.request
with urllib.request.urlopen("http://127.0.0.1:18080/api/v1/bootstrap", timeout=5) as response:
    content = json.load(response)["scratchpad"]["content"]
if content != os.environ["SENTINEL"]:
    raise SystemExit("persisted content does not match the probe")
PY
}

validate_logs() {
  local log_file="$1"
  docker logs "${container}" >"${log_file}" 2>&1
  LOG_FILE="${log_file}" SENTINEL="${sentinel}" python3 - <<'PY'
import json
import os
from pathlib import Path

lines = [line for line in Path(os.environ["LOG_FILE"]).read_text().splitlines() if line]
messages = []
for line in lines:
    if os.environ["SENTINEL"] in line:
        raise SystemExit("container logs leaked document content")
    try:
        messages.append(json.loads(line).get("msg"))
    except json.JSONDecodeError as error:
        raise SystemExit(f"container emitted an unstructured log line: {error}")
for required in ("database migrations applied", "server started", "shutdown requested", "server stopped cleanly"):
    if required not in messages:
        raise SystemExit(f"missing structured lifecycle log: {required}")
PY
}

start_container
wait_ready
assert_serving
write_sentinel
assert_persisted
test "$(docker exec "${container}" stat -c %a /data)" = "700"
test "$(docker exec "${container}" stat -c %a /data/jotter.db)" = "600"

docker restart --time 15 "${container}" >/dev/null
wait_ready
assert_persisted
docker stop --time 15 "${container}" >/dev/null
validate_logs "${temporary_root}/restart.log"
docker rm "${container}" >/dev/null

start_container
wait_ready
assert_persisted
assert_serving
docker inspect "${container}" >"${temporary_root}/inspect.json"
INSPECT_FILE="${temporary_root}/inspect.json" python3 - <<'PY'
import json
import os

value = json.load(open(os.environ["INSPECT_FILE"]))[0]
config = value["Config"]
host = value["HostConfig"]
assert config["User"] == "10001:10001"
assert host["ReadonlyRootfs"] is True
assert "ALL" in (host["CapDrop"] or [])
assert any(option.startswith("no-new-privileges") for option in host["SecurityOpt"] or [])
assert host["PidsLimit"] == 128
assert host["Memory"] == 268435456
assert host["NanoCpus"] == 1_000_000_000
assert host["RestartPolicy"]["Name"] == "unless-stopped"
assert host["LogConfig"]["Config"] == {"max-file": "3", "max-size": "10m"}
assert host["PortBindings"]["8080/tcp"][0]["HostIp"] == "127.0.0.1"
assert any(mount["Destination"] == "/data" and mount["Type"] == "bind" and mount["RW"] for mount in value["Mounts"])
assert config["Healthcheck"]["Test"]
PY

docker stop --time 15 "${container}" >/dev/null
validate_logs "${temporary_root}/recreate.log"
docker rm "${container}" >/dev/null
restored_directory="${temporary_root}/restored"
docker run --rm --pull never --user 0:0 \
  --mount "type=bind,src=${temporary_root},dst=/copies" \
  --entrypoint /bin/sh "${image}" -c 'cp -a /copies/data /copies/restored'
docker run --rm --pull never --user 10001:10001 --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --mount "type=bind,src=${restored_directory},dst=/data" \
  "${image}" verify-data /data
start_container "${restored_directory}"
wait_ready
assert_persisted
docker stop --time 15 "${container}" >/dev/null
validate_logs "${temporary_root}/restore.log"
printf 'container persistence, hardening and restore verification passed\n' 

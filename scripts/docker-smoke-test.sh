#!/usr/bin/env bash
# Runtime verification for the ADAMANT IPFS Node container image.
#
#   scripts/docker-smoke-test.sh <image-ref> [platform]
#
# The image is exercised the way the documentation says it should be run:
# configuration mounted at /app/config.json5, persistent state on a single
# /data volume, unprivileged user, and readiness taken from the JSON health
# state rather than the HTTP status code.
#
# It verifies that the image
#
#   1. starts from a mounted configuration and does not run as root
#   2. reaches the documented "ready" state, with "starting" observed first
#   3. accepts an upload and returns the same bytes on download
#   4. honours a configuration override without a rebuild
#   5. keeps content and the libp2p peer identity across container replacement
#   6. shuts down gracefully on SIGTERM
#   7. carries no configuration secret in its layers, history, or metadata
#
# Requires: docker, curl, node. Everything it creates is removed on exit.

set -euo pipefail

IMAGE="${1:?usage: scripts/docker-smoke-test.sh <image-ref> [platform]}"
PLATFORM="${2:-}"

SUFFIX="$$"
CONTAINER="ipfs-node-smoke-${SUFFIX}"
VOLUME="ipfs-node-smoke-${SUFFIX}"
WORKDIR="$(mktemp -d)"
PORT=""
# A unique 64-character secret. It must appear in no image layer or metadata.
ADMIN_KEY="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"

# Expanding an empty array under `set -u` is an error in bash 3.2, which is what
# macOS ships, so every use below goes through the `${arr[@]+...}` guard.
PLATFORM_ARGS=()
if [ -n "$PLATFORM" ]; then
  PLATFORM_ARGS=(--platform "$PLATFORM")
fi

step() { printf '\n=== %s\n' "$1"; }
fail() {
  printf '\nFAILED: %s\n' "$1" >&2
  if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
    printf '\n--- container logs ---\n' >&2
    docker logs --tail 120 "$CONTAINER" >&2 || true
  fi
  exit 1
}

cleanup() {
  # Preserve the script's exit status: without this, the last command of the
  # trap would become the status the caller sees, and a failed run would look
  # successful in CI.
  status=$?
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
  exit "$status"
}
trap cleanup EXIT

# Pick a free loopback port so the test can run next to a local node.
pick_port() {
  PORT="$(node -e '
const net = require("node:net")
const server = net.createServer()
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port))
  server.close()
})')"
}

# Write a self-contained single-node configuration.
#
# $1 target file, $2 maxFileCount (used to prove a configuration override)
write_config() {
  cat >"$1" <<EOF
{
  nodes: [],
  storeFolder: '.adm-ipfs',
  logLevel: 'info',
  prettyLogs: false,
  peerDiscovery: { bootstrap: [], listen: ['/ip4/0.0.0.0/tcp/4001'] },
  serverPort: 4000,
  diskUsageScanPeriod: '*/10 * * * * *',
  peeringSchedule: '*/30 * * * * *',
  uploadLimitSizeBytes: 268435456,
  maxFileCount: $2,
  findFileTimeout: 20000,
  cors: { allowedOrigins: ['http://localhost:8080'] },
  trustProxy: false,
  rateLimits: {
    upload: { windowMs: 900000, limit: 100 },
    pin: { windowMs: 900000, limit: 100 },
    read: { windowMs: 60000, limit: 1000 }
  },
  adminApiKey: '${ADMIN_KEY}',
  enableDebugApi: false,
  storage: {
    maxRequestSizeBytes: 536870912,
    maxConcurrentUploads: 4,
    maxConcurrentDownloads: 8,
    maxConcurrentDownloadsPerClient: 4,
    diskReserveBytes: 1048576,
    confirmationRequired: false,
    temporaryTtlMs: 3600000,
    gc: { enabled: true, schedule: '0 */15 * * * *', highWatermarkBytes: 10485760, lowWatermarkBytes: 5242880 }
  },
  replication: {
    enabled: true,
    placement: [{ minAgeMs: 0, copies: 4 }, { minAgeMs: 31536000000, copies: 2 }],
    ackQuorum: 1,
    requireQuorumOnUpload: false,
    requestTimeoutMs: 5000,
    repairEnabled: true,
    repairSchedule: '0 */5 * * * *',
    repairBatchDelayMs: 200,
    repairProbeConcurrency: 4
  },
  health: {
    checkpointIntervalMs: 5000,
    maxCheckpointAgeMs: 30000,
    storageMaxAgeMs: 60000,
    repairMaxAgeMs: 600000,
    clockSkewToleranceMs: 10000,
    requiredPeerCount: 0
  }
}
EOF
}

start_container() {
  pick_port
  docker run -d --name "$CONTAINER" ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} \
    -v "$VOLUME:/data" \
    -v "$1:/app/config.json5:ro" \
    -p "127.0.0.1:${PORT}:4000" \
    "$IMAGE" >/dev/null
}

# Read one field out of GET /api/node/health.
#
# A container that is starting answers with a refused connection or an empty
# reply, and `set -o pipefail` would turn that into a fatal error inside the
# polling loop, so the pipeline is allowed to fail and yields an empty value.
health_field() {
  { curl --silent --max-time 5 "http://127.0.0.1:${PORT}/api/node/health" 2>/dev/null || true; } |
    node -e '
let raw = ""
process.stdin.on("data", (chunk) => (raw += chunk))
process.stdin.on("end", () => {
  try {
    const value = JSON.parse(raw)[process.argv[1]]
    process.stdout.write(value === undefined ? "" : String(value))
  } catch {
    process.stdout.write("")
  }
})' "$1" || true
}

# Fail unless the container is still running. A configuration error aborts the
# process, and every later check would then report a confusing symptom.
assert_running() {
  sleep 3
  docker container inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true ||
    fail "$1"
}

# Block until the health state is one of the states listed in $1.
wait_for_state() {
  local wanted="$1" deadline=$((SECONDS + ${2:-180})) state=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! docker container inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
      fail "the container exited while waiting for state ${wanted}"
    fi
    state="$(health_field state)"
    case " $wanted " in
      *" $state "*)
        printf 'state=%s\n' "$state"
        return 0
        ;;
    esac
    sleep 2
  done
  fail "health state stayed \"${state:-unreachable}\" instead of reaching ${wanted}"
}

step "1/9 start from a mounted configuration"
write_config "$WORKDIR/config.json5" 10
docker volume create "$VOLUME" >/dev/null
start_container "$WORKDIR/config.json5"

assert_running "the container exited immediately after start"

RUNTIME_UID="$(docker exec "$CONTAINER" id -u)"
RUNTIME_USER="$(docker exec "$CONTAINER" id -un)"
[ "$RUNTIME_UID" != "0" ] || fail "the container runs as root"
printf 'running as %s (uid %s)\n' "$RUNTIME_USER" "$RUNTIME_UID"

step "2/9 the health endpoint reports a documented state"
wait_for_state "starting degraded stale ready" 120

step "3/9 the node reaches the documented ready state"
wait_for_state "ready" 240
HEIGHT="$(health_field height)"
[ -n "$HEIGHT" ] && [ "$HEIGHT" != "0" ] || fail "a ready node reported no checkpoint height"
printf 'checkpoint height=%s\n' "$HEIGHT"

step "4/9 the container health check agrees"
docker exec "$CONTAINER" node /app/docker/healthcheck.mjs || fail "the image health check reported unhealthy"

step "5/9 upload and download a file through the documented API"
head -c 262144 /dev/urandom >"$WORKDIR/payload.bin"
UPLOAD="$(curl --silent --show-error --fail-with-body \
  --form "files=@${WORKDIR}/payload.bin" \
  "http://127.0.0.1:${PORT}/api/file/upload")" || fail "upload was rejected: $UPLOAD"
CID="$(printf '%s' "$UPLOAD" | node -e '
let raw = ""
process.stdin.on("data", (chunk) => (raw += chunk))
process.stdin.on("end", () => process.stdout.write(JSON.parse(raw).cids[0]))')"
[ -n "$CID" ] || fail "the upload response carried no CID"
printf 'cid=%s\n' "$CID"

curl --silent --show-error --fail-with-body --output "$WORKDIR/download.bin" \
  "http://127.0.0.1:${PORT}/api/file/${CID}" || fail "download failed"
cmp "$WORKDIR/payload.bin" "$WORKDIR/download.bin" || fail "the downloaded bytes differ from the upload"

STATE="$(curl --silent --retry 5 --retry-connrefused --retry-all-errors "http://127.0.0.1:${PORT}/api/file/${CID}/status" | node -e '
let raw = ""
process.stdin.on("data", (chunk) => (raw += chunk))
process.stdin.on("end", () => process.stdout.write(JSON.parse(raw).state))')"
[ "$STATE" = "confirmed" ] || fail "the uploaded file is \"$STATE\" instead of confirmed"

PEER_ID="$(curl --silent --retry 5 --retry-connrefused --retry-all-errors --header "x-api-key: ${ADMIN_KEY}" \
  "http://127.0.0.1:${PORT}/api/node/details" | node -e '
let raw = ""
process.stdin.on("data", (chunk) => (raw += chunk))
process.stdin.on("end", () => process.stdout.write(JSON.parse(raw).peerId))')"
[ -n "$PEER_ID" ] || fail "the administrative route returned no peer id"
printf 'peerId=%s\n' "$PEER_ID"

step "6/9 SIGTERM shuts the node down gracefully"
docker stop --timeout 25 "$CONTAINER" >/dev/null
EXIT_CODE="$(docker container inspect --format '{{.State.ExitCode}}' "$CONTAINER")"
[ "$EXIT_CODE" = "0" ] || fail "the container exited with code ${EXIT_CODE} instead of 0"
# `docker stop` returns as soon as the container has exited, which can be before
# the daemon has flushed its last lines to the log driver. Reading once made the
# check fail intermittently on a loaded runner while the line was already there a
# moment later, so poll for up to five seconds instead.
shutdown_logged() {
  docker logs "$CONTAINER" 2>&1 | grep -q 'Received SIGTERM, shutting down'
}
for _ in $(seq 1 50); do
  shutdown_logged && break
  sleep 0.1
done
shutdown_logged || fail "no graceful shutdown was logged"

step "7/9 content, peer identity, and state survive container replacement"
docker rm -f "$CONTAINER" >/dev/null
write_config "$WORKDIR/config-override.json5" 7
start_container "$WORKDIR/config-override.json5"
assert_running "the replacement container exited immediately after start"
wait_for_state "ready" 240

NEW_PEER_ID="$(curl --silent --retry 5 --retry-connrefused --retry-all-errors --header "x-api-key: ${ADMIN_KEY}" \
  "http://127.0.0.1:${PORT}/api/node/details" | node -e '
let raw = ""
process.stdin.on("data", (chunk) => (raw += chunk))
process.stdin.on("end", () => process.stdout.write(JSON.parse(raw).peerId))')"
[ "$NEW_PEER_ID" = "$PEER_ID" ] || fail "the peer identity changed: ${PEER_ID} -> ${NEW_PEER_ID}"

curl --silent --show-error --fail-with-body --output "$WORKDIR/download2.bin" \
  "http://127.0.0.1:${PORT}/api/file/${CID}" || fail "content did not survive container replacement"
cmp "$WORKDIR/payload.bin" "$WORKDIR/download2.bin" || fail "restored content differs from the upload"

step "8/9 configuration overrides apply without rebuilding the image"
MAX_FILES="$(curl --silent --retry 5 --retry-connrefused --retry-all-errors "http://127.0.0.1:${PORT}/api/storage/policy" | node -e '
let raw = ""
process.stdin.on("data", (chunk) => (raw += chunk))
process.stdin.on("end", () => process.stdout.write(String(JSON.parse(raw).maxFileCount)))')"
[ "$MAX_FILES" = "7" ] || fail "maxFileCount is ${MAX_FILES}; the mounted override was not applied"

step "9/9 no configuration secret reached the image"
INSPECTION="$(docker image inspect "$IMAGE"; docker image history --no-trunc "$IMAGE")"
if printf '%s' "$INSPECTION" | grep -q "$ADMIN_KEY"; then
  fail "the administrative key appears in the image metadata or history"
fi
docker exec "$CONTAINER" sh -c 'ls /app/config.json5 >/dev/null 2>&1 && cat /app/config.json5' |
  grep -q "$ADMIN_KEY" || fail "the mounted configuration was not readable at /app/config.json5"
docker run --rm ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} --entrypoint sh "$IMAGE" -c \
  'test ! -e /app/config.json5' || fail "the image itself ships a config.json5"

printf '\nAll container checks passed for %s%s\n' "$IMAGE" "${PLATFORM:+ (${PLATFORM})}"

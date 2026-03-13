#!/usr/bin/env bash
# E2E test for ContainrDog on Docker.
#
# Flow:
#   1. Build ContainrDog image
#   2. Start a local registry
#   3. Push two versions of a test image (v1 and v2)
#   4. Run a "target" container with v1 and containrdog-enabled label
#   5. Run ContainrDog, wait for update cycle
#   6. Assert the target container is now running v2
#   7. Cleanup
#
# Usage: bash tests/e2e/docker/run.sh

set -euo pipefail

REGISTRY_PORT=5111
REGISTRY_HOST="localhost:${REGISTRY_PORT}"
CONTAINRDOG_IMAGE="containrdog:e2e"
TEST_APP_IMAGE_V1="${REGISTRY_HOST}/testapp:1.0.0"
TEST_APP_IMAGE_V2="${REGISTRY_HOST}/testapp:2.0.0"
TARGET_CONTAINER="e2e-target"
CONTAINRDOG_CONTAINER="e2e-containrdog"
REGISTRY_CONTAINER="e2e-registry"
NETWORK="e2e-net"
CHECK_INTERVAL=5

pass() { echo "✅ $*"; }
fail() { echo "❌ $*" >&2; exit 1; }
info() { echo "   $*"; }

cleanup() {
  info "Cleaning up..."
  docker rm -f "$TARGET_CONTAINER" "$CONTAINRDOG_CONTAINER" "$REGISTRY_CONTAINER" 2>/dev/null || true
  docker network rm "$NETWORK" 2>/dev/null || true
}
trap cleanup EXIT

echo ""
echo "======================================="
echo "  ContainrDog Docker E2E Test"
echo "======================================="
echo ""

# ── 1. Build ContainrDog ─────────────────────────────────────────────────────
info "Building ContainrDog image..."
docker build -t "$CONTAINRDOG_IMAGE" . -q
pass "Built $CONTAINRDOG_IMAGE"

# ── 2. Create network + local registry ───────────────────────────────────────
docker network create "$NETWORK" 2>/dev/null || true

docker run -d \
  --name "$REGISTRY_CONTAINER" \
  --network "$NETWORK" \
  -p "${REGISTRY_PORT}:5000" \
  registry:2 > /dev/null

# Wait for registry to be ready
for i in $(seq 1 10); do
  if curl -sf "http://${REGISTRY_HOST}/v2/" > /dev/null 2>&1; then break; fi
  sleep 1
done
pass "Local registry running at ${REGISTRY_HOST}"

# ── 3. Push v1 and v2 ────────────────────────────────────────────────────────
docker pull nginx:alpine -q
docker tag nginx:alpine "$TEST_APP_IMAGE_V1"
docker tag nginx:alpine "$TEST_APP_IMAGE_V2"

# Make v1 and v2 distinct by adding a label
docker buildx build \
  --label "version=v1" \
  --tag "$TEST_APP_IMAGE_V1" \
  --file - . <<'DOCKERFILE' > /dev/null
FROM nginx:alpine
LABEL version="v1"
DOCKERFILE

docker buildx build \
  --label "version=v2" \
  --tag "$TEST_APP_IMAGE_V2" \
  --file - . <<'DOCKERFILE' > /dev/null
FROM nginx:alpine
LABEL version="v2"
DOCKERFILE

docker push "$TEST_APP_IMAGE_V1" -q
docker push "$TEST_APP_IMAGE_V2" -q
pass "Pushed v1 and v2 to local registry"

# ── 4. Run target container with v1 ──────────────────────────────────────────
docker run -d \
  --name "$TARGET_CONTAINER" \
  --network "$NETWORK" \
  --label "containrdog-enabled=true" \
  --label "containrdog.auto-update=true" \
  --label "containrdog.policy=all" \
  "$TEST_APP_IMAGE_V1" > /dev/null
pass "Target container running with v1 (${TEST_APP_IMAGE_V1})"

# ── 5. Run ContainrDog ───────────────────────────────────────────────────────
docker run -d \
  --name "$CONTAINRDOG_CONTAINER" \
  --network "$NETWORK" \
  -e "CHECK_INTERVAL=${CHECK_INTERVAL}s" \
  -e "AUTO_UPDATE=true" \
  -e "LABELED_ONLY=true" \
  -e "LOG_LEVEL=debug" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "$CONTAINRDOG_IMAGE" > /dev/null
pass "ContainrDog started (check interval: ${CHECK_INTERVAL}s)"

# ── 6. Wait for update ───────────────────────────────────────────────────────
info "Waiting for ContainrDog to detect and apply update..."
MAX_WAIT=60
ELAPSED=0
UPDATED=false

while [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
  CURRENT_IMAGE=$(docker inspect "$TARGET_CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || echo "")
  if [ "$CURRENT_IMAGE" = "$TEST_APP_IMAGE_V2" ]; then
    UPDATED=true
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

# ── 7. Assert ────────────────────────────────────────────────────────────────
echo ""
echo "── ContainrDog logs ──────────────────────────────"
docker logs "$CONTAINRDOG_CONTAINER" 2>&1 | tail -30
echo "──────────────────────────────────────────────────"
echo ""

if [ "$UPDATED" = "true" ]; then
  pass "Target container updated to v2 (${TEST_APP_IMAGE_V2})"
  echo ""
  echo "======================================="
  echo "  E2E Test PASSED ✅"
  echo "======================================="
  exit 0
else
  CURRENT_IMAGE=$(docker inspect "$TARGET_CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || echo "unknown")
  fail "Target container still on '${CURRENT_IMAGE}' after ${MAX_WAIT}s (expected ${TEST_APP_IMAGE_V2})"
fi

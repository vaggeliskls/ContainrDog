#!/usr/bin/env bash
# E2E test for ContainrDog on Kubernetes using k3d.
#
# Flow:
#   1. Build ContainrDog image
#   2. Create k3d cluster with a local registry
#   3. Push two versions of a test image to the k3d registry
#   4. Load ContainrDog image into k3d
#   5. Deploy a target workload with v1 + containrdog annotations
#   6. Deploy ContainrDog via Helm
#   7. Wait for the target deployment to roll out with v2
#   8. Assert the deployment image tag is v2
#   9. Cleanup
#
# Prerequisites: docker, k3d, kubectl, helm
# Usage: bash tests/e2e/kubernetes/run.sh

set -euo pipefail

CLUSTER_NAME="containrdog-e2e"
REGISTRY_NAME="containrdog-e2e-registry"
REGISTRY_PORT=5222
REGISTRY_HOST="localhost:${REGISTRY_PORT}"
K3D_REGISTRY_HOST="k3d-${REGISTRY_NAME}:5000"

CONTAINRDOG_IMAGE="containrdog:e2e"
TEST_IMAGE_V1="${REGISTRY_HOST}/testapp:1.0.0"
TEST_IMAGE_V2="${REGISTRY_HOST}/testapp:2.0.0"
K3D_TEST_IMAGE_V1="${K3D_REGISTRY_HOST}/testapp:1.0.0"
K3D_TEST_IMAGE_V2="${K3D_REGISTRY_HOST}/testapp:2.0.0"

NAMESPACE="containrdog-e2e"
TARGET_DEPLOYMENT="nginx-target"

pass() { echo "✅ $*"; }
fail() { echo "❌ $*" >&2; exit 1; }
info() { echo "   $*"; }

cleanup() {
  info "Cleaning up cluster..."
  k3d cluster delete "$CLUSTER_NAME" 2>/dev/null || true
  k3d registry delete "$REGISTRY_NAME" 2>/dev/null || true
}
trap cleanup EXIT

echo ""
echo "======================================="
echo "  ContainrDog Kubernetes E2E Test"
echo "======================================="
echo ""

# ── Prerequisite check ────────────────────────────────────────────────────────
for cmd in docker k3d kubectl helm; do
  command -v "$cmd" > /dev/null 2>&1 || fail "Required tool not found: $cmd"
done
pass "Prerequisites OK"

# ── 1. Build ContainrDog ─────────────────────────────────────────────────────
info "Building ContainrDog image..."
docker build -t "$CONTAINRDOG_IMAGE" . -q
pass "Built $CONTAINRDOG_IMAGE"

# ── 2. Create k3d cluster with registry ──────────────────────────────────────
info "Creating k3d registry..."
k3d registry create "$REGISTRY_NAME" --port "$REGISTRY_PORT"

info "Creating k3d cluster..."
k3d cluster create "$CLUSTER_NAME" \
  --registry-use "k3d-${REGISTRY_NAME}:5000" \
  --wait

pass "k3d cluster ready"

# ── 3. Push test images to k3d registry ──────────────────────────────────────
docker buildx build \
  --label "version=v1" \
  --tag "$TEST_IMAGE_V1" \
  --file - . <<'DOCKERFILE' > /dev/null
FROM nginx:alpine
LABEL version="v1"
DOCKERFILE

docker buildx build \
  --label "version=v2" \
  --tag "$TEST_IMAGE_V2" \
  --file - . <<'DOCKERFILE' > /dev/null
FROM nginx:alpine
LABEL version="v2"
DOCKERFILE

docker push "$TEST_IMAGE_V1" -q
docker push "$TEST_IMAGE_V2" -q
pass "Pushed v1 and v2 to k3d registry"

# ── 4. Load ContainrDog image into k3d ───────────────────────────────────────
k3d image import "$CONTAINRDOG_IMAGE" -c "$CLUSTER_NAME"
pass "Loaded ContainrDog image into k3d"

# ── 5. Deploy target workload with v1 ────────────────────────────────────────
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

kubectl create deployment "$TARGET_DEPLOYMENT" \
  --image="${K3D_TEST_IMAGE_V1}" \
  --namespace="$NAMESPACE"

kubectl annotate deployment "$TARGET_DEPLOYMENT" \
  "containrdog-enabled=true" \
  --namespace="$NAMESPACE"

kubectl rollout status deployment/"$TARGET_DEPLOYMENT" \
  --namespace="$NAMESPACE" \
  --timeout=60s

pass "Target deployment running with v1 (${K3D_TEST_IMAGE_V1})"

# ── 6. Deploy ContainrDog via Helm ───────────────────────────────────────────
helm install containrdog ./helm \
  --namespace "$NAMESPACE" \
  --set "image.repository=containrdog" \
  --set "image.tag=e2e" \
  --set "image.pullPolicy=Never" \
  --set "kubernetes.namespaces={${NAMESPACE}}" \
  --set "config.checkInterval=5s" \
  --set "config.autoUpdate=true" \
  --set "config.labeledOnly=true" \
  --set "config.logLevel=debug"

kubectl rollout status deployment/containrdog \
  --namespace="$NAMESPACE" \
  --timeout=60s

pass "ContainrDog deployed via Helm"

# ── 7. Wait for target deployment to update ──────────────────────────────────
info "Waiting for ContainrDog to detect and apply update..."
MAX_WAIT=120
ELAPSED=0
UPDATED=false

while [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
  CURRENT_IMAGE=$(kubectl get deployment "$TARGET_DEPLOYMENT" \
    -n "$NAMESPACE" \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "")

  if [ "$CURRENT_IMAGE" = "$K3D_TEST_IMAGE_V2" ]; then
    UPDATED=true
    break
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
done

# ── 8. Assert ────────────────────────────────────────────────────────────────
echo ""
echo "── ContainrDog logs ──────────────────────────────"
kubectl logs deployment/containrdog -n "$NAMESPACE" --tail=40 2>&1 || true
echo "──────────────────────────────────────────────────"
echo ""

if [ "$UPDATED" = "true" ]; then
  pass "Target deployment updated to v2 (${K3D_TEST_IMAGE_V2})"
  echo ""
  echo "======================================="
  echo "  E2E Test PASSED ✅"
  echo "======================================="
  exit 0
else
  CURRENT_IMAGE=$(kubectl get deployment "$TARGET_DEPLOYMENT" \
    -n "$NAMESPACE" \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "unknown")
  fail "Deployment still on '${CURRENT_IMAGE}' after ${MAX_WAIT}s (expected ${K3D_TEST_IMAGE_V2})"
fi

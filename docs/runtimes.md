# Runtimes

ContainrDog supports Docker, Podman, and Kubernetes. Select the runtime with `RUNTIME=docker` (default) or `RUNTIME=kubernetes`.

## Docker

Mount the Docker socket and run:

```bash
docker run -d \
  --name containrdog \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e INTERVAL=5m \
  ghcr.io/vaggeliskls/containrdog
```

**docker-compose.yml** (recommended):

```yaml
services:
  containrdog:
    image: ghcr.io/vaggeliskls/containrdog:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      - INTERVAL=5m
      - LABELED=true
    restart: unless-stopped

  myapp:
    image: nginx:1.25
    labels:
      - containrdog-enabled=true
```

## Podman

Enable and mount the Podman socket:

```bash
systemctl --user enable --now podman.socket

docker run -d \
  --name containrdog \
  -v /run/user/1000/podman/podman.sock:/var/run/docker.sock:ro \
  -e INTERVAL=5m \
  ghcr.io/vaggeliskls/containrdog
```

Set a custom socket path if needed:
```bash
-e SOCKET_PATH=/run/podman/podman.sock
```

## Kubernetes

Set `RUNTIME=kubernetes`. ContainrDog monitors pods and patches the owning workload (Deployment, StatefulSet, DaemonSet) when an update is available. No image pull needed — Kubernetes handles the rolling update.

### Kubeconfig loading order

1. `K8S_KUBECONFIG` env var (or `KUBECONFIG`)
2. In-cluster service account (when running inside a pod)
3. `~/.kube/config`

### Running outside the cluster

```bash
docker run -d \
  --name containrdog \
  -e RUNTIME=kubernetes \
  -e K8S_NAMESPACES=default,production \
  -v ~/.kube/config:/root/.kube/config:ro \
  ghcr.io/vaggeliskls/containrdog
```

### Running inside the cluster

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: containrdog
  namespace: containrdog
spec:
  replicas: 1
  selector:
    matchLabels:
      app: containrdog
  template:
    metadata:
      labels:
        app: containrdog
    spec:
      serviceAccountName: containrdog
      containers:
        - name: containrdog
          image: ghcr.io/vaggeliskls/containrdog:latest
          env:
            - name: RUNTIME
              value: kubernetes
            - name: K8S_NAMESPACES
              value: default,production
            - name: INTERVAL
              value: 5m
```

You'll need a ServiceAccount with RBAC permissions to list pods and patch workloads:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: containrdog
  namespace: containrdog
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: containrdog
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["list", "get"]
  - apiGroups: ["apps"]
    resources: ["replicasets", "deployments", "statefulsets", "daemonsets"]
    verbs: ["list", "get", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: containrdog
subjects:
  - kind: ServiceAccount
    name: containrdog
    namespace: containrdog
roleRef:
  kind: ClusterRole
  name: containrdog
  apiGroup: rbac.authorization.k8s.io
```

### Annotating workloads

ContainrDog reads annotations on pods (which inherit from the pod template of the owning workload). Add to your Deployment:

```yaml
spec:
  template:
    metadata:
      annotations:
        containrdog-enabled: "true"
        containrdog.policy: "minor"
```

All [label options](labels.md) work as annotations in Kubernetes.

### Update behaviour

- Pods owned by the same Deployment are **deduplicated** — only one patch is applied.
- Standalone pods (no owning workload) are detected but **not auto-updated** — annotate the Deployment instead.
- Updates are applied as a **strategic merge patch**, triggering a rolling update.

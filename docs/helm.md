# Helm Chart

Deploy ContainrDog on Kubernetes using the included Helm chart in [`helm/`](../helm/).

## Quick Install

```bash
# From the repo
helm install containrdog ./helm \
  --namespace containrdog \
  --create-namespace

# Override namespaces to monitor
helm install containrdog ./helm \
  --namespace containrdog \
  --create-namespace \
  --set kubernetes.namespaces="{default,production}"
```

## Values

### Minimal production example

```yaml
# values-prod.yaml
config:
  interval: "5m"
  policy: "minor"
  labeled: true

kubernetes:
  namespaces:
    - default
    - production

webhook:
  enabled: true
  provider: slack
  url: "https://hooks.slack.com/services/..."
  notifyOnSuccess: true
  notifyOnFailure: true

resources:
  requests:
    cpu: 50m
    memory: 64Mi
  limits:
    cpu: 100m
    memory: 128Mi
```

```bash
helm install containrdog ./helm -f values-prod.yaml -n containrdog --create-namespace
```

### Monitor all namespaces

```bash
helm install containrdog ./helm \
  --set kubernetes.allNamespaces=true \
  -n containrdog --create-namespace
```

### Private registry credentials

The recommended approach is to reuse the same `kubernetes.io/dockerconfigjson` Secret you already use for `imagePullSecrets` — no duplication needed:

```bash
# Create the pull secret once (standard Kubernetes way)
kubectl create secret docker-registry my-pull-secret \
  --docker-server=ghcr.io \
  --docker-username=myuser \
  --docker-password=ghp_token \
  -n containrdog

# Reference it in the chart
helm install containrdog ./helm \
  --set registry.existingPullSecret=my-pull-secret \
  -n containrdog --create-namespace
```

ContainrDog mounts the secret as a volume and reads it as a Docker config file. The same secret can be referenced in your workloads' `imagePullSecrets` without any changes.

**Fallback** — raw JSON string (not recommended for production):
```bash
helm install containrdog ./helm \
  --set 'registry.credentials=[{"registry":"ghcr.io","username":"user","password":"ghp_token"}]' \
  -n containrdog --create-namespace
```

### AWS ECR

```yaml
ecr:
  enabled: true
  region: us-east-1
  accountId: "123456789"       # builds registry URL automatically
  accessKeyId: "AKIA..."       # leave empty to use IAM role
  secretAccessKey: "..."
  authRefreshInterval: "6h"
```

Using an IAM role (no keys needed):
```yaml
ecr:
  enabled: true
  region: us-east-1
  accountId: "123456789"
```

### GitOps

```yaml
gitops:
  enabled: true
  repoUrl: "https://github.com/user/config-repo.git"
  branch: main
  authType: token
  token: "ghp_xxxxx"
  watchPaths:
    - "k8s/**"
    - "config/*.yaml"
  commands:
    - "kubectl apply -f $GITOPS_CLONE_PATH/k8s/"
```

### Webhooks

```yaml
webhook:
  enabled: true
  provider: slack            # slack | discord | teams | generic
  url: "https://hooks.slack.com/..."
```

### Hooks (pre/post update commands)

```yaml
hooks:
  preUpdateCommands:
    - "echo Starting update for $CONTAINER_NAME"
  postUpdateCommands:
    - "kubectl rollout status deployment/$CONTAINER_NAME -n $CONTAINER_ID"
```

## Annotating Workloads

After installing, annotate the workloads you want to monitor:

```bash
kubectl annotate deployment myapp containrdog-enabled=true -n default
```

Or in the workload manifest:

```yaml
spec:
  template:
    metadata:
      annotations:
        containrdog-enabled: "true"
        containrdog.policy: "minor"
```

See [Labels & Annotations](labels.md) for all available annotations.

## RBAC

The chart creates a `ClusterRole` and `ClusterRoleBinding` by default. Required permissions:

| Resource | Verbs |
|----------|-------|
| `pods` | `get`, `list` |
| `replicasets` | `get` |
| `deployments`, `statefulsets`, `daemonsets` | `get`, `list`, `patch` |

Disable RBAC creation if you manage it separately:

```bash
helm install containrdog ./helm \
  --set rbac.create=false \
  --set serviceAccount.name=my-existing-sa
```

## Upgrade & Uninstall

```bash
helm upgrade containrdog ./helm -n containrdog -f values-prod.yaml

helm uninstall containrdog -n containrdog
```

## View Logs

```bash
kubectl logs -f deployment/containrdog -n containrdog
```

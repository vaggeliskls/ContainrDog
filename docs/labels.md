# Labels & Annotations

Per-container labels and annotations override the global defaults set via environment variables (see [Configuration](configuration.md)). Only set a label if you want to override the global behaviour for that specific container — if a label is not set, the global value applies.

Docker uses labels; Kubernetes reads annotations from three sources, merged in priority order (highest wins):

1. **Workload `metadata.annotations`** (Deployment/StatefulSet/DaemonSet root level) — highest priority
2. **Pod template `spec.template.metadata.annotations`**
3. **Pod template `spec.template.metadata.labels`** — lowest priority

## Enabling Monitoring

```yaml
# Docker (label)
containrdog-enabled: "true"

# Kubernetes — workload root level (recommended)
containrdog-enabled: "true"

# Kubernetes — pod template level (also works, overridden by workload-level if both set)
containrdog-enabled: "true"
```

Set `LABELED=true` (default) to only monitor containers/pods that carry this label.
Set `LABELED=false` to monitor everything (the label is still used to opt-out when set to `false`).

## Reference

| Label / Annotation | Values | Description |
|--------------------|--------|-------------|
| `containrdog-enabled` | `true`, `false` | Opt in/out of monitoring |
| `containrdog.policy` | `all` `major` `minor` `patch` `force` `glob` | Update policy (see [Update Policies](update-policies.md)) |
| `containrdog.auto-update` | `true`, `false` | Auto-update this container |
| `containrdog.glob-pattern` | e.g. `1.2*` | `glob` policy pattern |
| `containrdog.pre-update-commands` | JSON array | Commands before update (see [Hooks](hooks.md)) |
| `containrdog.post-update-commands` | JSON array | Commands after update |
| `containrdog.update-commands` | JSON array | Deprecated — use `post-update-commands` |
| `containrdog.gitops-enabled` | `true`, `false` | Enable GitOps for this container |
| `containrdog.gitops-repo-url` | URL | Per-container Git repository |
| `containrdog.gitops-branch` | e.g. `main` | Git branch to monitor |
| `containrdog.gitops-auth-type` | `token`, `ssh`, `none` | Auth method |
| `containrdog.gitops-token` | string | Access token |
| `containrdog.gitops-ssh-key-path` | path | SSH private key path |
| `containrdog.gitops-poll-interval` | e.g. `30s`, `2m` | Git check interval |
| `containrdog.gitops-watch-paths` | JSON array | Glob patterns to watch |
| `containrdog.gitops-commands` | JSON array | Commands on Git changes |
| `containrdog.gitops-clone-path` | path | Local clone directory |
| `containrdog.gitops-quiet-mode` | `true`, `false` | Suppress command stdout |

## Docker Example

```yaml
services:
  myapp:
    image: myapp:1.0.0
    labels:
      - containrdog-enabled=true
      - containrdog.policy=minor
      - containrdog.auto-update=true
      - containrdog.pre-update-commands=["echo 'Updating $CONTAINER_NAME'"]
      - containrdog.post-update-commands=["docker exec myapp /healthcheck.sh"]
```

## Kubernetes Example

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  annotations:
    containrdog-enabled: "true"
    containrdog.policy: "minor"
    containrdog.auto-update: "true"
    containrdog.post-update-commands: '["kubectl rollout status deployment/myapp"]'
```

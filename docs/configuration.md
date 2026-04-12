# Configuration

All configuration is via environment variables.

## Core

| Variable | Default | Description |
|----------|---------|-------------|
| `RUNTIME` | `docker` | Container runtime: `docker`, `kubernetes` |
| `INTERVAL` | `5s` | Check interval: `5s`, `5m`, `5` (minutes) |
| `LABELED` | `true` | Only monitor labeled/annotated containers |
| `LABEL` | `containrdog-enabled` | Label name to watch |
| `POLICY` | `major` | Update policy (see [Update Policies](update-policies.md)) |
| `AUTO_UPDATE` | `true` | Auto-pull and recreate on update |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `IMAGE_LABEL` | — | Image label key to display in notifications (e.g. `org.opencontainers.image.revision`). Fetched from the registry for both old and new image. Silently omitted if not present. |

## Docker / Podman

| Variable | Default | Description |
|----------|---------|-------------|
| `SOCKET_PATH` | `/var/run/docker.sock` | Docker/Podman socket path |

## Kubernetes

| Variable | Default | Description |
|----------|---------|-------------|
| `K8S_NAMESPACES` | `default` | Comma-separated namespaces to monitor |
| `K8S_ALL_NAMESPACES` | `false` | Monitor all namespaces |
| `K8S_KUBECONFIG` | *(auto)* | Path to kubeconfig; falls back to in-cluster, then `~/.kube/config` |

## Update Policy Options

| Variable | Default | Description |
|----------|---------|-------------|
| `GLOB_PATTERN` | — | Wildcard pattern for `glob` policy |

## Commands (Hooks)

| Variable | Default | Description |
|----------|---------|-------------|
| `PRE_UPDATE_COMMANDS` | — | JSON array of commands before update |
| `POST_UPDATE_COMMANDS` | — | JSON array of commands after update |
| `UPDATE_COMMANDS` | — | Deprecated alias for `POST_UPDATE_COMMANDS` |

## Webhooks

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOK_ENABLED` | `false` | Enable webhook notifications |
| `WEBHOOK_URL` | — | Webhook endpoint URL |
| `WEBHOOK_PROVIDER` | `generic` | `slack`, `discord`, `teams`, `generic` |
| `WEBHOOK_NOTIFY_SUCCESS` | `true` | Notify on successful update |
| `WEBHOOK_NOTIFY_FAILURE` | `true` | Notify on failed update |
| `WEBHOOK_NOTIFY_CHECK` | `false` | Notify on every check cycle |
| `WEBHOOK_NOTIFY_GITOPS` | `true` | Notify when GitOps commands execute |

## GitOps

| Variable | Default | Description |
|----------|---------|-------------|
| `GITOPS_ENABLED` | `false` | Enable GitOps monitoring |
| `GITOPS_REPO_URL` | — | Git repository URL |
| `GITOPS_BRANCH` | `main` | Branch to monitor |
| `GITOPS_AUTH_TYPE` | `none` | `token`, `ssh`, `none` |
| `GITOPS_TOKEN` | — | Access token |
| `GITOPS_SSH_KEY_PATH` | — | Path to SSH private key |
| `GITOPS_POLL_INTERVAL` | `60s` | Git check interval |
| `GITOPS_WATCH_PATHS` | — | JSON array of glob patterns to watch |
| `GITOPS_COMMANDS` | — | JSON array of commands to run on changes |
| `GITOPS_CLONE_PATH` | `/tmp/<repo>` | Local directory for clone |
| `GITOPS_QUIET_MODE` | `false` | Suppress command stdout |

## Registry Credentials

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCKER_CONFIG_PATH` | `/config.json` | Path to Docker config.json |
| `REGISTRY_CREDENTIALS` | — | JSON credentials (alternative to config.json) |
| `CREDENTIALS_FILE` | — | Path to a JSON credentials file |

## AWS ECR

| Variable | Default | Description |
|----------|---------|-------------|
| `ECR_ENABLED` | `false` | Enable ECR auto-authentication |
| `ECR_REGION` | — | AWS region (also reads `AWS_REGION`) |
| `ECR_ACCESS_KEY_ID` | — | AWS access key (also reads `AWS_ACCESS_KEY_ID`) |
| `ECR_SECRET_ACCESS_KEY` | — | AWS secret key (also reads `AWS_SECRET_ACCESS_KEY`) |
| `ECR_REGISTRIES` | — | Comma-separated ECR registry URLs |
| `ECR_ACCOUNT_ID` | — | AWS account ID (auto-builds registry URL) |
| `ECR_AUTH_REFRESH_INTERVAL` | `6h` | Token refresh interval |

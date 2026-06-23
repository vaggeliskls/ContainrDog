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
| `IMAGE_LABEL` | — | JSON array of image label keys to display in notifications (e.g. `["org.opencontainers.image.revision","org.opencontainers.image.version"]`). Each key is fetched from the registry; only labels found on the new image are included in chat notifications. |

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

## Update Verification & Rollback

After an auto-update, ContainrDog verifies the new version actually comes up healthy before reporting success. If it doesn't, the previous image is restored and a **failure** notification is sent — instead of a false "success" and a re-update loop.

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_CHECK_ENABLED` | `true` | Verify the new container/rollout is healthy after an update before declaring success |
| `HEALTH_CHECK_TIMEOUT` | `30` | Seconds to wait for the new version to become healthy. Docker: honours the image `HEALTHCHECK` if present, otherwise requires the container to stay running (no crash/restart loop). Kubernetes: waits for the rollout to become fully ready |
| `HEALTH_CHECK_INTERVAL` | `3` | Seconds between health polls while waiting |
| `ROLLBACK_ON_FAILURE` | `true` | Restore the previous image when the health check fails. Docker rolls back by image ID (survives digest-only updates); Kubernetes re-patches the prior image |
| `UPDATE_FAILURE_COOLDOWN` | `1h` | After a failed update, don't re-attempt the **same** target image for this long (`h`/`m`/`s`). Stops the repeated update/notification loop. A newer target is still attempted; set to `0` to disable |

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
| `WEBHOOK_NOTIFY_GITOPS_SUCCESS` | `true` | Notify when GitOps commands succeed |
| `WEBHOOK_NOTIFY_GITOPS_FAILURE` | `true` | Notify when GitOps commands fail |

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
| `GITOPS_CLONE_PATH` | `/tmp` | Parent directory for per-container clones. K8s: `<GITOPS_CLONE_PATH>/<namespace>-<repo>-<branch>`. Docker: `<GITOPS_CLONE_PATH>/<repo>-<branch>`. Workloads sharing those values share one working tree. |
| `GITOPS_SHALLOW` | `false` | Clone with `--depth 1` (history-less). Latest files are still on disk. Useful for large repos. |
| `GITOPS_QUIET_MODE` | `false` | Suppress command stdout |

## Registry Credentials

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCKER_CONFIG_PATH` | `/config.json` | Path to Docker config.json |
| `REGISTRY_CREDENTIALS` | — | JSON credentials (alternative to config.json) |
| `CREDENTIALS_FILE` | — | Path to a JSON credentials file |

## HTTP API & Dashboard UI

| Variable | Default | Description |
|----------|---------|-------------|
| `HTTP_API` | `true` | Run the built-in HTTP server (status + GitOps triggers). Set `false` to disable it entirely |
| `UI_ENABLED` | `false` | Serve the web dashboard page at `/`. Does **not** gate the HTTP API |
| `UI_PORT` | `8080` | Port the HTTP server listens on (alias: `HTTP_PORT`) |

The HTTP server runs by default and always exposes:
- `GET /api/status` — read-only JSON status
- `POST /api/gitops/trigger[/<container>]` — on-demand GitOps triggers (see [GitOps → HTTP Triggers](gitops.md#http-triggers))

`UI_ENABLED=true` additionally serves the dashboard page at `http://<host>:<UI_PORT>/`. With the UI disabled, `/` returns 404 but the API endpoints still work.

The dashboard presents monitored workloads ArgoCD-style: one card per component with a **Health** status (Healthy / Degraded / Progressing / Unknown) and a **Sync** status (Synced / OutOfSync / Updating / Failed), plus current→available image tags. Cards are sorted problems-first and can be filtered by name, health, or sync.

> **Docker**: publish the port with `-p 8080:8080` (or `ports: ["8080:8080"]` in Compose).
>
> **Kubernetes**: set `ui.enabled: true` in Helm values — the chart creates and removes the `Service` automatically. See [Deployment → Dashboard UI](deployments.md#dashboard-ui-kubernetes).

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

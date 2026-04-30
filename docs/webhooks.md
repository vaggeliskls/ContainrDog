# Webhooks

Send notifications to Slack, Discord, Teams, or any HTTP endpoint when updates are detected.

## Setup

```yaml
environment:
  - WEBHOOK_ENABLED=true
  - WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
  - WEBHOOK_PROVIDER=slack         # slack | discord | teams | generic
  - WEBHOOK_NOTIFY_SUCCESS=true    # notify on successful update (default: true)
  - WEBHOOK_NOTIFY_FAILURE=true    # notify on failed update (default: true)
  - WEBHOOK_NOTIFY_CHECK=false     # notify on every check cycle (default: false)
  - WEBHOOK_NOTIFY_GITOPS=true     # notify when GitOps commands execute (default: true)
```

## Image Labels in Notifications

Optionally display one or more image labels (e.g. commit hash, version) alongside version info in notifications. Pass a JSON array:

```yaml
environment:
  - IMAGE_LABEL=["org.opencontainers.image.revision","org.opencontainers.image.version"]
```

Each label is fetched from the registry for the new image and shown as a separate field. Labels not present on the image are silently omitted — no errors, no empty fields.

Per-container override (Docker label / Kubernetes annotation, JSON array):
```
containrdog.image-label=["org.opencontainers.image.revision","org.opencontainers.image.version"]
```

> **Note:** The label must be set by the image builder. Images built with GitHub Actions and `docker/metadata-action` include it automatically. Third-party images (nginx, postgres, etc.) typically do not.

## Providers

**Slack:**
```yaml
- WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../XXX
- WEBHOOK_PROVIDER=slack
```

**Discord:**
```yaml
- WEBHOOK_URL=https://discord.com/api/webhooks/123.../abc...
- WEBHOOK_PROVIDER=discord
```

**Microsoft Teams:**
```yaml
- WEBHOOK_URL=https://outlook.office.com/webhook/...
- WEBHOOK_PROVIDER=teams
```

**Generic (custom HTTP endpoint):**
```yaml
- WEBHOOK_PROVIDER=generic
```

**Container update** payload sent:
```json
{
  "event": "container_update",
  "status": "success",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "container": { "id": "abc123", "name": "nginx-app", "image": "nginx:1.25" },
  "update": {
    "currentTag": "1.25",
    "newTag": "1.26",
    "updateType": "semantic_version",
    "labels": [
      { "key": "org.opencontainers.image.revision", "value": "def5678" },
      { "key": "org.opencontainers.image.version", "value": "1.26.0" }
    ]
  },
  "error": null
}
```

The `labels` array is only present when `IMAGE_LABEL` is configured. Each entry's `value` is `null` if that label is not found on the new image.

**GitOps deploy** payload sent (when `WEBHOOK_NOTIFY_GITOPS=true`):
```json
{
  "event": "gitops_deploy",
  "status": "success",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "container": { "id": "abc123", "name": "myapp", "image": "ghcr.io/myorg/myapp:1.0.0" },
  "changes": {
    "commit": "a1b2c3d4e5f6...",
    "previousCommit": "9z8y7x6w5v4u...",
    "message": "chore: bump nginx to 1.26",
    "filesChanged": 1
  },
  "error": null
}
```

**Check cycle** payload sent (when `WEBHOOK_NOTIFY_CHECK=true`):
```json
{
  "event": "check_complete",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "containersChecked": 5,
  "updatesFound": 1
}
```

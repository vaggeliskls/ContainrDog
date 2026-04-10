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

## Image Label in Notifications

Optionally display an image label (e.g. commit hash) alongside version info in notifications:

```yaml
environment:
  - IMAGE_LABEL=org.opencontainers.image.revision
```

The label value is fetched from the registry for both the current and new image and shown as extra fields. If the label is not present on an image it is silently omitted — no errors, no empty fields.

Per-container override (Docker label / Kubernetes annotation):
```
containrdog.image-label=org.opencontainers.image.revision
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

JSON payload sent:
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
    "label": {
      "key": "org.opencontainers.image.revision",
      "currentValue": "abc1234",
      "newValue": "def5678"
    }
  },
  "error": null
}
```

The `label` field is only present when `IMAGE_LABEL` is configured. `currentValue`/`newValue` are `null` if the label is not found on that image.

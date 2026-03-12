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
```

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
  "update": { "currentTag": "1.25", "newTag": "1.26", "updateType": "semantic_version" },
  "error": null
}
```

# Hooks (Pre/Post Update Commands)

Run shell commands before and after a container is updated.

## Environment Variables Available in Commands

| Variable | Description |
|----------|-------------|
| `CONTAINER_ID` | Container ID |
| `CONTAINER_NAME` | Container name |
| `CURRENT_IMAGE` | Current image with tag |
| `CURRENT_TAG` | Current tag |
| `AVAILABLE_IMAGE` | New image with tag |
| `AVAILABLE_TAG` | New tag |
| `UPDATE_TYPE` | `semantic_version`, `digest_change`, `static_tag` |

## Global Hooks (all containers)

```bash
PRE_UPDATE_COMMANDS='["echo Starting update for $CONTAINER_NAME"]'
POST_UPDATE_COMMANDS='["echo Updated $CONTAINER_NAME to $AVAILABLE_TAG"]'
```

## Per-Container Hooks

```yaml
labels:
  - containrdog.pre-update-commands=["docker exec myapp /backup.sh"]
  - containrdog.post-update-commands=["docker exec myapp /healthcheck.sh"]
```

## Execution Order

```
Pre-update commands
  ↓
Update container image
  ↓
Post-update commands
```

- Commands run sequentially; a failure stops the sequence and marks the update as failed.
- Update still proceeds if pre-update commands succeed.

## Examples

**Backup before update:**
```bash
PRE_UPDATE_COMMANDS='["docker exec $CONTAINER_NAME pg_dump mydb > /backup/pre-update.sql"]'
```

**Health check and notify after update:**
```bash
POST_UPDATE_COMMANDS='[
  "docker exec $CONTAINER_NAME /healthcheck.sh",
  "curl -s -X POST https://notify.example.com -d \"Updated $CONTAINER_NAME to $AVAILABLE_TAG\""
]'
```

**Per-container with both hooks:**
```yaml
labels:
  - containrdog.policy=patch
  - containrdog.pre-update-commands=["docker exec postgres pg_dump mydb > /backup/latest.sql"]
  - containrdog.post-update-commands=["docker exec postgres psql -c 'SELECT version()'"]
```

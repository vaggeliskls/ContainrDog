# Update Policies

Policies control which version changes trigger an update. Inspired by [keel.sh](https://keel.sh/).

## Available Policies

| Policy | Triggers on | Example |
|--------|-------------|---------|
| `all` | Any bump including prereleases | `1.0.0` → `1.0.1-rc1` ✓ |
| `major` | Major, minor, and patch | `1.0.0` → `2.0.0`, `1.1.0`, `1.0.1` ✓ |
| `minor` | Minor and patch only | `1.0.0` → `1.1.0` ✓, `2.0.0` ✗ |
| `patch` | Patch only | `1.0.0` → `1.0.1` ✓, `1.1.0` ✗ |
| `force` | Digest changes (any tag, including `latest`) | Digest changed ✓ |
| `glob` | Tags matching a wildcard pattern | `1.2*` matches `1.25`, `1.26` |

## Setting the Policy

**Global** (all containers):
```bash
POLICY=minor
```

**Per-container** label/annotation (overrides global):
```yaml
# Docker label
containrdog.policy: minor

# Kubernetes annotation
containrdog.policy: "minor"
```

## Examples

**Stay within v1.x (minor policy):**
```yaml
image: myapp:1.5.0
labels:
  - containrdog.policy=minor
# ✓ 1.5.0 → 1.5.1, 1.6.0
# ✗ 1.5.0 → 2.0.0
```

**Only bug fixes (patch policy):**
```yaml
image: postgres:15.2.0
labels:
  - containrdog.policy=patch
# ✓ 15.2.0 → 15.2.1
# ✗ 15.2.0 → 15.3.0
```

**Track `latest` digest (force policy):**
```yaml
image: myapp:latest
labels:
  - containrdog.policy=force
  - containrdog.match-tag=true  # Only check same tag, not all tags
```

**Wildcard version range (glob policy):**
```yaml
image: myapp:1.2.3
labels:
  - containrdog.policy=glob
  - containrdog.glob-pattern=1.2*
# ✓ 1.20, 1.21, 1.29
# ✗ 1.3.0, 2.0.0
```

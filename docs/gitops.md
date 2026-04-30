# GitOps

Monitor a Git repository and run commands when files change. Runs on its own interval, independently of image update checks.

## How It Works

1. ContainrDog clones and monitors a Git repository on a configured branch.
2. On each poll it checks for new commits.
3. If `GITOPS_WATCH_PATHS` is set, only matching file changes trigger commands.
4. Configured commands are executed in the cloned repo's directory.

## Basic Setup

```yaml
environment:
  - GITOPS_ENABLED=true
  - GITOPS_REPO_URL=https://github.com/user/config-repo.git
  - GITOPS_BRANCH=main
  - GITOPS_AUTH_TYPE=token
  - GITOPS_TOKEN=ghp_your_token
  - GITOPS_POLL_INTERVAL=60s
  - GITOPS_WATCH_PATHS=["docker-compose.yml", "config/**"]
  - GITOPS_COMMANDS=["docker-compose pull", "docker-compose up -d --remove-orphans"]
```

## Authentication

**Token (GitHub, GitLab, Bitbucket):**
```yaml
- GITOPS_AUTH_TYPE=token
- GITOPS_TOKEN=ghp_xxxxx
```

**SSH / Deploy Keys:**

A deploy key is an SSH key pair scoped to a single repository. Add the public key to your repo (GitHub: _Settings → Deploy keys_; GitLab: _Settings → Repository → Deploy keys_) and mount the private key into the container.

Generate a key pair (no passphrase):
```bash
ssh-keygen -t ed25519 -C "containrdog" -f ./containrdog_deploy_key -N ""
# containrdog_deploy_key     → private key (mount into container)
# containrdog_deploy_key.pub → add to repo as a deploy key
```

Docker:
```yaml
- GITOPS_AUTH_TYPE=ssh
- GITOPS_REPO_URL=git@github.com:myorg/myrepo.git
- GITOPS_SSH_KEY_PATH=/keys/deploy_key
volumes:
  - ./containrdog_deploy_key:/keys/deploy_key:ro
```

Kubernetes — create a Secret with the private key and reference it in helm values:
```bash
kubectl create secret generic containrdog-deploy-key \
  --from-file=deploy_key=./containrdog_deploy_key \
  -n containrdog
```

```yaml
# helm values
gitops:
  enabled: true
  repoUrl: "git@github.com:myorg/myrepo.git"
  authType: ssh
  sshKeySecret: containrdog-deploy-key  # Secret name — key must be named "deploy_key"
  sshKeyPath: /keys/deploy_key          # default, can be omitted
```

The chart mounts the secret at `/keys` with `0400` permissions automatically.

> Note: host fingerprint verification is disabled (`StrictHostKeyChecking=no`), so no `known_hosts` setup is required.

**Public repos:**
```yaml
- GITOPS_AUTH_TYPE=none
```

## Environment Variables in Commands

| Variable | Description |
|----------|-------------|
| `CONTAINER_ID` | Container ID |
| `CONTAINER_NAME` | Container name |
| `CONTAINER_IMAGE` | Container image |
| `GIT_COMMIT` | Current commit hash |
| `GIT_PREVIOUS_COMMIT` | Previous commit hash |
| `GIT_COMMIT_MESSAGE` | Commit message |
| `GIT_CHANGED_FILES` | Comma-separated changed files |
| `GITOPS_CLONE_PATH` | Full path to the working tree for this command (`<parent>/<repo-name>`) |

## Per-Container GitOps

Each container can have its own repository and settings (overrides global):

```yaml
services:
  api:
    image: myapi:latest
    labels:
      - containrdog-enabled=true
      - containrdog.gitops-enabled=true
      - containrdog.gitops-repo-url=https://github.com/user/api-config.git
      - containrdog.gitops-branch=production
      - containrdog.gitops-auth-type=token
      - containrdog.gitops-token=ghp_api_token
      - containrdog.gitops-watch-paths=["config/**", "*.env"]
      - containrdog.gitops-commands=["docker exec api /reload-config.sh"]
```

## Watch Paths

```bash
# Specific file
GITOPS_WATCH_PATHS='["docker-compose.yml"]'

# All YAML files
GITOPS_WATCH_PATHS='["**/*.yml", "**/*.yaml"]'

# Directory subtree
GITOPS_WATCH_PATHS='["config/**"]'

# Multiple patterns
GITOPS_WATCH_PATHS='["docker-compose.yml", ".env*", "config/**"]'

# Omit to run on every commit (no filtering)
```

## Common Patterns

**Auto-deploy docker-compose on change:**
```yaml
- GITOPS_WATCH_PATHS=["docker-compose.yml"]
- GITOPS_COMMANDS=["docker-compose pull", "docker-compose up -d --remove-orphans"]
```

**Reload nginx config:**
```yaml
labels:
  - containrdog.gitops-watch-paths=["nginx/**"]
  - containrdog.gitops-commands=["docker cp $GITOPS_CLONE_PATH/nginx/nginx.conf nginx:/etc/nginx/nginx.conf", "docker exec nginx nginx -s reload"]
```

**Multi-container with shared repo:**
```yaml
# Global repo
GITOPS_REPO_URL=https://github.com/user/infra.git

services:
  api:
    labels:
      - containrdog.gitops-watch-paths=["services/api/**"]
      - containrdog.gitops-commands=["docker-compose restart api"]
  web:
    labels:
      - containrdog.gitops-watch-paths=["services/web/**"]
      - containrdog.gitops-commands=["docker-compose restart web"]
```

# ContainrDog 🐕

Automated container image update monitor for Docker and Podman. Periodically checks for new image versions and executes custom commands when updates are detected.

## Features

- **Docker & Podman Support**: Works with both Docker and Podman container runtimes
- **Flexible Update Detection**:
  - Semantic version changes (e.g., `1.2.3` → `1.2.4`)
  - Digest changes for static tags (e.g., `latest`, `stable`)
  - Tag-based monitoring
- **Policy-Based Updates** (keel.sh compatible):
  - **all**: Update on any version bump including prereleases
  - **major**: Update major, minor, and patch versions
  - **minor**: Update only minor and patch versions (ignores major)
  - **patch**: Update only patch versions (ignores minor and major)
  - **force**: Force update even for non-semver tags like `latest`
  - **glob**: Use wildcard patterns to match versions
- **Configurable Monitoring**:
  - Monitor all running containers
  - Monitor only labeled containers
  - Customizable check intervals (seconds or minutes)
  - Per-container or global policy configuration
- **Private Registry Support**: Authentication for private registries (Docker Hub, GitHub Container Registry, etc.)
- **Custom Update Hooks**: Execute custom commands/scripts when updates are detected
- **Built with TypeScript & Node.js 22**

## Quick Start

### Using Docker Compose (Recommended)

1. Clone or copy this repository
2. Edit `docker-compose.yml` to configure your settings
3. Start the service:

```bash
docker-compose up -d
```

### Using Docker

```bash
docker build -t containrdog .

docker run -d \
  --name containrdog \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e INTERVAL=5 \
  -e LOG_LEVEL=info \
  containrdog
```

### Using Podman

```bash
podman build -t containrdog .

podman run -d \
  --name containrdog \
  -v /run/podman/podman.sock:/var/run/docker.sock:ro \
  -e INTERVAL=5 \
  -e LOG_LEVEL=info \
  containrdog
```

## Configuration

All configuration is done via environment variables:

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `INTERVAL` | Check interval (supports: "5s", "5m", or "5" for minutes) | `5s` | `5s`, `1m`, `10` |
| `LABELED` | Only monitor labeled containers | `false` | `true` |
| `LABEL` | Label name to check for | `containrdog-enabled` | `auto-update` |
| `POLICY` | Global update policy (can be overridden per container) | `major` | `all`, `major`, `minor`, `patch`, `force`, `glob` |
| `GLOB_PATTERN` | Pattern for glob policy | - | `1.2*`, `*-stable` |
| `MATCH_TAG` | For force policy: only update same tag | `false` | `true` |
| `AUTO_UPDATE` | Automatically pull and recreate containers on update | `true` | `false` to only log |
| `SOCKET_PATH` | Custom socket path | `/var/run/docker.sock` | `/run/podman/podman.sock` |
| `LOG_LEVEL` | Logging level | `info` | `debug`, `warn`, `error` |
| `REGISTRY_CREDENTIALS` | Private registry credentials (JSON) | - | See below |
| `UPDATE_COMMANDS` | **Deprecated:** Custom commands to run after update (JSON array) | - | Use `POST_UPDATE_COMMANDS` |
| `PRE_UPDATE_COMMANDS` | Commands to run before update (JSON array) | - | See below |
| `POST_UPDATE_COMMANDS` | Commands to run after update (JSON array) | - | See below |
| `WEBHOOK_ENABLED` | Enable webhook notifications | `false` | `true` |
| `WEBHOOK_URL` | Webhook URL (required if enabled) | - | `https://hooks.slack.com/...` |
| `WEBHOOK_PROVIDER` | Webhook provider type | `generic` | `slack`, `discord`, `teams`, `generic` |
| `WEBHOOK_NOTIFY_SUCCESS` | Notify on successful updates | `true` | `false` |
| `WEBHOOK_NOTIFY_FAILURE` | Notify on failed updates | `true` | `false` |
| `WEBHOOK_NOTIFY_CHECK` | Notify on every check cycle | `false` | `true` |
| `GITOPS_ENABLED` | Enable GitOps repository monitoring | `false` | `true` |
| `GITOPS_REPO_URL` | Git repository URL | - | `https://github.com/user/repo.git` |
| `GITOPS_BRANCH` | Branch to monitor | `main` | `develop`, `production` |
| `GITOPS_AUTH_TYPE` | Authentication type | `none` | `token`, `ssh`, `none` |
| `GITOPS_TOKEN` | Access token for authentication | - | `ghp_xxxxx` |
| `GITOPS_SSH_KEY_PATH` | Path to SSH private key | - | `/config/id_rsa` |
| `GITOPS_POLL_INTERVAL` | Git check interval | `60s` | `30s`, `5m` |
| `GITOPS_WATCH_PATHS` | File patterns to watch (JSON array) | - | `["*.yml", "config/**"]` |
| `GITOPS_COMMANDS` | Commands to run on changes (JSON array) | - | See below |
| `GITOPS_CLONE_PATH` | Local clone directory | `/tmp/gitops-repo` | `/data/gitops` |

### Registry Credentials

The application reads Docker registry credentials from your Docker config file. Mount your Docker config when running the container:

```yaml
volumes:
  - ~/.docker/config.json:/config.json:ro
```

The application automatically parses Docker's `config.json` format. To add credentials, use `docker login`:

```bash
# Docker Hub
docker login

# GitHub Container Registry
echo $GITHUB_TOKEN | docker login ghcr.io -u $GITHUB_USERNAME --password-stdin

# Custom registry
docker login registry.example.com
```

**Alternative**: You can also provide credentials via environment variables (JSON format):
```bash
REGISTRY_CREDENTIALS='{"registry":"ghcr.io","username":"myuser","password":"ghp_token123"}'
```

### Pre and Post Update Commands

Execute custom commands before and after container updates. Available environment variables in commands:

- `CONTAINER_ID` - Container ID
- `CONTAINER_NAME` - Container name
- `CURRENT_IMAGE` - Current image with tag
- `CURRENT_TAG` - Current tag
- `AVAILABLE_IMAGE` - New image with tag
- `AVAILABLE_TAG` - New tag
- `UPDATE_TYPE` - Type of update (semantic_version, digest_change, static_tag)

**Pre-Update Commands:**

Execute commands BEFORE pulling the new image and recreating the container. Useful for:
- Backup operations
- Notifications about starting updates
- Pre-update health checks
- Stopping dependent services

```bash
PRE_UPDATE_COMMANDS='[
  "echo Starting update for $CONTAINER_NAME from $CURRENT_TAG to $AVAILABLE_TAG",
  "docker exec $CONTAINER_NAME /app/backup.sh"
]'
```

**Post-Update Commands:**

Execute commands AFTER successfully updating the container. Useful for:
- Post-update health checks
- Success notifications
- Cache clearing
- Restarting dependent services

```bash
POST_UPDATE_COMMANDS='[
  "echo Successfully updated $CONTAINER_NAME to $AVAILABLE_TAG",
  "docker exec $CONTAINER_NAME /app/healthcheck.sh",
  "curl -X POST https://webhook.site/xxx -d \"Updated: $CONTAINER_NAME ($CURRENT_TAG -> $AVAILABLE_TAG)\""
]'
```

**Combined Example:**

```bash
# Pre-update: Backup database before update
PRE_UPDATE_COMMANDS='["docker exec $CONTAINER_NAME /app/backup-db.sh"]'

# Post-update: Run migrations and health check
POST_UPDATE_COMMANDS='[
  "docker exec $CONTAINER_NAME /app/migrate.sh",
  "docker exec $CONTAINER_NAME /app/healthcheck.sh"
]'
```

**Backward Compatibility:**

The `UPDATE_COMMANDS` environment variable is still supported for backward compatibility but is deprecated. If set, it behaves as `POST_UPDATE_COMMANDS`:

```bash
# Deprecated (still works)
UPDATE_COMMANDS='["echo Update complete"]'

# Recommended
POST_UPDATE_COMMANDS='["echo Update complete"]'
```

### Webhook Notifications

ContainrDog can send notifications to various webhook providers when updates are detected or applied.

**Supported Providers:**
- **Slack** - Rich formatted messages with attachments
- **Discord** - Embedded messages with colors
- **Microsoft Teams** - Adaptive card format
- **Generic** - JSON payload for custom integrations

**Configuration:**

```yaml
environment:
  # Enable webhooks
  - WEBHOOK_ENABLED=true

  # Webhook URL (get this from your provider)
  - WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

  # Provider type (optional, auto-detects from URL)
  - WEBHOOK_PROVIDER=slack

  # Notification preferences (optional)
  - WEBHOOK_NOTIFY_SUCCESS=true   # Notify on successful updates (default: true)
  - WEBHOOK_NOTIFY_FAILURE=true   # Notify on failed updates (default: true)
  - WEBHOOK_NOTIFY_CHECK=false    # Notify on every check (default: false)
```

**Example: Slack Webhook**
```yaml
environment:
  - WEBHOOK_ENABLED=true
  - WEBHOOK_URL=https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXX
  - WEBHOOK_PROVIDER=slack
```

**Example: Discord Webhook**
```yaml
environment:
  - WEBHOOK_ENABLED=true
  - WEBHOOK_URL=https://discord.com/api/webhooks/123456789/abcdefghijklmnop
  - WEBHOOK_PROVIDER=discord
```

**Example: Microsoft Teams Webhook**
```yaml
environment:
  - WEBHOOK_ENABLED=true
  - WEBHOOK_URL=https://outlook.office.com/webhook/...
  - WEBHOOK_PROVIDER=teams
```

**Generic Webhook Payload Format:**

When using `WEBHOOK_PROVIDER=generic`, ContainrDog sends a JSON payload:

```json
{
  "event": "container_update",
  "status": "success",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "container": {
    "id": "abc123...",
    "name": "nginx-app",
    "image": "nginx:1.25"
  },
  "update": {
    "currentTag": "1.25",
    "newTag": "1.26",
    "updateType": "semantic_version"
  },
  "error": null
}
```

## GitOps - Configuration as Code

ContainrDog supports GitOps-style configuration management by monitoring a Git repository for changes. When changes are detected in specified files, custom commands can be executed automatically.

**Key Features:**
- Monitor any Git repository (GitHub, GitLab, Bitbucket, self-hosted)
- Token or SSH authentication support
- Filter by specific files/folders using glob patterns
- Execute commands when changes are detected
- Per-container or global GitOps configuration
- Runs independently on configurable intervals

### How It Works

1. **Repository Monitoring**: ContainrDog clones and monitors your Git repository
2. **Change Detection**: Periodically checks for new commits on the specified branch
3. **File Filtering**: Optionally filters changes by glob patterns (e.g., `docker-compose.yml`, `config/**/*.env`)
4. **Command Execution**: Runs configured commands when relevant changes are detected
5. **Coordination**: GitOps checks run independently but execute **before** container updates

### Configuration

**Global GitOps (applies to all containers):**

```yaml
environment:
  - GITOPS_ENABLED=true
  - GITOPS_REPO_URL=https://github.com/user/config-repo.git
  - GITOPS_BRANCH=main
  - GITOPS_AUTH_TYPE=token
  - GITOPS_TOKEN=ghp_your_token_here
  - GITOPS_POLL_INTERVAL=60s
  - GITOPS_WATCH_PATHS=["docker-compose.yml", "config/**/*.env", ".env*"]
  - GITOPS_COMMANDS=["docker-compose pull", "docker-compose up -d --remove-orphans"]
```

**Per-Container GitOps:**

```yaml
services:
  app:
    image: myapp:latest
    labels:
      - containrdog-enabled=true
      - containrdog.gitops-enabled=true
      - containrdog.gitops-watch-paths=["services/app/**", "config/app.yml"]
      - containrdog.gitops-commands=["docker exec app /app/reload-config.sh"]
```

### Authentication

**Token Authentication (GitHub, GitLab, Bitbucket):**

```yaml
environment:
  - GITOPS_AUTH_TYPE=token
  - GITOPS_TOKEN=ghp_your_github_token
  # or
  - GITOPS_TOKEN=glpat-your_gitlab_token
```

**SSH Authentication:**

```yaml
environment:
  - GITOPS_AUTH_TYPE=ssh
  - GITOPS_SSH_KEY_PATH=/config/id_rsa

volumes:
  - ~/.ssh/id_rsa:/config/id_rsa:ro
```

**No Authentication (public repositories):**

```yaml
environment:
  - GITOPS_AUTH_TYPE=none
  - GITOPS_REPO_URL=https://github.com/user/public-repo.git
```

### File Watching with Glob Patterns

Use glob patterns to watch specific files or directories:

```bash
# Watch specific file
GITOPS_WATCH_PATHS='["docker-compose.yml"]'

# Watch all YAML files
GITOPS_WATCH_PATHS='["**/*.yml", "**/*.yaml"]'

# Watch directory and subdirectories
GITOPS_WATCH_PATHS='["config/**"]'

# Watch multiple patterns
GITOPS_WATCH_PATHS='["docker-compose.yml", "config/**/*.env", ".env*"]'

# Watch everything (if not specified, all changes trigger commands)
# GITOPS_WATCH_PATHS not set = watch all files
```

### Available Environment Variables in Commands

When GitOps commands are executed, the following variables are available:

- `CONTAINER_ID` - Container ID
- `CONTAINER_NAME` - Container name
- `CONTAINER_IMAGE` - Container image
- `GIT_COMMIT` - Current commit hash
- `GIT_PREVIOUS_COMMIT` - Previous commit hash
- `GIT_COMMIT_MESSAGE` - Commit message
- `GIT_CHANGED_FILES` - Comma-separated list of changed files

### GitOps Examples

**Example 1: Auto-deploy on docker-compose.yml changes**

```yaml
environment:
  - GITOPS_ENABLED=true
  - GITOPS_REPO_URL=https://github.com/user/infrastructure.git
  - GITOPS_BRANCH=production
  - GITOPS_AUTH_TYPE=token
  - GITOPS_TOKEN=ghp_xxxxx
  - GITOPS_WATCH_PATHS=["docker-compose.yml"]
  - GITOPS_COMMANDS=["docker-compose pull", "docker-compose up -d --remove-orphans"]
```

**Example 2: Reload nginx config on changes**

```yaml
services:
  nginx:
    image: nginx:latest
    labels:
      - containrdog-enabled=true
      - containrdog.gitops-enabled=true
      - containrdog.gitops-watch-paths=["config/nginx/**"]
      - containrdog.gitops-commands=["docker cp $GITOPS_CLONE_PATH/config/nginx/nginx.conf nginx:/etc/nginx/nginx.conf", "docker exec nginx nginx -s reload"]
```

**Example 3: Update environment variables and restart**

```yaml
environment:
  - GITOPS_ENABLED=true
  - GITOPS_REPO_URL=https://github.com/user/configs.git
  - GITOPS_WATCH_PATHS=[".env", "config/*.env"]
  - GITOPS_COMMANDS=["cp $GITOPS_CLONE_PATH/.env /app/.env", "docker-compose restart"]
```

**Example 4: Notification on config changes**

```yaml
environment:
  - GITOPS_ENABLED=true
  - GITOPS_REPO_URL=https://github.com/user/configs.git
  - GITOPS_COMMANDS=["echo 'Config updated: $GIT_COMMIT_MESSAGE'", "curl -X POST https://slack.com/webhook -d 'Git changes detected in: $GIT_CHANGED_FILES'"]
```

**Example 5: Multi-container coordination (shared repository)**

```yaml
environment:
  - GITOPS_ENABLED=true
  - GITOPS_REPO_URL=https://github.com/user/microservices.git

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

**Example 6: Per-container repositories**

Each container monitors its own separate Git repository:

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
      - containrdog.gitops-poll-interval=30s
      - containrdog.gitops-watch-paths=["config/**", "*.env"]
      - containrdog.gitops-commands=["docker exec api /app/reload-config.sh"]

  web:
    image: myweb:latest
    labels:
      - containrdog-enabled=true
      - containrdog.gitops-enabled=true
      - containrdog.gitops-repo-url=https://github.com/user/web-config.git
      - containrdog.gitops-branch=production
      - containrdog.gitops-auth-type=token
      - containrdog.gitops-token=ghp_web_token
      - containrdog.gitops-watch-paths=["assets/**", "config.json"]
      - containrdog.gitops-commands=["docker exec web npm run rebuild"]

  database:
    image: postgres:15
    labels:
      - containrdog-enabled=true
      - containrdog.gitops-enabled=true
      - containrdog.gitops-repo-url=https://github.com/user/db-migrations.git
      - containrdog.gitops-branch=main
      - containrdog.gitops-watch-paths=["migrations/**"]
      - containrdog.gitops-commands=["docker exec database psql -f /migrations/latest.sql"]
```

**Example 7: Mix global and per-container repositories**

Some containers use the global repository, others use their own:

```yaml
environment:
  # Global GitOps for infrastructure
  - GITOPS_ENABLED=true
  - GITOPS_REPO_URL=https://github.com/user/infrastructure.git
  - GITOPS_WATCH_PATHS=["docker-compose.yml", "shared/**"]
  - GITOPS_COMMANDS=["docker-compose up -d --remove-orphans"]

services:
  # Uses global GitOps repo
  nginx:
    image: nginx:latest
    labels:
      - containrdog-enabled=true
      - containrdog.gitops-enabled=true
      - containrdog.gitops-watch-paths=["nginx/**"]

  # Uses its own dedicated repo
  app:
    image: myapp:latest
    labels:
      - containrdog-enabled=true
      - containrdog.gitops-enabled=true
      - containrdog.gitops-repo-url=https://github.com/user/app-config.git
      - containrdog.gitops-branch=production
      - containrdog.gitops-commands=["docker exec app /app/reload.sh"]
```

### GitOps Workflow

The complete update workflow with GitOps enabled:

```
1. GitOps Check (every GITOPS_POLL_INTERVAL)
   ↓
2. Changes detected in watched files?
   ↓ (yes)
3. Execute GitOps commands
   ↓
4. Container Update Check (every INTERVAL)
   ↓
5. New image version available?
   ↓ (yes)
6. Execute pre-update commands
   ↓
7. Pull new image & recreate container
   ↓
8. Execute post-update commands
```

### Use Cases

1. **Configuration Management**: Keep container configs in Git, auto-deploy changes
2. **Infrastructure as Code**: Manage docker-compose files in Git
3. **Multi-Environment**: Use different branches for dev/staging/production
4. **Audit Trail**: Git history provides complete change tracking
5. **Collaboration**: Team members can update configs via pull requests
6. **Rollback**: Easy rollback using Git reverts
7. **Secret Management**: Update secrets stored in Git (encrypted)

## Auto-Update Behavior

By default (`AUTO_UPDATE=true`), when an update is detected, the container updater will:

1. **Pull the new image** from the registry
2. **Stop the current container**
3. **Remove the old container**
4. **Create and start a new container** with the same configuration but using the new image

This happens automatically without requiring custom commands. To disable auto-update and only log detected updates:

```yaml
environment:
  - AUTO_UPDATE=false
```

### Per-Container Control

You can control auto-update behavior per container using labels:

```yaml
services:
  # This container will auto-update
  app1:
    image: myapp:1.0.0
    labels:
      - containrdog-enabled=true
      - containrdog.auto-update=true

  # This container will only log updates
  app2:
    image: myapp:1.0.0
    labels:
      - containrdog-enabled=true
      - containrdog.auto-update=false
```

## Label-Based Monitoring

To monitor only specific containers, set `LABELED=true` and add labels to your containers:

```yaml
services:
  myapp:
    image: nginx:1.25
    labels:
      - containrdog-enabled=true
```

Or with Docker CLI:
```bash
docker run -d \
  --name myapp \
  --label containrdog-enabled=true \
  nginx:1.25
```

### Available Container Labels

| Label | Description | Example |
|-------|-------------|---------|
| `containrdog-enabled` | Enable/disable monitoring | `true`, `false` |
| `containrdog.policy` | Update policy for this container | `major`, `minor`, `patch`, `force`, `glob` |
| `containrdog.auto-update` | Enable/disable auto-update | `true`, `false` |
| `containrdog.match-tag` | For force policy | `true` |
| `containrdog.glob-pattern` | For glob policy | `1.2*` |
| `containrdog.update-commands` | **Deprecated:** Custom commands (JSON array) | Use `containrdog.post-update-commands` |
| `containrdog.pre-update-commands` | Pre-update commands (JSON array) | `["echo 'Starting update'"]` |
| `containrdog.post-update-commands` | Post-update commands (JSON array) | `["echo 'Update complete'"]` |
| `containrdog.gitops-enabled` | Enable/disable GitOps for container | `true`, `false` |
| `containrdog.gitops-repo-url` | Per-container Git repository URL | `https://github.com/user/repo.git` |
| `containrdog.gitops-branch` | Per-container Git branch | `main`, `develop` |
| `containrdog.gitops-auth-type` | Per-container auth type | `token`, `ssh`, `none` |
| `containrdog.gitops-token` | Per-container auth token | `ghp_xxxxx` |
| `containrdog.gitops-ssh-key-path` | Per-container SSH key path | `/config/id_rsa` |
| `containrdog.gitops-poll-interval` | Per-container poll interval | `30s`, `2m` |
| `containrdog.gitops-watch-paths` | GitOps watch patterns (JSON array) | `["config/**", "*.yml"]` |
| `containrdog.gitops-commands` | GitOps commands (JSON array) | `["docker exec app reload"]` |
| `containrdog.gitops-clone-path` | Per-container clone directory | `/tmp/gitops-myapp` |

## Update Policies

Update policies control which version updates trigger notifications. Inspired by [keel.sh](https://keel.sh/), policies can be set globally via environment variables or per-container using labels.

### Available Policies

| Policy | Description | Example |
|--------|-------------|---------|
| `all` | Update on any version bump, including prereleases | `1.0.0` → `1.0.1-rc1` |
| `major` | Update on major, minor, and patch versions | `1.0.0` → `2.0.0`, `1.1.0`, `1.0.1` |
| `minor` | Update only on minor and patch (ignores major) | `1.0.0` → `1.1.0`, `1.0.1` (but not `2.0.0`) |
| `patch` | Update only on patch versions | `1.0.0` → `1.0.1` (but not `1.1.0` or `2.0.0`) |
| `force` | Force update even for non-semver tags like `latest` | Checks digest changes for any tag |
| `glob` | Match versions using wildcard patterns | `1.2*` matches `1.25`, `1.26`, etc. |

### Setting Policies

**Global Policy** (applies to all containers):
```yaml
environment:
  - POLICY=major
```

**Per-Container Policy** (overrides global):
```yaml
services:
  nginx:
    image: nginx:1.25
    labels:
      - containrdog-enabled=true
      - containrdog.policy=major
```

### Policy Examples

**Example 1: Major policy for nginx**
```yaml
nginx:
  image: nginx:1.25
  labels:
    - containrdog.policy=major
# Will detect: 1.25 → 1.26, 1.27, 2.0, etc.
```

**Example 2: Minor policy (stay within v1.x)**
```yaml
app:
  image: myapp:1.5.0
  labels:
    - containrdog.policy=minor
# Will detect: 1.5.0 → 1.5.1, 1.6.0
# Will NOT detect: 1.5.0 → 2.0.0
```

**Example 3: Patch policy (only bug fixes)**
```yaml
database:
  image: postgres:15.2.0
  labels:
    - containrdog.policy=patch
# Will detect: 15.2.0 → 15.2.1, 15.2.2
# Will NOT detect: 15.2.0 → 15.3.0 or 16.0.0
```

**Example 4: Force policy for latest tag**
```yaml
app:
  image: myapp:latest
  labels:
    - containrdog.policy=force
    - containrdog.match-tag=true
# Will check digest changes for the 'latest' tag
```

**Example 5: Glob pattern for specific versions**
```yaml
app:
  image: myapp:1.2.3
  labels:
    - containrdog.policy=glob
    - containrdog.glob-pattern=1.2*
# Will match: 1.20, 1.21, 1.25, 1.29
# Will NOT match: 1.3.0, 2.0.0
```

**Example 6: Per-container pre and post update commands**
```yaml
database:
  image: postgres:15.2
  labels:
    - containrdog-enabled=true
    - containrdog.policy=patch
    - containrdog.pre-update-commands=["docker exec postgres pg_dump mydb > /backup/pre-update.sql"]
    - containrdog.post-update-commands=["docker exec postgres psql -c 'SELECT version()'"]
# Will backup database before update and verify version after
```

## Development

### Prerequisites

- Node.js 22 or higher
- Docker or Podman
- Docker Compose v2.22+ (for `watch` support)
- npm

### Development with Docker Compose Watch (Recommended)

Use Docker Compose's `watch` feature for automatic hot-reload during development:

```bash
# Start development environment with hot reload
docker compose -f docker-compose.dev.yml up --watch

# The application will automatically restart when you modify:
# - TypeScript source files (src/**/*.ts)
# - TypeScript config (tsconfig.json)
# - Package dependencies (package.json - triggers rebuild)
```

The dev container runs with `ts-node` for instant TypeScript execution without build steps.

### Local Development (Without Docker)

1. Install dependencies:
```bash
npm install
```

2. Run in development mode:
```bash
npm run dev
```

3. Build the project:
```bash
npm run build
```

### Project Structure

```
containrdog/
├── src/
│   ├── services/
│   │   ├── docker-client.ts       # Docker/Podman client interface
│   │   ├── registry-service.ts    # Registry API interactions
│   │   ├── update-checker.ts      # Update detection logic
│   │   └── monitor-service.ts     # Main monitoring service
│   ├── types/
│   │   └── index.ts               # TypeScript type definitions
│   ├── utils/
│   │   ├── config.ts              # Configuration manager
│   │   ├── logger.ts              # Logging utility
│   │   ├── image-parser.ts        # Image string parser
│   │   └── command-executor.ts    # Command execution
│   └── index.ts                   # Application entry point
├── Dockerfile                      # Container image (prod + dev)
├── docker-compose.yml              # Production compose configuration
├── docker-compose.dev.yml          # Development with watch mode
├── config.json.example             # Example Docker credentials format
├── package.json
├── tsconfig.json
└── README.md
```

### Configuration Files

The repository includes example configuration files:

- **config.json.example**: Shows Docker config.json format for registry credentials
- **.env.example**: Environment variable examples
- **docker-compose.dev.yml**: Development setup with hot-reload

### Building the Container

```bash
# Build
docker build -t containrdog .

# Run locally for testing
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e INTERVAL=1 \
  -e LOG_LEVEL=debug \
  containrdog
```

## How It Works

1. **Initialization**: Connects to Docker/Podman socket and verifies access
2. **Container Discovery**: Lists all running containers (filtered by label if configured)
3. **Update Detection**:
   - For semantic version tags (e.g., `1.2.3`): Checks registry for newer versions
   - For static tags (e.g., `latest`): Compares image digests
4. **Notification**: Executes configured custom commands with update information
5. **Scheduling**: Repeats the check at configured intervals

## Examples

### Monitor All Containers with Webhook Notifications

```yaml
services:
  containrdog:
    build: .
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      - INTERVAL=10
      - LABELED=false
      - UPDATE_COMMANDS=["curl -X POST https://hooks.slack.com/services/YOUR/WEBHOOK -d '{\"text\":\"Update: $CONTAINER_NAME ($CURRENT_TAG -> $AVAILABLE_TAG)\"}'"]
```

### Monitor Specific Containers with Auto-Pull

```yaml
services:
  containrdog:
    build: .
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      - INTERVAL=5
      - LABELED=true
      - UPDATE_COMMANDS=["docker pull $AVAILABLE_IMAGE","echo Pulled $AVAILABLE_IMAGE"]

  webapp:
    image: myapp:1.0.0
    labels:
      - containrdog-enabled=true
```

### Private Registry with GitHub Container Registry

```yaml
services:
  containrdog:
    build: .
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ~/.docker/config.json:/config.json:ro  # Mount Docker credentials
    environment:
      - INTERVAL=15
      - LABELED=false

# Before starting, login to the registry:
# echo $GITHUB_TOKEN | docker login ghcr.io -u $GITHUB_USERNAME --password-stdin
```

## Troubleshooting

### Cannot connect to Docker daemon

Ensure the socket is correctly mounted and the container has permission:
```bash
# Check socket path
ls -l /var/run/docker.sock

# For Podman, enable socket
systemctl --user enable --now podman.socket
```

### No updates detected

Check the logs:
```bash
docker logs containrdog
```

Enable debug logging:
```bash
LOG_LEVEL=debug
```

### Registry authentication fails

Verify credentials are correct and the registry URL matches exactly (e.g., `ghcr.io`, not `https://ghcr.io`)

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

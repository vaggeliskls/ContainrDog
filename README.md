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
| `UPDATE_COMMANDS` | Custom commands to run on update (JSON array) | - | See below |

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

### Update Commands

Execute custom commands when updates are detected. Available environment variables in commands:

- `CONTAINER_ID` - Container ID
- `CONTAINER_NAME` - Container name
- `CURRENT_IMAGE` - Current image with tag
- `CURRENT_TAG` - Current tag
- `AVAILABLE_IMAGE` - New image with tag
- `AVAILABLE_TAG` - New tag
- `UPDATE_TYPE` - Type of update (semantic_version, digest_change, static_tag)

**Examples:**

Log to console:
```bash
UPDATE_COMMANDS='["echo Update for $CONTAINER_NAME: $CURRENT_TAG to $AVAILABLE_TAG"]'
```

Send webhook notification:
```bash
UPDATE_COMMANDS='["curl -X POST https://webhook.site/xxx -d \"Container: $CONTAINER_NAME, Update: $CURRENT_TAG -> $AVAILABLE_TAG\""]'
```

Pull and restart container:
```bash
UPDATE_COMMANDS='[
  "docker pull $AVAILABLE_IMAGE",
  "docker stop $CONTAINER_ID",
  "docker rm $CONTAINER_ID",
  "docker run -d --name $CONTAINER_NAME $AVAILABLE_IMAGE"
]'
```

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
| `containrdog.update-commands` | Custom commands (JSON array) | `["echo 'test'"]` |

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

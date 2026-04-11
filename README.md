<div align="center">
  <img src="assets/logo.png" alt="ContainrDog Logo" width="300"/>

  # ContainrDog

  **Automated container image update monitor for Docker, Podman, and Kubernetes**

  Periodically checks for new image versions and executes custom commands when updates are detected.

  📖 **[Documentation](https://vaggeliskls.github.io/ContainrDog)**

  [![GitHub release](https://img.shields.io/github/v/release/vaggeliskls/ContainrDog)](https://github.com/vaggeliskls/ContainrDog/releases)
  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
  [![Docker Image](https://img.shields.io/badge/ghcr.io-containrdog-blue?logo=docker)](https://github.com/vaggeliskls/ContainrDog/pkgs/container/containrdog)
  [![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js)](https://nodejs.org)
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org)

  ---
</div>

## Features

- **Multi-runtime**: Docker, Podman, and Kubernetes
- **Update detection**: Semantic versioning and digest-based
- **Policy-based**: `all`, `major`, `minor`, `patch`, `force`, `glob`
- **Auto-update**: Pull and recreate containers (or patch K8s workloads) automatically
- **Pre/post hooks**: Run commands before and after updates
- **Webhooks**: Slack, Discord, Teams, generic
- **GitOps**: Monitor a Git repo and run commands on changes
- **Private registries**: Docker Hub, GHCR, ECR, custom

## Quick Start

**Docker Compose**
```bash
docker-compose up -d
```

**Docker**
```bash
docker run -d \
  --name containrdog \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e INTERVAL=5m \
  ghcr.io/vaggeliskls/containrdog
```

Opt containers in with a label:
```yaml
labels:
  - containrdog-enabled=true
```

**Kubernetes (Helm)**
```bash
helm install containrdog oci://ghcr.io/vaggeliskls/charts/containrdog \
  --namespace containrdog \
  --create-namespace \
  --set kubernetes.namespaces="{default}"
```

Opt workloads in with an annotation on the pod template:
```yaml
spec:
  template:
    metadata:
      annotations:
        containrdog-enabled: "true"
```

## Documentation

| Topic | Description |
|-------|-------------|
| [Deployment](docs/deployments.md) | Docker, Podman, and Kubernetes setup |
| [Configuration](docs/configuration.md) | All environment variables |
| [Update Policies](docs/update-policies.md) | `major`, `minor`, `patch`, `force`, `glob` |
| [Labels & Annotations](docs/labels.md) | Per-container control |
| [Hooks](docs/hooks.md) | Pre/post update commands |
| [Webhooks](docs/webhooks.md) | Slack, Discord, Teams notifications |
| [GitOps](docs/gitops.md) | Git-based config management |
| [Registries](docs/registries.md) | Private registry authentication & ECR |
| [Examples](docs/examples.md) | Full working examples for Docker and Kubernetes |
| [Development](docs/development.md) | Local dev and project structure |

## License

MIT

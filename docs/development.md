# Development

## Prerequisites

- Node.js 22+
- Docker or Podman
- npm

## Local Setup

```bash
npm install
npm run dev        # ts-node with nodemon watch
npm run build      # compile to dist/
npm run lint
npm run format
```

## Docker Compose Watch (hot-reload)

```bash
docker compose -f docker-compose.dev.yml up --watch
```

Source changes reload automatically. `package.json` changes trigger a rebuild.

## Project Structure

```
src/
├── index.ts                      # Entry point — selects runtime, starts scheduler
├── types/index.ts                # All TypeScript types and enums
├── services/
│   ├── runtime-client.ts         # IRuntimeClient interface
│   ├── docker-client.ts          # Docker/Podman implementation
│   ├── kubernetes-client.ts      # Kubernetes implementation
│   ├── registry-service.ts       # Registry API (manifest, tag listing)
│   ├── update-checker.ts         # Semver and digest comparison logic
│   ├── monitor-service.ts        # Orchestrator (update loop + GitOps loop)
│   ├── webhook-service.ts        # Webhook notifications
│   ├── git-service.ts            # GitOps repository polling
│   └── ecr-auth-service.ts       # AWS ECR token refresh
└── utils/
    ├── config.ts                 # Singleton config from env vars
    ├── label-parser.ts           # Shared label/annotation parsing
    ├── logger.ts                 # Winston logger
    ├── image-parser.ts           # Image string parsing (registry/repo:tag)
    └── command-executor.ts       # Shell command runner with env injection
```

## Adding a New Runtime

1. Implement `IRuntimeClient` from `src/services/runtime-client.ts`.
2. Add a value to the `ContainerRuntime` enum in `src/types/index.ts`.
3. Add config parsing in `src/utils/config.ts`.
4. Instantiate it in `src/index.ts` `createRuntimeClient()`.

## Building the Container Image

```bash
docker build -t containrdog .

# Test locally
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e INTERVAL=10s \
  -e LOG_LEVEL=debug \
  containrdog
```

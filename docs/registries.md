# Registries

ContainrDog needs read access to registries to check for newer image versions.

## Docker Config File (Recommended)

Mount your Docker credentials file:

```yaml
volumes:
  - ~/.docker/config.json:/config.json:ro
```

Populate it with `docker login`:

```bash
# Docker Hub
docker login

# GitHub Container Registry
echo $GITHUB_TOKEN | docker login ghcr.io -u $GITHUB_USERNAME --password-stdin

# Custom registry
docker login registry.example.com
```

## Environment Variable

Provide credentials directly without a config file:

```bash
# Single registry
REGISTRY_CREDENTIALS='{"registry":"ghcr.io","username":"myuser","password":"ghp_token"}'

# Multiple registries
REGISTRY_CREDENTIALS='[
  {"registry":"ghcr.io","username":"user","password":"ghp_token"},
  {"registry":"registry.example.com","username":"user","password":"pass"}
]'
```

## AWS ECR

ECR tokens expire every 12 hours. ContainrDog auto-refreshes them.

```yaml
environment:
  - ECR_ENABLED=true
  - ECR_REGION=us-east-1
  # Explicit credentials (or use IAM role / instance profile)
  - ECR_ACCESS_KEY_ID=AKIA...
  - ECR_SECRET_ACCESS_KEY=...
  # Registry URLs to authenticate (or use ECR_ACCOUNT_ID)
  - ECR_REGISTRIES=123456789.dkr.ecr.us-east-1.amazonaws.com
  - ECR_AUTH_REFRESH_INTERVAL=6h  # default
```

Using an IAM role (no explicit keys needed):
```yaml
environment:
  - ECR_ENABLED=true
  - ECR_REGION=us-east-1
  - ECR_ACCOUNT_ID=123456789
```

## Troubleshooting

**Authentication fails:** Verify the registry URL matches exactly (e.g. `ghcr.io`, not `https://ghcr.io`).

**ECR 401 errors:** Check that the IAM user/role has `ecr:GetAuthorizationToken` and `ecr:BatchGetImage` permissions.

**Rate limits (Docker Hub):** Authenticate with a Docker Hub account to increase pull rate limits.

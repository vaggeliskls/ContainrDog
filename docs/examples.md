# Examples

## Docker

### 1. Monitor all public containers

Watch every running container for updates, log-only (no auto-update).

```yaml
# docker-compose.yml
services:
  containrdog:
    image: ghcr.io/vaggeliskls/containrdog:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      - INTERVAL=10m
      - LABELED=false
      - AUTO_UPDATE=false
    restart: unless-stopped
```

---

### 2. Auto-update labeled containers

Only update containers that have opted in via label.

```yaml
services:
  containrdog:
    image: ghcr.io/vaggeliskls/containrdog:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      - INTERVAL=5m
      - LABELED=true
      - POLICY=minor
      - AUTO_UPDATE=true
    restart: unless-stopped

  nginx:
    image: nginx:1.25
    labels:
      - containrdog-enabled=true
      - containrdog.policy=patch   # only patch updates for nginx

  myapp:
    image: ghcr.io/myorg/myapp:1.0.0
    labels:
      - containrdog-enabled=true   # uses global policy (minor)
```

---

### 3. Private registry (GHCR)

```yaml
services:
  containrdog:
    image: ghcr.io/vaggeliskls/containrdog:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ~/.docker/config.json:/config.json:ro   # registry credentials
    environment:
      - INTERVAL=5m
      - LABELED=true
    restart: unless-stopped

  myapp:
    image: ghcr.io/myorg/myapp:1.0.0
    labels:
      - containrdog-enabled=true
```

```bash
# Login once before starting
echo $GITHUB_TOKEN | docker login ghcr.io -u $GITHUB_USERNAME --password-stdin
docker-compose up -d
```

---

### 4. Pre/post update hooks with Slack notification

```yaml
services:
  containrdog:
    image: ghcr.io/vaggeliskls/containrdog:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      - INTERVAL=5m
      - LABELED=true
      - PRE_UPDATE_COMMANDS=["echo 'Updating $CONTAINER_NAME from $CURRENT_TAG to $AVAILABLE_TAG'"]
      - POST_UPDATE_COMMANDS=["curl -s -X POST $SLACK_WEBHOOK -d '{\"text\":\"Updated $CONTAINER_NAME to $AVAILABLE_TAG\"}'"]
      - SLACK_WEBHOOK=https://hooks.slack.com/services/...
    restart: unless-stopped
```

Or using the built-in webhook support:

```yaml
    environment:
      - WEBHOOK_ENABLED=true
      - WEBHOOK_URL=https://hooks.slack.com/services/...
      - WEBHOOK_PROVIDER=slack
```

---

### 5. Track `latest` tag (digest-based)

```yaml
  myapp:
    image: myapp:latest
    labels:
      - containrdog-enabled=true
      - containrdog.policy=force
      - containrdog.match-tag=true   # only check 'latest', not all tags
```

---

### 6. GitOps — auto-deploy on docker-compose.yml changes

```yaml
services:
  containrdog:
    image: ghcr.io/vaggeliskls/containrdog:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock   # needs write access for docker-compose commands
    environment:
      - INTERVAL=5m
      - GITOPS_ENABLED=true
      - GITOPS_REPO_URL=https://github.com/myorg/infra.git
      - GITOPS_BRANCH=main
      - GITOPS_AUTH_TYPE=token
      - GITOPS_TOKEN=ghp_xxxxx
      - GITOPS_WATCH_PATHS=["docker-compose.yml"]
      - GITOPS_COMMANDS=["docker-compose -f /path/to/docker-compose.yml pull", "docker-compose -f /path/to/docker-compose.yml up -d --remove-orphans"]
    restart: unless-stopped
```

---

### 7. AWS ECR

```yaml
services:
  containrdog:
    image: ghcr.io/vaggeliskls/containrdog:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      - INTERVAL=5m
      - LABELED=true
      - ECR_ENABLED=true
      - ECR_REGION=us-east-1
      - ECR_ACCOUNT_ID=123456789012
      - AWS_ACCESS_KEY_ID=AKIA...
      - AWS_SECRET_ACCESS_KEY=...
    restart: unless-stopped

  myapp:
    image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/myapp:1.0.0
    labels:
      - containrdog-enabled=true
```

---

---

## Kubernetes

### 1. Monitor public images in default namespace

```yaml
# helm values
config:
  interval: "10m"
  policy: "minor"
  labeled: true

kubernetes:
  namespaces:
    - default
```

```bash
helm install containrdog oci://ghcr.io/vaggeliskls/charts/containrdog -f values.yaml -n containrdog --create-namespace
```

Annotate workloads to opt in:
```bash
kubectl annotate deployment myapp containrdog-enabled=true
```

---

### 2. Auto-update across multiple namespaces

```yaml
config:
  interval: "5m"
  policy: "minor"
  autoUpdate: true

kubernetes:
  namespaces:
    - default
    - staging
    - production
```

Per-workload policy override via annotation:
```yaml
spec:
  template:
    metadata:
      annotations:
        containrdog-enabled: "true"
        containrdog.policy: "patch"   # stricter for production
```

---

### 3. Private registry (GHCR)

```bash
# Create the pull secret
kubectl create secret docker-registry ghcr-pull-secret \
  --docker-server=ghcr.io \
  --docker-username=myuser \
  --docker-password=ghp_token \
  -n containrdog
```

```yaml
# helm values
registry:
  existingPullSecret: ghcr-pull-secret
```

Reference the same secret in your workloads:
```yaml
spec:
  template:
    metadata:
      annotations:
        containrdog-enabled: "true"
    spec:
      imagePullSecrets:
        - name: ghcr-pull-secret
```

---

### 4. Slack notifications on update

```bash
kubectl create secret generic containrdog-secrets \
  --from-literal=WEBHOOK_URL='https://hooks.slack.com/services/...' \
  -n containrdog
```

```yaml
existingSecret: containrdog-secrets

webhook:
  enabled: true
  provider: slack
  notifyOnSuccess: true
  notifyOnFailure: true
```

---

### 5. Post-update hook — wait for rollout

```yaml
hooks:
  postUpdateCommands:
    - "kubectl rollout status deployment/$CONTAINER_NAME --timeout=120s"
```

---

### 6. AWS ECR with IAM role (no explicit credentials)

Attach an IAM role to the ContainrDog pod (via IRSA or node instance profile) with `ecr:GetAuthorizationToken` and `ecr:DescribeImages` permissions.

```yaml
ecr:
  enabled: true
  region: us-east-1
  accountId: "123456789012"   # no accessKeyId/secretAccessKey needed
```

---

### 7. GitOps — apply manifests on repo change

```bash
kubectl create secret generic containrdog-secrets \
  --from-literal=GITOPS_TOKEN='ghp_xxxxx' \
  -n containrdog
```

```yaml
existingSecret: containrdog-secrets

gitops:
  enabled: true
  repoUrl: "https://github.com/myorg/k8s-manifests.git"
  branch: main
  authType: token
  watchPaths:
    - "manifests/**"
  commands:
    - "kubectl apply -f $GITOPS_CLONE_PATH/manifests/"
```

---

### 8. Monitor all namespaces (cluster-wide)

```yaml
kubernetes:
  allNamespaces: true

config:
  labeled: true   # still requires annotation on each workload
```

The ServiceAccount will need cluster-wide read access — the chart's default ClusterRole already covers this.

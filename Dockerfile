# --- Base stage: common setup ---
FROM node:24-alpine AS base
# Install system dependencies, Docker CLI, Podman, and AWS CLI
RUN apk add --no-cache \
    dumb-init \
    curl \
    docker-cli \
    docker-compose \
    podman \
    podman-compose \
    helm \
    kubectl \
    git \
    openssh-client \
    make \
    jq \
    shadow \
    && rm -rf /var/cache/apk/* \
    && ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') \
    && curl -fsSL "https://github.com/vaggeliskls/kubed/releases/download/1.0.0/kubed-1.0.0-linux-${ARCH}" -o /usr/local/bin/kubed \
    && chmod +x /usr/local/bin/kubed

# Use existing node user (UID:GID 1000:1000) and set permissions
RUN mkdir -p /app \
    && chown -R node:node /app

WORKDIR /app
USER node

# --- Dev stage ---
FROM base AS dev
COPY --chown=node:node . .
RUN npm install
CMD ["npm", "run", "dev"]

# --- Build stage ---
FROM base AS builder
COPY --chown=node:node package*.json tsconfig.json ./
RUN npm ci
# Copy source code
COPY --chown=node:node src ./src
RUN npm run build


# --- Production stage ---
FROM base AS prod

# Copy package files and install production dependencies
COPY --from=builder /app/node_modules ./node_modules
# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "dist/index.js"]

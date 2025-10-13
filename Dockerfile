# --- Base stage: common setup ---
FROM node:22-alpine AS base
WORKDIR /app

# --- Dev stage ---
FROM base AS dev
COPY . .
RUN npm install
CMD ["npm", "run", "dev"]

# --- Build stage ---
FROM base AS builder
COPY package*.json tsconfig.json ./
RUN npm ci
# Copy source code
COPY src ./src
RUN npm run build


# Production stage with development tools
FROM base

WORKDIR /app

# Install system dependencies, Docker CLI, Podman, and AWS CLI
RUN apk add --no-cache \
    dumb-init \
    curl \
    docker-cli \
    podman \
    aws-cli \
    git \
    make \
    && rm -rf /var/cache/apk/*

# Copy package files and install production dependencies
COPY --from=builder /app/node_modules ./node_modules
# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "dist/index.js"]

# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage with development tools
FROM node:22-alpine

WORKDIR /app

# Install system dependencies, Docker CLI, Podman, and AWS CLI
RUN apk add --no-cache \
    dumb-init \
    bash \
    curl \
    docker-cli \
    podman \
    python3 \
    py3-pip \
    aws-cli \
    git \
    make \
    && rm -rf /var/cache/apk/*

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && \
    npm cache clean --force

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Copy source code for development
COPY src ./src
COPY tsconfig.json ./

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "dist/index.js"]

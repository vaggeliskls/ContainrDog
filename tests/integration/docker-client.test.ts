/**
 * Integration tests for DockerClient.
 *
 * Prerequisites: Docker daemon running.
 * Enable with: INTEGRATION_TESTS=true npx vitest run tests/integration/docker-client.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Docker from 'dockerode';
import { DockerClient } from '../../src/services/docker-client';

const RUN = process.env.INTEGRATION_TESTS === 'true';

const TEST_IMAGE = 'nginx:alpine';
const CONTAINER_NAME = 'containrdog-integration-test';

let docker: Docker;
let containerId: string;

describe.runIf(RUN)('DockerClient integration', () => {
  beforeAll(async () => {
    docker = new Docker();

    // Pull test image
    await new Promise<void>((resolve, reject) => {
      docker.pull(TEST_IMAGE, {}, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream!, (err) => (err ? reject(err) : resolve()));
      });
    });

    // Remove any leftover container from a previous run
    try {
      const existing = docker.getContainer(CONTAINER_NAME);
      await existing.stop().catch(() => {});
      await existing.remove().catch(() => {});
    } catch {}

    // Start a test container with a containrdog-enabled label
    const container = await docker.createContainer({
      name: CONTAINER_NAME,
      Image: TEST_IMAGE,
      Labels: {
        'containrdog-enabled': 'true',
        'containrdog.policy': 'patch',
        'containrdog.auto-update': 'false',
      },
    });
    await container.start();
    containerId = container.id;
  });

  afterAll(async () => {
    if (containerId) {
      const container = docker.getContainer(containerId);
      await container.stop().catch(() => {});
      await container.remove().catch(() => {});
    }
  });

  it('ping() returns true when Docker is reachable', async () => {
    const client = new DockerClient();
    expect(await client.ping()).toBe(true);
  });

  it('getRunningContainers() includes the test container', async () => {
    process.env.LABELED_ONLY = 'false';
    const client = new DockerClient();
    const containers = await client.getRunningContainers();

    const found = containers.find((c) => c.name === CONTAINER_NAME);
    expect(found).toBeDefined();
    expect(found!.image).toBe(TEST_IMAGE);
  });

  it('getRunningContainers() reads labels correctly', async () => {
    const client = new DockerClient();
    const containers = await client.getRunningContainers();
    const found = containers.find((c) => c.name === CONTAINER_NAME);

    expect(found).toBeDefined();
    expect(found!.autoUpdate).toBe(false);
  });

  it('getImageDigest() returns a non-empty string for a pulled image', async () => {
    const client = new DockerClient();
    const digest = await client.getImageDigest(TEST_IMAGE);
    expect(digest).toBeDefined();
    expect(typeof digest).toBe('string');
    expect((digest as string).length).toBeGreaterThan(0);
  });
});

describe.skipIf(RUN)('DockerClient integration (skipped)', () => {
  it('set INTEGRATION_TESTS=true to run these tests', () => {
    expect(true).toBe(true);
  });
});

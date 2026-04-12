import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdateChecker } from '../../../src/services/update-checker';
import { UpdatePolicy, UpdateType, ContainerInfo } from '../../../src/types';

// Mock the config module
vi.mock('../../../src/utils/config', () => ({
  getConfig: vi.fn(() => ({
    policy: UpdatePolicy.ALL,
    globPattern: undefined,
  })),
}));

// Mock the logger to suppress output during tests
vi.mock('../../../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeContainer(image: string, overrides: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: 'container-id',
    name: 'test-container',
    image,
    autoUpdate: true,
    policy: UpdatePolicy.ALL,
    ...overrides,
  } as ContainerInfo;
}

function makeRegistryService(tags: string[], digest?: string) {
  return {
    listTags: vi.fn().mockResolvedValue(tags),
    getImageManifest: vi.fn().mockResolvedValue(digest ? { digest } : null),
  };
}

function makeRuntimeClient(localDigest?: string) {
  return {
    ping: vi.fn(),
    getRunningContainers: vi.fn(),
    getImageDigest: vi.fn().mockResolvedValue(localDigest),
    updateContainerImage: vi.fn(),
  };
}

describe('UpdateChecker — semantic version policy', () => {
  let checker: UpdateChecker;
  const registryService = makeRegistryService(['1.0.0', '1.1.0', '1.2.0', '2.0.0', '2.1.0']);
  const runtimeClient = makeRuntimeClient();

  beforeEach(() => {
    checker = new UpdateChecker(registryService as any, runtimeClient as any);
  });

  it('ALL policy: picks the highest available version', async () => {
    const container = makeContainer('nginx:1.0.0', { policy: UpdatePolicy.ALL });
    const updates = await checker.checkForUpdates([container]);
    expect(updates).toHaveLength(1);
    expect(updates[0].availableImage.tag).toBe('2.1.0');
    expect(updates[0].updateType).toBe(UpdateType.SEMANTIC_VERSION);
  });

  it('MAJOR policy: picks the highest available version (same as ALL)', async () => {
    const container = makeContainer('nginx:1.0.0', { policy: UpdatePolicy.MAJOR });
    const updates = await checker.checkForUpdates([container]);
    expect(updates[0].availableImage.tag).toBe('2.1.0');
  });

  it('MINOR policy: skips major bumps, picks highest within same major', async () => {
    const container = makeContainer('nginx:1.0.0', { policy: UpdatePolicy.MINOR });
    const updates = await checker.checkForUpdates([container]);
    expect(updates).toHaveLength(1);
    expect(updates[0].availableImage.tag).toBe('1.2.0');
  });

  it('PATCH policy: skips major and minor bumps, picks highest patch', async () => {
    const registryWithPatches = makeRegistryService(['1.0.0', '1.0.1', '1.0.2', '1.1.0', '2.0.0']);
    checker = new UpdateChecker(registryWithPatches as any, runtimeClient as any);
    const container = makeContainer('nginx:1.0.0', { policy: UpdatePolicy.PATCH });
    const updates = await checker.checkForUpdates([container]);
    expect(updates).toHaveLength(1);
    expect(updates[0].availableImage.tag).toBe('1.0.2');
  });

  it('PATCH policy: returns nothing when already on latest patch', async () => {
    const registryWithPatches = makeRegistryService(['1.0.0', '1.0.1', '1.1.0']);
    checker = new UpdateChecker(registryWithPatches as any, runtimeClient as any);
    const container = makeContainer('nginx:1.0.1', { policy: UpdatePolicy.PATCH });
    const updates = await checker.checkForUpdates([container]);
    expect(updates).toHaveLength(0);
  });

  it('returns no update when already on latest', async () => {
    const container = makeContainer('nginx:2.1.0', { policy: UpdatePolicy.ALL });
    const updates = await checker.checkForUpdates([container]);
    expect(updates).toHaveLength(0);
  });

  it('handles v-prefixed tags', async () => {
    const registryWithV = makeRegistryService(['v1.0.0', 'v1.1.0', 'v2.0.0']);
    checker = new UpdateChecker(registryWithV as any, runtimeClient as any);
    const container = makeContainer('nginx:v1.0.0', { policy: UpdatePolicy.ALL });
    const updates = await checker.checkForUpdates([container]);
    expect(updates).toHaveLength(1);
    expect(updates[0].availableImage.tag).toBe('v2.0.0');
  });

  it('returns nothing when registry has no semver tags', async () => {
    const registryNoSemver = makeRegistryService(['latest', 'stable', 'main']);
    checker = new UpdateChecker(registryNoSemver as any, runtimeClient as any);
    const container = makeContainer('nginx:1.0.0', { policy: UpdatePolicy.ALL });
    const updates = await checker.checkForUpdates([container]);
    expect(updates).toHaveLength(0);
  });

  it('handles errors per-container without aborting remaining checks', async () => {
    const throwingRegistry = {
      listTags: vi.fn().mockRejectedValue(new Error('registry unreachable')),
      getImageManifest: vi.fn(),
    };
    checker = new UpdateChecker(throwingRegistry as any, runtimeClient as any);
    const containers = [
      makeContainer('nginx:1.0.0', { policy: UpdatePolicy.ALL }),
      makeContainer('redis:1.0.0', { policy: UpdatePolicy.ALL }),
    ];
    const updates = await checker.checkForUpdates(containers);
    expect(updates).toHaveLength(0); // both fail but no throw
  });
});

describe('UpdateChecker — GLOB policy', () => {
  const runtimeClient = makeRuntimeClient();

  it('matches tags against a glob pattern', async () => {
    const registry = makeRegistryService(['1.0.0', '1.0.0-alpine', '2.0.0', '2.0.0-alpine']);
    const checker = new UpdateChecker(registry as any, runtimeClient as any);
    const container = makeContainer('nginx:1.0.0-alpine', {
      policy: UpdatePolicy.GLOB,
      globPattern: '*-alpine',
    });
    const updates = await checker.checkForUpdates([container]);
    expect(updates).toHaveLength(1);
    expect(updates[0].availableImage.tag).toBe('2.0.0-alpine');
  });
});

describe('UpdateChecker — digest update (non-semver / FORCE)', () => {
  it('returns update when remote digest differs from local', async () => {
    const registry = makeRegistryService([], 'sha256:newdigest');
    const runtimeClient = makeRuntimeClient('sha256:olddigest');
    const checker = new UpdateChecker(registry as any, runtimeClient as any);
    const container = makeContainer('nginx:latest', { policy: UpdatePolicy.ALL });

    const updates = await checker.checkForUpdates([container]);
    expect(updates).toHaveLength(1);
    expect(updates[0].updateType).toBe(UpdateType.DIGEST_CHANGE);
    expect(updates[0].availableImage.digest).toBe('sha256:newdigest');
  });

  it('returns no update when digests match', async () => {
    const digest = 'sha256:abc123';
    const registry = makeRegistryService([], digest);
    const runtimeClient = makeRuntimeClient(digest);
    const checker = new UpdateChecker(registry as any, runtimeClient as any);
    const container = makeContainer('nginx:latest');

    const updates = await checker.checkForUpdates([container]);
    expect(updates).toHaveLength(0);
  });

  it('FORCE policy checks digest even for semver tags', async () => {
    const registry = makeRegistryService([], 'sha256:newdigest');
    const runtimeClient = makeRuntimeClient('sha256:olddigest');
    const checker = new UpdateChecker(registry as any, runtimeClient as any);
    const container = makeContainer('nginx:1.2.3', { policy: UpdatePolicy.FORCE });

    const updates = await checker.checkForUpdates([container]);
    expect(updates).toHaveLength(1);
    expect(updates[0].updateType).toBe(UpdateType.DIGEST_CHANGE);
  });

  it('returns no update when either digest is unavailable', async () => {
    const registry = makeRegistryService([], undefined);
    const runtimeClient = makeRuntimeClient(undefined);
    const checker = new UpdateChecker(registry as any, runtimeClient as any);
    const container = makeContainer('nginx:latest');

    const updates = await checker.checkForUpdates([container]);
    expect(updates).toHaveLength(0);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MonitorService } from '../../../src/services/monitor-service';
import { IRuntimeClient } from '../../../src/services/runtime-client';
import { ContainerInfo, ImageInfo, ImageUpdateInfo, UpdateType } from '../../../src/types';
import { ImageParser } from '../../../src/utils/image-parser';

// Config with auto-update on, no webhook/gitops, and a long failure cooldown.
const baseConfig = {
  autoUpdate: true,
  webhook: undefined,
  gitops: undefined,
  preUpdateCommands: undefined,
  postUpdateCommands: undefined,
  updateCommands: undefined,
  update: {
    healthCheckEnabled: true,
    healthCheckTimeout: 30_000,
    healthCheckInterval: 3_000,
    rollbackOnFailure: true,
    failureCooldown: 3_600_000,
  },
};

vi.mock('../../../src/utils/config', () => ({
  getConfig: vi.fn(() => baseConfig),
}));

vi.mock('../../../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeRuntimeClient(
  updateImpl: (id: string, image: string) => Promise<void>
): IRuntimeClient {
  return {
    ping: vi.fn().mockResolvedValue(true),
    getRunningContainers: vi.fn().mockResolvedValue([]),
    getImageDigest: vi.fn().mockResolvedValue(undefined),
    updateContainerImage: vi.fn(updateImpl),
  };
}

function makeUpdate(currentTag: string, newTag: string): ImageUpdateInfo {
  const container: ContainerInfo = {
    id: 'cid-1',
    name: 'web',
    image: `nginx:${currentTag}`,
    imageId: 'sha256:old',
    labels: {},
    created: 0,
    autoUpdate: true,
  };
  const currentImage: ImageInfo = ImageParser.parse(`nginx:${currentTag}`);
  const availableImage: ImageInfo = { ...currentImage, tag: newTag };
  return {
    container,
    currentImage,
    availableImage,
    updateType: UpdateType.SEMANTIC_VERSION,
  };
}

describe('MonitorService failure cooldown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not re-attempt the same target image while cooling down', async () => {
    const client = makeRuntimeClient(() => Promise.reject(new Error('boom')));
    const monitor = new MonitorService(client) as any;

    const update = makeUpdate('1.0.0', '2.0.0');

    await monitor.handleUpdate(update); // first attempt fails -> sets cooldown
    await monitor.handleUpdate(update); // should be suppressed by cooldown
    await monitor.handleUpdate(update); // still suppressed

    expect(client.updateContainerImage).toHaveBeenCalledTimes(1);
  });

  it('still attempts a different (newer) target despite an active cooldown', async () => {
    const client = makeRuntimeClient(() => Promise.reject(new Error('boom')));
    const monitor = new MonitorService(client) as any;

    await monitor.handleUpdate(makeUpdate('1.0.0', '2.0.0')); // fails -> cooldown for 2.0.0
    await monitor.handleUpdate(makeUpdate('1.0.0', '2.1.0')); // different target -> attempted

    expect(client.updateContainerImage).toHaveBeenCalledTimes(2);
  });

  it('clears the cooldown after a successful update', async () => {
    // Fail only for 2.0.0; succeed otherwise.
    const client = makeRuntimeClient((_id, image) =>
      image.endsWith(':2.0.0') ? Promise.reject(new Error('boom')) : Promise.resolve()
    );
    const monitor = new MonitorService(client) as any;

    await monitor.handleUpdate(makeUpdate('1.0.0', '2.0.0')); // fails -> cooldown
    await monitor.handleUpdate(makeUpdate('1.0.0', '2.1.0')); // succeeds -> clears cooldown
    await monitor.handleUpdate(makeUpdate('1.0.0', '2.0.0')); // cooldown cleared -> attempted again

    // 2.0.0 (fail) + 2.1.0 (ok) + 2.0.0 (retry) = 3 calls
    expect(client.updateContainerImage).toHaveBeenCalledTimes(3);
  });

  it('does not register a cooldown when failureCooldown is 0', async () => {
    baseConfig.update.failureCooldown = 0;
    const client = makeRuntimeClient(() => Promise.reject(new Error('boom')));
    const monitor = new MonitorService(client) as any;

    const update = makeUpdate('1.0.0', '2.0.0');
    await monitor.handleUpdate(update);
    await monitor.handleUpdate(update);

    expect(client.updateContainerImage).toHaveBeenCalledTimes(2);
    baseConfig.update.failureCooldown = 3_600_000; // restore for other tests
  });
});

function clientWithContainers(containers: ContainerInfo[]): IRuntimeClient {
  return {
    ping: vi.fn().mockResolvedValue(true),
    getRunningContainers: vi.fn().mockResolvedValue(containers),
    getImageDigest: vi.fn().mockResolvedValue(undefined),
    updateContainerImage: vi.fn().mockResolvedValue(undefined),
  };
}

function gitopsContainer(overrides: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: 'cid-1',
    name: 'web',
    image: 'nginx:1.0.0',
    imageId: 'sha256:x',
    labels: {},
    created: 0,
    gitopsEnabled: true,
    ...overrides,
  };
}

describe('MonitorService GitOps triggers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_found for an unknown container', async () => {
    const monitor = new MonitorService(clientWithContainers([])) as any;
    const res = await monitor.triggerContainerGitOps('does-not-exist', 'run', false);
    expect(res.code).toBe('not_found');
    expect(res.triggered).toBe(false);
  });

  it('returns disabled when GitOps is off for the container', async () => {
    const monitor = new MonitorService(clientWithContainers([gitopsContainer({ gitopsEnabled: false })])) as any;
    const res = await monitor.triggerContainerGitOps('web', 'run', false);
    expect(res.code).toBe('disabled');
  });

  it('runs container commands and reports the container as affected (run mode)', async () => {
    const monitor = new MonitorService(clientWithContainers([gitopsContainer()])) as any;
    monitor.executeGitOpsCommands = vi.fn().mockResolvedValue(undefined);

    const res = await monitor.triggerContainerGitOps('web', 'run', false);

    expect(monitor.executeGitOpsCommands).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ code: 'ok', triggered: true, affected: ['web'], scope: 'container' });
  });

  it('returns busy when the container is already executing GitOps', async () => {
    const monitor = new MonitorService(clientWithContainers([gitopsContainer()])) as any;
    monitor.executeGitOpsCommands = vi.fn().mockResolvedValue(undefined);
    monitor.gitopsExecuting.add('cid-1'); // simulate in-flight execution

    const res = await monitor.triggerContainerGitOps('web', 'run', false);

    expect(res.code).toBe('busy');
    expect(monitor.executeGitOpsCommands).not.toHaveBeenCalled();
  });

  it('returns disabled for a global trigger when global GitOps is off', async () => {
    const monitor = new MonitorService(clientWithContainers([gitopsContainer()])) as any;
    // gitService is undefined because baseConfig.gitops is undefined
    const res = await monitor.triggerGlobalGitOps('run', false);
    expect(res.code).toBe('disabled');
  });

  it('dispatches global commands to all consumers (run mode)', async () => {
    const monitor = new MonitorService(clientWithContainers([gitopsContainer()])) as any;
    monitor.gitService = {}; // pretend global GitOps is enabled
    monitor.dispatchGlobalGitOps = vi.fn().mockResolvedValue(undefined);

    const res = await monitor.triggerGlobalGitOps('run', false);

    expect(monitor.dispatchGlobalGitOps).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ code: 'ok', triggered: true, affected: ['web'], scope: 'global' });
  });

  it('reports noop for a global run with no consumers', async () => {
    const monitor = new MonitorService(clientWithContainers([])) as any;
    monitor.gitService = {};
    monitor.dispatchGlobalGitOps = vi.fn().mockResolvedValue(undefined);

    const res = await monitor.triggerGlobalGitOps('run', false);

    expect(res.code).toBe('noop');
    expect(res.triggered).toBe(false);
    expect(monitor.dispatchGlobalGitOps).not.toHaveBeenCalled();
  });
});

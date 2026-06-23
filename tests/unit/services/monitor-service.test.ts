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

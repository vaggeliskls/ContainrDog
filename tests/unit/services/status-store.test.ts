import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StatusStore } from '../../../src/services/status-store';
import { ComponentHealth, ContainerInfo, ImageUpdateInfo, SyncStatus, UpdateType } from '../../../src/types';
import { ImageParser } from '../../../src/utils/image-parser';

vi.mock('../../../src/utils/config', () => ({
  getConfig: vi.fn(() => ({ autoUpdate: true, policy: 'major', gitops: undefined })),
}));

function container(overrides: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: 'cid-1',
    name: 'web',
    image: 'nginx:1.0.0',
    imageId: 'sha256:x',
    labels: {},
    created: 0,
    ...overrides,
  };
}

function updateFor(c: ContainerInfo, newTag: string): ImageUpdateInfo {
  const currentImage = ImageParser.parse(c.image);
  return {
    container: c,
    currentImage,
    availableImage: { ...currentImage, tag: newTag },
    updateType: UpdateType.SEMANTIC_VERSION,
  };
}

describe('StatusStore component sync/health', () => {
  beforeEach(() => {
    // Reset the singleton's component list between tests.
    StatusStore.instance.setContainers([]);
  });

  it('marks a component synced and carries its health when no update is available', () => {
    StatusStore.instance.setContainers([container({ health: ComponentHealth.HEALTHY })]);
    const [c] = StatusStore.instance.getSnapshot().containers;
    expect(c.sync).toBe(SyncStatus.SYNCED);
    expect(c.health).toBe(ComponentHealth.HEALTHY);
    expect(c.currentTag).toBe('1.0.0');
    expect(c.availableTag).toBeUndefined();
  });

  it('defaults health to unknown when the runtime did not provide it', () => {
    StatusStore.instance.setContainers([container()]);
    expect(StatusStore.instance.getSnapshot().containers[0].health).toBe(ComponentHealth.UNKNOWN);
  });

  it('marks a component outdated with the available tag when an update exists', () => {
    const c = container({ health: ComponentHealth.HEALTHY });
    const updates = new Map([[c.id, updateFor(c, '2.0.0')]]);
    StatusStore.instance.setContainers([c], updates);

    const [snap] = StatusStore.instance.getSnapshot().containers;
    expect(snap.sync).toBe(SyncStatus.OUTDATED);
    expect(snap.availableTag).toBe('2.0.0');
    expect(snap.updateType).toBe(UpdateType.SEMANTIC_VERSION);
  });

  it('markComponentSync transitions to failed with an error message', () => {
    const c = container();
    StatusStore.instance.setContainers([c], new Map([[c.id, updateFor(c, '2.0.0')]]));
    StatusStore.instance.markComponentSync(c.id, SyncStatus.FAILED, { error: 'boom' });

    const [snap] = StatusStore.instance.getSnapshot().containers;
    expect(snap.sync).toBe(SyncStatus.FAILED);
    expect(snap.lastError).toBe('boom');
  });

  it('markComponentSync to synced clears the available tag and error', () => {
    const c = container();
    StatusStore.instance.setContainers([c], new Map([[c.id, updateFor(c, '2.0.0')]]));
    StatusStore.instance.markComponentSync(c.id, SyncStatus.FAILED, { error: 'boom' });
    StatusStore.instance.markComponentSync(c.id, SyncStatus.SYNCED);

    const [snap] = StatusStore.instance.getSnapshot().containers;
    expect(snap.sync).toBe(SyncStatus.SYNCED);
    expect(snap.availableTag).toBeUndefined();
    expect(snap.lastError).toBeUndefined();
  });

  it('markComponentSync is a no-op for an unknown container id', () => {
    StatusStore.instance.setContainers([container()]);
    expect(() => StatusStore.instance.markComponentSync('nope', SyncStatus.FAILED)).not.toThrow();
  });
});

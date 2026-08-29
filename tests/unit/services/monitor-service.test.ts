import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MonitorService } from '../../../src/services/monitor-service';
import { IRuntimeClient } from '../../../src/services/runtime-client';
import { ContainerInfo, ImageInfo, ImageUpdateInfo, UpdateType } from '../../../src/types';
import { ImageParser } from '../../../src/utils/image-parser';
import { logger } from '../../../src/utils/logger';

// Config with auto-update on, no webhook/gitops, and a long failure cooldown.
const baseConfig = {
  interval: 60_000,
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

  it('passes the detection-time image as the rollback target', async () => {
    // Pre-update commands can deploy the new image before the runtime client
    // runs, so the rollback target must come from detection time, not the
    // live spec.
    const client = makeRuntimeClient(() => Promise.resolve());
    const monitor = new MonitorService(client) as any;

    await monitor.handleUpdate(makeUpdate('1.0.0', '2.0.0'));

    expect(client.updateContainerImage).toHaveBeenCalledWith(
      'cid-1',
      expect.stringContaining(':2.0.0'),
      'library/nginx:1.0.0'
    );
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

describe('MonitorService cycle budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Wire a monitor whose detection immediately reports the given updates and
  // whose runtime update behavior is controlled by updateImpl.
  function makeMonitor(
    updates: ImageUpdateInfo[],
    updateImpl: (id: string, image: string) => Promise<void>
  ) {
    const client = makeRuntimeClient(updateImpl);
    (client.getRunningContainers as ReturnType<typeof vi.fn>).mockResolvedValue(
      updates.map((u) => u.container)
    );
    const monitor = new MonitorService(client) as any;
    monitor.updateChecker = { checkForUpdates: vi.fn().mockResolvedValue(updates) };
    return { monitor, client };
  }

  function loggedErrors(): string {
    return vi
      .mocked(logger.error)
      .mock.calls.flat()
      .map((a) => String(a))
      .join(' ');
  }

  it('a rollout wait longer than the detection budget is NOT killed', async () => {
    // interval 60s -> detection budget 120s; the update takes 200s.
    const { monitor, client } = makeMonitor(
      [makeUpdate('1.0.0', '2.0.0')],
      () => new Promise((resolve) => setTimeout(resolve, 200_000))
    );

    const run = monitor.runCheck();
    await vi.advanceTimersByTimeAsync(250_000);
    await run;

    expect(client.updateContainerImage).toHaveBeenCalledTimes(1);
    expect(loggedErrors()).not.toContain('budget');
    expect(monitor.updateCheckExecuting).toBe(false);
  });

  it('a hung detection is still killed by the budget and releases the flag', async () => {
    const { monitor } = makeMonitor([makeUpdate('1.0.0', '2.0.0')], () => Promise.resolve());
    monitor.updateChecker = { checkForUpdates: vi.fn(() => new Promise(() => {})) }; // hangs

    const run = monitor.runCheck();
    await vi.advanceTimersByTimeAsync(120_000); // budget = 2 * 60s interval
    await run;

    expect(loggedErrors()).toContain('detection exceeded');
    expect(monitor.updateCheckExecuting).toBe(false);
  });

  it('a hung update is abandoned by its own watchdog and the next update still runs', async () => {
    const first = makeUpdate('1.0.0', '2.0.0');
    const second = makeUpdate('1.0.0', '2.0.0');
    second.container = { ...second.container, id: 'cid-2', name: 'web2' };

    const attempted: string[] = [];
    const { monitor } = makeMonitor([first, second], (id) => {
      attempted.push(id);
      return id === 'cid-1' ? new Promise(() => {}) : Promise.resolve(); // first hangs forever
    });

    const run = monitor.runCheck();
    // per-update budget = healthCheckTimeout (30s) + 300s margin = 330s
    await vi.advanceTimersByTimeAsync(340_000);
    await run;

    expect(attempted).toEqual(['cid-1', 'cid-2']);
    expect(loggedErrors()).toContain('exceeded');
    expect(monitor.updateCheckExecuting).toBe(false);
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

describe('MonitorService GitOps-only mode (global commands, no monitored containers)', () => {
  const gitopsConfig = {
    enabled: true,
    repoUrl: 'git@github.com:acme/deploy.git',
    branch: 'main',
    pollInterval: 60_000,
    watchPaths: ['k8s/**'],
    commands: ['echo deploy'],
    clonePath: '',
    quietMode: false,
  };
  const change = {
    changedFiles: ['k8s/env.json'],
    previousCommit: 'a',
    currentCommit: 'b',
    commitMessage: 'promote',
    timestamp: new Date(0),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (baseConfig as any).gitops = gitopsConfig;
  });

  afterEach(() => {
    (baseConfig as any).gitops = undefined;
  });

  it('runs global commands on a watched change even when no containers are monitored', async () => {
    const monitor = new MonitorService(clientWithContainers([])) as any;
    monitor.gitService = {
      shouldRunOnInterval: () => false,
      checkForChanges: vi.fn().mockResolvedValue(change),
    };
    monitor.lastGitopsCheck = 0;
    monitor.executeGlobalGitOpsCommands = vi.fn().mockResolvedValue(undefined);

    await monitor.checkGitOpsChanges();

    expect(monitor.executeGlobalGitOpsCommands).toHaveBeenCalledTimes(1);
    expect(monitor.executeGlobalGitOpsCommands).toHaveBeenCalledWith([], change);
  });

  it('stays quiet when global consumers exist but none is affected by the change', async () => {
    // A consumer with narrower per-container watch paths that this change misses.
    const consumer = gitopsContainer({ gitopsWatchPaths: ['other/**'] });
    const monitor = new MonitorService(clientWithContainers([consumer])) as any;
    monitor.gitService = {
      shouldRunOnInterval: () => false,
      checkForChanges: vi.fn().mockResolvedValue(change),
    };
    monitor.lastGitopsCheck = 0;
    monitor.executeGlobalGitOpsCommands = vi.fn().mockResolvedValue(undefined);

    await monitor.checkGitOpsChanges();

    expect(monitor.executeGlobalGitOpsCommands).not.toHaveBeenCalled();
  });

  it('manual check runs global commands in GitOps-only mode and stays quiet with unaffected consumers', async () => {
    const gitService = {
      shouldRunOnInterval: () => false,
      checkForChanges: vi.fn().mockResolvedValue(change),
      pull: vi.fn().mockResolvedValue(undefined),
    };

    const only = new MonitorService(clientWithContainers([])) as any;
    only.gitService = gitService;
    only.executeGlobalGitOpsCommands = vi.fn().mockResolvedValue(undefined);
    const onlyRes = await only.triggerGlobalGitOps('check', false);
    expect(only.executeGlobalGitOpsCommands).toHaveBeenCalledTimes(1);
    expect(onlyRes).toMatchObject({ code: 'ok', triggered: true, changed: true, affected: [] });

    const consumer = gitopsContainer({ gitopsWatchPaths: ['other/**'] });
    const mixed = new MonitorService(clientWithContainers([consumer])) as any;
    mixed.gitService = gitService;
    mixed.executeGlobalGitOpsCommands = vi.fn().mockResolvedValue(undefined);
    const mixedRes = await mixed.triggerGlobalGitOps('check', false);
    expect(mixed.executeGlobalGitOpsCommands).not.toHaveBeenCalled();
    expect(mixedRes).toMatchObject({ code: 'noop', triggered: false, changed: true });
  });

  it('does not run global commands when every affected container has its own commands', async () => {
    const monitor = new MonitorService(clientWithContainers([])) as any;
    monitor.executeGitOpsCommands = vi.fn().mockResolvedValue(undefined);
    monitor.executeGlobalGitOpsCommands = vi.fn().mockResolvedValue(undefined);

    await monitor.dispatchGlobalGitOps([gitopsContainer({ gitopsCommands: ['echo own'] })], change);

    expect(monitor.executeGitOpsCommands).toHaveBeenCalledTimes(1);
    expect(monitor.executeGlobalGitOpsCommands).not.toHaveBeenCalled();
  });

  it('manual global run executes global commands with no consumers', async () => {
    const monitor = new MonitorService(clientWithContainers([])) as any;
    monitor.gitService = {};
    monitor.executeGlobalGitOpsCommands = vi.fn().mockResolvedValue(undefined);

    const res = await monitor.triggerGlobalGitOps('run', false);

    expect(monitor.executeGlobalGitOpsCommands).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ code: 'ok', triggered: true, affected: [] });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    monitor.gitService = { isInitialized: () => true }; // pretend global GitOps is enabled
    monitor.dispatchGlobalGitOps = vi.fn().mockResolvedValue(undefined);

    const res = await monitor.triggerGlobalGitOps('run', false);

    expect(monitor.dispatchGlobalGitOps).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ code: 'ok', triggered: true, affected: ['web'], scope: 'global' });
  });

  it('reports noop for a global run with no consumers', async () => {
    const monitor = new MonitorService(clientWithContainers([])) as any;
    monitor.gitService = { isInitialized: () => true };
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
      isInitialized: () => true,
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
      isInitialized: () => true,
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
      isInitialized: () => true,
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
    monitor.gitService = { isInitialized: () => true };
    monitor.executeGlobalGitOpsCommands = vi.fn().mockResolvedValue(undefined);

    const res = await monitor.triggerGlobalGitOps('run', false);

    expect(monitor.executeGlobalGitOpsCommands).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ code: 'ok', triggered: true, affected: [] });
  });
});
describe('MonitorService global GitOps repository init retry', () => {
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

  // A GitService stub whose initialize() fails `failures` times before it
  // succeeds, mirroring a clone that cannot resolve the git host at startup.
  function flakyGitService(failures: number) {
    let initialized = false;
    let attempts = 0;
    return {
      attempts: () => attempts,
      isInitialized: () => initialized,
      getLastInitError: () => (initialized ? null : 'ssh: Could not resolve hostname github.com'),
      initialize: vi.fn(async () => {
        attempts++;
        initialized = attempts > failures;
        return initialized;
      }),
      shouldRunOnInterval: () => false,
      checkForChanges: vi.fn().mockResolvedValue(change),
      pull: vi.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    (baseConfig as any).gitops = gitopsConfig;
  });

  afterEach(() => {
    (baseConfig as any).gitops = undefined;
  });

  it('keeps the global GitService when the initial clone fails', async () => {
    const monitor = new MonitorService(clientWithContainers([])) as any;
    const gitService = flakyGitService(1);
    monitor.gitService = gitService;

    const ok = await monitor.initialize();

    expect(ok).toBe(true); // the monitor itself still starts
    expect(monitor.gitService).toBe(gitService); // ...and GitOps is NOT dropped
    expect(gitService.initialize).toHaveBeenCalledTimes(1);
  });

  it('retries the clone on each poll and resumes change detection once it succeeds', async () => {
    const monitor = new MonitorService(clientWithContainers([])) as any;
    const gitService = flakyGitService(2);
    monitor.gitService = gitService;
    monitor.executeGlobalGitOpsCommands = vi.fn().mockResolvedValue(undefined);

    await monitor.initialize(); // attempt 1 fails

    monitor.lastGitopsCheck = 0;
    await monitor.checkGitOpsChanges(); // attempt 2 fails -> no change check
    expect(gitService.checkForChanges).not.toHaveBeenCalled();
    expect(monitor.executeGlobalGitOpsCommands).not.toHaveBeenCalled();

    monitor.lastGitopsCheck = 0;
    await monitor.checkGitOpsChanges(); // attempt 3 succeeds -> normal flow
    expect(gitService.initialize).toHaveBeenCalledTimes(3);
    expect(gitService.checkForChanges).toHaveBeenCalledTimes(1);
    expect(monitor.executeGlobalGitOpsCommands).toHaveBeenCalledWith([], change);

    monitor.lastGitopsCheck = 0;
    await monitor.checkGitOpsChanges(); // initialized: no further init attempts
    expect(gitService.initialize).toHaveBeenCalledTimes(3);
  });

  it('respects the poll interval while the repository is unavailable', async () => {
    const monitor = new MonitorService(clientWithContainers([])) as any;
    const gitService = flakyGitService(Number.MAX_SAFE_INTEGER);
    monitor.gitService = gitService;

    monitor.lastGitopsCheck = 0;
    await monitor.checkGitOpsChanges(); // retries (interval elapsed)
    await monitor.checkGitOpsChanges(); // interval not elapsed -> no retry

    expect(gitService.initialize).toHaveBeenCalledTimes(1);
  });

  it('notifies once on the first failure and once on recovery', async () => {
    const monitor = new MonitorService(clientWithContainers([])) as any;
    const gitService = flakyGitService(3);
    monitor.gitService = gitService;
    monitor.executeGlobalGitOpsCommands = vi.fn().mockResolvedValue(undefined);
    const sendGitOpsRepoNotification = vi.fn().mockResolvedValue(undefined);
    monitor.webhookService = { sendGitOpsRepoNotification };

    for (let i = 0; i < 5; i++) {
      monitor.lastGitopsCheck = 0;
      await monitor.checkGitOpsChanges();
    }

    expect(sendGitOpsRepoNotification).toHaveBeenCalledTimes(2);
    expect(sendGitOpsRepoNotification).toHaveBeenNthCalledWith(
      1,
      gitopsConfig.repoUrl,
      gitopsConfig.branch,
      false,
      'ssh: Could not resolve hostname github.com',
      1
    );
    expect(sendGitOpsRepoNotification).toHaveBeenNthCalledWith(
      2,
      gitopsConfig.repoUrl,
      gitopsConfig.branch,
      true,
      undefined,
      3
    );
  });

  it('reports an error for manual global triggers while the repository is unavailable', async () => {
    const monitor = new MonitorService(clientWithContainers([])) as any;
    const gitService = flakyGitService(1);
    monitor.gitService = gitService;
    monitor.executeGlobalGitOpsCommands = vi.fn().mockResolvedValue(undefined);

    const failed = await monitor.triggerGlobalGitOps('check', false);
    expect(failed.triggered).toBe(false);
    expect(failed.code).toBe('error');
    expect(failed.message).toContain('not initialized');
    expect(gitService.checkForChanges).not.toHaveBeenCalled();

    // The trigger itself is a retry: the next one finds the repo ready.
    const ok = await monitor.triggerGlobalGitOps('check', false);
    expect(ok.code).toBe('ok');
    expect(gitService.checkForChanges).toHaveBeenCalledTimes(1);
  });
});
describe('MonitorService monitored-set logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs the empty monitored set once, then only at debug level', async () => {
    const { logger } = await import('../../../src/utils/logger');
    const monitor = new MonitorService(clientWithContainers([])) as any;

    await monitor.executeUpdateCheck();
    await monitor.executeUpdateCheck();
    await monitor.executeUpdateCheck();

    const infoNoContainers = (logger.info as any).mock.calls.filter((c: any[]) =>
      String(c[0]).includes('No containers found to monitor')
    );
    const debugNoContainers = (logger.debug as any).mock.calls.filter((c: any[]) =>
      String(c[0]).includes('No containers found to monitor')
    );
    expect(infoNoContainers).toHaveLength(1);
    expect(debugNoContainers).toHaveLength(2);
  });

  it('reports again at info level when the set goes non-empty and back to empty', async () => {
    const { logger } = await import('../../../src/utils/logger');
    const client = clientWithContainers([]);
    const monitor = new MonitorService(client) as any;
    monitor.updateChecker = { checkForUpdates: vi.fn().mockResolvedValue([]) };

    await monitor.executeUpdateCheck(); // empty -> info
    (client.getRunningContainers as any).mockResolvedValueOnce([gitopsContainer()]);
    await monitor.executeUpdateCheck(); // one container -> "Monitoring 1 container(s)"
    await monitor.executeUpdateCheck(); // empty again -> info

    const infoNoContainers = (logger.info as any).mock.calls.filter((c: any[]) =>
      String(c[0]).includes('No containers found to monitor')
    );
    const monitoring = (logger.info as any).mock.calls.filter((c: any[]) =>
      String(c[0]).includes('Monitoring 1 container(s)')
    );
    expect(infoNoContainers).toHaveLength(2);
    expect(monitoring).toHaveLength(1);
  });
});

import { exec } from 'child_process';
import { IRuntimeClient } from './runtime-client';
import { RegistryService } from './registry-service';
import { UpdateChecker } from './update-checker';
import { CommandExecutor } from '../utils/command-executor';
import { WebhookService } from './webhook-service';
import { GitService } from './git-service';
import { logger } from '../utils/logger';
import { getConfig } from '../utils/config';
import { extractRepoName } from '../utils/label-parser';
import { ImageUpdateInfo, GitChangeInfo, ContainerInfo, RegistryCredentials, GitAuthType, GitOpsConfig, SyncStatus } from '../types';
import { StatusStore } from './status-store';
import { ImageParser } from '../utils/image-parser';
import { minimatch } from 'minimatch';

interface SubscriberState {
  containerId: string;
  lastCommit: string | null;
  lastCheck: number;
}

// Manual GitOps trigger (HTTP) types.
//   run   = execute the configured commands now against the current working
//           tree (no git fetch) — deploy-hook style.
//   check = fetch + diff and run only if matching changes are found; with
//           force=true, pull latest and run even when nothing changed.
export type GitOpsTriggerMode = 'run' | 'check';

export type GitOpsTriggerCode = 'ok' | 'noop' | 'busy' | 'disabled' | 'not_found' | 'error';

export interface GitOpsTriggerResult {
  scope: 'global' | 'container';
  mode: GitOpsTriggerMode;
  forced: boolean;
  triggered: boolean; // did commands actually execute
  code: GitOpsTriggerCode;
  affected?: string[]; // container names whose commands ran
  changed?: boolean; // (check mode) were matching git changes detected
  message?: string; // human-readable detail, esp. when triggered=false
}

interface SharedRepoState {
  service: GitService;
  subscribers: Map<string, SubscriberState>; // keyed by container.id
  // Promise-chain mutex: serialize fetch/pull/diff so concurrent subscribers
  // don't race on .git lock files.
  opQueue: Promise<unknown>;
  // Auth in effect for this state (taken from the first registrant). Used to
  // warn when later subscribers arrive with divergent credentials — they'll
  // silently be served by the first registrant's auth.
  auth: { authType: GitAuthType; token?: string; sshKeyPath?: string };
}

export class MonitorService {
  private runtimeClient: IRuntimeClient;
  private registryService: RegistryService;
  private updateChecker: UpdateChecker;
  private commandExecutor: CommandExecutor;
  private webhookService?: WebhookService;
  private gitService?: GitService; // Global GitOps service
  // Shared per-container GitOps services. Workloads pointing at the same
  // <namespace, repo, branch> converge on the same key (the clone path), so
  // one working tree serves all of them. Each subscriber tracks its own
  // lastCommit and runs its own commands.
  private sharedRepoStates: Map<string, SharedRepoState> = new Map();
  private lastGitopsCheck: number = 0;
  private gitopsExecuting: Set<string> = new Set(); // Track executing GitOps operations
  private globalGitopsExecuting: boolean = false; // Track global GitOps execution
  private updateCheckExecuting: boolean = false; // Track if update check is running
  private lastMonitoredContainerIds: string = ''; // Track last seen container set for change detection
  // After a failed auto-update, suppress re-attempts of the SAME target image
  // for a cooldown window. Without this, a crash-looping new image (or an old
  // image an external supervisor keeps recreating) is re-detected every cycle,
  // producing an endless update/notify loop. Keyed by container.name because a
  // container's id changes when it is recreated, but its name is stable.
  private updateFailureCooldowns: Map<string, { targetImage: string; until: number }> = new Map();

  constructor(runtimeClient: IRuntimeClient) {
    this.runtimeClient = runtimeClient;
    this.registryService = new RegistryService();
    this.updateChecker = new UpdateChecker(this.registryService, this.runtimeClient);
    this.commandExecutor = new CommandExecutor();

    const config = getConfig();
    if (config.webhook?.enabled) {
      this.webhookService = new WebhookService(config.webhook);
      logger.info('🔔 Webhook notifications enabled');
    }

    if (config.gitops?.enabled) {
      const cloneParent = (config.gitops.clonePath || '/tmp').replace(/\/+$/, '');
      this.gitService = new GitService({
        ...config.gitops,
        clonePath: `${cloneParent}/${extractRepoName(config.gitops.repoUrl)}`,
      });
      logger.info('📦 GitOps monitoring enabled');
    }
  }

  public setECRCredentials(ecrCredentials: Map<string, RegistryCredentials>): void {
    this.registryService.setECRCredentials(ecrCredentials);
  }

  async initialize(): Promise<boolean> {
    try {
      logger.info('🐾 Initializing container monitor service...');

      const isConnected = await this.runtimeClient.ping();
      if (!isConnected) {
        logger.error('❌ Failed to connect to container runtime');
        return false;
      }

      logger.info('🐾 Successfully connected to container runtime');

      if (this.gitService) {
        const gitInitialized = await this.gitService.initialize();
        if (!gitInitialized) {
          logger.warn('⚠️  GitOps initialization failed, continuing without GitOps');
          this.gitService = undefined;
        }
      }

      return true;
    } catch (error) {
      logger.error('❌ Failed to initialize monitor service:', error);
      return false;
    }
  }

  async runCheck(): Promise<void> {
    try {
      await this.checkGitOpsChanges();

      if (this.updateCheckExecuting) {
        logger.warn('⚠️  Update Check: Previous check still running, skipping this interval');
        return;
      }

      this.updateCheckExecuting = true;
      StatusStore.instance.setCheckInProgress(true);

      // Hard upper bound on the whole cycle so the executing flag always
      // releases. Without this, any unforeseen hang below (registry, runtime
      // client, etc.) leaves the flag stuck and every subsequent tick is
      // skipped — see prod incident 2026-05-15 where the flag stayed true
      // for 4+ hours.
      const cycleBudgetMs = Math.min(Math.max(2 * getConfig().interval, 60_000), 300_000);
      let cycleTimer: NodeJS.Timeout | undefined;
      const cycleTimeout = new Promise<never>((_, reject) => {
        cycleTimer = setTimeout(
          () => reject(new Error(`update check cycle exceeded ${cycleBudgetMs}ms budget`)),
          cycleBudgetMs
        );
      });

      try {
        await Promise.race([this.executeUpdateCheck(), cycleTimeout]);
      } finally {
        if (cycleTimer) clearTimeout(cycleTimer);
        this.updateCheckExecuting = false;
        StatusStore.instance.setCheckInProgress(false);
      }
    } catch (error) {
      logger.error('❌ Error during update check:', error);
    }
  }

  private async executeUpdateCheck(): Promise<void> {
    const containers = await this.runtimeClient.getRunningContainers();

    if (containers.length === 0) {
      logger.info('🔍 No containers found to monitor');
      return;
    }

    // Initial snapshot so the dashboard shows components (and their health)
    // immediately, before the registry check completes.
    StatusStore.instance.setContainers(containers);

    const containerIds = containers.map((c) => c.id).sort().join(',');
    if (containerIds !== this.lastMonitoredContainerIds) {
      this.lastMonitoredContainerIds = containerIds;
      logger.info(`🔍 Monitoring ${containers.length} container(s):`);
      for (const container of containers) {
        const labelHint = container.imageLabelKeys?.length ? ` [labels: ${container.imageLabelKeys.join(', ')}]` : '';
        logger.info(`   📦 ${container.name} (${container.image})${labelHint}`);
      }
    }

    const updates = await this.updateChecker.checkForUpdates(containers);

    // Re-snapshot with the available updates attached so each component's sync
    // status reflects this check (synced vs outdated).
    const updateById = new Map(updates.map((u) => [u.container.id, u]));
    StatusStore.instance.setContainers(containers, updateById);

    if (updates.length === 0) {
      if (this.webhookService) {
        await this.webhookService.sendCheckNotification(containers.length, 0);
      }
      return;
    }

    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info(`🆕 Found ${updates.length} update(s) available`);
    logger.info('═══════════════════════════════════════════════════════════════');

    for (const update of updates) {
      await this.handleUpdate(update);
      logger.info('───────────────────────────────────────────────────────────────');
    }

    logger.info('═══════════════════════════════════════════════════════════════');

    if (this.webhookService) {
      await this.webhookService.sendCheckNotification(containers.length, updates.length);
    }
  }

  private async handleUpdate(update: ImageUpdateInfo): Promise<void> {
    const config = getConfig();
    const container = update.container;
    const autoUpdateEnabled =
      container.autoUpdate !== undefined ? container.autoUpdate : config.autoUpdate;

    const targetImage = ImageParser.toString(update.availableImage);

    const baseEvent = {
      timestamp: new Date().toISOString(),
      containerName: container.name,
      fromTag: update.currentImage.tag,
      toTag: update.availableImage.tag,
      updateType: update.updateType,
      autoUpdated: autoUpdateEnabled,
      labelValues: update.availableLabelValues,
    };

    // Skip if this exact target image failed recently and is still cooling down.
    // A different (newer) target is allowed through; an expired entry is cleared.
    if (autoUpdateEnabled) {
      const cooldown = this.updateFailureCooldowns.get(container.name);
      if (cooldown && cooldown.targetImage === targetImage && cooldown.until > Date.now()) {
        const remainingS = Math.ceil((cooldown.until - Date.now()) / 1000);
        logger.warn(
          `   ⏳ Skipping ${container.name}: update to ${update.availableImage.tag} failed recently; cooling down for ${remainingS}s more`
        );
        StatusStore.instance.markComponentSync(container.id, SyncStatus.FAILED, {
          error: `cooling down after a failed update to ${update.availableImage.tag}`,
        });
        return;
      }
      if (cooldown && (cooldown.targetImage !== targetImage || cooldown.until <= Date.now())) {
        this.updateFailureCooldowns.delete(container.name);
      }
    }

    try {
      logger.info(`🔔 UPDATE AVAILABLE`);
      logger.info(`   Container: ${container.name}`);
      logger.info(`   Current:   ${update.currentImage.tag}`);
      logger.info(`   New:       ${update.availableImage.tag}`);

      if (autoUpdateEnabled) {
        logger.info(`   Action:    Auto-updating...`);
        StatusStore.instance.markComponentSync(container.id, SyncStatus.UPDATING);
        await this.autoUpdateContainer(update);
        this.updateFailureCooldowns.delete(container.name); // success clears any cooldown
        StatusStore.instance.markComponentSync(container.id, SyncStatus.SYNCED);
        StatusStore.instance.recordUpdate({ ...baseEvent, success: true });
      } else {
        logger.info(`   Action:    Skipped (auto-update disabled)`);
        logger.info(`   💡 Tip: Set AUTO_UPDATE=true or add label containrdog.auto-update=true`);
        StatusStore.instance.recordUpdate({ ...baseEvent, success: false });
      }
    } catch (error) {
      logger.error(`❌ Failed to handle update for ${update.container.name}:`, error);

      // Record a cooldown so the same failing target isn't retried — and
      // re-notified — every cycle. The failure notification itself was already
      // sent once by autoUpdateContainer.
      const cooldownMs = getConfig().update.failureCooldown;
      if (autoUpdateEnabled && cooldownMs > 0) {
        this.updateFailureCooldowns.set(container.name, {
          targetImage,
          until: Date.now() + cooldownMs,
        });
        logger.warn(
          `   ⏳ ${container.name}: will not retry ${update.availableImage.tag} for ${Math.ceil(cooldownMs / 1000)}s`
        );
      }

      const errMsg = error instanceof Error ? error.message : String(error);
      StatusStore.instance.markComponentSync(container.id, SyncStatus.FAILED, { error: errMsg });
      StatusStore.instance.recordUpdate({
        ...baseEvent,
        success: false,
        error: errMsg,
      });
    }
  }

  private async autoUpdateContainer(update: ImageUpdateInfo): Promise<void> {
    const container = update.container;
    const newImageName = ImageParser.toString(update.availableImage);
    const config = getConfig();

    const preUpdateCommands = container.preUpdateCommands || config.preUpdateCommands;
    const postUpdateCommands =
      container.postUpdateCommands ||
      config.postUpdateCommands ||
      container.updateCommands ||
      config.updateCommands;

    try {
      if (preUpdateCommands && preUpdateCommands.length > 0) {
        logger.info(`   🔧 Executing pre-update commands...`);
        await this.commandExecutor.executeUpdateCommands(update, preUpdateCommands);
      }

      await this.runtimeClient.updateContainerImage(container.id, newImageName);

      logger.info(`   ✅ Successfully updated to ${update.availableImage.tag}`);

      if (postUpdateCommands && postUpdateCommands.length > 0) {
        logger.info(`   💻 Executing post-update commands...`);
        await this.commandExecutor.executeUpdateCommands(update, postUpdateCommands);
      }

      if (this.webhookService) {
        await this.webhookService.sendUpdateNotification(update, true);
      }
    } catch (error) {
      logger.error(`   ❌ Auto-update failed: ${error}`);

      if (this.webhookService) {
        await this.webhookService.sendUpdateNotification(
          update,
          false,
          error instanceof Error ? error.message : String(error)
        );
      }

      throw error;
    }
  }

  /**
   * Check for GitOps changes on a separate interval
   */
  private async checkGitOpsChanges(): Promise<void> {
    const config = getConfig();
    const now = Date.now();

    const containers = await this.runtimeClient.getRunningContainers();

    // Check global GitOps service
    if (this.gitService) {
      if (now - this.lastGitopsCheck >= config.gitops!.pollInterval) {
        if (this.globalGitopsExecuting) {
          logger.warn('⚠️  GitOps (Global): Previous execution still running, skipping this interval');
        } else {
          this.lastGitopsCheck = now;
          this.globalGitopsExecuting = true;

          try {
            if (this.gitService.shouldRunOnInterval()) {
              logger.info('📦 GitOps (Global): Running interval-based commands (no watch paths)');

              const affectedContainers = containers.filter((container) => {
                if (container.gitopsRepoUrl) return false;
                const gitopsEnabled =
                  container.gitopsEnabled !== undefined
                    ? container.gitopsEnabled
                    : config.gitops?.enabled || false;
                return gitopsEnabled;
              });

              if (affectedContainers.length > 0) {
                const intervalChange: GitChangeInfo = {
                  changedFiles: [],
                  previousCommit: '',
                  currentCommit: '',
                  commitMessage: 'Interval-based execution',
                  timestamp: new Date(),
                };
                await this.dispatchGlobalGitOps(affectedContainers, intervalChange);
              }
            } else {
              const changes = await this.gitService.checkForChanges();

              if (changes) {
                const affectedContainers = this.getAffectedContainers(containers, changes, true);

                if (affectedContainers.length > 0) {
                  logger.info(`📦 GitOps (Global): ${affectedContainers.length} container(s) affected by changes`);
                  await this.dispatchGlobalGitOps(affectedContainers, changes);
                }
              }
            }
          } catch (error) {
            logger.error('❌ Global GitOps check failed:', error);
          } finally {
            this.globalGitopsExecuting = false;
          }
        }
      }
    }

    // Check per-container GitOps services
    for (const container of containers) {
      if (container.gitopsEnabled && container.gitopsRepoUrl) {
        await this.checkContainerGitOps(container, now);
      }
    }

    // Cleanup GitOps subscribers for containers that no longer exist. When a
    // shared repo state has no subscribers left, drop the state entry too
    // (the working tree on disk stays — disposing it is intentionally manual).
    const containerIds = new Set(containers.map((c) => c.id));
    for (const [clonePath, state] of this.sharedRepoStates) {
      for (const [id] of state.subscribers) {
        if (!containerIds.has(id)) {
          state.subscribers.delete(id);
          logger.debug(`🧹 GitOps: Removed subscriber ${id} from ${clonePath}`);
        }
      }
      if (state.subscribers.size === 0) {
        this.sharedRepoStates.delete(clonePath);
        logger.debug(`🧹 GitOps: Released shared repo state at ${clonePath}`);
      }
    }
  }

  /**
   * Build the shared clone path for a container's repo. Workloads that target
   * the same repo+branch in the same namespace converge on the same path and
   * therefore share a single working tree. Each subscriber still tracks its
   * own lastCommit and runs its own commands (see SharedRepoState).
   *
   * Format:
   *   K8s:    <parent>/<namespace>-<repo>-<branch>
   *   Docker: <parent>/<repo>-<branch>
   */
  private resolveContainerClonePath(container: ContainerInfo, gitopsConfig?: GitOpsConfig): string {
    const cloneParent =
      (container.gitopsClonePath || gitopsConfig?.clonePath || '/tmp').replace(/\/+$/, '');
    const repoName = extractRepoName(container.gitopsRepoUrl!);
    const branch = container.gitopsBranch || gitopsConfig?.branch || 'main';
    const parts = container.namespace
      ? [container.namespace, repoName, branch]
      : [repoName, branch];
    const slug = parts.join('-').replace(/[^a-zA-Z0-9._-]/g, '-');
    return `${cloneParent}/${slug}`;
  }

  /**
   * Get or create the SharedRepoState and this container's subscriber for a
   * per-container GitOps repo. A clone path is derived from
   * <namespace, repo, branch>, so workloads sharing those values converge on
   * the same state and reuse one working tree. New subscribers start at the
   * current HEAD so they don't replay history. Returns null if the repo can't
   * be initialized.
   */
  private async getOrCreateSubscriber(
    container: ContainerInfo
  ): Promise<{ state: SharedRepoState; sub: SubscriberState } | null> {
    const config = getConfig();
    const clonePath = this.resolveContainerClonePath(container, config.gitops);

    const subscriberAuth = {
      authType: container.gitopsAuthType || config.gitops?.authType || GitAuthType.NONE,
      token: container.gitopsToken || config.gitops?.token,
      sshKeyPath: container.gitopsSshKeyPath || config.gitops?.sshKeyPath,
    };

    let state = this.sharedRepoStates.get(clonePath);
    if (!state) {
      const gitConfig: GitOpsConfig = {
        enabled: true,
        repoUrl: container.gitopsRepoUrl!,
        branch: container.gitopsBranch || 'main',
        authType: subscriberAuth.authType,
        token: subscriberAuth.token,
        sshKeyPath: subscriberAuth.sshKeyPath,
        pollInterval: container.gitopsPollInterval || 60000,
        // watchPaths/commands live per-subscriber, not on the shared service.
        clonePath,
        shallow: config.gitops?.shallow,
      };

      const service = new GitService(gitConfig);
      const initialized = await service.initialize();
      if (!initialized) {
        logger.warn(`⚠️  GitOps: Failed to initialize shared repo at ${clonePath} (driven by ${container.name})`);
        return null;
      }

      state = { service, subscribers: new Map(), opQueue: Promise.resolve(), auth: subscriberAuth };
      this.sharedRepoStates.set(clonePath, state);
      logger.info(`📦 GitOps: Initialized shared repo at ${clonePath}`);
    }

    let sub = state.subscribers.get(container.id);
    if (!sub) {
      // Warn if the new subscriber's credentials differ from the in-effect
      // ones; the first registrant's auth is what's actually used for fetches.
      if (
        state.auth.authType !== subscriberAuth.authType ||
        state.auth.token !== subscriberAuth.token ||
        state.auth.sshKeyPath !== subscriberAuth.sshKeyPath
      ) {
        logger.warn(
          `⚠️  GitOps: ${container.name} joined shared repo ${clonePath} with different credentials; ` +
          `the first registrant's auth (${state.auth.authType}) remains in effect for all fetches.`
        );
      }
      const head = await state.service.getCurrentCommit();
      sub = { containerId: container.id, lastCommit: head, lastCheck: 0 };
      state.subscribers.set(container.id, sub);
      logger.info(`📦 GitOps: ${container.name} subscribed to ${clonePath}`);
    }

    return { state, sub };
  }

  /**
   * Check GitOps for a specific container with its own repository
   */
  private async checkContainerGitOps(container: ContainerInfo, now: number): Promise<void> {
    try {
      const ensured = await this.getOrCreateSubscriber(container);
      if (!ensured) return;
      const { state, sub } = ensured;

      // Per-subscriber poll cadence and re-entrancy guard.
      const pollInterval = container.gitopsPollInterval || 60000;
      if (now - sub.lastCheck < pollInterval) return;

      if (this.gitopsExecuting.has(container.id)) {
        logger.warn(`⚠️  GitOps (${container.name}): Previous execution still running, skipping this interval`);
        return;
      }

      sub.lastCheck = now;
      this.gitopsExecuting.add(container.id);

      try {
        await this.runSharedCheckForSubscriber(state, sub, container);
      } finally {
        this.gitopsExecuting.delete(container.id);
      }
    } catch (error) {
      logger.error(`❌ GitOps check failed for container ${container.name}:`, error);
    }
  }

  /**
   * Run a check for a single subscriber against the shared repo state.
   * Serialized via the state's promise-chain mutex so a concurrent subscriber
   * can't race on .git lock files. Each subscriber tracks its own lastCommit
   * and runs its own commands; fetch/pull are still per-subscriber here for
   * simplicity (no shared "last fetch" timestamp yet — git's own object dedup
   * keeps the network cost low when nothing has changed).
   */
  private async runSharedCheckForSubscriber(
    state: SharedRepoState,
    sub: SubscriberState,
    container: ContainerInfo,
    force = false
  ): Promise<boolean> {
    let ran = false;
    const op = state.opQueue.then(async () => {
      const watchPaths = container.gitopsWatchPaths;
      const isInterval = !watchPaths || watchPaths.length === 0;

      // No watchPaths: fire commands every poll, regardless of git state.
      if (isInterval) {
        logger.info(`📦 GitOps (${container.name}): Running interval-based commands (no watch paths)`);
        const change: GitChangeInfo = {
          changedFiles: [],
          previousCommit: '',
          currentCommit: '',
          commitMessage: 'Interval-based execution',
          timestamp: new Date(),
        };
        await this.executeGitOpsCommands(container, change);
        ran = true;
        return;
      }

      // watchPaths set: only fire on real commits that touch matching files —
      // unless force is set (manual trigger), which pulls latest and runs the
      // commands even when no matching change is found.
      await state.service.fetch();
      const currentHead = await state.service.getRemoteHead();
      if (!currentHead) {
        logger.warn(`⚠️  GitOps (${container.name}): Could not determine remote HEAD`);
        return;
      }

      const noNewCommits = !!sub.lastCommit && sub.lastCommit === currentHead;
      if (noNewCommits && !force) return; // no new commits for this subscriber

      const previousCommit = sub.lastCommit || `${currentHead}~1`;
      const changedFiles = noNewCommits ? [] : await state.service.getDiff(previousCommit, currentHead);
      const relevantFiles = state.service.filterByWatchPaths(changedFiles, watchPaths);

      if (relevantFiles.length === 0 && !force) {
        sub.lastCommit = currentHead; // advance so we don't keep re-checking the same commit
        return;
      }

      // Pull working tree to HEAD so the subscriber's commands see latest files.
      // Idempotent if another subscriber already pulled this cycle.
      await state.service.pull();

      const commitMessage = noNewCommits
        ? 'Manual trigger (forced)'
        : await state.service.getCommitMessage(currentHead);
      const change: GitChangeInfo = {
        changedFiles: relevantFiles,
        previousCommit,
        currentCommit: currentHead,
        commitMessage,
        timestamp: new Date(),
      };
      sub.lastCommit = currentHead;

      if (relevantFiles.length > 0) {
        logger.info(`📦 GitOps (${container.name}): ${relevantFiles.length} relevant file(s) changed @ ${currentHead.substring(0, 7)}`);
      } else {
        logger.info(`📦 GitOps (${container.name}): forced run @ ${currentHead.substring(0, 7)} (no matching changes)`);
      }
      await this.executeGitOpsCommands(container, change);
      ran = true;
    });

    state.opQueue = op.catch(() => undefined); // keep the chain alive after errors
    await op;
    return ran;
  }

  /**
   * Dispatch a global-GitOps change to affected containers.
   * Containers with their own gitops-commands label run those per container (so
   * $CONTAINER_* env vars resolve per pod). Containers relying on the global
   * commands share a single execution — otherwise N pods would re-run the same
   * cluster-wide command N times.
   */
  private async dispatchGlobalGitOps(
    affectedContainers: ContainerInfo[],
    changes: GitChangeInfo
  ): Promise<void> {
    const config = getConfig();
    const perContainer: ContainerInfo[] = [];
    const globalCommandConsumers: ContainerInfo[] = [];

    for (const container of affectedContainers) {
      if (container.gitopsCommands && container.gitopsCommands.length > 0) {
        perContainer.push(container);
      } else {
        globalCommandConsumers.push(container);
      }
    }

    for (const container of perContainer) {
      await this.executeGitOpsCommands(container, changes);
    }

    const globalCommands = config.gitops?.commands;
    if (globalCommandConsumers.length > 0 && globalCommands && globalCommands.length > 0) {
      await this.executeGlobalGitOpsCommands(globalCommandConsumers, changes);
    }
  }

  /**
   * Execute the globally configured GitOps commands exactly once for a change,
   * regardless of how many containers are affected.
   */
  private async executeGlobalGitOpsCommands(
    affectedContainers: ContainerInfo[],
    changes: GitChangeInfo
  ): Promise<void> {
    const config = getConfig();
    const commands = config.gitops?.commands;

    if (!commands || commands.length === 0) {
      return;
    }

    const cloneParent = (config.gitops?.clonePath || '/tmp').replace(/\/+$/, '');
    const clonePath = `${cloneParent}/${extractRepoName(config.gitops!.repoUrl)}`;
    const quietMode = config.gitops?.quietMode ?? false;

    logger.info(`📦 GitOps (Global): Executing commands once for ${affectedContainers.length} affected container(s)...`);
    logger.info(`   📁 Working directory: ${clonePath}`);

    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_COMMIT: changes.currentCommit,
        GIT_PREVIOUS_COMMIT: changes.previousCommit,
        GIT_COMMIT_MESSAGE: changes.commitMessage,
        GIT_CHANGED_FILES: changes.changedFiles.join(','),
        GITOPS_CLONE_PATH: clonePath,
        AFFECTED_CONTAINERS: affectedContainers.map((c) => c.name).join(','),
      };

      for (const command of commands) {
        logger.info(`   💻 Executing: ${command}`);

        let processedCommand = command;
        Object.entries(env).forEach(([key, value]) => {
          processedCommand = processedCommand.replace(new RegExp(`\\$${key}`, 'g'), value || '');
        });

        await new Promise<void>((resolve, reject) => {
          exec(processedCommand, { env, cwd: clonePath }, (error, stdout, stderr) => {
            if (error) {
              logger.error(`   ❌ Command failed: ${error.message}`);
              reject(error);
              return;
            }
            if (!quietMode && stdout) {
              logger.info(`   📤 ${stdout.trim()}`);
            }
            if (stderr) {
              logger.warn(`   ⚠️  ${stderr.trim()}`);
            }
            resolve();
          });
        });
      }

      if (!quietMode) {
        logger.info(`   ✅ GitOps (Global) commands completed`);
      }

      if (this.webhookService) {
        await this.webhookService.sendGlobalGitOpsNotification(affectedContainers, changes, true);
      }
    } catch (error) {
      logger.error(`   ❌ GitOps (Global) commands failed:`, error);

      if (this.webhookService) {
        await this.webhookService.sendGlobalGitOpsNotification(
          affectedContainers,
          changes,
          false,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }

  /**
   * Get containers affected by GitOps changes
   * @param isGlobal - If true, only return containers using global GitOps (not per-container repos)
   */
  private getAffectedContainers(
    containers: ContainerInfo[],
    changes: GitChangeInfo,
    isGlobal: boolean = false
  ): ContainerInfo[] {
    const config = getConfig();

    return containers.filter((container) => {
      if (isGlobal && container.gitopsRepoUrl) {
        return false;
      }

      const gitopsEnabled =
        container.gitopsEnabled !== undefined
          ? container.gitopsEnabled
          : config.gitops?.enabled || false;

      if (!gitopsEnabled) {
        return false;
      }

      const watchPaths = container.gitopsWatchPaths || config.gitops?.watchPaths;

      if (!watchPaths || watchPaths.length === 0) {
        return true;
      }

      return changes.changedFiles.some((file) =>
        watchPaths.some((pattern) => minimatch(file, pattern, { dot: true }))
      );
    });
  }

  /**
   * Execute GitOps commands for a container
   */
  private async executeGitOpsCommands(
    container: ContainerInfo,
    changes: GitChangeInfo
  ): Promise<void> {
    const config = getConfig();

    const commands = container.gitopsCommands || config.gitops?.commands;

    if (!commands || commands.length === 0) {
      logger.info(`📦 GitOps: No commands configured for ${container.name}`);
      return;
    }

    let clonePath: string;
    if (container.gitopsRepoUrl) {
      clonePath = this.resolveContainerClonePath(container, config.gitops);
    } else {
      const cloneParent = (config.gitops?.clonePath || '/tmp').replace(/\/+$/, '');
      clonePath = `${cloneParent}/${extractRepoName(config.gitops!.repoUrl)}`;
    }

    const quietMode = container.gitopsQuietMode ?? config.gitops?.quietMode ?? false;

    logger.info(`📦 GitOps: Executing commands for ${container.name}...`);
    logger.info(`   📁 Working directory: ${clonePath}`);

    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CONTAINER_ID: container.id,
        CONTAINER_NAME: container.name,
        CONTAINER_IMAGE: container.image,
        GIT_COMMIT: changes.currentCommit,
        GIT_PREVIOUS_COMMIT: changes.previousCommit,
        GIT_COMMIT_MESSAGE: changes.commitMessage,
        GIT_CHANGED_FILES: changes.changedFiles.join(','),
        GITOPS_CLONE_PATH: clonePath,
      };

      for (const command of commands) {
        logger.info(`   💻 Executing: ${command}`);

        let processedCommand = command;
        Object.entries(env).forEach(([key, value]) => {
          processedCommand = processedCommand.replace(new RegExp(`\\$${key}`, 'g'), value || '');
        });

        await new Promise<void>((resolve, reject) => {
          exec(processedCommand, { env, cwd: clonePath }, (error, stdout, stderr) => {
            if (error) {
              logger.error(`   ❌ Command failed: ${error.message}`);
              reject(error);
              return;
            }
            if (!quietMode && stdout) {
              logger.info(`   📤 ${stdout.trim()}`);
            }
            if (stderr) {
              logger.warn(`   ⚠️  ${stderr.trim()}`);
            }
            resolve();
          });
        });
      }

      if (!quietMode) {
        logger.info(`   ✅ GitOps commands completed for ${container.name}`);
      }

      if (this.webhookService) {
        await this.webhookService.sendGitOpsNotification(container, changes, true);
      }
    } catch (error) {
      logger.error(`   ❌ GitOps commands failed for ${container.name}:`, error);

      if (this.webhookService) {
        await this.webhookService.sendGitOpsNotification(
          container,
          changes,
          false,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }

  private manualChange(forced: boolean): GitChangeInfo {
    return {
      changedFiles: [],
      previousCommit: '',
      currentCommit: '',
      commitMessage: forced ? 'Manual trigger (forced)' : 'Manual trigger',
      timestamp: new Date(),
    };
  }

  /**
   * Containers that rely on the GLOBAL GitOps repo: GitOps enabled and no
   * per-container repo of their own.
   */
  private globalGitopsConsumers(containers: ContainerInfo[]): ContainerInfo[] {
    const config = getConfig();
    return containers.filter((c) => {
      if (c.gitopsRepoUrl) return false;
      return c.gitopsEnabled !== undefined ? c.gitopsEnabled : config.gitops?.enabled || false;
    });
  }

  /**
   * Manually trigger the GLOBAL GitOps process on demand (HTTP).
   * - mode 'run':   execute the global commands now for every global consumer.
   * - mode 'check': fetch + diff; run only on matching changes. With force,
   *                 pull latest and run for all consumers even with no changes.
   */
  async triggerGlobalGitOps(mode: GitOpsTriggerMode, force: boolean): Promise<GitOpsTriggerResult> {
    const base = { scope: 'global' as const, mode, forced: force };

    if (!this.gitService) {
      return { ...base, triggered: false, code: 'disabled', message: 'Global GitOps is not enabled' };
    }
    if (this.globalGitopsExecuting) {
      return { ...base, triggered: false, code: 'busy', message: 'Global GitOps is already executing' };
    }

    this.globalGitopsExecuting = true;
    try {
      const containers = await this.runtimeClient.getRunningContainers();
      const consumers = this.globalGitopsConsumers(containers);

      if (mode === 'run') {
        if (consumers.length === 0) {
          return { ...base, triggered: false, code: 'noop', affected: [], message: 'No containers use global GitOps' };
        }
        await this.dispatchGlobalGitOps(consumers, this.manualChange(force));
        return { ...base, triggered: true, code: 'ok', affected: consumers.map((c) => c.name) };
      }

      // mode === 'check'
      const changes = await this.gitService.checkForChanges();
      if (changes) {
        const affected = this.getAffectedContainers(containers, changes, true);
        if (affected.length > 0) {
          await this.dispatchGlobalGitOps(affected, changes);
        }
        return {
          ...base,
          triggered: affected.length > 0,
          code: affected.length > 0 ? 'ok' : 'noop',
          changed: true,
          affected: affected.map((c) => c.name),
          message: affected.length > 0 ? undefined : 'Changes did not affect any container',
        };
      }

      // No new changes.
      if (force) {
        if (consumers.length === 0) {
          return { ...base, triggered: false, code: 'noop', changed: false, affected: [], message: 'No containers use global GitOps' };
        }
        await this.gitService.pull(); // ensure the working tree is at latest
        await this.dispatchGlobalGitOps(consumers, this.manualChange(true));
        return { ...base, triggered: true, code: 'ok', changed: false, affected: consumers.map((c) => c.name) };
      }

      return { ...base, triggered: false, code: 'noop', changed: false, message: 'No relevant changes' };
    } catch (error) {
      logger.error('❌ Manual global GitOps trigger failed:', error);
      return { ...base, triggered: false, code: 'error', message: error instanceof Error ? error.message : String(error) };
    } finally {
      this.globalGitopsExecuting = false;
    }
  }

  /**
   * Manually trigger GitOps for a single container/deployment on demand (HTTP),
   * matched by container name.
   * - mode 'run':   execute that container's commands now (works for both
   *                 per-container repos and global-repo consumers).
   * - mode 'check': fetch + diff for the relevant repo; run on matching changes,
   *                 or with force pull latest and run regardless.
   */
  async triggerContainerGitOps(
    containerName: string,
    mode: GitOpsTriggerMode,
    force: boolean
  ): Promise<GitOpsTriggerResult> {
    const base = { scope: 'container' as const, mode, forced: force };
    const config = getConfig();

    let container: ContainerInfo | undefined;
    try {
      const containers = await this.runtimeClient.getRunningContainers();
      container = containers.find((c) => c.name === containerName);
    } catch (error) {
      return { ...base, triggered: false, code: 'error', message: error instanceof Error ? error.message : String(error) };
    }

    if (!container) {
      return { ...base, triggered: false, code: 'not_found', message: `Container '${containerName}' is not currently monitored` };
    }

    const gitopsEnabled =
      container.gitopsEnabled !== undefined ? container.gitopsEnabled : config.gitops?.enabled || false;
    if (!gitopsEnabled) {
      return { ...base, triggered: false, code: 'disabled', message: `GitOps is not enabled for '${containerName}'` };
    }

    if (this.gitopsExecuting.has(container.id)) {
      return { ...base, triggered: false, code: 'busy', message: `GitOps is already executing for '${containerName}'` };
    }

    this.gitopsExecuting.add(container.id);
    try {
      if (mode === 'run') {
        await this.executeGitOpsCommands(container, this.manualChange(force));
        return { ...base, triggered: true, code: 'ok', affected: [container.name] };
      }

      // mode === 'check'
      if (container.gitopsRepoUrl) {
        // Per-container repo: drive the shared-repo subscriber flow.
        const ensured = await this.getOrCreateSubscriber(container);
        if (!ensured) {
          return { ...base, triggered: false, code: 'error', message: `Could not initialize GitOps repo for '${containerName}'` };
        }
        const ran = await this.runSharedCheckForSubscriber(ensured.state, ensured.sub, container, force);
        return {
          ...base,
          triggered: ran,
          code: ran ? 'ok' : 'noop',
          affected: ran ? [container.name] : [],
          message: ran ? undefined : 'No relevant changes',
        };
      }

      // Global-repo consumer: check the global repo, scoped to this container.
      if (!this.gitService) {
        return { ...base, triggered: false, code: 'disabled', message: 'Global GitOps is not enabled' };
      }
      if (this.globalGitopsExecuting) {
        return { ...base, triggered: false, code: 'busy', message: 'Global GitOps is already executing' };
      }
      this.globalGitopsExecuting = true;
      try {
        const changes = await this.gitService.checkForChanges();
        if (changes) {
          const affected = this.getAffectedContainers([container], changes, true);
          if (affected.length > 0) {
            await this.executeGitOpsCommands(container, changes);
            return { ...base, triggered: true, code: 'ok', changed: true, affected: [container.name] };
          }
          return { ...base, triggered: false, code: 'noop', changed: true, message: "Changes did not match this container's watch paths" };
        }
        if (force) {
          await this.gitService.pull();
          await this.executeGitOpsCommands(container, this.manualChange(true));
          return { ...base, triggered: true, code: 'ok', changed: false, affected: [container.name] };
        }
        return { ...base, triggered: false, code: 'noop', changed: false, message: 'No relevant changes' };
      } finally {
        this.globalGitopsExecuting = false;
      }
    } catch (error) {
      logger.error(`❌ Manual GitOps trigger failed for ${containerName}:`, error);
      return { ...base, triggered: false, code: 'error', message: error instanceof Error ? error.message : String(error) };
    } finally {
      this.gitopsExecuting.delete(container.id);
    }
  }

  async shutdown(): Promise<void> {
    logger.info('🛑 Shutting down monitor service...');
  }
}

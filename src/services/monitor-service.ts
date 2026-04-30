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
import { ImageUpdateInfo, GitChangeInfo, ContainerInfo, RegistryCredentials, GitAuthType, GitOpsConfig } from '../types';
import { ImageParser } from '../utils/image-parser';
import { minimatch } from 'minimatch';

export class MonitorService {
  private runtimeClient: IRuntimeClient;
  private registryService: RegistryService;
  private updateChecker: UpdateChecker;
  private commandExecutor: CommandExecutor;
  private webhookService?: WebhookService;
  private gitService?: GitService; // Global GitOps service
  private containerGitServices: Map<string, { service: GitService; lastCheck: number }> = new Map(); // Per-container GitOps services
  private lastGitopsCheck: number = 0;
  private gitopsExecuting: Set<string> = new Set(); // Track executing GitOps operations
  private globalGitopsExecuting: boolean = false; // Track global GitOps execution
  private updateCheckExecuting: boolean = false; // Track if update check is running
  private lastMonitoredContainerIds: string = ''; // Track last seen container set for change detection

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

      try {
        const containers = await this.runtimeClient.getRunningContainers();

        if (containers.length === 0) {
          logger.info('🔍 No containers found to monitor');
          return;
        }

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
      } finally {
        this.updateCheckExecuting = false;
      }
    } catch (error) {
      logger.error('❌ Error during update check:', error);
    }
  }

  private async handleUpdate(update: ImageUpdateInfo): Promise<void> {
    try {
      const config = getConfig();
      const container = update.container;

      logger.info(`🔔 UPDATE AVAILABLE`);
      logger.info(`   Container: ${container.name}`);
      logger.info(`   Current:   ${update.currentImage.tag}`);
      logger.info(`   New:       ${update.availableImage.tag}`);

      const autoUpdateEnabled =
        container.autoUpdate !== undefined ? container.autoUpdate : config.autoUpdate;

      if (autoUpdateEnabled) {
        logger.info(`   Action:    Auto-updating...`);
        await this.autoUpdateContainer(update);
      } else {
        logger.info(`   Action:    Skipped (auto-update disabled)`);
        logger.info(`   💡 Tip: Set AUTO_UPDATE=true or add label containrdog.auto-update=true`);
      }
    } catch (error) {
      logger.error(`❌ Failed to handle update for ${update.container.name}:`, error);
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

    // Cleanup GitOps services for containers that no longer exist
    const containerIds = new Set(containers.map((c) => c.id));
    for (const [id] of this.containerGitServices) {
      if (!containerIds.has(id)) {
        this.containerGitServices.delete(id);
        logger.debug(`🧹 Cleaned up GitOps service for removed container: ${id}`);
      }
    }
  }

  /**
   * Build the clone path for a container's repo. When uniqueClonePath is set,
   * the workload's name (sanitized) is prefixed onto the repo dir so that
   * multiple workloads sharing the same repo get isolated working trees.
   */
  private resolveContainerClonePath(container: ContainerInfo, gitopsConfig?: GitOpsConfig): string {
    const cloneParent =
      (container.gitopsClonePath || gitopsConfig?.clonePath || '/tmp').replace(/\/+$/, '');
    const repoName = extractRepoName(container.gitopsRepoUrl!);
    if (gitopsConfig?.uniqueClonePath) {
      // Use the workload name on Kubernetes (Deployment/StatefulSet/DaemonSet),
      // not the per-pod container spec — replicas of the same workload share a
      // path. Fall back to container.name for Docker. Include namespace and
      // branch so cross-namespace and cross-branch reuse stays isolated.
      const workloadId = container.workloadName || container.name;
      const identifier = container.namespace
        ? `${container.namespace}-${workloadId}`
        : workloadId;
      const branch = container.gitopsBranch || gitopsConfig?.branch || 'main';
      const slug = `${identifier}-${repoName}-${branch}`.replace(/[^a-zA-Z0-9._-]/g, '-');
      return `${cloneParent}/${slug}`;
    }
    return `${cloneParent}/${repoName}`;
  }

  /**
   * Check GitOps for a specific container with its own repository
   */
  private async checkContainerGitOps(container: ContainerInfo, now: number): Promise<void> {
    try {
      const config = getConfig();

      let gitServiceData = this.containerGitServices.get(container.id);

      if (!gitServiceData) {
        const clonePath = this.resolveContainerClonePath(container, config.gitops);

        const gitConfig = {
          enabled: true,
          repoUrl: container.gitopsRepoUrl!,
          branch: container.gitopsBranch || 'main',
          authType: container.gitopsAuthType || config.gitops?.authType || GitAuthType.NONE,
          token: container.gitopsToken || config.gitops?.token,
          sshKeyPath: container.gitopsSshKeyPath || config.gitops?.sshKeyPath,
          pollInterval: container.gitopsPollInterval || 60000,
          watchPaths: container.gitopsWatchPaths,
          commands: container.gitopsCommands,
          clonePath,
          shallow: config.gitops?.shallow,
        };

        const gitService = new GitService(gitConfig);
        const initialized = await gitService.initialize();

        if (!initialized) {
          logger.warn(`⚠️  Failed to initialize GitOps for container ${container.name}`);
          return;
        }

        gitServiceData = { service: gitService, lastCheck: 0 };
        this.containerGitServices.set(container.id, gitServiceData);
        logger.info(`📦 GitOps: Initialized repository for ${container.name}`);
      }

      const pollInterval = container.gitopsPollInterval || 60000;
      if (now - gitServiceData.lastCheck < pollInterval) {
        return;
      }

      if (this.gitopsExecuting.has(container.id)) {
        logger.warn(`⚠️  GitOps (${container.name}): Previous execution still running, skipping this interval`);
        return;
      }

      gitServiceData.lastCheck = now;
      this.gitopsExecuting.add(container.id);

      try {
        if (gitServiceData.service.shouldRunOnInterval()) {
          logger.info(`📦 GitOps (${container.name}): Running interval-based commands (no watch paths)`);

          const intervalChange: GitChangeInfo = {
            changedFiles: [],
            previousCommit: '',
            currentCommit: '',
            commitMessage: 'Interval-based execution',
            timestamp: new Date(),
          };
          await this.executeGitOpsCommands(container, intervalChange);
        } else {
          const changes = await gitServiceData.service.checkForChanges();

          if (changes) {
            logger.info(`📦 GitOps (${container.name}): Changes detected in repository`);
            await this.executeGitOpsCommands(container, changes);
          }
        }
      } finally {
        this.gitopsExecuting.delete(container.id);
      }
    } catch (error) {
      logger.error(`❌ GitOps check failed for container ${container.name}:`, error);
    }
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
        for (const container of affectedContainers) {
          await this.webhookService.sendGitOpsNotification(container, changes, true);
        }
      }
    } catch (error) {
      logger.error(`   ❌ GitOps (Global) commands failed:`, error);

      if (this.webhookService) {
        for (const container of affectedContainers) {
          await this.webhookService.sendGitOpsNotification(
            container,
            changes,
            false,
            error instanceof Error ? error.message : String(error)
          );
        }
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

  async shutdown(): Promise<void> {
    logger.info('🛑 Shutting down monitor service...');
  }
}

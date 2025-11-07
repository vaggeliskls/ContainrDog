import { DockerClient } from './docker-client';
import { RegistryService } from './registry-service';
import { UpdateChecker } from './update-checker';
import { CommandExecutor } from '../utils/command-executor';
import { WebhookService } from './webhook-service';
import { GitService } from './git-service';
import { logger } from '../utils/logger';
import { getConfig } from '../utils/config';
import { ImageUpdateInfo, GitChangeInfo, ContainerInfo, RegistryCredentials } from '../types';
import { ImageParser } from '../utils/image-parser';
import { minimatch } from 'minimatch';

export class MonitorService {
  private dockerClient: DockerClient;
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

  constructor() {
    this.dockerClient = new DockerClient();
    this.registryService = new RegistryService();
    this.updateChecker = new UpdateChecker(this.registryService, this.dockerClient);
    this.commandExecutor = new CommandExecutor();

    // Initialize webhook service if configured
    const config = getConfig();
    if (config.webhook?.enabled) {
      this.webhookService = new WebhookService(config.webhook);
      logger.info('🔔 Webhook notifications enabled');
    }

    // Initialize GitOps service if configured
    if (config.gitops?.enabled) {
      this.gitService = new GitService(config.gitops);
      logger.info('📦 GitOps monitoring enabled');
    }
  }

  public setECRCredentials(ecrCredentials: Map<string, RegistryCredentials>): void {
    this.registryService.setECRCredentials(ecrCredentials);
  }

  async initialize(): Promise<boolean> {
    try {
      logger.info('🐾 Initializing container monitor service...');

      // Verify Docker daemon is accessible
      const isConnected = await this.dockerClient.ping();
      if (!isConnected) {
        logger.error('❌ Failed to connect to Docker daemon');
        return false;
      }

      logger.info('🐾 Successfully connected to Docker daemon');

      // Initialize GitOps if enabled
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
      const config = getConfig();

      // Check GitOps changes (on separate interval)
      await this.checkGitOpsChanges();

      // Check if update check is already running
      if (this.updateCheckExecuting) {
        logger.warn('⚠️  Update Check: Previous check still running, skipping this interval');
        return;
      }

      this.updateCheckExecuting = true;

      try {
        // Get all running containers (filtered by label if configured)
        const containers = await this.dockerClient.getRunningContainers();

        if (containers.length === 0) {
          return;
        }

        // Check for updates
        const updates = await this.updateChecker.checkForUpdates(containers);

        if (updates.length === 0) {
          // Send webhook notification for check
          if (this.webhookService) {
            await this.webhookService.sendCheckNotification(containers.length, 0);
          }
          return;
        }

        // Show logs when updates are found
        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info(`🆕 Found ${updates.length} update(s) available`);
        logger.info('═══════════════════════════════════════════════════════════════');

        // Process each update
        for (const update of updates) {
          await this.handleUpdate(update);
          logger.info('───────────────────────────────────────────────────────────────');
        }

        logger.info('═══════════════════════════════════════════════════════════════');

        // Send webhook notification for check
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

      // Determine if auto-update is enabled (container-specific or global)
      const autoUpdateEnabled =
        container.autoUpdate !== undefined ? container.autoUpdate : config.autoUpdate;

      // If auto-update is enabled, pull and recreate container
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

    // Determine which commands to use (container-specific or global)
    // Support backward compatibility with deprecated updateCommands
    const preUpdateCommands = container.preUpdateCommands || config.preUpdateCommands;
    const postUpdateCommands =
      container.postUpdateCommands ||
      config.postUpdateCommands ||
      container.updateCommands ||
      config.updateCommands;

    try {
      // Execute pre-update commands BEFORE the update
      if (preUpdateCommands && preUpdateCommands.length > 0) {
        logger.info(`   🔧 Executing pre-update commands...`);
        await this.commandExecutor.executeUpdateCommands(update, preUpdateCommands);
      }

      // Pull the new image
      logger.info(`   ⬇️  Pulling: ${newImageName}`);
      await this.dockerClient.pullImage(newImageName);

      // Recreate the container with the new image
      logger.info(`   🔄 Recreating container...`);
      await this.dockerClient.recreateContainer(container.id, newImageName);

      logger.info(`   ✅ Successfully updated to ${update.availableImage.tag}`);

      // Execute post-update commands AFTER successful update
      if (postUpdateCommands && postUpdateCommands.length > 0) {
        logger.info(`   💻 Executing post-update commands...`);
        await this.commandExecutor.executeUpdateCommands(update, postUpdateCommands);
      }

      // Send success webhook notification
      if (this.webhookService) {
        await this.webhookService.sendUpdateNotification(update, true);
      }
    } catch (error) {
      logger.error(`   ❌ Auto-update failed: ${error}`);

      // Send failure webhook notification
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

    // Get all containers
    const containers = await this.dockerClient.getRunningContainers();

    // Check global GitOps service
    if (this.gitService) {
      // Check if enough time has passed since last GitOps check
      if (now - this.lastGitopsCheck >= config.gitops!.pollInterval) {
        // Check if global GitOps is already executing
        if (this.globalGitopsExecuting) {
          logger.warn('⚠️  GitOps (Global): Previous execution still running, skipping this interval');
        } else {
          this.lastGitopsCheck = now;
          this.globalGitopsExecuting = true;

          try {
            // If no watch paths defined, run commands on every interval
            if (this.gitService.shouldRunOnInterval()) {
              logger.info('📦 GitOps (Global): Running interval-based commands (no watch paths)');

              // Get affected containers (all containers using global GitOps)
              const affectedContainers = containers.filter((container) => {
                if (container.gitopsRepoUrl) return false; // Skip containers with own repo
                const gitopsEnabled =
                  container.gitopsEnabled !== undefined
                    ? container.gitopsEnabled
                    : config.gitops?.enabled || false;
                return gitopsEnabled;
              });

              if (affectedContainers.length > 0) {
                for (const container of affectedContainers) {
                  // Create a dummy change info for interval execution
                  const intervalChange: GitChangeInfo = {
                    changedFiles: [],
                    previousCommit: '',
                    currentCommit: '',
                    commitMessage: 'Interval-based execution',
                    timestamp: new Date(),
                  };
                  await this.executeGitOpsCommands(container, intervalChange);
                }
              }
            } else {
              // Watch paths defined, only run on changes
              const changes = await this.gitService.checkForChanges();

              if (changes) {
                // Determine which containers should react to these changes
                const affectedContainers = this.getAffectedContainers(containers, changes, true);

                if (affectedContainers.length > 0) {
                  logger.info(`📦 GitOps (Global): ${affectedContainers.length} container(s) affected by changes`);

                  // Execute GitOps commands for affected containers
                  for (const container of affectedContainers) {
                    await this.executeGitOpsCommands(container, changes);
                  }
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
    for (const [id, _] of this.containerGitServices) {
      if (!containerIds.has(id)) {
        this.containerGitServices.delete(id);
        logger.debug(`🧹 Cleaned up GitOps service for removed container: ${id}`);
      }
    }
  }

  /**
   * Check GitOps for a specific container with its own repository
   */
  private async checkContainerGitOps(container: ContainerInfo, now: number): Promise<void> {
    try {
      const config = getConfig();

      // Get or create GitService for this container
      let gitServiceData = this.containerGitServices.get(container.id);

      if (!gitServiceData) {
        // Create new GitService for this container
        let clonePath = container.gitopsClonePath;
        if (!clonePath) {
          // Extract repo name from URL
          const repoName = this.extractRepoName(container.gitopsRepoUrl!);
          clonePath = `/tmp/${repoName}`;
        }

        const gitConfig = {
          enabled: true,
          repoUrl: container.gitopsRepoUrl!,
          branch: container.gitopsBranch || 'main',
          authType: container.gitopsAuthType || config.gitops?.authType || 'none' as any,
          token: container.gitopsToken || config.gitops?.token,
          sshKeyPath: container.gitopsSshKeyPath || config.gitops?.sshKeyPath,
          pollInterval: container.gitopsPollInterval || 60000,
          watchPaths: container.gitopsWatchPaths,
          commands: container.gitopsCommands,
          clonePath: clonePath,
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

      // Check if enough time has passed since last check
      const pollInterval = container.gitopsPollInterval || 60000;
      if (now - gitServiceData.lastCheck < pollInterval) {
        return;
      }

      // Check if this container's GitOps is already executing
      if (this.gitopsExecuting.has(container.id)) {
        logger.warn(`⚠️  GitOps (${container.name}): Previous execution still running, skipping this interval`);
        return;
      }

      gitServiceData.lastCheck = now;
      this.gitopsExecuting.add(container.id);

      try {
        // If no watch paths defined, run commands on every interval
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
          // Watch paths defined, only run on changes
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
      // If checking global GitOps, skip containers with their own repo
      if (isGlobal && container.gitopsRepoUrl) {
        return false;
      }

      // Check if GitOps is enabled for this container (explicitly set or globally enabled)
      const gitopsEnabled =
        container.gitopsEnabled !== undefined
          ? container.gitopsEnabled
          : config.gitops?.enabled || false;

      if (!gitopsEnabled) {
        return false;
      }

      // Get watch paths (container-specific or global)
      const watchPaths = container.gitopsWatchPaths || config.gitops?.watchPaths;

      // If no watch paths, container is affected by all changes
      if (!watchPaths || watchPaths.length === 0) {
        return true;
      }

      // Check if any changed file matches the watch paths
      return changes.changedFiles.some((file) => {
        return watchPaths.some((pattern) => {
          return minimatch(file, pattern, { dot: true });
        });
      });
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

    // Get commands (container-specific or global)
    const commands = container.gitopsCommands || config.gitops?.commands;

    if (!commands || commands.length === 0) {
      logger.info(`📦 GitOps: No commands configured for ${container.name}`);
      return;
    }

    // Determine the clone path (working directory for commands)
    let clonePath = config.gitops?.clonePath || '/tmp/gitops-repo';

    // If container has its own repo, use its clone path
    if (container.gitopsRepoUrl) {
      clonePath = container.gitopsClonePath || `/tmp/${this.extractRepoName(container.gitopsRepoUrl)}`;
    }

    logger.info(`📦 GitOps: Executing commands for ${container.name}...`);
    logger.info(`   📁 Working directory: ${clonePath}`);

    try {
      // Prepare environment variables
      const env = {
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

      // Execute each command
      for (const command of commands) {
        logger.info(`   💻 Executing: ${command}`);

        // Replace environment variables in command
        let processedCommand = command;
        Object.entries(env).forEach(([key, value]) => {
          processedCommand = processedCommand.replace(
            new RegExp(`\\$${key}`, 'g'),
            value || ''
          );
        });

        // Execute command using command executor with cwd set to clone path
        const { exec } = require('child_process');
        await new Promise<void>((resolve, reject) => {
          exec(processedCommand, { env, cwd: clonePath }, (error: any, stdout: any, stderr: any) => {
            if (error) {
              logger.error(`   ❌ Command failed: ${error.message}`);
              reject(error);
              return;
            }
            if (stdout) logger.info(`   📤 ${stdout.trim()}`);
            if (stderr) logger.warn(`   ⚠️  ${stderr.trim()}`);
            resolve();
          });
        });
      }

      logger.info(`   ✅ GitOps commands completed for ${container.name}`);
    } catch (error) {
      logger.error(`   ❌ GitOps commands failed for ${container.name}:`, error);
    }
  }

  /**
   * Extract repository name from Git URL
   */
  private extractRepoName(url: string): string {
    try {
      const match = url.match(/\/([^\/]+?)(\.git)?$/);
      if (match && match[1]) {
        return match[1];
      }
      return 'gitops-repo';
    } catch {
      return 'gitops-repo';
    }
  }

  async shutdown(): Promise<void> {
    logger.info('🛑 Shutting down monitor service...');
    // Cleanup if needed
  }
}

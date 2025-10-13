import { DockerClient } from './docker-client';
import { RegistryService } from './registry-service';
import { UpdateChecker } from './update-checker';
import { CommandExecutor } from '../utils/command-executor';
import { WebhookService } from './webhook-service';
import { logger } from '../utils/logger';
import { getConfig } from '../utils/config';
import { ImageUpdateInfo } from '../types';
import { ImageParser } from '../utils/image-parser';

export class MonitorService {
  private dockerClient: DockerClient;
  private registryService: RegistryService;
  private updateChecker: UpdateChecker;
  private commandExecutor: CommandExecutor;
  private webhookService?: WebhookService;

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
      return true;
    } catch (error) {
      logger.error('❌ Failed to initialize monitor service:', error);
      return false;
    }
  }

  async runCheck(): Promise<void> {
    try {
      const config = getConfig();
      logger.info('═══════════════════════════════════════════════════════════════');
      logger.info('🔍 Starting container update check...');
      logger.info('═══════════════════════════════════════════════════════════════');

      // Get all running containers (filtered by label if configured)
      const containers = await this.dockerClient.getRunningContainers();

      if (containers.length === 0) {
        logger.info('ℹ️  No containers to monitor');
        logger.info('═══════════════════════════════════════════════════════════════');
        return;
      }

      logger.info(`📦 Monitoring ${containers.length} container(s)`);
      logger.info('───────────────────────────────────────────────────────────────');

      // Check for updates
      const updates = await this.updateChecker.checkForUpdates(containers);

      logger.info('───────────────────────────────────────────────────────────────');
      if (updates.length === 0) {
        logger.info('✅ All containers are up to date!');
        logger.info('═══════════════════════════════════════════════════════════════');

        // Send webhook notification for check
        if (this.webhookService) {
          await this.webhookService.sendCheckNotification(containers.length, 0);
        }
        return;
      }

      logger.info(`🆕 Found ${updates.length} update(s) available`);
      logger.info('───────────────────────────────────────────────────────────────');

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

      // Determine which commands to use (container-specific or global)
      const updateCommands = container.updateCommands || config.updateCommands;

      // If custom commands are specified, execute them
      if (updateCommands && updateCommands.length > 0) {
        logger.info(`💻 Executing custom update commands for ${container.name}`);
        await this.commandExecutor.executeUpdateCommands(update, updateCommands);
        return;
      }

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

    try {
      // Pull the new image
      logger.info(`   ⬇️  Pulling: ${newImageName}`);
      await this.dockerClient.pullImage(newImageName);

      // Recreate the container with the new image
      logger.info(`   🔄 Recreating container...`);
      await this.dockerClient.recreateContainer(container.id, newImageName);

      logger.info(`   ✅ Successfully updated to ${update.availableImage.tag}`);

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

  async shutdown(): Promise<void> {
    logger.info('🛑 Shutting down monitor service...');
    // Cleanup if needed
  }
}

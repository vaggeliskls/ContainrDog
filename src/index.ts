import cron from 'node-cron';
import { MonitorService } from './services/monitor-service';
import { ECRAuthService } from './services/ecr-auth-service';
import { DockerClient } from './services/docker-client';
import { KubernetesClient } from './services/kubernetes-client';
import { IRuntimeClient } from './services/runtime-client';
import { logger } from './utils/logger';
import { getConfig } from './utils/config';
import { ContainerRuntime } from './types';

class ContainerUpdater {
  private monitorService: MonitorService;
  private ecrAuthService?: ECRAuthService;
  private cronJob?: cron.ScheduledTask;
  private intervalId?: NodeJS.Timeout;
  private config = getConfig();

  constructor() {
    const runtimeClient = this.createRuntimeClient();
    this.monitorService = new MonitorService(runtimeClient);

    if (this.config.ecr?.enabled) {
      this.ecrAuthService = new ECRAuthService();
    }
  }

  private createRuntimeClient(): IRuntimeClient {
    if (this.config.runtime === ContainerRuntime.KUBERNETES) {
      logger.info('☸️  Runtime: Kubernetes');
      return new KubernetesClient();
    }
    logger.info('🐳 Runtime: Docker/Podman');
    return new DockerClient();
  }

  async start(): Promise<void> {
    try {
      logger.info('🐾 Starting ContainrDog...');
      this.logConfiguration();

      if (this.ecrAuthService) {
        const ecrInitialized = await this.ecrAuthService.initialize();
        if (ecrInitialized) {
          this.monitorService.setECRCredentials(this.ecrAuthService.getCredentials());
        }
      }

      const initialized = await this.monitorService.initialize();
      if (!initialized) {
        logger.error('❌ Failed to initialize monitor service. Exiting...');
        process.exit(1);
      }

      logger.info('🔍 Running initial update check...');
      await this.monitorService.runCheck();

      this.setupScheduler();
      this.setupShutdownHandlers();

      logger.info('🐾 ContainrDog is running and watching your containers!');
    } catch (error) {
      logger.error('❌ Failed to start ContainrDog:', error);
      process.exit(1);
    }
  }

  private setupScheduler(): void {
    const intervalMs = this.config.interval;
    const intervalSeconds = Math.floor(intervalMs / 1000);

    if (intervalSeconds < 60) {
      logger.info(`⏰ Scheduling checks every ${intervalSeconds} second(s)`);
      this.intervalId = setInterval(async () => {
        await this.monitorService.runCheck();
      }, intervalMs);
    } else {
      const intervalMinutes = Math.floor(intervalMs / 60000);
      let cronExpression: string;

      if (intervalMinutes < 60) {
        cronExpression = `*/${intervalMinutes} * * * *`;
      } else {
        const intervalHours = Math.floor(intervalMinutes / 60);
        cronExpression = `0 */${intervalHours} * * *`;
      }

      logger.info(`⏰ Scheduling checks with cron expression: ${cronExpression}`);
      this.cronJob = cron.schedule(cronExpression, async () => {
        await this.monitorService.runCheck();
      });
    }
  }

  private logConfiguration(): void {
    logger.info('⚙️  Configuration:');
    const intervalMinutes = Math.floor(this.config.interval / 60000);
    const intervalSeconds = Math.floor(this.config.interval / 1000);
    if (intervalMinutes > 0) {
      logger.info(`  ⏱️  Check interval: ${intervalMinutes} minute(s)`);
    } else {
      logger.info(`  ⏱️  Check interval: ${intervalSeconds} second(s)`);
    }
    logger.info(`  🖥️  Runtime: ${this.config.runtime}`);
    if (this.config.runtime === ContainerRuntime.KUBERNETES) {
      const k8s = this.config.kubernetes;
      if (k8s?.allNamespaces) {
        logger.info(`  ☸️  Namespaces: all`);
      } else {
        logger.info(`  ☸️  Namespaces: ${k8s?.namespaces?.join(', ') || 'default'}`);
      }
    } else {
      logger.info(`  🔌 Socket path: ${this.config.socketPath}`);
    }
    logger.info(`  📋 Update policy: ${this.config.policy}`);
    logger.info(`  🏷️  Labeled only: ${this.config.labeledOnly}`);
    if (this.config.labeledOnly) {
      logger.info(`  🔖 Label filter: ${this.config.label}=true`);
    }
    if (this.config.registryCredentials && this.config.registryCredentials.length > 0) {
      logger.info(`  🔐 Registry credentials: ${this.config.registryCredentials.map((c) => c.registry).join(', ')}`);
    } else {
      logger.info(`  🔐 Registry credentials: none`);
    }
    if (this.config.ecr?.enabled) {
      logger.info(`  🔐 AWS ECR: enabled (region: ${this.config.ecr.region})`);
    }
    logger.info(`  💻 Update commands: ${this.config.updateCommands?.length || 0} configured`);
    logger.info(`  🏷️  Image labels: ${this.config.imageLabelKeys?.join(', ') || 'not set'} (fetch timeout: ${this.config.labelFetchTimeout / 1000}s)`);
    logger.info(`  📝 Log level: ${this.config.logLevel}`);
  }

  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      logger.info(`🛑 Received ${signal}, shutting down gracefully...`);

      if (this.cronJob) {
        this.cronJob.stop();
      }

      if (this.intervalId) {
        clearInterval(this.intervalId);
      }

      if (this.ecrAuthService) {
        this.ecrAuthService.shutdown();
      }

      await this.monitorService.shutdown();

      logger.info('🐾 ContainrDog stopped. Goodbye!');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('uncaughtException', (error) => {
      logger.error('❌ Uncaught exception:', error);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('❌ Unhandled rejection at:', promise, 'reason:', reason);
      process.exit(1);
    });
  }
}

const app = new ContainerUpdater();
app.start().catch((error) => {
  logger.error('❌ Fatal error:', error);
  process.exit(1);
});

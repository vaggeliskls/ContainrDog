import cron from 'node-cron';
import { MonitorService } from './services/monitor-service';
import { ECRAuthService } from './services/ecr-auth-service';
import { logger } from './utils/logger';
import { getConfig } from './utils/config';

class ContainerUpdater {
  private monitorService: MonitorService;
  private ecrAuthService?: ECRAuthService;
  private cronJob?: cron.ScheduledTask;
  private intervalId?: NodeJS.Timeout;
  private config = getConfig();

  constructor() {
    this.monitorService = new MonitorService();

    // Initialize ECR auth service if configured
    if (this.config.ecr?.enabled) {
      this.ecrAuthService = new ECRAuthService();
    }
  }

  async start(): Promise<void> {
    try {
      logger.info('🐾 Starting ContainrDog...');
      this.logConfiguration();

      // Initialize ECR authentication if enabled
      if (this.ecrAuthService) {
        const ecrInitialized = await this.ecrAuthService.initialize();
        if (ecrInitialized) {
          // Provide ECR credentials to the monitor service's registry service
          this.monitorService.setECRCredentials(this.ecrAuthService.getCredentials());
        }
      }

      // Initialize the monitor service
      const initialized = await this.monitorService.initialize();
      if (!initialized) {
        logger.error('❌ Failed to initialize monitor service. Exiting...');
        process.exit(1);
      }

      // Run initial check
      logger.info('🔍 Running initial update check...');
      await this.monitorService.runCheck();

      // Setup scheduled checks
      this.setupScheduler();

      // Handle graceful shutdown
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
      // Use setInterval for sub-minute intervals
      this.intervalId = setInterval(async () => {
        await this.monitorService.runCheck();
      }, intervalMs);
    } else {
      // Use cron for minute-based intervals (1 minute or more)
      const intervalMinutes = Math.floor(intervalMs / 60000);
      let cronExpression: string;

      if (intervalMinutes < 60) {
        // Run every N minutes
        cronExpression = `*/${intervalMinutes} * * * *`;
      } else {
        // Run every N hours
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
    logger.info(`  📋 Update policy: ${this.config.policy}`);
    if (this.config.policy === 'force' && this.config.matchTag) {
      logger.info(`  🏷️  Match tag: ${this.config.matchTag}`);
    }
    if (this.config.policy === 'glob' && this.config.globPattern) {
      logger.info(`  🔍 Glob pattern: ${this.config.globPattern}`);
    }
    logger.info(`  🏷️  Labeled only: ${this.config.labeledOnly}`);
    if (this.config.labeledOnly) {
      logger.info(`  🔖 Label filter: ${this.config.label}=true`);
    }
    logger.info(`  🔌 Socket path: ${this.config.socketPath}`);
    logger.info(
      `  🔐 Registry credentials: ${this.config.registryCredentials?.length || 0} configured`
    );
    if (this.config.ecr?.enabled) {
      logger.info(`  🔐 AWS ECR: enabled (region: ${this.config.ecr.region})`);
      const refreshHours = Math.floor(this.config.ecr.authRefreshInterval / 1000 / 60 / 60);
      logger.info(`  🔄 ECR token refresh: every ${refreshHours} hour(s)`);
    }
    logger.info(`  💻 Update commands: ${this.config.updateCommands?.length || 0} configured`);
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

    // Handle uncaught errors
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

// Start the application
const app = new ContainerUpdater();
app.start().catch((error) => {
  logger.error('❌ Fatal error:', error);
  process.exit(1);
});

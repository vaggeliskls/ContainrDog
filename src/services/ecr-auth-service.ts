import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import cron from 'node-cron';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getConfig } from '../utils/config';
import { logger } from '../utils/logger';
import { RegistryCredentials } from '../types';

const execAsync = promisify(exec);

export class ECRAuthService {
  private ecrClient?: ECRClient;
  private cronJob?: cron.ScheduledTask;
  private intervalId?: NodeJS.Timeout;
  private credentialsMap: Map<string, RegistryCredentials>;
  private config = getConfig();

  constructor() {
    this.credentialsMap = new Map();
  }

  async initialize(): Promise<boolean> {
    if (!this.config.ecr?.enabled) {
      logger.debug('ECR authentication is not enabled');
      return false;
    }

    const ecrConfig = this.config.ecr;

    logger.info('🔐 Initializing AWS ECR authentication...');

    try {
      // Initialize ECR client
      const clientConfig: { region: string; credentials?: { accessKeyId: string; secretAccessKey: string } } = {
        region: ecrConfig.region,
      };

      if (ecrConfig.accessKeyId && ecrConfig.secretAccessKey) {
        clientConfig.credentials = {
          accessKeyId: ecrConfig.accessKeyId,
          secretAccessKey: ecrConfig.secretAccessKey,
        };
        logger.info(`  📍 Region: ${ecrConfig.region} (using explicit credentials)`);
      } else {
        logger.info(`  📍 Region: ${ecrConfig.region} (using IAM role/instance profile)`);
      }

      this.ecrClient = new ECRClient(clientConfig);

      // Perform initial authentication
      await this.authenticateECR();

      // Setup periodic re-authentication
      this.setupAuthScheduler();

      logger.info('✅ AWS ECR authentication initialized successfully');
      return true;
    } catch (error) {
      logger.error('❌ Failed to initialize ECR authentication:', error);
      return false;
    }
  }

  private async dockerLogin(registry: string, username: string, password: string): Promise<void> {
    try {
      // Use docker login with password passed via stdin for security
      const command = `echo "${password}" | docker login --username ${username} --password-stdin ${registry}`;

      const { stdout, stderr } = await execAsync(command);

      if (stderr && !stderr.includes('Login Succeeded')) {
        logger.debug(`Docker login stderr: ${stderr}`);
      }

      logger.debug(`Docker login stdout: ${stdout}`);
    } catch (error) {
      throw new Error(`Failed to execute docker login: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async authenticateECR(): Promise<void> {
    if (!this.ecrClient || !this.config.ecr) {
      return;
    }

    try {
      logger.info('🔑 Obtaining ECR authorization tokens...');

      const command = new GetAuthorizationTokenCommand({});
      const response = await this.ecrClient.send(command);

      if (!response.authorizationData || response.authorizationData.length === 0) {
        logger.error('❌ No authorization data received from ECR');
        return;
      }

      // Process each authorization token
      for (const authData of response.authorizationData) {
        if (!authData.authorizationToken || !authData.proxyEndpoint) {
          continue;
        }

        // Decode the base64 token (format: AWS:password)
        const decodedToken = Buffer.from(authData.authorizationToken, 'base64').toString('utf-8');
        const [username, password] = decodedToken.split(':');

        // Extract registry hostname from proxy endpoint
        // Format: https://123456789012.dkr.ecr.us-east-1.amazonaws.com
        const registryUrl = authData.proxyEndpoint.replace('https://', '');

        // Store credentials
        this.credentialsMap.set(registryUrl, {
          registry: registryUrl,
          username,
          password,
        });

        // Perform docker login
        try {
          await this.dockerLogin(registryUrl, username, password);
          logger.info(`  ✅ Docker login successful for ECR registry: ${registryUrl}`);
        } catch (loginError) {
          logger.error(`  ❌ Docker login failed for ${registryUrl}: ${loginError instanceof Error ? loginError.message : String(loginError)}`);
          // Continue with other registries even if one fails
        }

        // Log token expiration
        if (authData.expiresAt) {
          const expiresIn = Math.floor((authData.expiresAt.getTime() - Date.now()) / 1000 / 60);
          logger.info(`  ⏱️  Token expires in ${expiresIn} minutes`);
        }
      }

      // If specific registries were configured, verify we have credentials for them
      if (this.config.ecr.registries.length > 0) {
        for (const registry of this.config.ecr.registries) {
          if (!this.credentialsMap.has(registry)) {
            logger.warn(`  ⚠️  No credentials obtained for configured registry: ${registry}`);
          }
        }
      }
    } catch (error) {
      logger.error('❌ Failed to authenticate with ECR:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  private setupAuthScheduler(): void {
    if (!this.config.ecr) {
      return;
    }

    const intervalMs = this.config.ecr.authRefreshInterval;
    const intervalSeconds = Math.floor(intervalMs / 1000);
    const intervalMinutes = Math.floor(intervalSeconds / 60);
    const intervalHours = Math.floor(intervalMinutes / 60);

    let intervalStr = '';
    if (intervalHours > 0) {
      intervalStr = `${intervalHours} hour(s)`;
    } else if (intervalMinutes > 0) {
      intervalStr = `${intervalMinutes} minute(s)`;
    } else {
      intervalStr = `${intervalSeconds} second(s)`;
    }

    logger.info(`⏰ Scheduling ECR token refresh every ${intervalStr}`);

    if (intervalMinutes < 60) {
      // Use setInterval for sub-hour intervals
      this.intervalId = setInterval(async () => {
        logger.info('🔄 Refreshing ECR authorization tokens...');
        try {
          await this.authenticateECR();
        } catch (error) {
          logger.error('❌ Failed to refresh ECR tokens:', error);
        }
      }, intervalMs);
    } else {
      // Use cron for hour-based intervals
      const cronExpression = `0 */${intervalHours} * * *`;
      logger.info(`  📅 Cron expression: ${cronExpression}`);

      this.cronJob = cron.schedule(cronExpression, async () => {
        logger.info('🔄 Refreshing ECR authorization tokens...');
        try {
          await this.authenticateECR();
        } catch (error) {
          logger.error('❌ Failed to refresh ECR tokens:', error);
        }
      });
    }
  }

  public getCredentials(): Map<string, RegistryCredentials> {
    return this.credentialsMap;
  }

  public shutdown(): void {
    logger.info('🛑 Shutting down ECR authentication service...');

    if (this.cronJob) {
      this.cronJob.stop();
    }

    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    this.credentialsMap.clear();
  }
}

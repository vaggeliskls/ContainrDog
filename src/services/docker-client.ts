import Docker from 'dockerode';
import { ContainerInfo, UpdatePolicy } from '../types';
import { logger } from '../utils/logger';
import { getConfig } from '../utils/config';

export class DockerClient {
  private docker: Docker;
  private config = getConfig();

  constructor() {
    this.docker = new Docker({ socketPath: this.config.socketPath });
    logger.info(`🐳 Initialized Docker client with socket: ${this.config.socketPath}`);
  }

  async getRunningContainers(): Promise<ContainerInfo[]> {
    try {
      const containers = await this.docker.listContainers({ all: false });
      const containerInfos: ContainerInfo[] = [];

      for (const containerData of containers) {
        const container = this.docker.getContainer(containerData.Id);
        const inspect = await container.inspect();

        const labels = inspect.Config.Labels || {};

        const containerInfo: ContainerInfo = {
          id: containerData.Id,
          name: containerData.Names[0]?.replace(/^\//, '') || 'unknown',
          image: containerData.Image,
          imageId: inspect.Image,
          labels,
          created: inspect.Created ? new Date(inspect.Created).getTime() : 0,
          policy: this.parsePolicyFromLabel(labels['containrdog.policy']),
          matchTag: labels['containrdog.match-tag'] === 'true',
          globPattern: labels['containrdog.glob-pattern'],
          autoUpdate: this.parseAutoUpdateLabel(labels['containrdog.auto-update']),
          updateCommands: this.parseUpdateCommandsLabel(labels['containrdog.update-commands']),
          preUpdateCommands: this.parseUpdateCommandsLabel(labels['containrdog.pre-update-commands']),
          postUpdateCommands: this.parseUpdateCommandsLabel(labels['containrdog.post-update-commands']),
        };

        // Always exclude containers with label explicitly set to 'false'
        const labelValue = containerInfo.labels[this.config.label];
        if (labelValue === 'false') {
          logger.debug(`Skipping container ${containerInfo.name} (label=${labelValue})`);
          continue;
        }

        // Filter by label if labeledOnly is enabled
        if (this.config.labeledOnly) {
          const hasLabel = labelValue === 'true';
          if (hasLabel) {
            containerInfos.push(containerInfo);
          }
        } else {
          containerInfos.push(containerInfo);
        }
      }

      logger.debug(`📦 Found ${containerInfos.length} containers to monitor`);
      return containerInfos;
    } catch (error) {
      logger.error('❌ Failed to get running containers:', error);
      throw error;
    }
  }

  async pullImage(imageName: string, auth?: { username: string; password: string }): Promise<void> {
    return new Promise((resolve, reject) => {
      logger.info(`⬇️  Pulling image: ${imageName}`);

      const options: any = {};
      if (auth) {
        options.authconfig = {
          username: auth.username,
          password: auth.password,
        };
      }

      this.docker.pull(imageName, options, (err, stream) => {
        if (err) {
          logger.error(`❌ Failed to pull image ${imageName}:`, err);
          reject(err);
          return;
        }

        if (!stream) {
          reject(new Error('No stream returned from pull operation'));
          return;
        }

        this.docker.modem.followProgress(
          stream,
          (err, output) => {
            if (err) {
              logger.error(`❌ Error during image pull ${imageName}:`, err);
              reject(err);
            } else {
              logger.info(`✅ Successfully pulled image: ${imageName}`);
              resolve();
            }
          },
          (event) => {
            if (event.status) {
              logger.debug(`📥 Pull progress: ${event.status} ${event.progress || ''}`);
            }
          }
        );
      });
    });
  }

  async getImageDigest(imageName: string): Promise<string | undefined> {
    try {
      const image = this.docker.getImage(imageName);
      const inspect = await image.inspect();

      // Try to get the digest from RepoDigests
      if (inspect.RepoDigests && inspect.RepoDigests.length > 0) {
        // Extract digest from format: registry/repo@sha256:...
        const digestPart = inspect.RepoDigests[0].split('@')[1];
        return digestPart;
      }

      // Fallback to image ID
      return inspect.Id;
    } catch (error) {
      logger.error(`❌ Failed to get image digest for ${imageName}:`, error);
      return undefined;
    }
  }

  async restartContainer(containerId: string): Promise<void> {
    try {
      logger.info(`🔄 Restarting container: ${containerId}`);
      const container = this.docker.getContainer(containerId);
      await container.restart();
      logger.info(`✅ Successfully restarted container: ${containerId}`);
    } catch (error) {
      logger.error(`❌ Failed to restart container ${containerId}:`, error);
      throw error;
    }
  }

  async recreateContainer(containerId: string, newImageName: string): Promise<void> {
    try {
      logger.info(`🔄 Recreating container: ${containerId} with image: ${newImageName}`);

      const container = this.docker.getContainer(containerId);
      const inspect = await container.inspect();

      // Stop and remove the old container
      await container.stop();
      await container.remove();

      // Create new container with the same configuration but new image
      const createOptions: Docker.ContainerCreateOptions = {
        name: inspect.Name.replace(/^\//, ''),
        Image: newImageName,
        Env: inspect.Config.Env,
        Cmd: inspect.Config.Cmd,
        Entrypoint: inspect.Config.Entrypoint,
        Labels: inspect.Config.Labels,
        ExposedPorts: inspect.Config.ExposedPorts,
        HostConfig: inspect.HostConfig,
        NetworkingConfig: {
          EndpointsConfig: inspect.NetworkSettings.Networks,
        },
      };

      const newContainer = await this.docker.createContainer(createOptions);
      await newContainer.start();

      logger.info(`✅ Successfully recreated container: ${containerId}`);
    } catch (error) {
      logger.error(`❌ Failed to recreate container ${containerId}:`, error);
      throw error;
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch (error) {
      logger.error('❌ Failed to ping Docker daemon:', error);
      return false;
    }
  }

  private parsePolicyFromLabel(policyLabel?: string): UpdatePolicy | undefined {
    if (!policyLabel) return undefined;

    const normalized = policyLabel.toLowerCase();
    switch (normalized) {
      case 'all':
        return UpdatePolicy.ALL;
      case 'major':
        return UpdatePolicy.MAJOR;
      case 'minor':
        return UpdatePolicy.MINOR;
      case 'patch':
        return UpdatePolicy.PATCH;
      case 'force':
        return UpdatePolicy.FORCE;
      case 'glob':
        return UpdatePolicy.GLOB;
      default:
        logger.warn(`⚠️  Invalid policy label '${policyLabel}' - will use global default`);
        return undefined;
    }
  }

  private parseAutoUpdateLabel(autoUpdateLabel?: string): boolean | undefined {
    if (!autoUpdateLabel) return undefined;
    return autoUpdateLabel === 'true';
  }

  private parseUpdateCommandsLabel(commandsLabel?: string): string[] | undefined {
    if (!commandsLabel) return undefined;

    try {
      const parsed = JSON.parse(commandsLabel);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      // If single command string, wrap in array
      return [parsed];
    } catch (error) {
      logger.warn(`⚠️  Invalid update-commands label format - expected JSON array`);
      return undefined;
    }
  }
}

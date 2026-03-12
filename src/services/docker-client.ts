import Docker from 'dockerode';
import { ContainerInfo, GitAuthType } from '../types';
import { IRuntimeClient } from './runtime-client';
import { logger } from '../utils/logger';
import { getConfig } from '../utils/config';
import {
  parsePolicyFromLabel,
  parseAutoUpdateLabel,
  parseJSONLabel,
  parseIntervalLabel,
  parseGitAuthTypeLabel,
} from '../utils/label-parser';

export class DockerClient implements IRuntimeClient {
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
          policy: parsePolicyFromLabel(labels['containrdog.policy']),
          matchTag: labels['containrdog.match-tag'] === 'true',
          globPattern: labels['containrdog.glob-pattern'],
          autoUpdate: parseAutoUpdateLabel(labels['containrdog.auto-update']),
          updateCommands: parseJSONLabel(labels['containrdog.update-commands']),
          preUpdateCommands: parseJSONLabel(labels['containrdog.pre-update-commands']),
          postUpdateCommands: parseJSONLabel(labels['containrdog.post-update-commands']),
          gitopsEnabled: labels['containrdog.gitops-enabled'] === 'true' ? true : undefined,
          gitopsRepoUrl: labels['containrdog.gitops-repo-url'],
          gitopsBranch: labels['containrdog.gitops-branch'],
          gitopsAuthType: parseGitAuthTypeLabel(labels['containrdog.gitops-auth-type']),
          gitopsToken: labels['containrdog.gitops-token'],
          gitopsSshKeyPath: labels['containrdog.gitops-ssh-key-path'],
          gitopsPollInterval: parseIntervalLabel(labels['containrdog.gitops-poll-interval']),
          gitopsWatchPaths: parseJSONLabel(labels['containrdog.gitops-watch-paths']),
          gitopsCommands: parseJSONLabel(labels['containrdog.gitops-commands']),
          gitopsClonePath: labels['containrdog.gitops-clone-path'],
          gitopsQuietMode: labels['containrdog.gitops-quiet-mode']
            ? labels['containrdog.gitops-quiet-mode'] === 'true'
            : undefined,
        };

        // Always exclude containers with label explicitly set to 'false'
        const labelValue = containerInfo.labels[this.config.label];
        if (labelValue === 'false') {
          logger.debug(`Skipping container ${containerInfo.name} (label=${labelValue})`);
          continue;
        }

        // Filter by label if labeledOnly is enabled
        if (this.config.labeledOnly) {
          if (labelValue === 'true') {
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

  async getImageDigest(imageName: string): Promise<string | undefined> {
    try {
      const image = this.docker.getImage(imageName);
      const inspect = await image.inspect();

      if (inspect.RepoDigests && inspect.RepoDigests.length > 0) {
        return inspect.RepoDigests[0].split('@')[1];
      }

      return inspect.Id;
    } catch (error) {
      logger.error(`❌ Failed to get image digest for ${imageName}:`, error);
      return undefined;
    }
  }

  async updateContainerImage(containerId: string, newImageName: string): Promise<void> {
    logger.info(`   ⬇️  Pulling: ${newImageName}`);
    await this.pullImage(newImageName);

    logger.info(`   🔄 Recreating container...`);
    await this.recreateContainer(containerId, newImageName);
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

  private async pullImage(imageName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.docker.pull(imageName, {}, (err, stream) => {
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
          (err, _output) => {
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

  private async recreateContainer(containerId: string, newImageName: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      const inspect = await container.inspect();

      await container.stop();
      await container.remove();

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
}

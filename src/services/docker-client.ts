import Docker from 'dockerode';
import { ComponentHealth, ContainerInfo } from '../types';
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
        const { health, healthReason } = this.deriveHealth(inspect);

        const containerInfo: ContainerInfo = {
          id: containerData.Id,
          name: containerData.Names[0]?.replace(/^\//, '') || 'unknown',
          image: containerData.Image,
          imageId: inspect.Image,
          labels,
          created: inspect.Created ? new Date(inspect.Created).getTime() : 0,
          health,
          healthReason,
          policy: parsePolicyFromLabel(labels['containrdog.policy']),
          globPattern: labels['containrdog.glob-pattern'],
          autoUpdate: parseAutoUpdateLabel(labels['containrdog.auto-update']),
          imageLabelKeys: parseJSONLabel(labels['containrdog.image-label']),
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

    // Capture the previous image and the full create spec BEFORE we destroy the
    // old container. We record the image by ID (not tag): for digest-only
    // updates the tag now resolves to the freshly-pulled image, so the image ID
    // is the only reliable handle for rolling back to the prior version.
    const oldContainer = this.docker.getContainer(containerId);
    const inspect = await oldContainer.inspect();
    const previousImageId = inspect.Image;
    const previousImageName = inspect.Config.Image;
    const createOptions = this.buildCreateOptions(inspect);

    logger.info(`   🔄 Recreating container...`);
    const newContainer = await this.replaceContainer(oldContainer, {
      ...createOptions,
      Image: newImageName,
    });
    logger.info(`✅ Successfully recreated container: ${newContainer.id}`);

    const cfg = getConfig().update;
    if (!cfg.healthCheckEnabled) {
      return;
    }

    logger.info(`   🩺 Verifying health (up to ${Math.round(cfg.healthCheckTimeout / 1000)}s)...`);
    const healthy = await this.waitForHealthy(
      newContainer.id,
      cfg.healthCheckTimeout,
      cfg.healthCheckInterval
    );

    if (healthy) {
      logger.info(`   ✅ Container healthy after update to ${newImageName}`);
      return;
    }

    logger.error(`   ❌ Container did not become healthy after update to ${newImageName}`);

    if (!cfg.rollbackOnFailure) {
      throw new Error(`Update to ${newImageName} failed health check`);
    }

    logger.warn(`   ↩️  Rolling back to ${previousImageName}...`);
    try {
      await this.replaceContainer(this.docker.getContainer(newContainer.id), {
        ...createOptions,
        Image: previousImageId,
      });
    } catch (rollbackError) {
      const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      logger.error(`   ❌ Rollback failed: ${detail}`);
      throw new Error(
        `Update to ${newImageName} failed health check AND rollback to ${previousImageName} failed: ${detail}`
      );
    }

    logger.info(`   ✅ Rolled back to ${previousImageName}`);
    throw new Error(
      `Update to ${newImageName} failed health check; rolled back to ${previousImageName}`
    );
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
          (err, _) => {
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

  /**
   * Build the create options for a replacement container from the inspect of an
   * existing one, preserving env, command, labels, ports, host config and
   * networking. Caller overrides `Image` with the target (or previous) image.
   */
  private buildCreateOptions(inspect: Docker.ContainerInspectInfo): Docker.ContainerCreateOptions {
    return {
      name: inspect.Name.replace(/^\//, ''),
      Image: inspect.Config.Image,
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
  }

  /**
   * Stop+remove an existing container and create+start a replacement from the
   * given options. Tolerates an already-stopped container (the case during a
   * rollback of a crash-looping container).
   */
  private async replaceContainer(
    oldContainer: Docker.Container,
    createOptions: Docker.ContainerCreateOptions
  ): Promise<Docker.Container> {
    try {
      await oldContainer.stop();
    } catch (error) {
      // 304 (already stopped) is expected when rolling back a crashed container.
      logger.debug(`Container already stopped or stop failed (continuing): ${error}`);
    }
    await oldContainer.remove({ force: true });

    const newContainer = await this.docker.createContainer(createOptions);
    await newContainer.start();
    return newContainer;
  }

  /**
   * Poll a container's state until it is verifiably healthy or the timeout
   * elapses. If the image defines a Docker HEALTHCHECK we honour its status;
   * otherwise we treat an exit, a restart loop, or any restart as a failure and
   * require the container to stay Running for the whole window.
   */
  private async waitForHealthy(
    containerId: string,
    timeoutMs: number,
    intervalMs: number
  ): Promise<boolean> {
    const container = this.docker.getContainer(containerId);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      let info: Docker.ContainerInspectInfo;
      try {
        info = await container.inspect();
      } catch (error) {
        // Container vanished (e.g. removed after exhausting its restart policy).
        logger.debug(`Health check: inspect failed, treating as unhealthy: ${error}`);
        return false;
      }

      const verdict = this.evaluateHealth(info);
      if (verdict !== 'pending') {
        return verdict === 'healthy';
      }

      await this.sleep(intervalMs);
    }

    // Timed out. A container with a HEALTHCHECK still 'starting' counts as a
    // failure; a healthcheck-less container that stayed up the whole window is
    // considered healthy.
    try {
      const verdict = this.evaluateHealth(await container.inspect());
      return verdict === 'healthy' || verdict === 'pending-no-healthcheck';
    } catch {
      return false;
    }
  }

  /**
   * Derive the dashboard health of a running container from its inspect state.
   * Honours the image HEALTHCHECK when present; otherwise infers from the
   * run/restart state. (Distinct from evaluateHealth(), which gates updates.)
   */
  private deriveHealth(
    info: Docker.ContainerInspectInfo
  ): { health: ComponentHealth; healthReason?: string } {
    const state = info.State;

    if (state.Health) {
      switch (state.Health.Status) {
        case 'healthy':
          return { health: ComponentHealth.HEALTHY };
        case 'unhealthy':
          return { health: ComponentHealth.DEGRADED, healthReason: 'healthcheck failing' };
        case 'starting':
          return { health: ComponentHealth.PROGRESSING, healthReason: 'healthcheck starting' };
      }
    }

    if (state.Restarting) {
      return { health: ComponentHealth.DEGRADED, healthReason: 'restarting' };
    }
    if (state.Status === 'exited' || state.Status === 'dead') {
      return { health: ComponentHealth.DEGRADED, healthReason: `container ${state.Status}` };
    }
    if ((info.RestartCount ?? 0) > 3) {
      return { health: ComponentHealth.DEGRADED, healthReason: `restarted ${info.RestartCount}x` };
    }
    if (state.Running) {
      return { health: ComponentHealth.HEALTHY };
    }
    return { health: ComponentHealth.UNKNOWN };
  }

  private evaluateHealth(
    info: Docker.ContainerInspectInfo
  ): 'healthy' | 'unhealthy' | 'pending' | 'pending-no-healthcheck' {
    const state = info.State;

    if (state.Health) {
      if (state.Health.Status === 'healthy') return 'healthy';
      if (state.Health.Status === 'unhealthy') return 'unhealthy';
      return 'pending'; // 'starting'
    }

    // No HEALTHCHECK defined: a crash, restart loop, or any restart is failure.
    if (state.Status === 'exited' || state.Status === 'dead') return 'unhealthy';
    if (state.Restarting) return 'unhealthy';
    if ((info.RestartCount ?? 0) > 0) return 'unhealthy';
    if (!state.Running) return 'unhealthy';

    // Running and stable so far — keep observing until the window elapses.
    return 'pending-no-healthcheck';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

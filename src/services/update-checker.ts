import semver from 'semver';
import { ContainerInfo, ImageInfo, ImageUpdateInfo, UpdateType, UpdatePolicy } from '../types';
import { logger } from '../utils/logger';
import { ImageParser } from '../utils/image-parser';
import { RegistryService } from './registry-service';
import { DockerClient } from './docker-client';
import { getConfig } from '../utils/config';

export class UpdateChecker {
  private registryService: RegistryService;
  private dockerClient: DockerClient;

  constructor(registryService: RegistryService, dockerClient: DockerClient) {
    this.registryService = registryService;
    this.dockerClient = dockerClient;
  }

  async checkForUpdates(containers: ContainerInfo[]): Promise<ImageUpdateInfo[]> {
    const updates: ImageUpdateInfo[] = [];

    for (const container of containers) {
      try {
        const update = await this.checkContainerUpdate(container);
        if (update) {
          updates.push(update);
        }
      } catch (error) {
        logger.error(`❌ Failed to check updates for ${container.name}: ${error}`);
      }
    }

    return updates;
  }

  private async checkContainerUpdate(
    container: ContainerInfo
  ): Promise<ImageUpdateInfo | null> {
    const config = getConfig();
    const currentImage = ImageParser.parse(container.image);

    // Use container-specific policy or fall back to global policy
    const policy = container.policy || config.policy;
    const matchTag = container.matchTag !== undefined ? container.matchTag : config.matchTag;
    const globPattern = container.globPattern || config.globPattern;

    logger.debug(`Checking updates for ${container.name} (${container.image}) with policy: ${policy}`);

    // Force policy: always check digest, even for non-semver tags
    if (policy === UpdatePolicy.FORCE) {
      return await this.checkDigestUpdate(container, currentImage);
    }

    // Determine update strategy based on tag format
    if (ImageParser.isSemanticVersion(currentImage.tag)) {
      return await this.checkSemanticVersionUpdate(container, currentImage, policy, globPattern);
    } else {
      // Non-semver tags default to digest checking
      return await this.checkDigestUpdate(container, currentImage);
    }
  }

  private async checkSemanticVersionUpdate(
    container: ContainerInfo,
    currentImage: ImageInfo,
    policy: UpdatePolicy,
    globPattern?: string
  ): Promise<ImageUpdateInfo | null> {
    try {
      // Get all tags from registry
      const tags = await this.registryService.listTags(currentImage);

      if (tags.length === 0) {
        logger.debug(`No tags found for ${currentImage.repository}`);
        return null;
      }

      // Filter semantic version tags and coerce to valid semver
      const semverTags = tags
        .filter((tag) => ImageParser.isSemanticVersion(tag))
        .map((tag) => {
          const cleaned = tag.replace(/^v/, '');
          const coerced = semver.coerce(cleaned);
          return coerced ? { original: tag, version: coerced.version } : null;
        })
        .filter((item): item is { original: string; version: string } => item !== null);

      if (semverTags.length === 0) {
        logger.debug(`No semantic version tags found for ${currentImage.repository}`);
        return null;
      }

      // Get current version
      const currentTagCleaned = currentImage.tag.replace(/^v/, '');
      const currentVersion = semver.coerce(currentTagCleaned);

      if (!currentVersion) {
        logger.debug(`Could not parse current version: ${currentImage.tag}`);
        return null;
      }

      // Find the best matching update based on policy
      const newerVersion = this.findBestUpdate(currentVersion.version, semverTags, policy, globPattern);

      if (newerVersion) {
        logger.info(
          `🆕 Found newer version for ${container.name}: ${currentImage.tag} -> ${newerVersion.original}`
        );

        const availableImage: ImageInfo = {
          ...currentImage,
          tag: newerVersion.original,
        };

        return {
          container,
          currentImage,
          availableImage,
          updateType: UpdateType.SEMANTIC_VERSION,
        };
      }

      return null;
    } catch (error) {
      logger.error(`❌ Failed to check semantic version update for ${container.name}:`, error);
      return null;
    }
  }

  private findBestUpdate(
    currentVersion: string,
    availableTags: Array<{ original: string; version: string }>,
    policy: UpdatePolicy,
    globPattern?: string
  ): { original: string; version: string } | null {
    const current = semver.parse(currentVersion);
    if (!current) return null;

    // Sort tags by version (descending)
    const sorted = availableTags.sort((a, b) => semver.compare(b.version, a.version));

    for (const tag of sorted) {
      const candidate = semver.parse(tag.version);
      if (!candidate) continue;

      // Skip if not newer
      if (!semver.gt(candidate.version, current.version)) continue;

      // Check policy
      switch (policy) {
        case UpdatePolicy.ALL:
          // Accept any version bump, including prereleases
          return tag;

        case UpdatePolicy.MAJOR:
          // Accept major, minor, and patch updates
          // No restrictions
          return tag;

        case UpdatePolicy.MINOR:
          // Accept only minor and patch updates (block major changes)
          if (candidate.major === current.major) {
            return tag;
          }
          break;

        case UpdatePolicy.PATCH:
          // Accept only patch updates (block major and minor changes)
          if (candidate.major === current.major && candidate.minor === current.minor) {
            return tag;
          }
          break;

        case UpdatePolicy.GLOB:
          // Check glob pattern
          if (globPattern && this.matchesGlob(tag.original, globPattern)) {
            return tag;
          }
          break;
      }
    }

    return null;
  }

  private matchesGlob(tag: string, pattern: string): boolean {
    // Convert glob pattern to regex
    // Simple implementation: * matches any characters, ? matches single character
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(tag);
  }

  private async checkDigestUpdate(
    container: ContainerInfo,
    currentImage: ImageInfo
  ): Promise<ImageUpdateInfo | null> {
    try {
      const config = getConfig();

      // For force policy with matchTag, only check the current tag
      // Otherwise, we'd need to check all tags (not implemented here for simplicity)

      // Get current local image digest
      const localDigest = await this.dockerClient.getImageDigest(container.image);

      // Get remote image manifest for the current tag
      const remoteManifest = await this.registryService.getImageManifest(currentImage);

      if (!remoteManifest || !localDigest) {
        logger.debug(`Could not get digests for ${container.image}`);
        return null;
      }

      // Compare digests
      if (remoteManifest.digest !== localDigest && !localDigest.includes(remoteManifest.digest)) {
        logger.info(
          `🔄 Found digest change for ${container.name}: ${localDigest.substring(0, 16)}... -> ${remoteManifest.digest.substring(0, 16)}...`
        );

        const availableImage: ImageInfo = {
          ...currentImage,
          digest: remoteManifest.digest,
        };

        return {
          container,
          currentImage,
          availableImage,
          updateType: UpdateType.DIGEST_CHANGE,
        };
      }

      return null;
    } catch (error) {
      logger.error(`❌ Failed to check digest update for ${container.name}:`, error);
      return null;
    }
  }
}

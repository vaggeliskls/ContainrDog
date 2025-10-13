import { ImageInfo } from '../types';

export class ImageParser {
  /**
   * Parse a Docker image string into its components
   * Supports formats:
   * - nginx:latest
   * - nginx:1.21.0
   * - myregistry.com/nginx:latest
   * - docker.io/library/nginx:latest
   * - ghcr.io/owner/repo:tag
   */
  static parse(imageString: string): ImageInfo {
    let registry = 'docker.io';
    let repository = imageString;
    let tag = 'latest';

    // Extract tag
    const tagSeparatorIndex = imageString.lastIndexOf(':');
    if (tagSeparatorIndex !== -1) {
      // Check if it's not a port (e.g., localhost:5000)
      const afterColon = imageString.substring(tagSeparatorIndex + 1);
      if (!afterColon.includes('/')) {
        tag = afterColon;
        repository = imageString.substring(0, tagSeparatorIndex);
      }
    }

    // Extract registry
    const parts = repository.split('/');
    if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':'))) {
      registry = parts[0];
      repository = parts.slice(1).join('/');
    } else if (parts.length === 1) {
      // Official Docker Hub images (e.g., nginx)
      repository = `library/${parts[0]}`;
    }

    return {
      registry,
      repository,
      tag,
    };
  }

  /**
   * Reconstruct the full image string from ImageInfo
   */
  static toString(imageInfo: ImageInfo): string {
    const registryPart = imageInfo.registry !== 'docker.io' ? `${imageInfo.registry}/` : '';
    return `${registryPart}${imageInfo.repository}:${imageInfo.tag}`;
  }

  /**
   * Check if tag is a semantic version
   */
  static isSemanticVersion(tag: string): boolean {
    // Simple semantic version check (e.g., 1.2.3, v1.2.3, 1.2.3-alpha)
    const semverPattern = /^v?\d+\.\d+(\.\d+)?(-[\w.]+)?$/;
    return semverPattern.test(tag);
  }
}

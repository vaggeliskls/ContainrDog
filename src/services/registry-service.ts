import axios, { AxiosInstance } from 'axios';
import { ImageInfo, RegistryCredentials, RegistryManifest } from '../types';
import { logger } from '../utils/logger';
import { getConfig } from '../utils/config';

export class RegistryService {
  private axiosInstance: AxiosInstance;
  private credentials: Map<string, RegistryCredentials>;
  private ecrCredentials?: Map<string, RegistryCredentials>;

  constructor() {
    this.axiosInstance = axios.create({
      timeout: 30000,
      headers: {
        Accept: 'application/vnd.docker.distribution.manifest.v2+json',
      },
    });

    // Load credentials
    this.credentials = new Map();
    const config = getConfig();
    if (config.registryCredentials) {
      config.registryCredentials.forEach((cred) => {
        this.credentials.set(cred.registry, cred);
      });
    }
  }

  public setECRCredentials(ecrCredentials: Map<string, RegistryCredentials>): void {
    this.ecrCredentials = ecrCredentials;
    logger.debug(`ECR credentials updated for ${ecrCredentials.size} registries`);
  }

  private getCredentials(registry: string): RegistryCredentials | undefined {
    // Check if this is an ECR registry and we have ECR credentials
    if (this.ecrCredentials && this.isECRRegistry(registry)) {
      const ecrCred = this.ecrCredentials.get(registry);
      if (ecrCred) {
        logger.debug(`Using ECR credentials for ${registry}`);
        return ecrCred;
      }
    }

    // Fall back to static credentials
    return this.credentials.get(registry);
  }

  private isECRRegistry(registry: string): boolean {
    // ECR registries follow the pattern: {account-id}.dkr.ecr.{region}.amazonaws.com
    return /^\d+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$/.test(registry);
  }

  private async getAuthToken(registry: string, repository: string): Promise<string | undefined> {
    const creds = this.getCredentials(registry);

    try {
      let authUrl: string;
      let authHeader: string | undefined;

      if (this.isECRRegistry(registry)) {
        // AWS ECR - uses Basic auth directly (no separate token endpoint)
        // The ECR authorization token IS the password for Basic auth
        if (creds) {
          logger.debug(`Using ECR Basic auth for ${registry}`);
          // ECR tokens are already in the format needed - just use password as bearer token
          return creds.password;
        } else {
          logger.warn(`⚠️  No ECR credentials available for ${registry}`);
          return undefined;
        }
      } else if (registry === 'docker.io') {
        // Docker Hub
        authUrl = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`;
        if (creds) {
          const basicAuth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
          authHeader = `Basic ${basicAuth}`;
        }
      } else if (registry === 'ghcr.io') {
        // GitHub Container Registry
        authUrl = `https://ghcr.io/token?scope=repository:${repository}:pull`;
        if (creds) {
          authHeader = `Bearer ${creds.password}`; // GitHub uses PAT as password
        }
      } else {
        // Generic registry - try to get auth endpoint
        // For private registries, this may need to be customized
        authUrl = `https://${registry}/v2/token?scope=repository:${repository}:pull`;
        if (creds) {
          const basicAuth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
          authHeader = `Basic ${basicAuth}`;
        }
      }

      const headers: Record<string, string> = {};
      if (authHeader) {
        headers.Authorization = authHeader;
      }

      const response = await this.axiosInstance.get(authUrl, { headers });
      return response.data.token || response.data.access_token;
    } catch (error) {
      logger.warn(`⚠️  Failed to get auth token for ${registry}/${repository}:`, error);
      return undefined;
    }
  }

  async getImageManifest(imageInfo: ImageInfo): Promise<RegistryManifest | null> {
    try {
      const { registry, repository, tag } = imageInfo;
      const token = await this.getAuthToken(registry, repository);

      let registryUrl: string;
      if (registry === 'docker.io') {
        registryUrl = 'https://registry-1.docker.io';
      } else {
        registryUrl = `https://${registry}`;
      }

      const manifestUrl = `${registryUrl}/v2/${repository}/manifests/${tag}`;

      const headers: Record<string, string> = {
        Accept:
          'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json',
      };

      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await this.axiosInstance.get(manifestUrl, { headers });

      // Get digest from response header
      const digest = response.headers['docker-content-digest'];

      return {
        digest: digest || 'unknown',
        tag,
        created: response.data.config?.created,
      };
    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.warn(`⚠️  Image not found in registry: ${imageInfo.repository}:${imageInfo.tag}`);
      } else {
        logger.error(
          `❌ Failed to get manifest for ${imageInfo.repository}:${imageInfo.tag}:`,
          error.message
        );
      }
      return null;
    }
  }

  async listTags(imageInfo: ImageInfo): Promise<string[]> {
    try {
      const { registry, repository } = imageInfo;
      const token = await this.getAuthToken(registry, repository);

      let registryUrl: string;
      if (registry === 'docker.io') {
        registryUrl = 'https://registry-1.docker.io';
      } else {
        registryUrl = `https://${registry}`;
      }

      const tagsUrl = `${registryUrl}/v2/${repository}/tags/list`;

      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await this.axiosInstance.get(tagsUrl, { headers });
      return response.data.tags || [];
    } catch (error) {
      logger.error(`❌ Failed to list tags for ${imageInfo.repository}:`, error);
      return [];
    }
  }
}

import { ContainerInfo } from '../types';

export interface IRuntimeClient {
  ping(): Promise<boolean>;
  getRunningContainers(): Promise<ContainerInfo[]>;
  getImageDigest(imageName: string): Promise<string | undefined>;
  updateContainerImage(containerId: string, newImageName: string): Promise<void>;
}

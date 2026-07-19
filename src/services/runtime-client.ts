import { ContainerInfo } from '../types';

export interface IRuntimeClient {
  ping(): Promise<boolean>;
  getRunningContainers(): Promise<ContainerInfo[]>;
  getImageDigest(imageName: string): Promise<string | undefined>;
  // knownPreviousImage: rollback target captured at detection time. Callers
  // should pass it whenever pre-update commands may mutate the workload before
  // the update runs — reading the live spec at update time is too late then.
  updateContainerImage(containerId: string, newImageName: string, knownPreviousImage?: string): Promise<void>;
}

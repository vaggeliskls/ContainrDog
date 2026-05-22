import { ContainerInfo } from '../types';
import { getConfig } from '../utils/config';

export interface GitopsStatus {
  scope: 'global' | 'per-container' | 'none';
  repoUrl?: string;
  branch?: string;
  watchPaths?: string[];
  pollIntervalMs?: number;
  hasPerContainerCommands: boolean;
}

export interface ContainerStatus {
  id: string;
  name: string;
  image: string;
  namespace?: string;
  workloadKind?: string;
  workloadName?: string;
  containerName?: string;
  autoUpdate: boolean;
  policy: string;
  imageLabelKeys?: string[];
  gitops: GitopsStatus;
}

export interface UpdateEvent {
  timestamp: string;
  containerName: string;
  fromTag: string;
  toTag: string;
  updateType: string;
  autoUpdated: boolean;
  success: boolean;
  labelValues?: Record<string, string>;
  error?: string;
}

export interface StatusSnapshot {
  startedAt: string;
  lastCheckAt: string | null;
  checkInProgress: boolean;
  containers: ContainerStatus[];
  recentUpdates: UpdateEvent[];
}

const MAX_UPDATES = 100;

export class StatusStore {
  private static _instance: StatusStore;

  private startedAt = new Date().toISOString();
  private lastCheckAt: string | null = null;
  private checkInProgress = false;
  private containers: ContainerStatus[] = [];
  private recentUpdates: UpdateEvent[] = [];

  private constructor() {}

  static get instance(): StatusStore {
    if (!StatusStore._instance) {
      StatusStore._instance = new StatusStore();
    }
    return StatusStore._instance;
  }

  setCheckInProgress(v: boolean): void {
    this.checkInProgress = v;
    if (!v) {
      this.lastCheckAt = new Date().toISOString();
    }
  }

  setContainers(containers: ContainerInfo[]): void {
    const config = getConfig();
    this.containers = containers.map((c) => {
      const globallyEnabled = config.gitops?.enabled ?? false;
      const enabled = c.gitopsEnabled !== undefined ? c.gitopsEnabled : globallyEnabled;

      let gitops: GitopsStatus;
      if (!enabled) {
        gitops = { scope: 'none', hasPerContainerCommands: false };
      } else if (c.gitopsRepoUrl) {
        gitops = {
          scope: 'per-container',
          repoUrl: c.gitopsRepoUrl,
          branch: c.gitopsBranch ?? config.gitops?.branch ?? 'main',
          watchPaths: c.gitopsWatchPaths ?? config.gitops?.watchPaths,
          pollIntervalMs: c.gitopsPollInterval ?? config.gitops?.pollInterval,
          hasPerContainerCommands: !!(c.gitopsCommands?.length),
        };
      } else {
        gitops = {
          scope: 'global',
          repoUrl: config.gitops?.repoUrl,
          branch: config.gitops?.branch ?? 'main',
          watchPaths: config.gitops?.watchPaths,
          pollIntervalMs: config.gitops?.pollInterval,
          hasPerContainerCommands: !!(c.gitopsCommands?.length),
        };
      }

      return {
        id: c.id,
        name: c.name,
        image: c.image,
        namespace: c.namespace,
        workloadKind: c.workloadKind,
        workloadName: c.workloadName,
        containerName: c.containerName,
        autoUpdate: c.autoUpdate !== undefined ? c.autoUpdate : config.autoUpdate,
        policy: c.policy ?? config.policy,
        imageLabelKeys: c.imageLabelKeys,
        gitops,
      };
    });
  }

  recordUpdate(event: UpdateEvent): void {
    this.recentUpdates.unshift(event);
    if (this.recentUpdates.length > MAX_UPDATES) {
      this.recentUpdates.length = MAX_UPDATES;
    }
  }

  getSnapshot(): StatusSnapshot {
    return {
      startedAt: this.startedAt,
      lastCheckAt: this.lastCheckAt,
      checkInProgress: this.checkInProgress,
      containers: [...this.containers],
      recentUpdates: [...this.recentUpdates],
    };
  }
}

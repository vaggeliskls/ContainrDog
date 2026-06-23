import { ComponentHealth, ContainerInfo, ImageUpdateInfo, SyncStatus } from '../types';
import { getConfig } from '../utils/config';
import { ImageParser } from '../utils/image-parser';

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
  // ArgoCD-style component status
  health: ComponentHealth;
  healthReason?: string;
  sync: SyncStatus;
  currentTag: string;
  availableTag?: string;
  updateType?: string;
  lastError?: string;
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

  setContainers(containers: ContainerInfo[], updates?: Map<string, ImageUpdateInfo>): void {
    const config = getConfig();
    this.containers = containers.map((c) => {
      const update = updates?.get(c.id);
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
        health: c.health ?? ComponentHealth.UNKNOWN,
        healthReason: c.healthReason,
        sync: update ? SyncStatus.OUTDATED : SyncStatus.SYNCED,
        currentTag: ImageParser.parse(c.image).tag,
        availableTag: update?.availableImage.tag,
        updateType: update?.updateType,
      };
    });
  }

  /**
   * Override a single component's sync status after an auto-update attempt
   * (updating → synced/failed). Keyed by container id; no-op if the container
   * is no longer in the current snapshot.
   */
  markComponentSync(containerId: string, sync: SyncStatus, opts?: { error?: string }): void {
    const c = this.containers.find((x) => x.id === containerId);
    if (!c) return;
    c.sync = sync;
    c.lastError = opts?.error;
    if (sync === SyncStatus.SYNCED) {
      c.availableTag = undefined;
      c.lastError = undefined;
    }
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

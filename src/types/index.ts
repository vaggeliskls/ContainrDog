export enum UpdatePolicy {
  ALL = 'all',
  MAJOR = 'major',
  MINOR = 'minor',
  PATCH = 'patch',
  FORCE = 'force',
  GLOB = 'glob',
}

export enum WebhookProvider {
  SLACK = 'slack',
  DISCORD = 'discord',
  TEAMS = 'teams',
  GENERIC = 'generic',
}

export enum GitAuthType {
  TOKEN = 'token',
  SSH = 'ssh',
  NONE = 'none',
}

export interface WebhookConfig {
  enabled: boolean;
  provider: WebhookProvider;
  url: string;
  notifyOnSuccess?: boolean; // Notify when update succeeds (default: true)
  notifyOnFailure?: boolean; // Notify when update fails (default: true)
  notifyOnCheck?: boolean; // Notify on every check (default: false)
}

export interface GitOpsConfig {
  enabled: boolean;
  repoUrl: string;
  branch: string;
  authType: GitAuthType;
  token?: string;
  sshKeyPath?: string;
  pollInterval: number; // in milliseconds
  watchPaths?: string[]; // Glob patterns for files/folders to watch
  commands?: string[]; // Commands to execute on changes
  clonePath: string; // Local path to clone repo
}

export interface Config {
  interval: number; // in milliseconds
  labeledOnly: boolean;
  label: string;
  socketPath: string;
  registryCredentials?: RegistryCredentials[];
  updateCommands?: string[]; // Deprecated: use preUpdateCommands and postUpdateCommands
  preUpdateCommands?: string[]; // Commands to run before update
  postUpdateCommands?: string[]; // Commands to run after update
  logLevel: string;
  policy: UpdatePolicy;
  matchTag: boolean; // For force policy: only update if same tag
  globPattern?: string; // For glob policy
  autoUpdate: boolean; // Global auto-update setting
  webhook?: WebhookConfig; // Webhook notifications
  gitops?: GitOpsConfig; // GitOps configuration
}

export interface RegistryCredentials {
  registry: string;
  username: string;
  password: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  imageId: string;
  labels: Record<string, string>;
  created: number;
  policy?: UpdatePolicy;
  matchTag?: boolean;
  globPattern?: string;
  autoUpdate?: boolean;
  updateCommands?: string[]; // Deprecated: use preUpdateCommands and postUpdateCommands
  preUpdateCommands?: string[]; // Commands to run before update
  postUpdateCommands?: string[]; // Commands to run after update
  gitopsEnabled?: boolean; // Enable/disable GitOps for this container
  gitopsRepoUrl?: string; // Per-container Git repository URL
  gitopsBranch?: string; // Per-container Git branch
  gitopsAuthType?: GitAuthType; // Per-container auth type
  gitopsToken?: string; // Per-container auth token
  gitopsSshKeyPath?: string; // Per-container SSH key path
  gitopsPollInterval?: number; // Per-container poll interval
  gitopsWatchPaths?: string[]; // Watch specific paths for this container
  gitopsCommands?: string[]; // GitOps commands for this container
  gitopsClonePath?: string; // Per-container clone path
}

export interface ImageInfo {
  registry: string;
  repository: string;
  tag: string;
  digest?: string;
}

export interface ImageUpdateInfo {
  container: ContainerInfo;
  currentImage: ImageInfo;
  availableImage: ImageInfo;
  updateType: UpdateType;
}

export enum UpdateType {
  SEMANTIC_VERSION = 'semantic_version',
  DIGEST_CHANGE = 'digest_change',
  STATIC_TAG = 'static_tag',
}

export interface RegistryManifest {
  digest: string;
  tag: string;
  created?: string;
}

export interface GitChangeInfo {
  changedFiles: string[];
  previousCommit: string;
  currentCommit: string;
  commitMessage: string;
  timestamp: Date;
}

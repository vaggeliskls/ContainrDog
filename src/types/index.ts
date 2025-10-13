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

export interface WebhookConfig {
  enabled: boolean;
  provider: WebhookProvider;
  url: string;
  notifyOnSuccess?: boolean; // Notify when update succeeds (default: true)
  notifyOnFailure?: boolean; // Notify when update fails (default: true)
  notifyOnCheck?: boolean; // Notify on every check (default: false)
}

export interface Config {
  interval: number; // in milliseconds
  labeledOnly: boolean;
  label: string;
  socketPath: string;
  registryCredentials?: RegistryCredentials[];
  updateCommands?: string[];
  logLevel: string;
  policy: UpdatePolicy;
  matchTag: boolean; // For force policy: only update if same tag
  globPattern?: string; // For glob policy
  autoUpdate: boolean; // Global auto-update setting
  webhook?: WebhookConfig; // Webhook notifications
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
  updateCommands?: string[];
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

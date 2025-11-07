import { Config, RegistryCredentials, UpdatePolicy, WebhookConfig, WebhookProvider, GitOpsConfig, GitAuthType, ECRConfig } from '../types';
import { readFileSync, existsSync } from 'fs';

export class ConfigManager {
  private static instance: ConfigManager;
  private config: Config;

  private constructor() {
    this.config = this.loadConfig();
  }

  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  private loadConfig(): Config {
    // Parse interval (default 5 seconds)
    // Can be in seconds (e.g., "5s") or minutes (e.g., "5" or "5m")
    const intervalStr = process.env.INTERVAL || '5s';
    const interval = this.parseInterval(intervalStr);

    // Parse labeled only mode (default: true - only check labeled containers)
    const labeledOnly = process.env.LABELED !== 'false';

    // Label to check for
    const label = process.env.LABEL || 'containrdog-enabled';

    // Socket path (auto-detect Docker or Podman)
    const socketPath = this.detectSocketPath();

    // Parse registry credentials (from file or environment)
    const registryCredentials = this.parseRegistryCredentials();

    // Parse update commands (from file or environment)
    const updateCommands = this.parseUpdateCommands();
    const preUpdateCommands = this.parsePreUpdateCommands();
    const postUpdateCommands = this.parsePostUpdateCommands();

    // Log level
    const logLevel = process.env.LOG_LEVEL || 'info';

    // Update policy (default: major - update all major, minor, and patch versions)
    const policy = this.parsePolicy(process.env.POLICY || 'major');

    // Match tag (for force policy)
    const matchTag = process.env.MATCH_TAG === 'true';

    // Glob pattern (for glob policy)
    const globPattern = process.env.GLOB_PATTERN;

    // Auto-update (default: true)
    const autoUpdate = process.env.AUTO_UPDATE !== 'false';

    // Webhook configuration
    const webhook = this.parseWebhookConfig();

    // GitOps configuration
    const gitops = this.parseGitOpsConfig();

    // ECR configuration
    const ecr = this.parseECRConfig();

    return {
      interval,
      labeledOnly,
      label,
      socketPath,
      registryCredentials,
      updateCommands,
      preUpdateCommands,
      postUpdateCommands,
      logLevel,
      policy,
      matchTag,
      globPattern,
      autoUpdate,
      webhook,
      gitops,
      ecr,
    };
  }

  private parsePolicy(policyStr: string): UpdatePolicy {
    const normalizedPolicy = policyStr.toLowerCase();
    switch (normalizedPolicy) {
      case 'all':
        return UpdatePolicy.ALL;
      case 'major':
        return UpdatePolicy.MAJOR;
      case 'minor':
        return UpdatePolicy.MINOR;
      case 'patch':
        return UpdatePolicy.PATCH;
      case 'force':
        return UpdatePolicy.FORCE;
      case 'glob':
        return UpdatePolicy.GLOB;
      default:
        console.warn(`Invalid POLICY: ${policyStr}, using default 'major'`);
        return UpdatePolicy.MAJOR;
    }
  }

  private parseInterval(intervalStr: string): number {
    // Support formats: "5s", "5", "5m"
    const match = intervalStr.match(/^(\d+)(s|m)?$/);

    if (!match) {
      console.warn(`Invalid INTERVAL format: ${intervalStr}, using default 5s`);
      return 5000; // Default 5 seconds
    }

    const value = parseInt(match[1], 10);
    const unit = match[2] || 'm'; // Default to minutes for backward compatibility

    if (unit === 's') {
      return value * 1000; // Convert seconds to milliseconds
    } else {
      return value * 60 * 1000; // Convert minutes to milliseconds
    }
  }

  private detectSocketPath(): string {
    // Check if custom socket path is provided
    if (process.env.SOCKET_PATH) {
      return process.env.SOCKET_PATH;
    }

    // Default Docker socket
    return '/var/run/docker.sock';
  }

  private readFileIfExists(filePath: string): string | null {
    try {
      if (existsSync(filePath)) {
        return readFileSync(filePath, 'utf-8').trim();
      }
    } catch (error) {
      console.error(`Failed to read file ${filePath}:`, error);
    }
    return null;
  }

  private parseRegistryCredentials(): RegistryCredentials[] | undefined {
    // Try to read from Docker config.json first
    const dockerConfigPath = process.env.DOCKER_CONFIG_PATH || '/config.json';
    const dockerConfig = this.readFileIfExists(dockerConfigPath);

    if (dockerConfig) {
      try {
        const config = JSON.parse(dockerConfig);
        if (config.auths) {
          // Parse Docker config.json format
          const credentials: RegistryCredentials[] = [];
          for (const [registry, authData] of Object.entries<any>(config.auths)) {
            if (authData.auth) {
              // Decode base64 auth string
              const decoded = Buffer.from(authData.auth, 'base64').toString('utf-8');
              const [username, password] = decoded.split(':');
              credentials.push({
                registry: registry.replace(/^https?:\/\//, ''),
                username,
                password,
              });
            } else if (authData.username && authData.password) {
              credentials.push({
                registry: registry.replace(/^https?:\/\//, ''),
                username: authData.username,
                password: authData.password,
              });
            }
          }
          if (credentials.length > 0) {
            return credentials;
          }
        }
      } catch (error) {
        console.error('Failed to parse Docker config.json:', error);
      }
    }

    // Fallback to custom credentials file or environment variable
    const credentialsFile = process.env.CREDENTIALS_FILE;
    const fileContent = credentialsFile ? this.readFileIfExists(credentialsFile) : null;
    const credentialsJson = fileContent || process.env.REGISTRY_CREDENTIALS;

    if (!credentialsJson) {
      return undefined;
    }

    try {
      const credentials = JSON.parse(credentialsJson);
      if (Array.isArray(credentials)) {
        return credentials;
      }
      // If single credential object, wrap in array
      return [credentials];
    } catch (error) {
      console.error('Failed to parse REGISTRY_CREDENTIALS:', error);
      return undefined;
    }
  }

  private parseUpdateCommands(): string[] | undefined {
    // Try to read from mounted file first
    const commandsFile = process.env.COMMANDS_FILE || '/config/update-commands.json';
    const fileContent = this.readFileIfExists(commandsFile);

    const commandsJson = fileContent || process.env.UPDATE_COMMANDS;

    if (!commandsJson) {
      return undefined;
    }

    try {
      const commands = JSON.parse(commandsJson);
      if (Array.isArray(commands)) {
        return commands;
      }
      // If single command string, wrap in array
      return [commands];
    } catch (error) {
      console.error('Failed to parse UPDATE_COMMANDS:', error);
      return undefined;
    }
  }

  private parsePreUpdateCommands(): string[] | undefined {
    // Try to read from mounted file first
    const commandsFile = process.env.PRE_COMMANDS_FILE || '/config/pre-update-commands.json';
    const fileContent = this.readFileIfExists(commandsFile);

    const commandsJson = fileContent || process.env.PRE_UPDATE_COMMANDS;

    if (!commandsJson) {
      return undefined;
    }

    try {
      const commands = JSON.parse(commandsJson);
      if (Array.isArray(commands)) {
        return commands;
      }
      // If single command string, wrap in array
      return [commands];
    } catch (error) {
      console.error('Failed to parse PRE_UPDATE_COMMANDS:', error);
      return undefined;
    }
  }

  private parsePostUpdateCommands(): string[] | undefined {
    // Try to read from mounted file first
    const commandsFile = process.env.POST_COMMANDS_FILE || '/config/post-update-commands.json';
    const fileContent = this.readFileIfExists(commandsFile);

    const commandsJson = fileContent || process.env.POST_UPDATE_COMMANDS;

    if (!commandsJson) {
      return undefined;
    }

    try {
      const commands = JSON.parse(commandsJson);
      if (Array.isArray(commands)) {
        return commands;
      }
      // If single command string, wrap in array
      return [commands];
    } catch (error) {
      console.error('Failed to parse POST_UPDATE_COMMANDS:', error);
      return undefined;
    }
  }

  private parseWebhookConfig(): WebhookConfig | undefined {
    const enabled = process.env.WEBHOOK_ENABLED === 'true';
    const url = process.env.WEBHOOK_URL;

    if (!enabled || !url) {
      return undefined;
    }

    // Parse provider (default: generic)
    let provider = WebhookProvider.GENERIC;
    const providerStr = process.env.WEBHOOK_PROVIDER?.toLowerCase();

    switch (providerStr) {
      case 'slack':
        provider = WebhookProvider.SLACK;
        break;
      case 'discord':
        provider = WebhookProvider.DISCORD;
        break;
      case 'teams':
      case 'msteams':
        provider = WebhookProvider.TEAMS;
        break;
      default:
        provider = WebhookProvider.GENERIC;
    }

    // Parse notification preferences (defaults)
    const notifyOnSuccess = process.env.WEBHOOK_NOTIFY_SUCCESS !== 'false'; // default: true
    const notifyOnFailure = process.env.WEBHOOK_NOTIFY_FAILURE !== 'false'; // default: true
    const notifyOnCheck = process.env.WEBHOOK_NOTIFY_CHECK === 'true'; // default: false

    return {
      enabled,
      provider,
      url,
      notifyOnSuccess,
      notifyOnFailure,
      notifyOnCheck,
    };
  }

  private parseGitOpsConfig(): GitOpsConfig | undefined {
    const enabled = process.env.GITOPS_ENABLED === 'true';
    const repoUrl = process.env.GITOPS_REPO_URL;

    if (!enabled || !repoUrl) {
      return undefined;
    }

    // Parse branch (default: main)
    const branch = process.env.GITOPS_BRANCH || 'main';

    // Parse auth type (default: none)
    let authType = GitAuthType.NONE;
    const authTypeStr = process.env.GITOPS_AUTH_TYPE?.toLowerCase();

    switch (authTypeStr) {
      case 'token':
        authType = GitAuthType.TOKEN;
        break;
      case 'ssh':
        authType = GitAuthType.SSH;
        break;
      default:
        authType = GitAuthType.NONE;
    }

    // Parse token and SSH key path
    const token = process.env.GITOPS_TOKEN;
    const sshKeyPath = process.env.GITOPS_SSH_KEY_PATH;

    // Parse poll interval (default: 60s)
    const pollIntervalStr = process.env.GITOPS_POLL_INTERVAL || '60s';
    const pollInterval = this.parseInterval(pollIntervalStr);

    // Parse watch paths
    const watchPathsJson = process.env.GITOPS_WATCH_PATHS;
    let watchPaths: string[] | undefined;

    if (watchPathsJson) {
      try {
        const parsed = JSON.parse(watchPathsJson);
        if (Array.isArray(parsed)) {
          watchPaths = parsed;
        }
      } catch (error) {
        console.error('Failed to parse GITOPS_WATCH_PATHS:', error);
      }
    }

    // Parse commands
    const commandsJson = process.env.GITOPS_COMMANDS;
    let commands: string[] | undefined;

    if (commandsJson) {
      try {
        const parsed = JSON.parse(commandsJson);
        if (Array.isArray(parsed)) {
          commands = parsed;
        } else {
          commands = [parsed];
        }
      } catch (error) {
        console.error('Failed to parse GITOPS_COMMANDS:', error);
      }
    }

    // Clone path (default: /tmp/{repo-name})
    let clonePath = process.env.GITOPS_CLONE_PATH;
    if (!clonePath) {
      // Extract repo name from URL
      const repoName = this.extractRepoName(repoUrl);
      clonePath = `/tmp/${repoName}`;
    }

    return {
      enabled,
      repoUrl,
      branch,
      authType,
      token,
      sshKeyPath,
      pollInterval,
      watchPaths,
      commands,
      clonePath,
    };
  }

  private parseECRConfig(): ECRConfig | undefined {
    const enabled = process.env.ECR_ENABLED === 'true';

    if (!enabled) {
      return undefined;
    }

    // AWS region is required for ECR
    const region = process.env.ECR_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;

    if (!region) {
      console.warn('ECR_ENABLED is true but no region specified. Provide ECR_REGION, AWS_REGION, or AWS_DEFAULT_REGION');
      return undefined;
    }

    // AWS credentials (optional - can use IAM role/instance profile)
    const accessKeyId = process.env.ECR_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.ECR_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;

    // Parse auth refresh interval (default: 6 hours, ECR tokens expire in 12 hours)
    const refreshIntervalStr = process.env.ECR_AUTH_REFRESH_INTERVAL || '6h';
    const authRefreshInterval = this.parseECRInterval(refreshIntervalStr);

    // Parse registry URLs (comma-separated list)
    const registriesStr = process.env.ECR_REGISTRIES;
    let registries: string[] = [];

    if (registriesStr) {
      registries = registriesStr.split(',').map(r => r.trim()).filter(r => r.length > 0);
    }

    // If no explicit registries provided, we'll auto-detect from account ID if available
    if (registries.length === 0) {
      const accountId = process.env.ECR_ACCOUNT_ID || process.env.AWS_ACCOUNT_ID;
      if (accountId) {
        registries = [`${accountId}.dkr.ecr.${region}.amazonaws.com`];
      }
    }

    return {
      enabled,
      region,
      accessKeyId,
      secretAccessKey,
      authRefreshInterval,
      registries,
    };
  }

  private parseECRInterval(intervalStr: string): number {
    // Support formats: "6h", "30m", "3600s"
    const match = intervalStr.match(/^(\d+)(h|m|s)?$/);

    if (!match) {
      console.warn(`Invalid ECR_AUTH_REFRESH_INTERVAL format: ${intervalStr}, using default 6h`);
      return 6 * 60 * 60 * 1000; // 6 hours in milliseconds
    }

    const value = parseInt(match[1], 10);
    const unit = match[2] || 'h'; // Default to hours

    switch (unit) {
      case 'h':
        return value * 60 * 60 * 1000; // hours to milliseconds
      case 'm':
        return value * 60 * 1000; // minutes to milliseconds
      case 's':
        return value * 1000; // seconds to milliseconds
      default:
        return 6 * 60 * 60 * 1000; // Default 6 hours
    }
  }

  public getConfig(): Config {
    return this.config;
  }

  private extractRepoName(url: string): string {
    // Extract repo name from Git URL
    // Examples:
    //   https://github.com/user/repo.git -> repo
    //   git@github.com:user/repo.git -> repo
    //   https://github.com/user/repo -> repo
    try {
      const match = url.match(/\/([^\/]+?)(\.git)?$/);
      if (match && match[1]) {
        return match[1];
      }
      // Fallback to generic name
      return 'gitops-repo';
    } catch {
      return 'gitops-repo';
    }
  }

  public reload(): void {
    this.config = this.loadConfig();
  }
}

export const getConfig = (): Config => {
  return ConfigManager.getInstance().getConfig();
};

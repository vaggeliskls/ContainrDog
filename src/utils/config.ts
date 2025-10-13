import { Config, RegistryCredentials, UpdatePolicy } from '../types';
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

    return {
      interval,
      labeledOnly,
      label,
      socketPath,
      registryCredentials,
      updateCommands,
      logLevel,
      policy,
      matchTag,
      globPattern,
      autoUpdate,
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

  public getConfig(): Config {
    return this.config;
  }

  public reload(): void {
    this.config = this.loadConfig();
  }
}

export const getConfig = (): Config => {
  return ConfigManager.getInstance().getConfig();
};

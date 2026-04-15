import simpleGit, { SimpleGit, SimpleGitOptions } from 'simple-git';
import { minimatch } from 'minimatch';
import { existsSync, mkdirSync } from 'fs';
import { access, stat } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { logger } from '../utils/logger';
import { GitOpsConfig, GitAuthType, GitChangeInfo } from '../types';

export class GitService {
  private git: SimpleGit;
  private config: GitOpsConfig;
  private lastCommit: string | null = null;

  constructor(config: GitOpsConfig) {
    this.config = config;

    // Ensure clone path exists
    if (!existsSync(this.config.clonePath)) {
      mkdirSync(this.config.clonePath, { recursive: true });
    }

    // Configure git options
    const options: Partial<SimpleGitOptions> = {
      baseDir: this.config.clonePath,
      binary: 'git',
      maxConcurrentProcesses: 6,
    };

    // Configure SSH for this specific instance if using SSH auth.
    // simple-git's `options.config` (which maps to `git -c ...`) does not propagate
    // to `clone` in practice, so we set GIT_SSH_COMMAND on the process env — git
    // always honors it for every invocation including clone.
    if (this.config.authType === GitAuthType.SSH && this.config.sshKeyPath) {
      if (!existsSync(this.config.sshKeyPath)) {
        throw new Error(`GitOps: SSH key not found at ${this.config.sshKeyPath}`);
      }
      process.env.GIT_SSH_COMMAND = `ssh -i ${this.config.sshKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes`;
    }

    this.git = simpleGit(options);
  }

  /**
   * Initialize the repository - clone if not exists, otherwise pull
   */
  async initialize(): Promise<boolean> {
    try {
      if (this.config.authType === GitAuthType.SSH && this.config.sshKeyPath) {
        try {
          await access(this.config.sshKeyPath, fsConstants.R_OK);
        } catch {
          const st = await stat(this.config.sshKeyPath);
          const mode = (st.mode & 0o777).toString(8);
          throw new Error(
            `GitOps: SSH key at ${this.config.sshKeyPath} is not readable ` +
            `(mode ${mode}, uid ${process.getuid?.()}, gid ${process.getgid?.()}). ` +
            `Ensure the secret is mounted with defaultMode: 0440 and the runtime user can read it.`
          );
        }
      }

      const repoPath = `${this.config.clonePath}/.git`;

      if (!existsSync(repoPath)) {
        logger.info(`🔄 GitOps: Cloning repository ${this.config.repoUrl}...`);
        await this.cloneRepository();
      } else {
        logger.info(`🔄 GitOps: Repository already exists, pulling latest changes...`);
        await this.pullChanges();
      }

      // Store initial commit
      const log = await this.git.log(['-1']);
      this.lastCommit = log.latest?.hash || null;
      logger.info(`🔄 GitOps: Initialized at commit ${this.lastCommit?.substring(0, 7)}`);

      return true;
    } catch (error) {
      logger.error('❌ GitOps: Failed to initialize repository:', error);
      return false;
    }
  }

  /**
   * Clone the repository with authentication
   */
  private async cloneRepository(): Promise<void> {
    const repoUrl = this.buildAuthenticatedUrl();

    await this.git.clone(repoUrl, this.config.clonePath, [
      '--branch',
      this.config.branch,
      '--single-branch',
    ]);

    logger.info(`✅ GitOps: Repository cloned successfully`);
  }

  /**
   * Pull latest changes from the repository
   */
  private async pullChanges(): Promise<void> {
    await this.git.fetch();
    await this.git.pull('origin', this.config.branch);
  }

  /**
   * Check for changes in the repository
   * @returns GitChangeInfo if changes detected, null otherwise
   */
  async checkForChanges(): Promise<GitChangeInfo | null> {
    try {
      // Fetch latest changes
      await this.git.fetch();

      // Get the latest commit on the remote tracking branch (fetch updates
      // origin/<branch> but not local HEAD — we must read the remote ref,
      // otherwise currentCommit === lastCommit forever).
      const remoteRef = `origin/${this.config.branch}`;
      const currentCommit = (await this.git.revparse([remoteRef])).trim() || null;

      if (!currentCommit) {
        logger.warn('⚠️  GitOps: Could not determine current commit');
        return null;
      }

      // Check if there are new commits
      if (this.lastCommit && currentCommit === this.lastCommit) {
        logger.debug('🔍 GitOps: No new changes detected');
        return null;
      }

      // Get changed files between commits
      const previousCommit = this.lastCommit || `${currentCommit}~1`;
      const diffSummary = await this.git.diff([
        '--name-only',
        previousCommit,
        currentCommit,
      ]);

      const changedFiles = diffSummary
        .split('\n')
        .filter((file) => file.trim().length > 0);

      if (changedFiles.length === 0) {
        logger.debug('🔍 GitOps: No file changes detected');
        return null;
      }

      // Filter by watch paths if configured
      const relevantFiles = this.filterByWatchPaths(changedFiles);

      if (relevantFiles.length === 0) {
        logger.debug('🔍 GitOps: No relevant file changes (filtered by watch paths)');
        this.lastCommit = currentCommit; // Update but don't trigger
        return null;
      }

      // Pull the changes
      await this.pullChanges();

      const currentLog = await this.git.log(['-1']);

      const changeInfo: GitChangeInfo = {
        changedFiles: relevantFiles,
        previousCommit: previousCommit,
        currentCommit: currentCommit,
        commitMessage: currentLog.latest?.message || 'Unknown',
        timestamp: new Date(),
      };

      // Update last commit
      this.lastCommit = currentCommit;

      logger.info('═══════════════════════════════════════════════════════════════');
      logger.info(`📦 GitOps: Changes detected`);
      logger.info(`   Commit: ${currentCommit.substring(0, 7)}`);
      logger.info(`   Message: ${changeInfo.commitMessage}`);
      logger.info(`   Files changed: ${relevantFiles.length}`);
      relevantFiles.slice(0, 5).forEach((file) => {
        logger.info(`     - ${file}`);
      });
      if (relevantFiles.length > 5) {
        logger.info(`     ... and ${relevantFiles.length - 5} more`);
      }
      logger.info('═══════════════════════════════════════════════════════════════');

      return changeInfo;
    } catch (error) {
      logger.error('❌ GitOps: Failed to check for changes:', error);
      return null;
    }
  }

  /**
   * Filter files by watch paths (glob patterns)
   */
  private filterByWatchPaths(files: string[]): string[] {
    // If no watch paths configured, return all files
    if (!this.config.watchPaths || this.config.watchPaths.length === 0) {
      return files;
    }

    // Filter files that match any of the watch patterns
    return files.filter((file) => {
      return this.config.watchPaths!.some((pattern) => {
        return minimatch(file, pattern, { dot: true });
      });
    });
  }

  /**
   * Build authenticated URL for git operations
   */
  private buildAuthenticatedUrl(): string {
    const url = this.config.repoUrl;

    switch (this.config.authType) {
      case GitAuthType.TOKEN:
        if (!this.config.token) {
          throw new Error('GitOps: Token authentication requires GITOPS_TOKEN');
        }
        // For GitHub/GitLab: https://token@github.com/user/repo.git
        // For generic: https://username:token@host/repo.git
        if (url.includes('github.com') || url.includes('gitlab.com')) {
          return url.replace('https://', `https://${this.config.token}@`);
        } else {
          return url.replace('https://', `https://git:${this.config.token}@`);
        }

      case GitAuthType.SSH:
        if (!this.config.sshKeyPath) {
          throw new Error('GitOps: SSH authentication requires GITOPS_SSH_KEY_PATH');
        }
        // SSH URLs remain unchanged, SSH config is set in constructor
        return url;

      case GitAuthType.NONE:
      default:
        return url;
    }
  }

  /**
   * Get the current commit hash
   */
  async getCurrentCommit(): Promise<string | null> {
    try {
      const log = await this.git.log(['-1']);
      return log.latest?.hash || null;
    } catch (error) {
      logger.error('❌ GitOps: Failed to get current commit:', error);
      return null;
    }
  }

  /**
   * Check if commands should run on every interval (when no watch paths defined)
   */
  shouldRunOnInterval(): boolean {
    return !this.config.watchPaths || this.config.watchPaths.length === 0;
  }

  /**
   * Get repository status
   */
  async getStatus(): Promise<string> {
    try {
      const status = await this.git.status();
      return JSON.stringify(status, null, 2);
    } catch (error) {
      logger.error('❌ GitOps: Failed to get status:', error);
      return 'Error getting status';
    }
  }
}

import { exec } from 'child_process';
import { promisify } from 'util';
import { ImageUpdateInfo } from '../types';
import { logger } from './logger';
import { ImageParser } from './image-parser';

const execAsync = promisify(exec);

export class CommandExecutor {
  async executeUpdateCommands(
    updateInfo: ImageUpdateInfo,
    commands?: string[]
  ): Promise<void> {
    if (!commands || commands.length === 0) {
      return;
    }

    logger.info(`💻 Executing ${commands.length} update command(s) for ${updateInfo.container.name}`);

    // Prepare environment variables for the commands
    const env = {
      ...process.env,
      CONTAINER_ID: updateInfo.container.id,
      CONTAINER_NAME: updateInfo.container.name,
      CURRENT_IMAGE: ImageParser.toString(updateInfo.currentImage),
      CURRENT_TAG: updateInfo.currentImage.tag,
      AVAILABLE_IMAGE: ImageParser.toString(updateInfo.availableImage),
      AVAILABLE_TAG: updateInfo.availableImage.tag,
      UPDATE_TYPE: updateInfo.updateType,
    };

    for (let i = 0; i < commands.length; i++) {
      const command = commands[i];
      try {
        logger.debug(`▶️  Executing command ${i + 1}/${commands.length}: ${command}`);

        const { stdout, stderr } = await execAsync(command, {
          env,
          timeout: 60000, // 60 second timeout
          maxBuffer: 1024 * 1024, // 1MB buffer
        });

        if (stdout) {
          logger.info(`✅ Command ${i + 1} output: ${stdout.trim()}`);
        }

        if (stderr) {
          logger.warn(`⚠️  Command ${i + 1} stderr: ${stderr.trim()}`);
        }
      } catch (error) {
        logger.error(`❌ Failed to execute command ${i + 1}: ${command}`, error instanceof Error ? error.message : String(error));
        // Continue with next command even if one fails
      }
    }
  }

  async executeCommand(command: string, env?: Record<string, string>): Promise<string> {
    try {
      const { stdout } = await execAsync(command, {
        env: { ...process.env, ...env },
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim();
    } catch (error) {
      logger.error(`❌ Failed to execute command: ${command}`, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}

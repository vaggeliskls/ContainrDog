import axios, { AxiosInstance } from 'axios';
import { WebhookConfig, WebhookProvider, ImageUpdateInfo, ContainerInfo, GitChangeInfo } from '../types';
import { logger } from '../utils/logger';

export class WebhookService {
  private axiosInstance: AxiosInstance;
  private config: WebhookConfig;

  constructor(config: WebhookConfig) {
    this.config = config;
    this.axiosInstance = axios.create({
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  async sendUpdateNotification(
    update: ImageUpdateInfo,
    success: boolean,
    error?: string
  ): Promise<void> {
    try {
      // Check if we should send this notification
      if (success && !this.config.notifyOnSuccess) {
        return;
      }
      if (!success && !this.config.notifyOnFailure) {
        return;
      }

      const payload = this.buildPayload(update, success, error);
      await this.axiosInstance.post(this.config.url, payload);
      logger.debug('📨 Webhook notification sent successfully');
    } catch (err) {
      logger.warn(`⚠️  Failed to send webhook notification: ${err}`);
    }
  }

  async sendGitOpsNotification(
    container: ContainerInfo,
    changes: GitChangeInfo,
    success: boolean,
    error?: string
  ): Promise<void> {
    try {
      if (!this.config.notifyOnGitops) {
        return;
      }

      const payload = this.buildGitOpsPayload(container, changes, success, error);
      await this.axiosInstance.post(this.config.url, payload);
      logger.debug('📨 Webhook GitOps notification sent successfully');
    } catch (err) {
      logger.warn(`⚠️  Failed to send webhook GitOps notification: ${err}`);
    }
  }

  async sendCheckNotification(containersChecked: number, updatesFound: number): Promise<void> {
    try {
      if (!this.config.notifyOnCheck) {
        return;
      }

      const payload = this.buildCheckPayload(containersChecked, updatesFound);
      await this.axiosInstance.post(this.config.url, payload);
      logger.debug('📨 Webhook check notification sent successfully');
    } catch (err) {
      logger.warn(`⚠️  Failed to send webhook check notification: ${err}`);
    }
  }

  private labelDisplayName(key: string): string {
    return key.split('.').pop() || key;
  }

  private buildPayload(update: ImageUpdateInfo, success: boolean, error?: string): Record<string, unknown> {
    const status = success ? 'Success' : 'Failed';
    const emoji = success ? '✅' : '❌';

    switch (this.config.provider) {
      case WebhookProvider.SLACK:
        return this.buildSlackPayload(update, status, emoji, error);
      case WebhookProvider.DISCORD:
        return this.buildDiscordPayload(update, status, emoji, error);
      case WebhookProvider.TEAMS:
        return this.buildTeamsPayload(update, status, emoji, error);
      default:
        return this.buildGenericPayload(update, status, emoji, error);
    }
  }

  private buildSlackPayload(
    update: ImageUpdateInfo,
    status: string,
    emoji: string,
    error?: string
  ): Record<string, unknown> {
    const container = update.container;
    const fields: Record<string, unknown>[] = [
      {
        title: 'Container',
        value: container.name,
        short: true,
      },
      {
        title: 'Status',
        value: status,
        short: true,
      },
      {
        title: 'Current Version',
        value: update.currentImage.tag,
        short: true,
      },
      {
        title: 'New Version',
        value: update.availableImage.tag,
        short: true,
      },
    ];

    if (update.imageLabelKey) {
      const labelName = this.labelDisplayName(update.imageLabelKey);
      if (update.currentLabelValue) fields.push({ title: `Current ${labelName}`, value: update.currentLabelValue, short: true });
      if (update.availableLabelValue) fields.push({ title: `New ${labelName}`, value: update.availableLabelValue, short: true });
    }

    if (error) {
      fields.push({
        title: 'Error',
        value: error,
        short: false,
      });
    }

    return {
      text: `${emoji} ContainrDog Update: ${container.name}`,
      attachments: [
        {
          color: status === 'Success' ? 'good' : 'danger',
          fields,
          footer: '🐾 ContainrDog',
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };
  }

  private buildDiscordPayload(
    update: ImageUpdateInfo,
    status: string,
    emoji: string,
    error?: string
  ): Record<string, unknown> {
    const container = update.container;
    const fields: Record<string, unknown>[] = [
      {
        name: 'Container',
        value: container.name,
        inline: true,
      },
      {
        name: 'Status',
        value: status,
        inline: true,
      },
      {
        name: 'Current Version',
        value: update.currentImage.tag,
        inline: true,
      },
      {
        name: 'New Version',
        value: update.availableImage.tag,
        inline: true,
      },
    ];

    if (update.imageLabelKey) {
      const labelName = this.labelDisplayName(update.imageLabelKey);
      if (update.currentLabelValue) fields.push({ name: `Current ${labelName}`, value: update.currentLabelValue, inline: true });
      if (update.availableLabelValue) fields.push({ name: `New ${labelName}`, value: update.availableLabelValue, inline: true });
    }

    if (error) {
      fields.push({
        name: 'Error',
        value: error,
        inline: false,
      });
    }

    return {
      embeds: [
        {
          title: `${emoji} ContainrDog Update: ${container.name}`,
          color: status === 'Success' ? 0x00ff00 : 0xff0000,
          fields,
          footer: {
            text: '🐾 ContainrDog',
          },
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  private buildTeamsPayload(
    update: ImageUpdateInfo,
    status: string,
    emoji: string,
    error?: string
  ): Record<string, unknown> {
    const container = update.container;
    const facts: any[] = [
      {
        name: 'Container',
        value: container.name,
      },
      {
        name: 'Status',
        value: status,
      },
      {
        name: 'Current Version',
        value: update.currentImage.tag,
      },
      {
        name: 'New Version',
        value: update.availableImage.tag,
      },
    ];

    if (update.imageLabelKey) {
      const labelName = this.labelDisplayName(update.imageLabelKey);
      if (update.currentLabelValue) facts.push({ name: `Current ${labelName}`, value: update.currentLabelValue });
      if (update.availableLabelValue) facts.push({ name: `New ${labelName}`, value: update.availableLabelValue });
    }

    if (error) {
      facts.push({
        name: 'Error',
        value: error,
      });
    }

    return {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary: `${emoji} ContainrDog Update: ${container.name}`,
      themeColor: status === 'Success' ? '00FF00' : 'FF0000',
      title: `${emoji} ContainrDog Update`,
      sections: [
        {
          facts,
        },
      ],
      text: `Update for container: ${container.name}`,
    };
  }

  private buildGenericPayload(
    update: ImageUpdateInfo,
    status: string,
    _emoji: string,
    error?: string
  ): Record<string, unknown> {
    const container = update.container;
    return {
      event: 'container_update',
      status: status.toLowerCase(),
      timestamp: new Date().toISOString(),
      container: {
        id: container.id,
        name: container.name,
        image: container.image,
      },
      update: {
        currentTag: update.currentImage.tag,
        newTag: update.availableImage.tag,
        updateType: update.updateType,
        ...(update.imageLabelKey && {
          label: {
            key: update.imageLabelKey,
            currentValue: update.currentLabelValue ?? null,
            newValue: update.availableLabelValue ?? null,
          },
        }),
      },
      error: error || null,
    };
  }

  private buildGitOpsPayload(
    container: ContainerInfo,
    changes: GitChangeInfo,
    success: boolean,
    error?: string
  ): Record<string, unknown> {
    const status = success ? 'Success' : 'Failed';
    const emoji = success ? '✅' : '❌';

    switch (this.config.provider) {
      case WebhookProvider.SLACK:
        return {
          text: `${emoji} ContainrDog GitOps: ${container.name}`,
          attachments: [
            {
              color: success ? 'good' : 'danger',
              fields: [
                { title: 'Container', value: container.name, short: true },
                { title: 'Status', value: status, short: true },
                { title: 'Commit', value: changes.currentCommit.substring(0, 7), short: true },
                { title: 'Message', value: changes.commitMessage, short: true },
                { title: 'Files Changed', value: changes.changedFiles.length.toString(), short: true },
                ...(error ? [{ title: 'Error', value: error, short: false }] : []),
              ],
              footer: '🐾 ContainrDog',
              ts: Math.floor(Date.now() / 1000),
            },
          ],
        };

      case WebhookProvider.DISCORD:
        return {
          embeds: [
            {
              title: `${emoji} ContainrDog GitOps: ${container.name}`,
              color: success ? 0x00ff00 : 0xff0000,
              fields: [
                { name: 'Container', value: container.name, inline: true },
                { name: 'Status', value: status, inline: true },
                { name: 'Commit', value: changes.currentCommit.substring(0, 7), inline: true },
                { name: 'Message', value: changes.commitMessage, inline: false },
                { name: 'Files Changed', value: changes.changedFiles.length.toString(), inline: true },
                ...(error ? [{ name: 'Error', value: error, inline: false }] : []),
              ],
              footer: { text: '🐾 ContainrDog' },
              timestamp: new Date().toISOString(),
            },
          ],
        };

      case WebhookProvider.TEAMS:
        return {
          '@type': 'MessageCard',
          '@context': 'https://schema.org/extensions',
          summary: `${emoji} ContainrDog GitOps: ${container.name}`,
          themeColor: success ? '00FF00' : 'FF0000',
          title: `${emoji} ContainrDog GitOps Update`,
          sections: [
            {
              facts: [
                { name: 'Container', value: container.name },
                { name: 'Status', value: status },
                { name: 'Commit', value: changes.currentCommit.substring(0, 7) },
                { name: 'Message', value: changes.commitMessage },
                { name: 'Files Changed', value: changes.changedFiles.length.toString() },
                ...(error ? [{ name: 'Error', value: error }] : []),
              ],
            },
          ],
        };

      default:
        return {
          event: 'gitops_deploy',
          status: status.toLowerCase(),
          timestamp: new Date().toISOString(),
          container: { id: container.id, name: container.name, image: container.image },
          changes: {
            commit: changes.currentCommit,
            previousCommit: changes.previousCommit,
            message: changes.commitMessage,
            filesChanged: changes.changedFiles.length,
          },
          error: error || null,
        };
    }
  }

  private buildCheckPayload(containersChecked: number, updatesFound: number): Record<string, unknown> {
    switch (this.config.provider) {
      case WebhookProvider.SLACK:
        return {
          text: `🐾 ContainrDog Check Complete`,
          attachments: [
            {
              color: updatesFound > 0 ? 'warning' : 'good',
              fields: [
                {
                  title: 'Containers Checked',
                  value: containersChecked.toString(),
                  short: true,
                },
                {
                  title: 'Updates Found',
                  value: updatesFound.toString(),
                  short: true,
                },
              ],
              footer: '🐾 ContainrDog',
              ts: Math.floor(Date.now() / 1000),
            },
          ],
        };

      case WebhookProvider.DISCORD:
        return {
          embeds: [
            {
              title: '🐾 ContainrDog Check Complete',
              color: updatesFound > 0 ? 0xffa500 : 0x00ff00,
              fields: [
                {
                  name: 'Containers Checked',
                  value: containersChecked.toString(),
                  inline: true,
                },
                {
                  name: 'Updates Found',
                  value: updatesFound.toString(),
                  inline: true,
                },
              ],
              footer: {
                text: '🐾 ContainrDog',
              },
              timestamp: new Date().toISOString(),
            },
          ],
        };

      case WebhookProvider.TEAMS:
        return {
          '@type': 'MessageCard',
          '@context': 'https://schema.org/extensions',
          summary: '🐾 ContainrDog Check Complete',
          themeColor: updatesFound > 0 ? 'FFA500' : '00FF00',
          title: '🐾 ContainrDog Check Complete',
          sections: [
            {
              facts: [
                {
                  name: 'Containers Checked',
                  value: containersChecked.toString(),
                },
                {
                  name: 'Updates Found',
                  value: updatesFound.toString(),
                },
              ],
            },
          ],
        };

      default:
        return {
          event: 'check_complete',
          timestamp: new Date().toISOString(),
          containersChecked,
          updatesFound,
        };
    }
  }
}

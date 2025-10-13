import axios, { AxiosInstance } from 'axios';
import { WebhookConfig, WebhookProvider, ImageUpdateInfo } from '../types';
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

  async sendCheckNotification(
    containersChecked: number,
    updatesFound: number
  ): Promise<void> {
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

  private buildPayload(
    update: ImageUpdateInfo,
    success: boolean,
    error?: string
  ): any {
    const container = update.container;
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
  ): any {
    const container = update.container;
    const fields: any[] = [
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
  ): any {
    const container = update.container;
    const fields: any[] = [
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
  ): any {
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
    emoji: string,
    error?: string
  ): any {
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
      },
      error: error || null,
    };
  }

  private buildCheckPayload(containersChecked: number, updatesFound: number): any {
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

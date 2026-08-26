import type { NotificationRequest, NotificationResult } from '@payrecover/shared';
import { NotificationProviderError, NotificationStatus } from '@payrecover/shared';
import type { NotificationProvider } from './provider.js';

export type MockFailureType = 'timeout' | 'network' | 'retryable_5xx' | 'permanent_4xx' | 'malformed';

export interface MockNotificationProviderOptions {
  failureScenario?: MockFailureType | null;
}

export class MockNotificationProvider implements NotificationProvider {
  public sentNotifications: NotificationRequest[] = [];
  private failureScenario: MockFailureType | null = null;

  constructor(options?: MockNotificationProviderOptions) {
    if (options?.failureScenario) {
      this.failureScenario = options.failureScenario;
    }
  }

  public setFailureScenario(scenario: MockFailureType | null): void {
    this.failureScenario = scenario;
  }

  public clear(): void {
    this.sentNotifications = [];
    this.failureScenario = null;
  }

  async send(notification: NotificationRequest): Promise<NotificationResult> {
    if (this.failureScenario) {
      switch (this.failureScenario) {
        case 'timeout':
          throw new NotificationProviderError('Notification provider request timed out', true, 408);
        case 'network':
          throw new NotificationProviderError('Network connection failed', true);
        case 'retryable_5xx':
          throw new NotificationProviderError('Internal Notification Service Error', true, 503);
        case 'permanent_4xx':
          throw new NotificationProviderError('Invalid recipient or channel parameters', false, 400);
        case 'malformed':
          return {
            idempotencyKey: notification.idempotencyKey,
            status: 'malformed_invalid' as unknown as NotificationStatus,
            error: 'Malformed response',
            retryable: false,
          };
      }
    }

    // Success path (offline)
    this.sentNotifications.push(notification);

    return {
      notificationId: `notif_mock_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      idempotencyKey: notification.idempotencyKey,
      status: NotificationStatus.SENT,
      deliveredAt: new Date().toISOString(),
    };
  }
}

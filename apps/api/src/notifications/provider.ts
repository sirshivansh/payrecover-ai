import type { NotificationRequest, NotificationResult } from '@payrecover/shared';

export interface NotificationProvider {
  send(notification: NotificationRequest): Promise<NotificationResult>;
}

import type { Models } from '@earendil-works/pi-ai';
import type { SessionEnd, Storage } from '@earendil-works/pi-durable';

import { infiniChatTasks, type KeepAliveController } from '../keep-alive/controller';
import type { RemoteHostRepository } from './execution/remote/hosts';
import type { RemoteExecution } from './execution/remote/owner';
import { createExpoImages } from './images';
import { ScheduledTaskNotifications } from './infinichat-notifications';
import { InfiniChatService } from './infinichat-service';
import { infiniChatDevices } from './infinichat/device-tools';
import { createDevices } from './infinichat/devices';
import type { Workspaces } from './workspace/storage';

/** InfiniChat on this phone, and what closes it. */
export type PhoneInfiniChat = { service: InfiniChatService; close(): Promise<void> };

/**
 * Opens InfiniChat with the phone's devices: its workspace and the configured machines, over the remote owner the
 * chat service shares, whose connections InfiniChat uses and never closes. While it is open, the keep-alive counts
 * its work and its scheduled tasks remind the user through local notifications while the app is closed.
 */
export async function openPhoneInfiniChat(options: {
  storage: Storage; models: Models; workspaces: Workspaces; remote: RemoteExecution;
  remoteHosts: RemoteHostRepository;
  authError?: (providerId: string) => string | undefined;
  onClosed?: (end: SessionEnd) => void;
  /** Counts InfiniChat's live work while it is open; its owner closes it. */
  keepAlive?: KeepAliveController;
}): Promise<PhoneInfiniChat> {
  const devices = createDevices(options.workspaces, options.remote, options.remoteHosts);
  const service = await InfiniChatService.open({
    storage: options.storage,
    models: options.models,
    devices: infiniChatDevices(devices, createExpoImages()),
    authError: options.authError,
    onClosed: options.onClosed,
  });
  const detachKeepAlive = options.keepAlive?.observe(service.harness, infiniChatTasks) ?? (() => {});
  const notifications = new ScheduledTaskNotifications(service.scheduled, (error) => service.report(error));
  return {
    service,
    async close() {
      try {
        await service.close();
      } finally {
        // Keep-alive stops counting this Harness's work; disposing its task graph after the close is safe.
        detachKeepAlive();
        notifications.close();
      }
    },
  };
}

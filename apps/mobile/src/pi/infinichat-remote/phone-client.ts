import type { InfiniChatClient } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { randomUUID } from 'expo-crypto';
import * as Device from 'expo-device';
import Storage from 'expo-sqlite/kv-store';

const KEY = 'pi.infinichat.client.v1';

/**
 * This app as a client of the machines' InfiniChat servers: its ID, made once and stored with the app's other settings
 * (expo-sqlite kv-store), which names its secret's file on each machine, and the name the device gives itself, which a
 * machine records when InfiniChat moves back here.
 */
export function phoneClient(): InfiniChatClient {
  let id = Storage.getItemSync(KEY);
  if (id === null) {
    id = randomUUID();
    Storage.setItemSync(KEY, id);
  }
  return { id, name: Device.deviceName ?? 'iPhone' };
}

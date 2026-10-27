import { createInfiniChatHome } from '@pi-agent/infinichat/pi/infinichat-remote/home';
import Storage from 'expo-sqlite/kv-store';

/** Where InfiniChat lives, stored with the app's other settings (expo-sqlite kv-store) through its synchronous calls. */
export const createPhoneHome = () => createInfiniChatHome({
  getItem: (key) => Storage.getItemSync(key),
  setItem: (key, value) => Storage.setItemSync(key, value),
});

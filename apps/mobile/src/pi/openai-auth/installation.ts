import type { LoginOptions } from '@earendil-works/pi-ai';
import * as Crypto from 'expo-crypto';

import { createCredentialBackend } from '../secure-storage';

const HOST_KEY = 'pi.openai.host.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let pending: Promise<string> | undefined;

/** Pi's host ID identifies an installation, independently of its login credentials. */
export async function getOpenAILoginOptions(): Promise<LoginOptions> {
  pending ??= (async () => {
    const backend = createCredentialBackend();
    const existing = await backend.getItemAsync(HOST_KEY);
    if (existing !== null) {
      if (!UUID.test(existing)) throw new Error('The saved OpenAI installation ID could not be restored.');
      return existing;
    }
    const id = Crypto.randomUUID();
    await backend.setItemAsync(HOST_KEY, id);
    return id;
  })().catch(() => {
    pending = undefined;
    throw new Error('Could not prepare secure ChatGPT sign-in. Unlock this device and try again.');
  });
  const id = await pending;
  return { getDeviceId: () => id };
}

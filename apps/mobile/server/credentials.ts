import { randomUUID } from 'node:crypto';

import type { LoginOptions } from '@earendil-works/pi-ai';
import type { CredentialBackend } from '@pi-agent/infinichat/pi/provider-credentials';

/** The phone's key for its OpenAI installation ID (`src/pi/openai-auth/installation.ts`), beside the credentials. */
const HOST_KEY = 'pi.openai.host.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * pi-ai's ChatGPT sign-in names this installation to OpenAI and must get the same ID every time
 * (`LoginOptions.getDeviceId`); its own CLI makes a new one per login and says apps should keep one. This machine is
 * its own installation, so it keeps its own, made at its first sign-in, read once per process as the phone's
 * `getOpenAILoginOptions` does. `agentName` is the name the phone's sign-in gives OpenAI.
 */
export function openAILoginOptions(backend: CredentialBackend): () => Promise<LoginOptions> {
  let pending: Promise<LoginOptions> | undefined;
  return () => {
    pending ??= (async () => {
      const saved = await backend.getItemAsync(HOST_KEY);
      if (saved !== null && !UUID.test(saved)) {
        throw new Error('The saved OpenAI installation ID could not be restored.');
      }
      const id = saved ?? randomUUID();
      if (saved === null) await backend.setItemAsync(HOST_KEY, id);
      return { getDeviceId: () => id, agentName: 'InfiniChat' };
    })().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

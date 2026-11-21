import type { Store } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { convertConversation, LEGACY_DATABASE } from '@pi-agent/infinichat/pi/infinichat-convert';
import { INFINICHAT_DATABASE } from '@pi-agent/infinichat/pi/infinichat-remote/move';
import { infiniChatStorage } from '@pi-agent/infinichat/pi/infinichat-store';

import { phoneDatabaseExists, phoneDatabaseFiles } from './infinichat-remote/phone-files';
import { openExpoSqliteStorage, openExpoStore } from './storage';

const context = BACKGROUND_CONTEXT;

/**
 * A conversation an earlier build left on this phone in `infinichat.db`, pi-durable's own SQLite storage, becomes the
 * store, once, as a machine's server converts its own (`conversation.ts`): copied record by record into a store
 * aside, which takes the store's name only when the copy is whole, so a conversion the app's end cut off starts
 * over. The old file then goes.
 */
async function convert() {
  if (phoneDatabaseExists(INFINICHAT_DATABASE) || !phoneDatabaseExists(LEGACY_DATABASE)) return;
  const aside = `${INFINICHAT_DATABASE}.converting`;
  await phoneDatabaseFiles.remove(aside);
  const from = await openExpoSqliteStorage(LEGACY_DATABASE);
  try {
    const store = await openExpoStore(aside);
    try {
      const to = await infiniChatStorage(store, context);
      await convertConversation(from, to, context);
      await to.close(context);
    } finally {
      await store.close(context);
    }
  } finally {
    await from.close(context);
  }
  // The rename takes the file alone, so its WAL is folded into it first.
  await phoneDatabaseFiles.fold(aside);
  await phoneDatabaseFiles.rename(aside, INFINICHAT_DATABASE);
  await phoneDatabaseFiles.remove(LEGACY_DATABASE);
}

/** InfiniChat's store on this phone, which its opener closes. */
export async function openPhoneStore(): Promise<Store> {
  await convert();
  return openExpoStore(INFINICHAT_DATABASE);
}

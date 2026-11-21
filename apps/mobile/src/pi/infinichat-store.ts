import type { Store } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { convertConversation, LEGACY_DATABASE } from '@pi-agent/infinichat/pi/infinichat-convert';
import { INFINICHAT_DATABASE, infiniChatStorage } from '@pi-agent/infinichat/pi/infinichat-store';

import { phoneStoreFiles as files } from './infinichat-remote/phone-files';
import { openExpoSqliteStorage, openExpoStore } from './storage';

const context = BACKGROUND_CONTEXT;
/** This phone's copy while a machine held the conversation, as the builds that copied the database file named it. */
const LEGACY_COPY = 'infinichat-moved.db';

/**
 * A conversation an earlier build left on this phone in `infinichat.db`, pi-durable's own SQLite storage, becomes the
 * store, once, as a machine's server converts its own (`conversation.ts`): copied record by record into a store
 * aside, which takes the store's name only when the copy is whole, so a conversion the app's end cut off starts
 * over. The old file then goes. So does the copy such a build kept while a machine held the conversation, which
 * nothing reads now: this phone holds the conversation when it opens its store.
 */
async function convert() {
  await files.remove(LEGACY_COPY);
  if (files.exists(INFINICHAT_DATABASE) || !files.exists(LEGACY_DATABASE)) return;
  const aside = `${INFINICHAT_DATABASE}.converting`;
  await files.remove(aside);
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
  await files.fold(aside);
  await files.rename(aside, INFINICHAT_DATABASE);
  await files.remove(LEGACY_DATABASE);
}

/** InfiniChat's store on this phone, which its opener closes. */
export async function openPhoneStore(): Promise<Store> {
  await convert();
  return openExpoStore(INFINICHAT_DATABASE);
}

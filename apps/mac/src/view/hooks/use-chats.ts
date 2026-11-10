import type { Held } from '@earendil-works/chord';
import { createContext, use } from 'react';

import type { MacAccount, MacChat, MacChats } from '../../contract';

export type ChatsRef = Held<typeof MacChats>;
export type ChatRef = Held<typeof MacChat>;
export type AccountRef = Held<typeof MacAccount>;

/** The window's reference to this Mac's providers, which the chat screens and their settings read. */
export const AccountContext = createContext<AccountRef | undefined>(undefined);

export function useAccountRef(): AccountRef {
  const ref = use(AccountContext);
  if (ref === undefined) throw new Error('The chat screens render inside the window.');
  return ref;
}

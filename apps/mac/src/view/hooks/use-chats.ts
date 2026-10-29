import type { Host, Ref } from '@earendil-works/chord';
import { createContext, use, useEffect, useState } from 'react';

import { MacAccount, MacChat, MacChats, type MacPrincipal } from '../../contract';

export type ChatsRef = Ref<typeof MacChats>;
export type ChatRef = Ref<typeof MacChat>;
export type AccountRef = Ref<typeof MacAccount>;

/** Holds the window's reference to the chat list for the window's lifetime, as the phone's provider holds its service. */
export function useHeldChats(host: Host<MacPrincipal>): ChatsRef {
  const [ref] = useState(() => host.hold(MacChats, {}));
  useEffect(() => () => ref.release(), [ref]);
  return ref;
}

/** Holds one chat while its screen shows it; the main side attaches the chat's view meanwhile. */
export function useHeldChat(host: Host<MacPrincipal>, id: string): ChatRef {
  const [ref] = useState(() => host.hold(MacChat, { id }));
  useEffect(() => () => ref.release(), [ref]);
  return ref;
}

export function useHeldAccount(host: Host<MacPrincipal>): AccountRef {
  const [ref] = useState(() => host.hold(MacAccount, {}));
  useEffect(() => () => ref.release(), [ref]);
  return ref;
}

/** The window's reference to this Mac's providers, which the chat screens and their settings read. */
export const AccountContext = createContext<AccountRef | undefined>(undefined);

export function useAccountRef(): AccountRef {
  const ref = use(AccountContext);
  if (ref === undefined) throw new Error('The chat screens render inside the window.');
  return ref;
}

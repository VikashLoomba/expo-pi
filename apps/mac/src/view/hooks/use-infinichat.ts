import type { Host, Ref } from '@earendil-works/chord';
import { createContext, use, useEffect, useState } from 'react';

import { MacInfiniChat, type MacPrincipal } from '../../contract';

export type InfiniChatRef = Ref<typeof MacInfiniChat>;

/** The screen's reference to InfiniChat, which its components read and call. */
export const InfiniChatContext = createContext<InfiniChatRef | undefined>(undefined);

export function useInfiniChatRef(): InfiniChatRef {
  const ref = use(InfiniChatContext);
  if (ref === undefined) throw new Error('InfiniChat’s components render inside its screen.');
  return ref;
}

/** Holds the window's reference to InfiniChat for the screen's lifetime, as the phone's provider holds its host. */
export function useHeldInfiniChat(host: Host<MacPrincipal>): InfiniChatRef {
  const [ref] = useState(() => host.hold(MacInfiniChat, {}));
  useEffect(() => () => ref.release(), [ref]);
  return ref;
}

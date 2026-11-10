import type { Held } from '@earendil-works/chord';
import { createContext, use } from 'react';

import type { MacInfiniChat } from '../../contract';

export type InfiniChatRef = Held<typeof MacInfiniChat>;

/** The screen's reference to InfiniChat, which its components read and call. */
export const InfiniChatContext = createContext<InfiniChatRef | undefined>(undefined);

export function useInfiniChatRef(): InfiniChatRef {
  const ref = use(InfiniChatContext);
  if (ref === undefined) throw new Error('InfiniChat’s components render inside its screen.');
  return ref;
}

import type { Ref } from '@earendil-works/chord';
import { createContext, use } from 'react';

import type { MacApp } from '../contract';

/** The window's reference to the app, for the screens that open links. */
export const AppContext = createContext<Ref<typeof MacApp> | undefined>(undefined);

export function useOpenExternal(): (url: string) => void {
  const app = use(AppContext);
  return (url) => {
    void app?.openExternal({ url }).catch(() => {});
  };
}

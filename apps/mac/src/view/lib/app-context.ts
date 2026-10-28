import type { Ref } from '@earendil-works/chord';
import { createContext, use, useCallback } from 'react';

import type { MacApp } from '../../contract';

/** The window's reference to the app, for the screens that open links. */
export const AppContext = createContext<Ref<typeof MacApp> | undefined>(undefined);

/** Opens a URL in the default browser through the main process; one function for the reference's lifetime. */
export function useOpenExternal(): (url: string) => void {
  const app = use(AppContext);
  return useCallback((url: string) => {
    void app?.openExternal({ url }).catch(() => {});
  }, [app]);
}

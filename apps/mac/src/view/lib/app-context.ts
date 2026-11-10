import type { Held } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createContext, use, useCallback } from 'react';

import type { MacApp, SettingsTarget } from '../../contract';

/** The window's reference to the app, for the screens that open links. */
export const AppContext = createContext<Held<typeof MacApp> | undefined>(undefined);

/** The Providers pane with `provider` listed first, where a Connect notice leads. */
export const providersPane = (provider?: string): SettingsTarget =>
  provider === undefined ? { pane: 'providers' } : { pane: 'providers', provider };

/** Opens the Settings window through the main process, at `target` or where it was. */
export function useOpenSettings(): (target?: SettingsTarget) => void {
  const app = use(AppContext);
  return useCallback((target?: SettingsTarget) => {
    void app?.openSettings(target === undefined ? {} : { target }, BACKGROUND_CONTEXT).catch(() => {});
  }, [app]);
}

/** Opens a URL in the default browser through the main process; one function for the reference's lifetime. */
export function useOpenExternal(): (url: string) => void {
  const app = use(AppContext);
  return useCallback((url: string) => {
    void app?.openExternal({ url }, BACKGROUND_CONTEXT).catch(() => {});
  }, [app]);
}

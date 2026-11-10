import { constant, createHost, defineFacet, type FacetHost, type Host } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { safeSourceUrl } from '@pi-agent/infinichat/chat/web-search-url';
import { Utils } from 'electrobun/main';

import {
  MacApp, MacMain, principalKey, type About, type MacPrincipal, type SettingsTarget,
} from '../contract';
import { done } from './serve';

/**
 * The main process's Chord host, loaded: the app's one addressable host, which acts as itself on its own objects
 * (chord `docs/design.md` §3, "The low-level host API"). Its one facet serves the app itself and the types `serve`
 * adds, whose factories close over the stores `index.ts` made before it (§18, start data). The windows are accepted
 * once this resolves (`listen.ts`).
 */
export async function createMacHost(about: About, windows: { openSettings(target?: SettingsTarget): void },
  serve: (host: FacetHost<MacPrincipal>) => void): Promise<Host<MacPrincipal>> {
  const host = createHost<MacPrincipal>({
    address: MacMain(), principal: { kind: 'host' }, principalKey,
    // Chord never ends the process: what fails in the background is the log's, and the objects retry.
    onError: (error) => console.error('InfiniChat:', error),
  });
  const facet = defineFacet<MacPrincipal>((served) => {
    served.serve(MacApp, () => ({
      variant: 'owner',
      members: {
        about: constant(about),
        // Markdown links and provider citations share the phone's external-web URL policy (`source-link.ts`).
        openExternal: async ({ url }) => {
          const safe = safeSourceUrl(url);
          if (safe !== undefined && !Utils.openExternal(safe)) throw new Error('Could not open link.');
          return null;
        },
        openSettings: async ({ target }) => done(windows.openSettings(target)),
      },
    }));
    serve(served);
  });
  const { failed } = await host.load([{ name: '@infinichat/mac', facet }], BACKGROUND_CONTEXT);
  // `load` leaves out a plugin it refuses and goes on; without this one no window has anything to show, so the
  // launch fails with its error.
  const [failure] = failed;
  if (failure !== undefined) throw failure.error;
  return host;
}

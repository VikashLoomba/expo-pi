import { createHost, type Host } from '@earendil-works/chord';
import { safeSourceUrl } from '@pi-agent/infinichat/chat/web-search-url';
import { Utils } from 'electrobun/main';

import { AboutSchema, MacApp, principalKey, type About, type MacPrincipal } from '../contract';

/** The main process's Chord host: its objects, and the links the windows connect through. */
export function createMacHost(about: About, windows: { openSettings(): void }): Host<MacPrincipal> {
  const host = createHost<MacPrincipal>({ name: 'mac', self: { kind: 'host' }, principalKey });
  host.serve(MacApp, (_input, _principal, self) => ({
    variant: 'owner',
    about: self.state('about', AboutSchema, about),
    // Markdown links and provider citations share the phone's external-web URL policy (`source-link.ts`).
    openExternal: ({ url }) => {
      const safe = safeSourceUrl(url);
      if (safe !== undefined && !Utils.openExternal(safe)) throw new Error('Could not open link.');
    },
    openSettings: () => { windows.openSettings(); },
  }));
  return host;
}

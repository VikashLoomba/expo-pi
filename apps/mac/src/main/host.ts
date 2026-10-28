import { createHost, type Host } from '@earendil-works/chord';

import { AboutSchema, MacApp, principalKey, type About, type MacPrincipal } from '../contract';

/** The main process's Chord host: its objects, and the links the windows connect through. */
export function createMacHost(about: About): Host<MacPrincipal> {
  const host = createHost<MacPrincipal>({ name: 'mac', self: { kind: 'host' }, principalKey });
  host.serve(MacApp, (_input, _principal, self) => ({
    variant: 'owner',
    about: self.state('about', AboutSchema, about),
  }));
  return host;
}

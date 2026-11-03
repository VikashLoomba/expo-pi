import type { Host, Ref } from '@earendil-works/chord';
import { useEffect, useState } from 'react';

import { MacMcp, type MacPrincipal } from '../../contract';

export type McpRef = Ref<typeof MacMcp>;

/** Holds the window's reference to the shown machine's MCP servers while the `/mcp` sheet shows them. */
export function useHeldMcp(host: Host<MacPrincipal>): McpRef {
  const [ref] = useState(() => host.hold(MacMcp, {}));
  useEffect(() => () => ref.release(), [ref]);
  return ref;
}

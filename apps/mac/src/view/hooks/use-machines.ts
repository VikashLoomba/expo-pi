import type { Host, Ref } from '@earendil-works/chord';
import { useEffect, useState } from 'react';

import { MacMachines, type MacPrincipal } from '../../contract';

export type MachinesRef = Ref<typeof MacMachines>;

/** Holds the window's reference to the machines for the Settings window's lifetime. */
export function useHeldMachines(host: Host<MacPrincipal>): MachinesRef {
  const [ref] = useState(() => host.hold(MacMachines, {}));
  useEffect(() => () => ref.release(), [ref]);
  return ref;
}

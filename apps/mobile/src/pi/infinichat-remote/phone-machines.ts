import { machineEndpoint, type Machine } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import type { MachineDirectory } from '@pi-agent/infinichat/pi/infinichat-remote/dialer';
import type { MachinePatch, MachinesState } from '@pi-agent/infinichat/pi/infinichat-remote/machines';
import type { ShownInfiniChat } from '@pi-agent/infinichat/pi/shown-infinichat';

/**
 * The conversation's machines document as this phone reads and edits it: through the side it shows, this phone's own
 * service or the machine's client, whichever holds the conversation. While a move holds the screens, the last list
 * stays readable and an edit is refused with the move's message.
 */
export interface MachinesAccess {
  subscribe(listener: () => void): () => void;
  get(): MachinesState | undefined;
  put(record: Machine): Promise<void>;
  patch(endpoint: string, patch: MachinePatch): Promise<void>;
  remove(endpoint: string): Promise<void>;
}

export function shownMachines(shown: ShownInfiniChat): MachinesAccess {
  return {
    subscribe: shown.machines.subscribe,
    get: shown.machines.getSnapshot,
    put: (record) => shown.putMachine(record),
    patch: (endpoint, patch) => shown.patchMachine(endpoint, patch),
    remove: (endpoint) => shown.removeMachine(endpoint),
  };
}

/** The InfiniChat keys of the other machines, which the key exchange authorizes on a machine. */
export function otherKeys(machines: MachinesAccess, endpoint: string): string[] {
  return Object.values(machines.get()?.machines ?? {}).flatMap((other) =>
    machineEndpoint(other) !== endpoint && other.publicKey !== undefined ? [other.publicKey] : []);
}

/** One machine as the document lists it, for the client of its server and for a move there. */
export function phoneMachines(machines: MachinesAccess, endpoint: string): MachineDirectory {
  return {
    id: endpoint,
    machine: () => machines.get()?.machines[endpoint],
    subscribe: machines.subscribe,
  };
}

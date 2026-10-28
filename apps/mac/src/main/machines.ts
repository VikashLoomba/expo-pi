import { hostname, userInfo } from 'node:os';

import type { MachineDirectory } from '@pi-agent/infinichat/pi/infinichat-remote/dialer';

/** The ID of this Mac in the app's machine list, which its home record names from the first launch. */
export const THIS_MAC = 'mac';

/** A machine as the app lists it; this Mac is the one record until piece 4 adds the others. */
export interface MacMachine {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
}

/** This Mac as a machine: the Mac's name, its host name and the account the app runs as. */
export const thisMac = (name: string): MacMachine =>
  ({ id: THIS_MAC, name, hostname: hostname(), port: 22, username: userInfo().username });

/** The machine as `RemoteInfiniChat` knows it; piece 4 reads the conversation's machines document instead. */
export function macDirectory(machine: MacMachine): MachineDirectory {
  const { name, hostname, port, username } = machine;
  return {
    id: machine.id,
    machine: () => ({ name, hostname, port, username }),
    subscribe: () => () => {},
  };
}

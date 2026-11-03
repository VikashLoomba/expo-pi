import { homedir } from 'node:os';
import { join } from 'node:path';

import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createPhotonImages } from '@earendil-works/pi-durable/images';
import photon from '@silvia-odwyer/photon/photon_rs_bg.wasm';

import { MACHINE_WORK, infiniChatDevices } from '../pi/infinichat/device-tools';
import type { ServerMachines } from './machines';

/**
 * This machine, under the name and with the description the phone's device list gives it, so the model's memory of
 * the device stays true when the conversation moves, then the other configured machines, reached over SSH from here.
 * Both are read at each use: a server plugin builds its tools before the objects that know them are open. Its tools
 * run in the work dir the phone uses for machines.
 */
export function serverDevices(self: () => { name: string; description: string }, machines: () => ServerMachines) {
  const environment = async (who: string) => machineEnvironment(who);
  // The plugin carries Photon's WebAssembly itself, so images are prepared on this thread without resolving its
  // package at run time, as pi-durable's `images` documents.
  return infiniChatDevices(async () => [{ ...self(), environment }, ...machines().devices()],
    createPhotonImages(photon));
}

/**
 * This machine in <work>/<who>, the device its tools name it by. The Harness gives it to pi-durable's own tools as the
 * conversation's environment (`HarnessOptions.env`): code mode, whose scripts run in this process, saves a result too
 * long for the model there (durable `src/codemode/output.ts`).
 */
export const machineEnvironment = (who: string) => new NodeExecutionEnv({ cwd: join(homedir(), MACHINE_WORK, who) });

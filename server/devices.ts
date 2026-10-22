import { homedir } from 'node:os';
import { join } from 'node:path';

import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createPhotonImages } from '@earendil-works/pi-durable/images';
import photon from '@silvia-odwyer/photon/photon_rs_bg.wasm';

import { MACHINE_WORK, infiniChatDevices } from '../src/pi/infinichat/device-tools';

/**
 * One device, this machine, under the name and with the description the phone's device list gives it, so the model's
 * memory of the device stays true when the conversation moves. Its tools run in the work dir the phone uses for
 * machines.
 */
export function serverDevices(name: string, description: string) {
  const work = join(homedir(), MACHINE_WORK);
  const device = {
    name,
    description,
    environment: async (who: string) => new NodeExecutionEnv({ cwd: join(work, who) }),
  };
  // A single-file bundle cannot resolve Photon's package, so it carries its own copy of the WebAssembly, as
  // pi-durable's `images/node` says; images are then prepared on this thread.
  return infiniChatDevices(async () => [device], createPhotonImages(photon));
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  serverBundle, type DaemonPlatform, type ServerAssets,
} from '@pi-agent/infinichat/pi/infinichat-remote/install';
import { PI_DAEMON_MANIFEST } from '@pi-agent/infinichat-server/daemon-manifest';
import { INFINICHAT_SERVER_MANIFEST } from '@pi-agent/infinichat-server/manifest';
import { PATHS } from 'electrobun/main';

const SERVER_UNAVAILABLE = 'The bundled InfiniChat server is unavailable or failed verification. Reinstall the app.';
const DAEMON_UNAVAILABLE = 'The bundled Pi daemon is unavailable or failed verification. Reinstall the app.';
type DaemonTarget = `${DaemonPlatform['platform']}-${DaemonPlatform['arch']}`;

/** The name of this app's bundle on a machine. */
export const SERVER_BUNDLE = serverBundle(INFINICHAT_SERVER_MANIFEST.sha256);
/** Where `build.copy` places the package's assets. */
const folder = join(PATHS.RESOURCES_FOLDER, 'app', 'server');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function verified(file: string, expected: { sha256: string; size: number }, message: string,
  signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  let bytes: Uint8Array;
  try {
    bytes = await readFile(join(folder, file));
  } catch {
    throw new Error(message);
  }
  if (bytes.byteLength !== expected.size || sha256(bytes) !== expected.sha256) throw new Error(message);
  signal.throwIfAborted();
  return bytes;
}

/**
 * What an install uploads from this app: the server bundle and the Pi daemons among its resources, checked against
 * their generated manifests, as the phone's `server-assets.ts` and `daemon-assets.ts` check its bundled assets.
 */
export const macServerAssets: ServerAssets = {
  manifest: { sha256: INFINICHAT_SERVER_MANIFEST.sha256, daemons: PI_DAEMON_MANIFEST },
  bundle: (signal) => verified('server.bin', INFINICHAT_SERVER_MANIFEST, SERVER_UNAVAILABLE, signal),
  daemon: async ({ platform, arch }, signal) => {
    const target: DaemonTarget = `${platform}-${arch}`;
    const expected = PI_DAEMON_MANIFEST[target];
    const bytes = await verified(`pi-env/pi-env-${target}.bin`, expected, DAEMON_UNAVAILABLE, signal);
    return { bytes, sha256: expected.sha256 };
  },
};

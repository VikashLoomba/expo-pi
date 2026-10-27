import { serverBundle, type ServerAssets } from '@pi-agent/infinichat/pi/infinichat-remote/install';
import { Buffer } from 'buffer';
import { Asset } from 'expo-asset';
import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { File } from 'expo-file-system';

import { loadPackagedDaemon } from '../execution/remote/daemon-assets';
import { PI_DAEMON_MANIFEST } from '../execution/remote/daemon-manifest';
import { INFINICHAT_SERVER_MANIFEST } from './server-manifest';

const UNAVAILABLE = 'The bundled InfiniChat server is unavailable or failed verification. Reinstall the app.';

/** The name of this app's bundle on a machine. */
export const SERVER_BUNDLE = serverBundle(INFINICHAT_SERVER_MANIFEST.sha256);

/**
 * The server bundle the app ships, checked against its pinned hash, as daemon-assets.ts loads the Pi daemon. A
 * literal asset reference lets Metro embed it in the standalone app; nothing is downloaded.
 */
async function loadServerBundle(signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const asset = await Asset.fromModule(require('../../../assets/infinichat-server/server.bin')).downloadAsync();
  if (!asset.localUri) throw new Error(UNAVAILABLE);
  const bytes = await new File(asset.localUri).bytes();
  if (bytes.byteLength !== INFINICHAT_SERVER_MANIFEST.size) throw new Error(UNAVAILABLE);
  const sha256 = Buffer.from(await digest(CryptoDigestAlgorithm.SHA256, bytes)).toString('hex');
  if (sha256 !== INFINICHAT_SERVER_MANIFEST.sha256) throw new Error(UNAVAILABLE);
  signal.throwIfAborted();
  return bytes;
}

/** What an install uploads from this app: the server bundle and the Pi daemons, with their generated manifests. */
export const phoneServerAssets: ServerAssets = {
  manifest: { sha256: INFINICHAT_SERVER_MANIFEST.sha256, daemons: PI_DAEMON_MANIFEST },
  bundle: loadServerBundle,
  daemon: loadPackagedDaemon,
};

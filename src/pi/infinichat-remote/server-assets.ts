import { Buffer } from 'buffer';
import { Asset } from 'expo-asset';
import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { File } from 'expo-file-system';

import { INFINICHAT_SERVER_MANIFEST } from './server-manifest';

const UNAVAILABLE = 'The bundled InfiniChat server is unavailable or failed verification. Reinstall the app.';

/**
 * The server bundle the app ships, checked against its pinned hash, as daemon-assets.ts loads the Pi daemon. A
 * literal asset reference lets Metro embed it in the standalone app; nothing is downloaded.
 */
export async function loadServerBundle(signal: AbortSignal): Promise<Uint8Array> {
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

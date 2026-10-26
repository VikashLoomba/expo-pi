import { Asset } from 'expo-asset';
import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { File } from 'expo-file-system';
import { PI_DAEMON_MANIFEST } from './daemon-manifest';
import { BootstrapError } from './bootstrap-errors';

export interface DaemonPlatform { platform: 'darwin' | 'linux'; arch: 'arm64' | 'x64' }
export interface DaemonBinary { bytes: Uint8Array; sha256: string }
type Target = keyof typeof PI_DAEMON_MANIFEST;

// Literal asset references let Metro embed every supported remote target in the
// standalone application. Nothing is downloaded from a registry on the phone.
/* eslint-disable @typescript-eslint/no-require-imports */
function bundledModule(target: Target): number {
  switch (target) {
    case 'darwin-arm64': return require('../../../../assets/pi-env/pi-env-darwin-arm64.bin');
    case 'darwin-x64': return require('../../../../assets/pi-env/pi-env-darwin-x64.bin');
    case 'linux-arm64': return require('../../../../assets/pi-env/pi-env-linux-arm64.bin');
    case 'linux-x64': return require('../../../../assets/pi-env/pi-env-linux-x64.bin');
  }
}
/* eslint-enable @typescript-eslint/no-require-imports */

async function readBundled(target: Target): Promise<DaemonBinary> {
  const asset = await Asset.fromModule(bundledModule(target)).downloadAsync();
  if (!asset.localUri) throw new Error('The bundled Pi daemon asset is unavailable. Reinstall the app.');
  const bytes = await new File(asset.localUri).bytes();
  const expected = PI_DAEMON_MANIFEST[target];
  if (bytes.byteLength !== expected.size) throw new Error('The bundled Pi daemon asset is incomplete. Reinstall the app.');
  const hash = await digest(CryptoDigestAlgorithm.SHA256, bytes);
  const sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (sha256 !== expected.sha256) throw new Error('The bundled Pi daemon asset failed verification. Reinstall the app.');
  return { bytes, sha256 };
}

/** Loads only the detected target and checks the pinned hash. */
export async function loadPackagedDaemon(remote: DaemonPlatform, signal: AbortSignal): Promise<DaemonBinary> {
  signal.throwIfAborted();
  const target: Target = `${remote.platform}-${remote.arch}`;
  const binary = await readBundled(target).catch(() => { throw new BootstrapError('DAEMON_ASSET'); });
  signal.throwIfAborted();
  return binary;
}

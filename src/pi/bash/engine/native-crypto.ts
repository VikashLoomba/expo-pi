import { CryptoDigestAlgorithm, digest as expoDigest } from 'expo-crypto';

export { getRandomValues } from 'expo-crypto';

/** Module-local replacement for just-bash's SHA call, never a global shim. */
export function digest(algorithm: string, bytes: Uint8Array): Promise<ArrayBuffer> {
  const resolved = algorithm === 'SHA-1' ? CryptoDigestAlgorithm.SHA1
    : algorithm === 'SHA-256' ? CryptoDigestAlgorithm.SHA256 : undefined;
  if (!resolved) throw new Error(`Unsupported shell digest algorithm: ${algorithm}`);
  // Copy to an owned ArrayBuffer. Typed-array views may otherwise expose bytes
  // outside the requested slice to a native bridge or use SharedArrayBuffer.
  return expoDigest(resolved, new Uint8Array(bytes));
}

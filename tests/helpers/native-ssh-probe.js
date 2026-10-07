// A standalone Metro entry for the native dependency check. It is never imported
// by the product app; scripts/check-native-ssh.mjs loads it into a development build.
import { Platform } from 'react-native';
import { NitroModules } from 'react-native-nitro-modules';
import nitroPackage from 'react-native-nitro-modules/package.json';
import { connect, generateKeyPair, inspectPrivateKey, nativeVersion, SshError } from '@osuki-dev/react-native-ssh';
import sshPackage from '@osuki-dev/react-native-ssh/package.json';

export default async function nativeSshProbe({ platform }) {
  const checks = [];
  const record = (name, condition) => {
    if (!condition) throw new Error(`Native SSH probe failed: ${name}`);
    checks.push(name);
  };
  record('running in Hermes', typeof globalThis.HermesInternal === 'object');
  record('requested native platform', Platform.OS === platform);
  record('Nitro JS and native versions match', NitroModules.version === nitroPackage.version);
  const version = nativeVersion();
  record('SSH native core registered and linked', typeof version === 'string' && version.length > 0);

  // This generated key exists only in this function. Never return, log, persist,
  // authorize, or use it for a network connection.
  let pair;
  try {
    pair = await generateKeyPair({ type: 'ed25519', comment: 'pi-ssh-native-probe' });
    const info = inspectPrivateKey(pair.privateKey);
    record('native Ed25519 generation and inspection agree', info.algorithm === 'ssh-ed25519'
      && info.publicKey === pair.publicKey && info.fingerprint === pair.fingerprint
      && info.comment === 'pi-ssh-native-probe' && info.encrypted === false);
  } finally {
    // Releases JS references; it is not a claim that JS strings can be zeroized.
    pair = undefined;
  }

  let invalidKey;
  try { inspectPrivateKey('pi-ssh-probe-invalid-key'); }
  catch (error) { invalidKey = SshError.is(error, 'KEY'); }
  record('native key errors become typed KEY errors', invalidKey === true);

  let invalidConnection;
  let hostVerificationCalled = false;
  try {
    // The package's native C++ validation rejects an empty host before opening
    // a socket. Unlike an already-aborted signal, this exercises the native API.
    const connection = await connect({ host: '', username: 'pi-ssh-probe', auth: { type: 'none' },
      verifyHostKey: () => { hostVerificationCalled = true; return false; } });
    await connection.disconnect();
  } catch (error) { invalidConnection = SshError.is(error, 'INVALID_ARGUMENT'); }
  record('native connect rejects invalid input before networking', invalidConnection === true && !hostVerificationCalled);

  return {
    ok: true, hermes: true, platform: Platform.OS,
    packageVersion: sshPackage.version, nativeVersion: version, nitroVersion: NitroModules.version,
    network: 'Metro loads this probe; SSH operations never open a socket',
    credentials: 'Ephemeral test key discarded; no user credentials or persistent keys',
    coverage: 'Native linkage and API smoke only; no SSH server or Pi daemon integration',
    checks,
  };
}

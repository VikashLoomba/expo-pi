import { Platform } from 'react-native';
import { connect } from '@osuki-dev/react-native-ssh';
import { createSshChannelFactory } from '../../src/pi/execution/remote/channel';
import { Connection } from '../../src/pi/execution/remote/connection';
import { loadPackagedDaemon } from '../../src/pi/execution/remote/daemon-assets';
import { PI_DAEMON_VERSION } from '../../src/pi/execution/remote/daemon-manifest';
import { matchesHostKey } from '../../src/pi/execution/remote/hosts';

const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Disposable Mac fixture: verifies native asset loading and real SSH bootstrap before conformance. */
export default async function probe({ platform, signal, config }) {
  const checks = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); checks.push(message); };
  check(Platform.OS === platform && typeof globalThis.HermesInternal === 'object', 'native Hermes runtime');
  const options = { host: config.host.hostname, port: config.host.port, username: config.host.username,
    auth: { type: 'privateKey', privateKey: config.privateKey },
    verifyHostKey: (key) => matchesHostKey(config.trustedHostKey, key), signal };
  const observer = await connect(options);
  let connection;
  const run = async (command) => {
    signal.throwIfAborted();
    const result = await observer.exec(command);
    check(result.exitCode === 0, 'independent SSH observation succeeded');
    return result.stdout.trim();
  };
  const open = () => new Connection({ openChannel: createSshChannelFactory(options), startTimeoutMs: 420_000 });
  try {
    const system = await run('uname -s; uname -m');
    check(system === 'Darwin\narm64', 'disposable bootstrap fixture is Darwin arm64');
    const home = await run('printf "%s" "$HOME"');
    const binary = await loadPackagedDaemon({ platform: 'darwin', arch: 'arm64' }, signal);
    const path = `${home}/.pi/mobile/tools/pi-env-${binary.sha256.slice(0, 32)}`;
    const existed = await run(`if [ -e ${quote(path)} ]; then printf present; else printf missing; fi`);
    check(existed === 'missing', 'expected daemon cache is initially absent');
    connection = open();
    const info = await connection.info(signal);
    check(info.version === PI_DAEMON_VERSION, 'first operation deploys and launches the pinned daemon');
    await connection.close();
    const hash = () => run(`shasum -a 256 ${quote(path)} | cut -d ' ' -f 1`);
    check(await hash() === binary.sha256, 'remote deployed bytes match the bundled SHA256');
    const identity = await run(`stat -f '%i:%m' ${quote(path)}`);
    connection = open();
    await connection.info(signal);
    await connection.close();
    check(await run(`stat -f '%i:%m' ${quote(path)}`) === identity, 'verified cache is reused without replacement');
    // Only corrupt the exact cache entry this probe just created, after its daemon exited.
    await run(`printf corrupt > ${quote(path)}`);
    check(await hash() !== binary.sha256, 'disposable cached daemon was deliberately corrupted');
    connection = open();
    await connection.info(signal);
    check(await hash() === binary.sha256, 'next operation repairs the corrupted daemon before launching it');
    const result = await connection.request('exec', { argv: ['/bin/sh', '-c', 'printf AUTO_PROVISIONED'], cwd: info.home,
      env: {}, inheritEnv: true }, { signal });
    check(result.json.exitCode === 0, 'repaired daemon executes a remote command');
    return { ok: true, hermes: true, checks, version: info.version, cachePath: path, sha256: binary.sha256,
      bundledBytes: binary.bytes.byteLength, existingAppModules: true };
  } finally {
    await connection?.close();
    await observer.disconnect();
  }
}

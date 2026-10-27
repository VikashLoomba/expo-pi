import { connect, type SshConnection } from '@osuki-dev/react-native-ssh';
import { machineDescription } from '@pi-agent/infinichat/pi/infinichat/device-tools';
import { Buffer } from 'buffer';
import { getRandomBytesAsync } from 'expo-crypto';

import { BootstrapError } from '../execution/remote/bootstrap-errors';
import { connectionFailure } from '../execution/remote/channel';
import { runSshCommand } from '../execution/remote/command-channel';
import { loadPackagedDaemon, type DaemonPlatform } from '../execution/remote/daemon-assets';
import { PI_DAEMON_MANIFEST } from '../execution/remote/daemon-manifest';
import { matchesHostKey, type RemoteHostAdmission, type RemoteHostRepository } from '../execution/remote/hosts';
import { HASH, quotePosix, script } from '../execution/remote/provisioning';
import { createCredentialBackend } from '../secure-storage';
import { loadServerBundle } from './server-assets';
import { INFINICHAT_SERVER_MANIFEST } from './server-manifest';

export type InstallStage = 'connecting' | 'checking' | 'uploading' | 'starting';

/** The name of this app's bundle on a machine, its directory there: the first 32 hex digits of its SHA-256. */
export const SERVER_BUNDLE = INFINICHAT_SERVER_MANIFEST.sha256.slice(0, 32);

export interface InstalledServer {
  /** The server's port on the machine's loopback, where the phone's tunnel goes. */
  port: number;
  /** What each connection carries as `Authorization: Bearer <secret>`. */
  secret: string;
  /** Set when the machine won't keep the server running by itself; shown instead of failing. */
  notice?: string;
}

const LABEL = 'com.vikashloomba.piagent.infinichat';
const MARKER = 'INFINICHAT-SETUP';
export const PRINT_MARKER = `printf '%s\\n' "$M"`;
/** pi-env's `UPLOAD_TIMEOUT_MS`, as provisioning.ts uploads the Pi daemon; other steps keep the 60 s default. */
const UPLOAD_TIMEOUT_MS = 300_000;
const CONTROL = /[\x00-\x1f\x7f]/;
// sshd doesn't stop a command whose session closed, so a wait prints a line each second: once the phone's channel is
// gone, such as after its step's timeout, the next line ends the script with SIGPIPE. Lines before the marker are
// ignored.
const TICK = `tick() { printf '\\n'; sleep 1; }`;
const PID = `sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' "$s"`;
/** The Node that runs the server, from `server.json` at `$s`, which move.ts runs the bundle's page commands with. */
export const NODE = `sed -n 's/.*"node":"\\([^"]*\\)".*/\\1/p' "$s"`;
/**
 * The pi-env daemons the app ships, which the server deploys to the other machines its tools use. pi-env takes the one
 * for each system it detects from `bin/` beside its package (`packagedDaemon`, `src/ssh.ts:356-360` at v1.4.0); in the
 * single-file bundle that is `bin/` beside the bundle folders, and its options name no binary per system.
 */
const DAEMONS: readonly DaemonPlatform[] = [{ platform: 'darwin', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' },
  { platform: 'linux', arch: 'arm64' }, { platform: 'linux', arch: 'x64' }];

/** Fixed messages: remote output never reaches one. */
function messages(name: string) {
  return {
    check: `Checking ${name} for InfiniChat failed. Try again.`,
    files: `Setting up InfiniChat on ${name} failed. Check the account’s home folder permissions and disk space.`,
    service: `InfiniChat’s service could not be started on ${name}.`,
    ready: `InfiniChat did not start on ${name}.`,
  };
}

export interface Step {
  /** The message for a script that fails or answers without its marker. */
  failure: string;
  /** The message when the step's timeout ends it; by default a connection failure. */
  timedOut?: string;
  input?: Uint8Array;
  /** 60 s by default; `null` for none (`runSshCommand`). */
  timeoutMs?: number | null;
  onWritten?: (bytes: number) => void;
}
type Run = (lines: string[], step: Step) => Promise<string[]>;

/**
 * One POSIX script over the install's connection. Its answer is what it prints after the marker, which comes after
 * anything the account's shell startup files print.
 */
export async function runScript(connection: SshConnection, signal: AbortSignal, name: string, lines: string[],
  step: Step): Promise<string[]> {
  let response: { stdout: string; exitCode: number };
  try {
    response = await runSshCommand(connection, script(['set -eu', `M=${MARKER}`, ...lines].join('\n')),
      { signal, input: step.input, timeoutMs: step.timeoutMs, onWritten: step.onWritten });
  } catch (error) {
    if (error instanceof BootstrapError && error.code === 'CANCELLED') throw error;
    if (error instanceof BootstrapError && error.code === 'TIMEOUT' && step.timedOut) throw new Error(step.timedOut);
    throw new Error(`The connection to ${name} failed while setting up InfiniChat. Check Tailscale and try again.`);
  }
  const output = response.stdout.split(/\r?\n/);
  const start = output.lastIndexOf(MARKER);
  if (response.exitCode !== 0 || start < 0) throw new Error(step.failure);
  return output.slice(start + 1);
}

const SECRET_UNAVAILABLE = 'Could not prepare InfiniChat’s key for this machine. Unlock this device and try again.';
const secretKey = (machineId: string) => `pi.infinichat.secret.v1.${machineId}`;

/** The secret this phone keeps for a machine, if it has one; only an install makes one. */
export async function savedSecret(machineId: string): Promise<string | undefined> {
  try {
    return await createCredentialBackend().getItemAsync(secretKey(machineId)) ?? undefined;
  } catch {
    throw new Error(SECRET_UNAVAILABLE);
  }
}

/** A removed machine's secret, never read again: added back, it gets a new ID, and its install a new secret. */
export async function forgetSecret(machineId: string): Promise<void> {
  await createCredentialBackend().deleteItemAsync(secretKey(machineId));
}

/** The phone keeps one secret per machine; a phone without one, new or reinstalled, makes a new one. */
async function machineSecret(machineId: string): Promise<string> {
  const saved = await savedSecret(machineId);
  if (saved !== undefined) return saved;
  try {
    const secret = Buffer.from(await getRandomBytesAsync(32)).toString('hex');
    await createCredentialBackend().setItemAsync(secretKey(machineId), secret);
    return secret;
  } catch {
    throw new Error(SECRET_UNAVAILABLE);
  }
}

/**
 * The system, the home folder, the login shell, and the Node that runs the server. `ssh` runs commands without a login
 * shell, and Node from Homebrew, nvm or fnm is often only on the login shell's PATH, so Node is found the way pi-env's
 * `loginShell` starts its daemon. `$0` is a second marker, printed after whatever the login shell's profile prints.
 * Android is told apart from Linux as provisioning.ts does.
 */
async function detect(run: Run, name: string) {
  const failure = messages(name).check;
  const [system, home, shell, ...rest] = await run([PRINT_MARKER,
    `if [ "$(uname -o 2>/dev/null || true)" = Android ]; then printf '%s\\n' Android; else uname -s; fi`,
    `printf '%s\\n' "$HOME"`,
    `printf '%s\\n' "$SHELL"`,
    `"$SHELL" -lc 'printf "%s\\n" "$0"; command -v node && node -p process.versions.node' "$M-NODE" || true`,
  ], { failure });
  const platform = system === 'Darwin' ? 'darwin' : system === 'Linux' ? 'linux' : undefined;
  if (!platform) throw new Error(`InfiniChat runs on macOS and Linux machines, and ${name} is neither.`);
  if (!home?.startsWith('/') || CONTROL.test(home)) throw new Error(failure);
  if (!shell?.startsWith('/') || CONTROL.test(shell)) throw new Error(failure);
  const found = rest.lastIndexOf(`${MARKER}-NODE`);
  const [node, version] = found < 0 ? [] : rest.slice(found + 1);
  // pi-durable's `engines`: Node 22.19 has the built-in `node:sqlite` its storage opens.
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(version ?? '');
  const supported = match !== null && (Number(match[1]) > 22 || (Number(match[1]) === 22 && Number(match[2]) >= 19));
  if (!supported || !node?.startsWith('/') || CONTROL.test(node)) {
    throw new Error(`InfiniChat needs Node 22.19 or newer on ${name}, on its login shell’s PATH (set in ~/.zprofile `
      + 'or ~/.profile, not only ~/.zshrc). Install it there and try again.');
  }
  return { platform, home: home.replace(/\/+$/, ''), shell, node } as const;
}

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Started at login and kept alive by launchd: a clean stop stays stopped, and a failure starts it again. */
function launchAgent(args: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', '<dict>',
    `  <key>Label</key><string>${LABEL}</string>`,
    '  <key>ProgramArguments</key>', '  <array>',
    ...args.map((arg) => `    <string>${xml(arg)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '</dict>', '</plist>', '',
  ].join('\n');
}

/** ExecStart unquotes C-style, and expands `%` specifiers and `$` variables, so each is escaped. */
const systemdArgument = (text: string) =>
  `"${text.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%').replace(/\$/g, () => '$$')}"`;

function systemdUnit(args: string[]): string {
  return ['[Unit]', 'Description=InfiniChat', '', '[Service]', `ExecStart=${args.map(systemdArgument).join(' ')}`,
    'Restart=on-failure', '', '[Install]', 'WantedBy=default.target', ''].join('\n');
}

/**
 * Reads the service file from stdin into `$t`, names `server.json` `$s`, sets `$restart` for a new secret, and
 * `$current` when `server.json` names this bundle and a live process.
 */
const readService = (restart: boolean, bundle: string) => ['umask 077', TICK, `restart=${restart ? 1 : 0}`,
  's="$HOME/.infinichat/server.json"', 't=$(mktemp "$HOME/.infinichat/.service.XXXXXX")', `trap 'rm -f "$t"' 0`,
  `trap 'exit 1' HUP INT TERM`, 'cat > "$t"', 'current=0',
  `if [ -f "$s" ] && grep -q '"bundle":"${bundle}"' "$s"; then`,
  `  pid=$(${PID}); if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then current=1; fi`,
  'fi'];

/**
 * Publishes `$t` at `path` when it differs, and sets `$changed` then, or when the running server isn't this bundle's:
 * a reload that failed or was cancelled after an earlier publish left the service manager on the old definition.
 */
const publish = (path: string) => [`if [ -f ${path} ] && cmp -s "$t" ${path}; then changed=0`,
  `else mkdir -p "$(dirname ${path})"; mv -f "$t" ${path}; changed=1; fi`,
  'if [ "$current" = 0 ]; then changed=1; fi'];

/**
 * Installs the LaunchAgent and starts it, or starts it again when it changed, isn't this bundle's, or must read a
 * new secret. `kickstart -k` restarts the definition launchd loaded before, so a changed one is booted out and
 * bootstrapped instead. The service stays listed for a moment after `bootout` returns, and a `bootstrap` then fails
 * with an I/O error, so it waits until launchd has let go; the step's timeout bounds the wait.
 */
function launchdScript(restart: boolean, bundle: string): string[] {
  const service = `"$domain"/${LABEL}`;
  return [...readService(restart, bundle), 'domain="gui/$(id -u)"', `p="$HOME/Library/LaunchAgents/${LABEL}.plist"`,
    // The gui domain exists while the account is logged in; LaunchAgents start there at login.
    `if ! launchctl print "$domain" >/dev/null 2>&1; then ${PRINT_MARKER}; echo nologin; exit 0; fi`,
    ...publish('"$p"'),
    `if ! launchctl print ${service} >/dev/null 2>&1; then rm -f "$s"; launchctl bootstrap "$domain" "$p"`,
    `elif [ "$changed" = 1 ]; then rm -f "$s"; launchctl bootout ${service}`,
    `  while launchctl print ${service} >/dev/null 2>&1; do tick; done`,
    '  launchctl bootstrap "$domain" "$p"',
    `elif [ "$restart" = 1 ]; then rm -f "$s"; launchctl kickstart -k ${service}; fi`,
    PRINT_MARKER, 'echo launchd'];
}

/**
 * Installs the systemd user unit and starts it, or starts it again when it changed, isn't this bundle's, or must read
 * a new secret, then reports lingering. Without a user bus (a container), the server starts detached, and the next
 * install starts it again. A detached server to replace gets SIGTERM, and the new one starts only once it is gone; the
 * step's timeout bounds the wait.
 */
function systemdScript(restart: boolean, args: string[], bundle: string): string[] {
  return [...readService(restart, bundle), 'u="$HOME/.config/systemd/user/infinichat.service"',
    'if systemctl --user show-environment >/dev/null 2>&1; then',
    ...publish('"$u"'),
    '  if [ "$changed" = 1 ] || [ "$restart" = 1 ]; then',
    '    rm -f "$s"; systemctl --user daemon-reload; systemctl --user enable infinichat.service',
    '    systemctl --user restart infinichat.service',
    '  else systemctl --user enable infinichat.service; fi',
    `  ${PRINT_MARKER}; echo systemd`,
    '  loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || echo unknown',
    'else',
    '  if [ "$current" = 0 ] || [ "$restart" = 1 ]; then',
    `    old=$(${PID} 2>/dev/null || true)`,
    '    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then kill "$old"; fi',
    '    while [ -n "$old" ] && kill -0 "$old" 2>/dev/null; do tick; done',
    '    rm -f "$s"',
    // setsid leaves the SSH session, and nohup ignores its hangup.
    `    setsid nohup ${args.map(quotePosix).join(' ')} </dev/null >/dev/null 2>&1 &`,
    '  fi',
    `  ${PRINT_MARKER}; echo detached`,
    'fi'];
}

/**
 * Waits until `server.json` names this bundle and a live process, in the form listen.ts writes, then removes the
 * server folders of other bundles, which no service starts any more. The step's timeout bounds the wait, as pi-env
 * bounds each `ssh` command (`SSH_TIMEOUT_MS`) and its daemon's start (`START_TIMEOUT_MS`) by 60 s.
 */
function readyScript(bundle: string): string[] {
  return [TICK, 's="$HOME/.infinichat/server.json"', `current="$HOME/.infinichat/server/${bundle}"`, 'while :; do',
    `  if [ -f "$s" ] && grep -q '"bundle":"${bundle}"' "$s"; then`,
    `    pid=$(${PID})`,
    '    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then break; fi',
    '  fi',
    '  tick',
    'done',
    // `bin/` holds the pi-env daemons, which every bundle shares.
    'for d in "$HOME/.infinichat/server"/*; do',
    '  [ "$d" = "$current" ] || [ "$d" = "$HOME/.infinichat/server/bin" ] || rm -rf "$d"',
    'done',
    PRINT_MARKER, 'cat "$s"'];
}

/**
 * An SSH connection with the machine's admission: its credentials, and its pinned host key checked and offered first,
 * as owner.ts admits its daemon channels. The caller owns the connection and disconnects it.
 */
export function connectAdmitted({ host, auth, trustedHostKey }: RemoteHostAdmission, options: {
  signal: AbortSignal;
  onDisconnected?: () => void;
}): Promise<SshConnection> {
  if (!trustedHostKey) {
    throw new Error(`Test ${host.name} in Remote machines and verify its SSH host key before using InfiniChat there.`);
  }
  return connect({
    host: host.hostname, port: host.port, username: host.username, auth, signal: options.signal,
    hostKeyAlgorithms: [trustedHostKey.algorithm],
    verifyHostKey: (observed) => matchesHostKey(trustedHostKey, observed),
    onDisconnected: options.onDisconnected,
  }).catch((error: unknown) => {
    throw connectionFailure(error);
  });
}

function readyPort(line: string | undefined, bundle: string): number | undefined {
  let info: unknown;
  try {
    info = JSON.parse(line ?? '');
  } catch {
    return undefined;
  }
  if (typeof info !== 'object' || info === null || !('port' in info) || !('bundle' in info)) return undefined;
  return typeof info.port === 'number' && info.bundle === bundle ? info.port : undefined;
}

/**
 * Installs the app's InfiniChat server on a configured machine and starts it as that account's service, over one
 * SSH connection opened with the machine's admission, as owner.ts admits its daemon channels. The bundle is uploaded
 * only when missing and verified before it is renamed into place, as provisioning.ts does; a dropped run leaves at
 * most a bundle folder, which the next run removes once its server is ready. The service manager owns the server;
 * this connection never does.
 */
export async function installServer(hosts: RemoteHostRepository, machineId: string, options: {
  signal: AbortSignal;
  onProgress?: (stage: InstallStage) => void;
}): Promise<InstalledServer> {
  const { signal } = options;
  const admission = await hosts.admit(machineId);
  const { host } = admission;
  const name = host.name;
  const secret = await machineSecret(machineId);
  options.onProgress?.('connecting');
  const connection = await connectAdmitted(admission, { signal });
  try {
    const run: Run = (lines, step) => runScript(connection, signal, name, lines, step);
    const message = messages(name);
    options.onProgress?.('checking');
    const machine = await detect(run, name);
    const { sha256 } = INFINICHAT_SERVER_MANIFEST;
    const file = `${machine.home}/.infinichat/server/${SERVER_BUNDLE}/server.js`;
    const daemons = DAEMONS.map((daemon) => {
      const target = `${daemon.platform}-${daemon.arch}` as const;
      return { daemon, target, sha256: PI_DAEMON_MANIFEST[target].sha256,
        file: `${machine.home}/.infinichat/server/bin/pi-env-${target}/pi-env` };
    });
    const present = (path: string, hash: string) =>
      `[ -f ${quotePosix(path)} ] && [ ! -L ${quotePosix(path)} ] && [ "$(hash ${quotePosix(path)})" = ${hash} ]`;
    // The bundle's state, then each daemon that is missing.
    const [state, ...missing] = await run([HASH, PRINT_MARKER,
      'if [ "$(hash /dev/null)" = none ]; then echo nohash',
      `elif ${present(file, sha256)}; then echo present`,
      'else echo missing; fi',
      ...daemons.map((daemon) => `${present(daemon.file, daemon.sha256)} || echo ${daemon.target}`)],
    { failure: message.check });
    if (state === 'nohash') throw new Error(`${name} needs sha256sum, shasum or openssl to verify InfiniChat.`);
    if (state !== 'present' && state !== 'missing') throw new Error(message.check);
    // Uploaded aside, verified, and renamed into place, as provisioning.ts uploads the Pi daemon.
    const upload = (path: string, hash: string, input: Uint8Array) => run([HASH, `f=${quotePosix(path)}`,
      'd=$(dirname "$f")', 'umask 077', 'mkdir -p "$d"', 't=$(mktemp "$d/.upload.XXXXXX")', `trap 'rm -f "$t"' 0`,
      `trap 'exit 1' HUP INT TERM`,
      // mv treats a directory, or a symlink to one, as a container; never publish into it.
      'if [ -L "$f" ] || { [ -e "$f" ] && [ ! -f "$f" ]; }; then exit 1; fi',
      'cat > "$t"', `[ "$(hash "$t")" = ${hash} ]`, 'mv -f "$t" "$f"', PRINT_MARKER],
    { failure: message.files, input, timeoutMs: UPLOAD_TIMEOUT_MS });
    if (state === 'missing') {
      options.onProgress?.('uploading');
      await upload(file, sha256, await loadServerBundle(signal));
    }
    for (const { daemon, target, file: path } of daemons) {
      if (!missing.includes(target)) continue;
      options.onProgress?.('uploading');
      const { bytes, sha256: hash } = await loadPackagedDaemon(daemon, signal);
      await upload(path, hash, bytes);
    }
    options.onProgress?.('starting');
    // On stdin, never on a command line other accounts can read. The server reads it when it starts, so a changed
    // secret restarts it; another phone's secret is refused from then on.
    const [secretFile] = await run(['umask 077', 'd="$HOME/.infinichat"', 'mkdir -p "$d"',
      'if [ -L "$d/secret" ] || { [ -e "$d/secret" ] && [ ! -f "$d/secret" ]; }; then exit 1; fi',
      't=$(mktemp "$d/.secret.XXXXXX")', `trap 'rm -f "$t"' 0`, `trap 'exit 1' HUP INT TERM`, 'cat > "$t"',
      'if [ -f "$d/secret" ] && cmp -s "$t" "$d/secret"; then r=same; else mv -f "$t" "$d/secret"; r=changed; fi',
      'chmod 600 "$d/secret"', PRINT_MARKER, 'echo "$r"'], { failure: message.files, input: Buffer.from(secret) });
    const restart = secretFile === 'changed';
    // Started through the login shell, as pi-env's `loginShell` starts its daemon, so the agent's tools see the PATH
    // the account's profile sets up rather than the service manager's. The device list's own text for the machine,
    // so the model's memory of it stays true once the conversation moves.
    const args = [machine.shell, '-lc', 'exec "$0" "$@"', machine.node, file, 'serve', '--device', name,
      '--description', machineDescription(host)];
    const [manager, linger] = machine.platform === 'darwin'
      ? await run(launchdScript(restart, SERVER_BUNDLE),
        { failure: message.service, timedOut: message.service, input: Buffer.from(launchAgent(args)) })
      : await run(systemdScript(restart, args, SERVER_BUNDLE),
        { failure: message.service, timedOut: message.service, input: Buffer.from(systemdUnit(args)) });
    if (manager === 'nologin') {
      throw new Error(`InfiniChat starts at login on ${name}, and no one is logged in there. Log in, then try again.`);
    }
    const [line] = await run(readyScript(SERVER_BUNDLE), { failure: message.service, timedOut: message.ready });
    const port = readyPort(line, SERVER_BUNDLE);
    if (port === undefined) throw new Error(message.ready);
    const notice = manager === 'detached'
      ? `${name} has no user service manager, so InfiniChat won’t start again by itself after a restart.`
      : linger === 'no'
        ? `InfiniChat stops on ${name} whenever no session is open there, including when this phone disconnects. `
          + `To keep it running, an administrator can run “loginctl enable-linger ${host.username}” on it.`
        : undefined;
    return { port, secret, ...(notice === undefined ? {} : { notice }) };
  } finally {
    await connection.disconnect().catch(() => undefined);
  }
}

/**
 * The port of this bundle's server when `server.json` names it and a live process, read over the caller's connection;
 * undefined when it must be installed or started first. The file can name a process that exited or a reused pid, so
 * the caller installs when the server refuses its socket anyway.
 */
export async function runningServer(connection: SshConnection, name: string, signal: AbortSignal,
): Promise<number | undefined> {
  const [line] = await runScript(connection, signal, name, ['s="$HOME/.infinichat/server.json"', PRINT_MARKER,
    `if [ -f "$s" ] && grep -q '"bundle":"${SERVER_BUNDLE}"' "$s"; then`,
    `  pid=$(${PID}); if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then cat "$s"; fi`,
    'fi'], { failure: messages(name).check });
  return readyPort(line, SERVER_BUNDLE);
}

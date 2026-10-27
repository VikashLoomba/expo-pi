import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

import type { CredentialBackend } from '../provider-credentials';
import type { InstallStage } from './dialer';
import {
  discard, fileFailure, HASH, MARKER, PRINT_MARKER, quotePosix, runScript, temporary, type Step,
} from './machine';

/** The name of a server bundle on a machine, its directory there: the first 32 hex digits of its SHA-256. */
export const serverBundle = (sha256: string) => sha256.slice(0, 32);

export interface InstalledServer {
  /** The server's port on the machine's loopback, where the app's tunnel goes. */
  port: number;
  /** What each connection carries as `Authorization: Bearer <secret>`. */
  secret: string;
  /** Set when the machine won't keep the server running by itself; shown instead of failing. */
  notice?: string;
}

/** A system the app ships a pi-env daemon for, in Node's names. */
export interface DaemonPlatform { platform: 'darwin' | 'linux'; arch: 'arm64' | 'x64' }
type DaemonTarget = `${DaemonPlatform['platform']}-${DaemonPlatform['arch']}`;

/** The server bundle and the pi-env daemons an install uploads, which each app ships its own way. */
export interface ServerAssets {
  /** The SHA-256 of the bundle and of each daemon, which the machine's copies are checked against first. */
  manifest: { sha256: string; daemons: Readonly<Record<DaemonTarget, { sha256: string }>> };
  /** The bundle, verified against the manifest. */
  bundle(signal: AbortSignal): Promise<Uint8Array>;
  /** One system's daemon, verified, with its SHA-256. */
  daemon(platform: DaemonPlatform, signal: AbortSignal): Promise<{ bytes: Uint8Array; sha256: string }>;
}

/** The machine an install acts on, as the app knows it. */
export interface InstallTarget {
  /** Its files and commands, borrowed from the owner of the app's connection to it. */
  machine: ExecutionEnv;
  /** Its name in the app's list, for messages and as the server's device name. */
  name: string;
  /** The device list's text for it (`machineDescription`), which the server describes itself with. */
  description: string;
  /** The account the app signs in as, which the linger advice names. */
  username: string;
}

const LABEL = 'com.vikashloomba.piagent.infinichat';
/** pi-env's `UPLOAD_TIMEOUT_MS`, as it uploads its daemon; other steps keep the 60 s default. */
const UPLOAD_TIMEOUT_MS = 300_000;
const CONTROL = /[\x00-\x1f\x7f]/;
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

type Run = (lines: string[], step: Step) => Promise<string[]>;

const SECRET_UNAVAILABLE = 'Could not prepare InfiniChat’s key for this machine. Unlock this device and try again.';
const secretKey = (machineId: string) => `pi.infinichat.secret.v1.${machineId}`;
/** Each client's secret on a machine, in a file named after its client ID; the server reads them at each connection. */
const CLIENTS = '.infinichat/clients';

/** The secret this app keeps for a machine, if it has one; only an install makes one. */
export async function savedSecret(credentials: CredentialBackend, machineId: string): Promise<string | undefined> {
  try {
    return await credentials.getItemAsync(secretKey(machineId)) ?? undefined;
  } catch {
    throw new Error(SECRET_UNAVAILABLE);
  }
}

/** A removed machine's secret, never read again: added back, it gets a new ID, and its install a new secret. */
export async function forgetSecret(credentials: CredentialBackend, machineId: string): Promise<void> {
  await credentials.deleteItemAsync(secretKey(machineId));
}

/** The app keeps one secret per machine; an app without one, new or reinstalled, makes a new one. */
export async function machineSecret(credentials: CredentialBackend,
  randomBytes: (count: number) => Promise<Uint8Array>, machineId: string): Promise<string> {
  const saved = await savedSecret(credentials, machineId);
  if (saved !== undefined) return saved;
  try {
    const bytes = await randomBytes(32);
    const secret = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    await credentials.setItemAsync(secretKey(machineId), secret);
    return secret;
  } catch {
    throw new Error(SECRET_UNAVAILABLE);
  }
}

/**
 * The system, the home folder, the login shell, and the Node that runs the server. A command's PATH depends on how the
 * environment runs it, and Node from Homebrew, nvm or fnm is often only on the login shell's PATH, so Node is found
 * through the login shell, the way pi-env's `loginShell` starts its daemon. `$0` is a second marker, printed after
 * whatever the login shell's profile prints. Android is told apart from Linux as pi-env's ssh.ts does.
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
 * With the service file at `$t`, names `server.json` `$s`, and sets `$current` when it names this bundle and a live
 * process.
 */
const readService = (bundle: string) => ['umask 077', 's="$HOME/.infinichat/server.json"', 'current=0',
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
 * Installs the LaunchAgent and starts it, or boots it out and bootstraps it again when it changed or isn't this
 * bundle's. The service stays listed for a moment after `bootout` returns, and a `bootstrap` then fails with an I/O
 * error, so it waits until launchd has let go; the step's timeout bounds the wait.
 */
function launchdScript(bundle: string): string[] {
  const service = `"$domain"/${LABEL}`;
  return [...readService(bundle), 'domain="gui/$(id -u)"', `p="$HOME/Library/LaunchAgents/${LABEL}.plist"`,
    // The gui domain exists while the account is logged in; LaunchAgents start there at login.
    `if ! launchctl print "$domain" >/dev/null 2>&1; then ${PRINT_MARKER}; echo nologin; exit 0; fi`,
    ...publish('"$p"'),
    `if ! launchctl print ${service} >/dev/null 2>&1; then rm -f "$s"; launchctl bootstrap "$domain" "$p"`,
    `elif [ "$changed" = 1 ]; then rm -f "$s"; launchctl bootout ${service}`,
    `  while launchctl print ${service} >/dev/null 2>&1; do sleep 1; done`,
    '  launchctl bootstrap "$domain" "$p"', 'fi',
    PRINT_MARKER, 'echo launchd'];
}

/**
 * Installs the systemd user unit and starts it, or starts it again when it changed or isn't this bundle's, then
 * reports lingering. Without a user bus (a container), the server starts detached, and the next install starts it
 * again. A detached server to replace gets SIGTERM, and the new one starts only once it is gone; the step's timeout
 * bounds the wait.
 */
function systemdScript(args: string[], bundle: string): string[] {
  return [...readService(bundle), 'u="$HOME/.config/systemd/user/infinichat.service"',
    'if systemctl --user show-environment >/dev/null 2>&1; then',
    ...publish('"$u"'),
    '  if [ "$changed" = 1 ]; then',
    '    rm -f "$s"; systemctl --user daemon-reload; systemctl --user enable infinichat.service',
    '    systemctl --user restart infinichat.service',
    '  else systemctl --user enable infinichat.service; fi',
    `  ${PRINT_MARKER}; echo systemd`,
    '  loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || echo unknown',
    'else',
    '  if [ "$current" = 0 ]; then',
    `    old=$(${PID} 2>/dev/null || true)`,
    '    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then kill "$old"; fi',
    '    while [ -n "$old" ] && kill -0 "$old" 2>/dev/null; do sleep 1; done',
    '    rm -f "$s"',
    // setsid leaves the command's process group, which pi-env's daemon kills when it stops; nohup ignores a hangup.
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
  return ['s="$HOME/.infinichat/server.json"', `current="$HOME/.infinichat/server/${bundle}"`, 'while :; do',
    `  if [ -f "$s" ] && grep -q '"bundle":"${bundle}"' "$s"; then`,
    `    pid=$(${PID})`,
    '    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then break; fi',
    '  fi',
    '  sleep 1',
    'done',
    // `bin/` holds the pi-env daemons, which every bundle shares.
    'for d in "$HOME/.infinichat/server"/*; do',
    '  [ "$d" = "$current" ] || [ "$d" = "$HOME/.infinichat/server/bin" ] || rm -rf "$d"',
    'done',
    PRINT_MARKER, 'cat "$s"'];
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
 * Installs the app's InfiniChat server on a configured machine and starts it as that account's service, through the
 * machine's `ExecutionEnv`, which the app borrows and never closes. The bundle is uploaded only when missing and
 * verified before it is renamed into place, as pi-env deploys its daemon; a dropped run leaves at most a bundle folder,
 * which the next run removes once its server is ready, and, if its connection was lost while writing, that file's
 * temporary copy. The service manager owns the server; the environment's connection never does. `secret` is the app's
 * for this machine (`machineSecret`), written as the file of `client`, the app's client ID, beside other clients'.
 */
export async function installServer({ machine, name, description, username }: InstallTarget, assets: ServerAssets,
  client: string, secret: string, options: { signal: AbortSignal; onProgress?: (stage: InstallStage) => void },
): Promise<InstalledServer> {
  const { signal } = options;
  const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
  const run: Run = (lines, step) => runScript(machine, signal, name, lines, step);
  const message = messages(name);
  const bundle = serverBundle(assets.manifest.sha256);
  // A lazily connected environment connects at its first command.
  options.onProgress?.('connecting');
  const system = await detect(run, name);
  options.onProgress?.('checking');
  const { sha256 } = assets.manifest;
  const file = `${system.home}/.infinichat/server/${bundle}/server.js`;
  const daemons = DAEMONS.map((daemon) => {
    const target = `${daemon.platform}-${daemon.arch}` as const;
    return { daemon, target, sha256: assets.manifest.daemons[target].sha256,
      file: `${system.home}/.infinichat/server/bin/pi-env-${target}/pi-env` };
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
  /**
   * Its folder made under umask 077, as pi-env deploys its daemon, then written beside its final name, verified, and
   * renamed into place, readable by the account alone (600).
   */
  const upload = async (path: string, hash: string, bytes: Uint8Array) => {
    const aside = temporary(path.slice(0, path.lastIndexOf('/')), 'upload');
    try {
      await run([`f=${quotePosix(path)}`, 'umask 077', 'mkdir -p "$(dirname "$f")"', PRINT_MARKER],
        { failure: message.files });
      const written = await machine.writeFile(aside, bytes,
        withAbortSignal(AbortSignal.timeout(UPLOAD_TIMEOUT_MS), context));
      if (!written.ok) throw fileFailure(signal, written.error, name, message.files);
      await run([HASH, `f=${quotePosix(path)}`, `t=${quotePosix(aside)}`,
        // mv treats a directory, or a symlink to one, as a container; never publish into it.
        'if [ -L "$f" ] || { [ -e "$f" ] && [ ! -f "$f" ]; }; then exit 1; fi',
        `[ "$(hash "$t")" = ${hash} ]`, 'chmod 600 "$t"', 'mv -f "$t" "$f"', PRINT_MARKER],
      { failure: message.files });
    } finally {
      discard(machine, aside);
    }
  };
  /**
   * Runs `lines` with `$t` naming a file of `content`, written first: never onto a command line other accounts can
   * read. It goes into ~/.infinichat, which the bundle's install made under umask 077, as the server makes it (0700).
   */
  const runWith = async (kind: string, content: string, lines: string[], step: Step) => {
    const input = temporary(`${system.home}/.infinichat`, kind);
    try {
      const written = await machine.writeFile(input, content, context);
      if (!written.ok) throw fileFailure(signal, written.error, name, step.failure);
      return await run([`t=${quotePosix(input)}`, ...lines], step);
    } finally {
      discard(machine, input);
    }
  };
  if (state === 'missing') {
    options.onProgress?.('uploading');
    await upload(file, sha256, await assets.bundle(signal));
  }
  for (const { daemon, target, file: path } of daemons) {
    if (!missing.includes(target)) continue;
    options.onProgress?.('uploading');
    const { bytes, sha256: hash } = await assets.daemon(daemon, signal);
    await upload(path, hash, bytes);
  }
  options.onProgress?.('starting');
  // The server reads the clients' files at each connection, so a new secret needs no restart, and the other clients'
  // files stay as they are.
  await runWith('secret', secret, ['umask 077', `d="$HOME/${CLIENTS}"`, 'mkdir -p "$d"', `f="$d/"${quotePosix(client)}`,
    'if [ -L "$f" ] || { [ -e "$f" ] && [ ! -f "$f" ]; }; then exit 1; fi', 'mv -f "$t" "$f"', 'chmod 600 "$f"',
    PRINT_MARKER], { failure: message.files });
  // Started through the login shell, as pi-env's `loginShell` starts its daemon, so the agent's tools see the PATH
  // the account's profile sets up rather than the service manager's. The device list's own text for the machine,
  // so the model's memory of it stays true once the conversation moves.
  const args = [system.shell, '-lc', 'exec "$0" "$@"', system.node, file, 'serve', '--device', name,
    '--description', description];
  const service = { failure: message.service, timedOut: message.service };
  const [manager, linger] = system.platform === 'darwin'
    ? await runWith('service', launchAgent(args), launchdScript(bundle), service)
    : await runWith('service', systemdUnit(args), systemdScript(args, bundle), service);
  if (manager === 'nologin') {
    throw new Error(`InfiniChat starts at login on ${name}, and no one is logged in there. Log in, then try again.`);
  }
  const [line] = await run(readyScript(bundle), { failure: message.service, timedOut: message.ready });
  const port = readyPort(line, bundle);
  if (port === undefined) throw new Error(message.ready);
  const notice = manager === 'detached'
    ? `${name} has no user service manager, so InfiniChat won’t start again by itself after a restart.`
    : linger === 'no'
      ? `InfiniChat stops on ${name} whenever no session is open there, including when this phone disconnects. `
        + `To keep it running, an administrator can run “loginctl enable-linger ${username}” on it.`
      : undefined;
  return { port, secret, ...(notice === undefined ? {} : { notice }) };
}

/**
 * Removes the file of `client` from the machine, borrowed as for an install, so its server refuses that client's
 * secret from then on.
 */
export async function removeClient(machine: ExecutionEnv, client: string): Promise<void> {
  const removed = await machine.remove(`~/${CLIENTS}/${client}`, { force: true }, BACKGROUND_CONTEXT);
  if (!removed.ok) throw new Error(removed.error.message);
}

/**
 * The port of this bundle's server when `server.json` names it and a live process; undefined when it must be installed
 * or started first. The file can name a process that exited or a reused pid, so the caller installs when the server
 * refuses its socket anyway.
 */
export async function runningServer(machine: ExecutionEnv, name: string, bundle: string, signal: AbortSignal,
): Promise<number | undefined> {
  const [line] = await runScript(machine, signal, name, ['s="$HOME/.infinichat/server.json"', PRINT_MARKER,
    `if [ -f "$s" ] && grep -q '"bundle":"${bundle}"' "$s"; then`,
    `  pid=$(${PID}); if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then cat "$s"; fi`,
    'fi'], { failure: messages(name).check });
  return readyPort(line, bundle);
}

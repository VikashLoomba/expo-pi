import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

import type { CredentialBackend } from '../provider-credentials';
import type { InstallStage } from './dialer';
import {
  discard, fileFailure, HASH, MARKER, PRINT_MARKER, quotePosix, runScript, temporary, type Step,
} from './machine';
import { latestServerRelease, PLUGIN_FILE, releaseFile, runtimeFile } from './release';

export interface InstalledServer {
  /** The server's port on the machine's loopback, where the app's tunnel goes. */
  port: number;
  /** What each connection carries as `Authorization: Bearer <secret>`. */
  secret: string;
  /** The server's release (`release.ts`). */
  version: string;
  /** Set when the machine won't keep the server running by itself; shown instead of failing. */
  notice?: string;
}

/** What a machine calls itself (`machineIdentity`). */
export interface MachineIdentity {
  /** macOS's computer name, else Linux's static host name, else the host name. */
  name: string;
  /** The host name, which the description names it by. */
  hostname: string;
}

/**
 * The machine's own name and host name, read on the machine, which its server names and describes itself by, so no
 * client names it. `label` names the machine in a failure.
 */
export async function machineIdentity(machine: ExecutionEnv, label: string, signal: AbortSignal,
): Promise<MachineIdentity> {
  const failure = `The name of ${label} could not be read.`;
  const [name, hostname] = await runScript(machine, signal, label, [
    'if [ "$(uname -s 2>/dev/null || true)" = Darwin ]; then n=$(scutil --get ComputerName 2>/dev/null || true);',
    'else n=$(hostnamectl --static 2>/dev/null || true); fi',
    'h=$(hostname 2>/dev/null || true)',
    '[ -n "$n" ] || n=$h',
    PRINT_MARKER,
    `printf '%s\\n' "$n" "$h"`,
  ], { failure });
  if (!name?.trim() || !hostname?.trim()) throw new Error(failure);
  return { name: name.trim(), hostname: hostname.trim() };
}

/** The machine an install acts on, as the app knows it. */
export interface InstallTarget {
  /** Its files and commands, borrowed from the owner of the app's connection to it. */
  machine: ExecutionEnv;
  /** Its name as the app lists it, for messages. */
  name: string;
  /** The account the app signs in as, which the linger advice names. */
  username: string;
}

const LABEL = 'com.vikashloomba.piagent.infinichat';
/** pi-env's `UPLOAD_TIMEOUT_MS`, as it uploads its daemon, for a release's download; other steps keep 60 s. */
const DOWNLOAD_TIMEOUT = 300;
const CONTROL = /[\x00-\x1f\x7f]/;
const PID = `sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' "$s"`;
/** The Node that runs the server, from `server.json` at `$s`, which move.ts runs the server's page commands with. */
export const NODE = `sed -n 's/.*"node":"\\([^"]*\\)".*/\\1/p' "$s"`;
/**
 * The server a machine runs, under its home: each runtime in a folder named after its key (`release.ts`), holding
 * its Chord host (`main.js`), the packages that host and every plugin share (`node_modules`, pi-env's daemons among
 * them), InfiniChat's server plugin (`plugins/infinichat/server.js`) and the release it came with (`release.json`);
 * `current` names the one the service starts.
 */
export const SERVER = '.infinichat/server';
/** The host the service starts. */
export const CURRENT = `${SERVER}/current/main.js`;
/** `fetch <url> <file>`, with whichever of curl and wget the machine has. */
const FETCH = 'fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"; '
  + 'else wget -q -O "$2" "$1"; fi; }';

/** InfiniChat's server plugin within a runtime folder; the host loads it from there and reloads it in place. */
export const PLUGIN = 'plugins/infinichat/server.js';

/** Fixed messages: remote output never reaches one. */
function messages(name: string) {
  return {
    check: `Checking ${name} for InfiniChat failed. Try again.`,
    files: `Setting up InfiniChat on ${name} failed. Check the account’s home folder permissions and disk space.`,
    download: `InfiniChat could not be downloaded on ${name}. Check its internet connection and try again.`,
    service: `InfiniChat’s service could not be started on ${name}.`,
    ready: `InfiniChat did not start on ${name}.`,
  };
}

type Run = (lines: string[], step: Step) => Promise<string[]>;

const SECRET_UNAVAILABLE = 'Could not prepare InfiniChat’s key for this machine. Unlock this device and try again.';
/**
 * The key the secret is kept under. A machine's ID is its endpoint, whose `@` and `:` the phone's secure store refuses
 * in a key (expo-secure-store: alphanumerics, `.`, `-` and `_`), so they are written as `_`.
 */
const secretKey = (machineId: string) => `pi.infinichat.secret.v1.${machineId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
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

/**
 * Started at login and kept alive by launchd: a clean stop stays stopped, and a failure, or the exit by which an
 * update restarts the server, starts it again.
 */
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
 * With the service file at `$t`, names `server.json` `$s`, and sets `$running` when it names a live server of a
 * release; a server from before releases names none, and is replaced.
 */
const readService = ['umask 077', 's="$HOME/.infinichat/server.json"', 'running=0',
  'if [ -f "$s" ] && grep -q \'"version":\' "$s"; then',
  `  pid=$(${PID}); if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then running=1; fi`,
  'fi'];

/**
 * Publishes `$t` at `path` when it differs, and sets `$changed` then, or when no server runs: a reload that failed or
 * was cancelled after an earlier publish left the service manager on the old definition.
 */
const publish = (path: string) => [`if [ -f ${path} ] && cmp -s "$t" ${path}; then changed=0`,
  `else mkdir -p "$(dirname ${path})"; mv -f "$t" ${path}; changed=1; fi`,
  'if [ "$running" = 0 ]; then changed=1; fi'];

/**
 * Installs the LaunchAgent and starts it, or boots it out and bootstraps it again when it changed or isn't running.
 * The service stays listed for a moment after `bootout` returns, and a `bootstrap` then fails with an I/O error, so it
 * waits until launchd has let go; the step's timeout bounds the wait.
 */
function launchdScript(): string[] {
  const service = `"$domain"/${LABEL}`;
  return [...readService, 'domain="gui/$(id -u)"', `p="$HOME/Library/LaunchAgents/${LABEL}.plist"`,
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
 * Installs the systemd user unit and starts it, or starts it again when it changed or isn't running, then reports
 * lingering. Without a user bus (a container), the server starts detached, and the next connection starts it again,
 * as after an update. A detached server to replace gets SIGTERM, and the new one starts only once it is gone; the
 * step's timeout bounds the wait.
 */
function systemdScript(args: string[]): string[] {
  return [...readService, 'u="$HOME/.config/systemd/user/infinichat.service"',
    'if systemctl --user show-environment >/dev/null 2>&1; then',
    ...publish('"$u"'),
    '  if [ "$changed" = 1 ]; then',
    '    rm -f "$s"; systemctl --user daemon-reload; systemctl --user enable infinichat.service',
    '    systemctl --user restart infinichat.service',
    '  else systemctl --user enable infinichat.service; fi',
    `  ${PRINT_MARKER}; echo systemd`,
    '  loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || echo unknown',
    'else',
    '  if [ "$running" = 0 ]; then',
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

/** True when `server.json` at `$s` names a live server of a release, in the form listen.ts writes. */
const LIVE = `[ -f "$s" ] && grep -q '"version":' "$s" && pid=$(${PID}) && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null`;

/**
 * Waits until `server.json` names a live server; the service scripts removed it before starting one. The step's
 * timeout bounds the wait, as pi-env bounds each `ssh` command (`SSH_TIMEOUT_MS`) and its daemon's start
 * (`START_TIMEOUT_MS`) by 60 s.
 */
const READY = ['s="$HOME/.infinichat/server.json"', `until ${LIVE}; do sleep 1; done`, PRINT_MARKER, 'cat "$s"'];

/** The port and release `server.json` names, or undefined when it doesn't name both. */
function serverInfo(line: string | undefined): { port: number; version: string } | undefined {
  let info: unknown;
  try {
    info = JSON.parse(line ?? '');
  } catch {
    return undefined;
  }
  if (typeof info !== 'object' || info === null || !('port' in info) || !('version' in info)) return undefined;
  return typeof info.port === 'number' && typeof info.version === 'string'
    ? { port: info.port, version: info.version } : undefined;
}

/**
 * Lets this app use InfiniChat on a configured machine: writes `secret`, the app's for this machine (`machineSecret`),
 * as the file of `client`, the app's client ID, beside other clients', and starts the server as that account's
 * service when it isn't running. A machine with no server first downloads the newest release (`release.ts`), each file
 * verified before it is moved into place, as pi-env deploys its daemon. It never replaces a server, which updates
 * itself. It works through the machine's `ExecutionEnv`, which the app borrows and never closes; the service manager
 * owns the server, and the environment's connection never does.
 */
export async function installServer({ machine, name, username }: InstallTarget, client: string, secret: string,
  options: { signal: AbortSignal; onProgress?: (stage: InstallStage) => void },
): Promise<InstalledServer> {
  const { signal } = options;
  const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
  const run: Run = (lines, step) => runScript(machine, signal, name, lines, step);
  const message = messages(name);
  // A lazily connected environment connects at its first command.
  options.onProgress?.('connecting');
  const system = await detect(run, name);
  options.onProgress?.('checking');
  const [state] = await run([HASH, PRINT_MARKER, `if [ -f "$HOME/${CURRENT}" ]; then echo present`,
    'elif ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then echo nofetch',
    'elif ! command -v tar >/dev/null 2>&1; then echo notar',
    'elif [ "$(hash /dev/null)" = none ]; then echo nohash',
    'else echo missing; fi'], { failure: message.check });
  if (state === 'nofetch') throw new Error(`${name} needs curl or wget to download InfiniChat.`);
  if (state === 'notar') throw new Error(`${name} needs tar to unpack InfiniChat.`);
  if (state === 'nohash') throw new Error(`${name} needs sha256sum, shasum or openssl to verify InfiniChat.`);
  if (state !== 'present' && state !== 'missing') throw new Error(message.check);
  /**
   * Runs `lines` with `$t` naming a file of `content`, written first: never onto a command line other accounts can
   * read. It goes into ~/.infinichat, which the download made under umask 077, as the server makes it (0700).
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
    options.onProgress?.('installing');
    const release = await latestServerRelease(signal);
    if (release === undefined) throw new Error('No InfiniChat server has been released yet.');
    const { version, runtime, plugin } = release;
    // Each download goes beside its final name under umask 077 and is verified before it is moved into place,
    // readable by the account alone: the runtime unpacked into a folder of its own, then the plugin and the release's
    // description; `current` then names the runtime.
    const download = (url: string, sha256: string) => [
      `  if fetch ${quotePosix(url)} "$t" && [ "$(hash "$t")" = ${sha256} ]; then :; else rm -f "$t"; exit 1; fi`];
    await run([HASH, FETCH, 'umask 077', `d="$HOME/${SERVER}/${runtime.key}"`, 'mkdir -p "$(dirname "$d")"',
      'if [ ! -f "$d/main.js" ]; then', '  t="$d.$$.tar.gz"',
      ...download(releaseFile(version, runtimeFile(runtime.key)), runtime.sha256),
      '  rm -rf "$d" "$d.$$"; mkdir "$d.$$"; tar -xzf "$t" -C "$d.$$"; rm -f "$t"; mv "$d.$$" "$d"', 'fi',
      `f="$d/${PLUGIN}"`, 'mkdir -p "$(dirname "$f")"', 't="$f.$$"',
      ...download(releaseFile(version, PLUGIN_FILE), plugin.sha256), 'mv -f "$t" "$f"', PRINT_MARKER],
    { failure: message.download, timeout: DOWNLOAD_TIMEOUT, timedOut: message.download });
    await runWith('release', JSON.stringify(release), [`d="$HOME/${SERVER}/${runtime.key}"`,
      'mv -f "$t" "$d/release.json"', `ln -sfn ${quotePosix(runtime.key)} "$HOME/${SERVER}/current"`, PRINT_MARKER],
    { failure: message.files });
  }
  options.onProgress?.('starting');
  // The server reads the clients' files at each connection, so a new secret needs no restart, and the other clients'
  // files stay as they are.
  await runWith('secret', secret, ['umask 077', `d="$HOME/${CLIENTS}"`, 'mkdir -p "$d"', `f="$d/"${quotePosix(client)}`,
    'if [ -L "$f" ] || { [ -e "$f" ] && [ ! -f "$f" ]; }; then exit 1; fi', 'mv -f "$t" "$f"', 'chmod 600 "$f"',
    PRINT_MARKER], { failure: message.files });
  // Started through the login shell, as pi-env's `loginShell` starts its daemon, so the agent's tools see the PATH
  // the account's profile sets up rather than the service manager's. The server names and describes the machine
  // itself.
  const args = [system.shell, '-lc', 'exec "$0" "$@"', system.node, `${system.home}/${CURRENT}`, 'serve'];
  const service = { failure: message.service, timedOut: message.service };
  const [manager, linger] = system.platform === 'darwin'
    ? await runWith('service', launchAgent(args), launchdScript(), service)
    : await runWith('service', systemdUnit(args), systemdScript(args), service);
  if (manager === 'nologin') {
    throw new Error(`InfiniChat starts at login on ${name}, and no one is logged in there. Log in, then try again.`);
  }
  const [line] = await run(READY, { failure: message.service, timedOut: message.ready });
  const server = serverInfo(line);
  if (server === undefined) throw new Error(message.ready);
  const notice = manager === 'detached'
    ? `${name} has no user service manager, so InfiniChat won’t start again by itself after a restart.`
    : linger === 'no'
      ? `InfiniChat stops on ${name} whenever no session is open there, including when this phone disconnects. `
        + `To keep it running, an administrator can run “loginctl enable-linger ${username}” on it.`
      : undefined;
  return { ...server, secret, ...(notice === undefined ? {} : { notice }) };
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
 * The port and release of the machine's server when `server.json` names a live one; undefined when it must be started
 * or set up first. The file can name a process that exited or a reused pid, so the caller installs when the server
 * refuses its socket anyway.
 */
export async function runningServer(machine: ExecutionEnv, name: string, signal: AbortSignal,
): Promise<{ port: number; version: string } | undefined> {
  const [line] = await runScript(machine, signal, name,
    ['s="$HOME/.infinichat/server.json"', PRINT_MARKER, `if ${LIVE}; then cat "$s"; fi`],
    { failure: messages(name).check });
  return serverInfo(line);
}

/** Asks the machine's server to update itself now (`SIGHUP`, server `update.ts`), as it does each day. */
export async function requestUpdate(machine: ExecutionEnv, name: string, signal: AbortSignal): Promise<void> {
  await runScript(machine, signal, name, ['s="$HOME/.infinichat/server.json"', `if ${LIVE}; then kill -HUP "$pid"; fi`,
    PRINT_MARKER], { failure: messages(name).check });
}

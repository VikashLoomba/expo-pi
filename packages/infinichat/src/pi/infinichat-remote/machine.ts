import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { uuidv7 } from '@earendil-works/pi-ai';
import type { ExecutionEnv, FileError } from '@earendil-works/pi-durable/env';

/**
 * A machine's files and commands for installing InfiniChat's server and moving its conversation, through the
 * pi-durable `ExecutionEnv` an app borrows from the owner of its connection to the machine. Commands are POSIX scripts
 * whose answer follows a marker line. `exec` has no stdin (pi-durable `ShellExecOptions`), so a script's input is a
 * file written first, inside `~/.infinichat`, which only the machine's account enters (mode 0700).
 */

/** Printed on its own line before a script's answer; whatever comes before it isn't the answer. */
export const MARKER = 'INFINICHAT-SETUP';
export const PRINT_MARKER = `printf '%s\\n' "$M"`;
/** pi-env's SSH step timeout (`SSH_TIMEOUT_MS`), in seconds. */
const STEP_TIMEOUT = 60;

/** One word for POSIX `sh`, as pi-env's ssh.ts quotes its own scripts' arguments. */
export function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** `hash <file>` prints its SHA-256, or `none` without a tool for it, as pi-env's ssh.ts checks its daemon. */
export const HASH = `hash() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; `
  + `elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; `
  + `elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/.*= //'; `
  + `else printf 'none\\n'; fi; }`;

/** A failure that isn't the machine's answer; remote output never reaches a message. */
export const connectionFailure = (name: string) =>
  new Error(`The connection to ${name} failed while setting up InfiniChat. Check Tailscale and try again.`);

/**
 * Whether a file operation failed because the connection to the machine was lost, not by the machine's answer. Only
 * the connection's owner can tell: `FileError`'s `unknown` is also every system error the environment doesn't map,
 * such as a full disk, and pi-env marks a lost connection on the error it keeps as the cause (`isConnectionLost`).
 */
export type ConnectionLost = (error: FileError) => boolean;

/**
 * The cancellation, or the message for a file operation that failed: a connection failure for a lost connection, and
 * for a deadline the caller set (`aborted` once the caller's own signal is checked); `failure` for anything else.
 */
export function fileFailure(signal: AbortSignal, error: FileError, lost: ConnectionLost, name: string,
  failure: string): Error {
  signal.throwIfAborted();
  return error.code === 'aborted' || lost(error) ? connectionFailure(name) : new Error(failure);
}

/** A unique name for one step's temporary file in `folder`, as `mktemp` names one. */
export const temporary = (folder: string, kind: string) => `${folder}/.${kind}.${uuidv7()}`;

/**
 * Removes a step's temporary file, however the step ended: a cancelled or timed-out command dies with its process
 * group (pi-durable `Shell.exec`), before its script could. Not awaited, so a lost connection never holds up the step's
 * failure while the removal waits for a new one.
 */
export function discard(machine: ExecutionEnv, path: string) {
  void machine.remove(path, { force: true }, BACKGROUND_CONTEXT);
}

export interface Step {
  /** The message for a script that fails or answers without its marker. */
  failure: string;
  /** The message when the step's timeout ends it; by default a connection failure. */
  timedOut?: string;
  /** In seconds: 60 by default, `null` for none. */
  timeout?: number | null;
}

/** One POSIX script on the machine. Its answer is what it prints after the marker. */
export async function runScript(machine: ExecutionEnv, signal: AbortSignal, name: string, lines: string[],
  step: Step): Promise<string[]> {
  let stdout = '';
  const result = await machine.exec(['set -eu', `M=${MARKER}`, ...lines].join('\n'), {
    timeout: step.timeout === null ? undefined : step.timeout ?? STEP_TIMEOUT,
    onOutput: (text, _context, info) => {
      if (info.stream === 'stdout') stdout += text;
    },
  }, withAbortSignal(signal, BACKGROUND_CONTEXT));
  if (!result.ok) {
    signal.throwIfAborted();
    if (result.error.code === 'timeout' && step.timedOut) throw new Error(step.timedOut);
    throw connectionFailure(name);
  }
  const output = stdout.split(/\r?\n/);
  const start = output.lastIndexOf(MARKER);
  if (result.value.exitCode !== 0 || start < 0) throw new Error(step.failure);
  return output.slice(start + 1);
}

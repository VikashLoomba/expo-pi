import type { SshConnection, SshShell } from '@osuki-dev/react-native-ssh';
import { Buffer } from 'buffer';
import { BootstrapError } from './bootstrap-errors';

export type BootstrapConnection = Pick<SshConnection, 'openShell' | 'disconnect'>;
const WRITE_CHUNK = 64 * 1024;

function code(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/** Yield between bounded writes, and retry only QUEUE_FULL, which the library guarantees accepted no bytes. */
async function writable(operation: () => void, signal: AbortSignal): Promise<void> {
  for (;;) {
    if (signal.aborted) throw new BootstrapError('CANCELLED');
    try { operation(); return; }
    catch (error) { if (code(error) !== 'QUEUE_FULL') throw error; }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/** A short bootstrap command with owned output, EOF, exit status, and awaited channel disposal. */
export async function runSshCommand(connection: BootstrapConnection, command: string, options: {
  signal: AbortSignal;
  input?: Uint8Array;
  timeoutMs?: number;
}): Promise<{ stdout: string; exitCode: number }> {
  if (options.signal.aborted) throw new BootstrapError('CANCELLED');
  const controller = new AbortController();
  let shell: SshShell | undefined;
  let failed = false;
  let failure: unknown;
  let ended = false;
  let exitCode: number | undefined;
  const chunks: Uint8Array[] = [];
  let rejectFailure!: (error: unknown) => void;
  let resolveExit!: () => void;
  const failurePromise = new Promise<never>((_, reject) => { rejectFailure = reject; });
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true; failure = error;
    controller.abort();
    rejectFailure(error);
    // A channel close can wait behind blocked writes. Disconnecting its unique
    // SSH connection releases that native queue and pending channel-open calls.
    void connection.disconnect().catch(() => {});
  };
  const abort = () => fail(new BootstrapError('CANCELLED'));
  const timer = setTimeout(() => fail(new BootstrapError('TIMEOUT')), options.timeoutMs ?? 60_000);
  options.signal.addEventListener('abort', abort, { once: true });
  const capture = (bytes: ArrayBuffer) => {
    if (failed || ended) return;
    chunks.push(new Uint8Array(bytes).slice());
  };
  const opening = Promise.resolve().then(() => {
    if (failed || options.signal.aborted) throw failure ?? new BootstrapError('CANCELLED');
    return connection.openShell({ term: '', command }, {
      onData: capture,
      // Remote shell diagnostics stay out of the parsed output and are deliberately discarded.
      onStderr: () => {},
      onClosed: (status) => { ended = true; exitCode = status; resolveExit(); },
    });
  });
  // Install a rejection observer even if an injected transport rejects synchronously.
  void failurePromise.catch(() => {});
  try {
    if (options.signal.aborted) abort();
    shell = await Promise.race([opening, failurePromise]);
    if (failed) throw failure;
    const input = options.input;
    if (input) {
      for (let offset = 0; offset < input.length; offset += WRITE_CHUNK) {
        if (ended) throw new BootstrapError('DAEMON_UPLOAD');
        const bytes = new Uint8Array(input.subarray(offset, offset + WRITE_CHUNK));
        await Promise.race([writable(() => shell!.write(bytes), controller.signal), failurePromise]);
        // Give native output/closure and cancellation callbacks an opportunity
        // to run instead of filling the native input queue in one JS turn.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    if (!ended) {
      try {
        await Promise.race([writable(() => shell!.sendEof(), controller.signal), failurePromise]);
      } catch (error) {
        // A short command can close its native handle before its queued stdout
        // and onClosed callbacks reach JS. EOF has no remaining input to send;
        // drain those callbacks under the existing deadline instead of treating
        // this ordering as a failed command. Writes never take this exception.
        if (code(error) !== 'CLOSED') throw error;
      }
    }
    await Promise.race([exited, failurePromise]);
    if (exitCode === undefined) throw Object.assign(new Error('SSH setup command closed without an exit status.'), { code: 'CLOSED' });
    return { stdout: Buffer.concat(chunks).toString('utf8'), exitCode };
  } catch (error) {
    fail(error);
    throw failure;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
    // A late channel remains owned even when abort won before openShell resolved.
    const close = opening.then((opened) => opened.close(), () => undefined);
    await Promise.allSettled([close, ...(failed ? [connection.disconnect()] : [])]);
  }
}
